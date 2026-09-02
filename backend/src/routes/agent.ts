import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { getRepository } from "../lib/migration-state";
import {
  addEvent,
  getEvents,
  getMigration,
  listMigrations,
  saveMigration,
  saveRepository,
} from "../lib/migration-state";
import {
  analyzeRepository,
  createRepositoryWorkspace,
  importGithubWorkspace,
  startMigration,
} from "../lib/repository-agent";
import { ZipSecurityError } from "../lib/zip";

const router: IRouter = Router();

/** Extract a clean machine-readable error code + message from a thrown error. */
function errorPayload(error: unknown): { error: string } {
  // Prefer the error's `code`/`name` over `instanceof` — the tsx/esbuild loader can
  // produce a duplicate class identity so `instanceof ZipSecurityError` is unreliable.
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { name?: unknown }).name === "ZipSecurityError"
  ) {
    const err = error as { code: string; message: string };
    const detail = err.message.replace(/^[A-Z_]+:\s*/, "");
    return { error: `${err.code}: ${detail}` };
  }
  const message = String(error)
    .replace(/^Error:\s*/, "")
    .replace(/^(?:ZipSecurityError|Error):\s*/, "");
  return { error: message };
}

function readUploadedZip(body: unknown, contentType: string | undefined): { bytes: Buffer; filename: string } {
  if (!Buffer.isBuffer(body)) return { bytes: Buffer.alloc(0), filename: "repository.zip" };
  if (!contentType?.startsWith("multipart/form-data")) return { bytes: body, filename: "repository.zip" };
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) throw new Error("REPOSITORY_INVALID: multipart boundary is missing");
  const marker = Buffer.from(`--${boundary}`);
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) throw new Error("REPOSITORY_INVALID: multipart file header is missing");
  const header = body.subarray(0, headerEnd).toString("utf8");
  const fileStart = headerEnd + 4;
  const fileEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), fileStart);
  if (fileEnd < 0) throw new Error("REPOSITORY_INVALID: multipart file payload is missing");
  if (!header.includes('name="file"')) throw new Error("REPOSITORY_INVALID: upload field must be file");
  const filename = header.match(/filename="([^"]+)"/)?.[1] ?? "repository.zip";
  return { bytes: body.subarray(fileStart, fileEnd), filename };
}

function publicRepository(repository: Awaited<ReturnType<typeof analyzeRepository>>) {
  const { rootPath: _rootPath, ...publicData } = repository;
  return publicData;
}

function publicMigration(migration: NonNullable<Awaited<ReturnType<typeof getMigration>>>) {
  const { plan: _plan, impactFiles: _impactFiles, sources: _sources, changes: _changes, remainingIssues: _remainingIssues, diff: _diff, agentState, research, riskSummary, verificationCommands, baseline, attempts, cancelled, ...publicData } = migration;
  return {
    ...publicData,
    agentState: agentState ?? null,
    research: research ?? null,
    riskSummary: riskSummary ?? null,
    attempts: attempts ?? [],
    verificationCommands: verificationCommands ?? [],
    baseline: baseline ?? null,
    cancelled: Boolean(cancelled),
  };
}

router.get("/dashboard", async (_req, res) => {
  const migrations = await listMigrations();
  res.json({
    totalMigrations: migrations.length,
    completedMigrations: migrations.filter((item) => ["completed", "approved"].includes(item.status)).length,
    runningMigrations: migrations.filter((item) => ["queued", "running"].includes(item.status)).length,
    failedMigrations: migrations.filter((item) => item.status === "failed").length,
    recent: migrations.slice(0, 8).map(publicMigration),
    capabilities: ["JavaScript", "TypeScript", "npm", "pnpm", "ZIP repositories", "Grok planning"],
  });
});

router.post("/repositories/upload", async (req, res) => {
  try {
    const upload = readUploadedZip(req.body, req.header("content-type"));
    const bytes = upload.bytes;
    if (!bytes.length) return res.status(400).json({ error: "INVALID_FILE_TYPE: empty upload" });
    const filename = String(req.header("x-repository-name") ?? upload.filename);
    const workspace = await createRepositoryWorkspace(bytes, filename);
    const repository = await analyzeRepository(workspace.rootPath, "zip");
    await saveRepository(repository);
    return res.status(201).json(publicRepository(repository));
  } catch (error) {
    return res.status(400).json(errorPayload(error));
  }
});

router.post("/repositories/github", async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    const workspace = await importGithubWorkspace(url);
    const repository = await analyzeRepository(workspace.rootPath, "github");
    await saveRepository(repository);
    return res.status(201).json(publicRepository(repository));
  } catch (error) {
    return res.status(400).json(errorPayload(error));
  }
});

router.get("/repositories/:id", async (req, res) => {
  const repository = await getRepository(req.params.id);
  if (!repository) return res.status(404).json({ error: "REPOSITORY_NOT_FOUND" });
  return res.json(publicRepository(repository));
});

router.get("/migrations", async (_req, res) => {
  return res.json((await listMigrations()).map(publicMigration));
});

router.post("/migrations", async (req, res) => {
  try {
    const { repositoryId, dependency, targetMajor, mode = "agentic" } = req.body ?? {};
    if (typeof repositoryId !== "string" || typeof dependency !== "string" || !/^\d+$/.test(String(targetMajor))) {
      return res.status(400).json({ error: "INVALID_MIGRATION_REQUEST" });
    }
    const migration = await startMigration(repositoryId, dependency, String(targetMajor), mode === "baseline" ? "baseline" : "agentic");
    return res.status(202).json(publicMigration(migration));
  } catch (error) {
    return res.status(400).json(errorPayload(error));
  }
});

router.get("/migrations/:id", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  return res.json(publicMigration(migration));
});

router.get("/migrations/:id/events", async (req, res) => {
  return res.json(await getEvents(req.params.id));
});

router.get("/migrations/:id/diff", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  return res.json(migration.diff);
});

router.get("/migrations/:id/report", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  const repository = await getRepository(migration.repositoryId);
  return res.json({
    migrationId: migration.id,
    status: migration.status,
    summary: migration.plan?.summary ?? "No final report was generated.",
    repository: {
      name: migration.repositoryName,
      language: repository?.language ?? "Unknown",
      packageManager: repository?.packageManager ?? "unsupported",
      framework: repository?.framework ?? null,
    },
    impact: {
      affectedFiles: migration.affectedFiles,
      affectedUsages: migration.affectedUsages,
      files: migration.impactFiles,
    },
    sources: migration.sources,
    changes: migration.changes,
    attempts: migration.attempts,
    remainingIssues: migration.remainingIssues,
    // Phase 2 structured data
    research: migration.research ?? null,
    riskSummary: migration.riskSummary ?? null,
    plan: migration.plan,
    affectedApiFindings: migration.riskSummary?.affectedApis ?? [],
    verificationCommands: migration.verificationCommands ?? [],
    baseline: migration.baseline ?? null,
    approvalStatus: migration.status === "approved" ? "APPROVED" : migration.status === "rejected" ? "REJECTED" : migration.status === "completed" ? "PENDING" : String(migration.status),
  });
});

router.post("/migrations/:id/approve", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  if (migration.status !== "completed") return res.status(409).json({ error: "MIGRATION_NOT_READY" });
  migration.status = "approved";
  migration.updatedAt = new Date().toISOString();
  await saveMigration(migration);
  await addEvent({ id: randomUUID(), migrationId: migration.id, timestamp: new Date().toISOString(), level: "success", message: "Changes approved by user" });
  return res.json(publicMigration(migration));
});

router.post("/migrations/:id/reject", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  if (migration.status !== "completed") return res.status(409).json({ error: "MIGRATION_NOT_READY" });
  migration.status = "rejected";
  migration.updatedAt = new Date().toISOString();
  await saveMigration(migration);
  await addEvent({ id: randomUUID(), migrationId: migration.id, timestamp: new Date().toISOString(), level: "warning", message: "Changes rejected by user" });
  return res.json(publicMigration(migration));
});

router.post("/migrations/:id/cancel", async (req, res) => {
  const migration = await getMigration(req.params.id);
  if (!migration) return res.status(404).json({ error: "MIGRATION_NOT_FOUND" });
  migration.status = "cancelled";
  migration.cancelled = true;
  migration.updatedAt = new Date().toISOString();
  await saveMigration(migration);
  await addEvent({ id: randomUUID(), migrationId: migration.id, timestamp: new Date().toISOString(), level: "warning", message: "Migration cancelled by user" });
  return res.json(publicMigration(migration));
});

export default router;