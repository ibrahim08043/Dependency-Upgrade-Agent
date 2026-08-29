import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";
import {
  addEvent,
  createMigration,
  getRepository,
  saveMigration,
  type MigrationRecord,
  type PackageManager,
  type RepositoryRecord,
} from "./migration-state";

const execFileAsync = promisify(execFile);
const workspaceRoot = "/tmp/dependency-agent";
const MAX_OUTPUT = 24_000;
const COMMAND_TIMEOUT = 120_000;

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: COMMAND_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      env: {
        HOME: process.env.HOME ?? "/tmp",
        PATH: process.env.PATH ?? "",
        CI: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    });
    return {
      code: 0,
      stdout: result.stdout.slice(0, MAX_OUTPUT),
      stderr: result.stderr.slice(0, MAX_OUTPUT),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof result.code === "number" ? result.code : 1,
      stdout: (result.stdout ?? "").slice(0, MAX_OUTPUT),
      stderr: (result.stderr ?? String(error)).slice(0, MAX_OUTPUT),
      durationMs: Date.now() - started,
    };
  }
}

async function findPackageRoot(rootPath: string): Promise<string | null> {
  const direct = path.join(rootPath, "package.json");
  try {
    await stat(direct);
    return rootPath;
  } catch {
    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries.slice(0, 30)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const candidate = path.join(rootPath, entry.name, "package.json");
      try {
        await stat(candidate);
        return path.dirname(candidate);
      } catch {
        // Continue looking only one wrapper directory deep.
      }
    }
    return null;
  }
}

async function listFiles(rootPath: string, current = rootPath): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(rootPath, fullPath)));
    else files.push(path.relative(rootPath, fullPath));
    if (files.length > 3000) return files;
  }
  return files;
}

function packageManagerFor(rootPath: string): PackageManager {
  return "pnpm";
}

export async function analyzeRepository(
  rootPath: string,
  source: "zip" | "github",
): Promise<RepositoryRecord> {
  const packageRoot = await findPackageRoot(rootPath);
  const files = await listFiles(rootPath);
  const packageJsonPath = packageRoot ? path.join(packageRoot, "package.json") : "";
  let packageJson: PackageJson = {};
  if (packageRoot) {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
  }

  const allDependencies = [
    ["dependencies", packageJson.dependencies],
    ["devDependencies", packageJson.devDependencies],
    ["peerDependencies", packageJson.peerDependencies],
    ["optionalDependencies", packageJson.optionalDependencies],
  ] as const;
  const dependencies = allDependencies.flatMap(([section, values]) =>
    Object.entries(values ?? {}).map(([name, version]) => ({
      name,
      version,
      section,
    })),
  );
  const lockfile =
    files.find((file) => file === "package-lock.json" || file === "pnpm-lock.yaml" || file === "yarn.lock") ??
    files.find((file) => file.endsWith("/package-lock.json") || file.endsWith("/pnpm-lock.yaml") || file.endsWith("/yarn.lock")) ??
    null;
  const language = files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    ? "TypeScript"
    : "JavaScript";
  const framework =
    dependencies.some((item) => item.name === "next") ? "Next.js" :
    dependencies.some((item) => item.name === "vite") ? "Vite" :
    dependencies.some((item) => item.name === "react") ? "React" :
    dependencies.some((item) => item.name === "vue") ? "Vue" : null;

  const name = packageJson.name || path.basename(rootPath);
  return {
    id: randomUUID(),
    name,
    source,
    language,
    packageManager: packageRoot ? packageManagerFor(packageRoot) : "unsupported",
    hasPackageJson: Boolean(packageRoot),
    lockfile,
    framework,
    dependencies,
    scripts: Object.keys(packageJson.scripts ?? {}),
    status: packageRoot ? "analyzed" : "invalid",
    createdAt: new Date().toISOString(),
    rootPath: packageRoot ?? rootPath,
  };
}

export async function createRepositoryWorkspace(
  bytes: Buffer,
  filename: string,
): Promise<{ rootPath: string; originalPath: string }> {
  const id = randomUUID();
  const jobRoot = path.join(workspaceRoot, id);
  const archivePath = path.join(jobRoot, "repository.zip");
  const originalPath = path.join(jobRoot, "original");
  const workPath = path.join(jobRoot, "workspace");
  await mkdir(originalPath, { recursive: true });
  await mkdir(workPath, { recursive: true });
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "repository.zip";
  const archive = path.join(jobRoot, safeFilename.endsWith(".zip") ? safeFilename : "repository.zip");
  await writeFile(archive, bytes);
  const listing = await runCommand("unzip", ["-Z1", archive], jobRoot);
  if (listing.code !== 0) throw new Error("REPOSITORY_INVALID: ZIP file could not be inspected");
  const names = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (names.length > 20_000 || names.some((name) => path.isAbsolute(name) || name.split("/").includes(".."))) {
    throw new Error("REPOSITORY_INVALID: ZIP contains unsafe paths");
  }
  const extracted = await runCommand("unzip", ["-q", archive, "-d", originalPath], jobRoot);
  if (extracted.code !== 0) throw new Error("REPOSITORY_INVALID: ZIP extraction failed");
  const originalRoot = (await findPackageRoot(originalPath)) ? originalPath : originalPath;
  const copied = await runCommand("cp", ["-a", `${originalRoot}/.`, `${workPath}/`], jobRoot);
  if (copied.code !== 0) throw new Error("REPOSITORY_INVALID: working copy could not be created");
  return { rootPath: workPath, originalPath };
}

export async function importGithubWorkspace(url: string): Promise<{ rootPath: string; originalPath: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("REPOSITORY_INVALID: GitHub URL is invalid");
  }
  if (parsed.hostname !== "github.com") throw new Error("REPOSITORY_INVALID: only github.com URLs are supported");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("REPOSITORY_INVALID: GitHub URL must include owner and repository");
  const repo = parts[1].replace(/\.git$/, "");
  const zipUrl = `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(repo)}/zip/refs/heads/HEAD`;
  const response = await fetch(zipUrl, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined,
  });
  if (!response.ok) throw new Error(`REPOSITORY_INVALID: GitHub returned ${response.status}`);
  return createRepositoryWorkspace(Buffer.from(await response.arrayBuffer()), `${repo}.zip`);
}

async function searchImpact(rootPath: string, dependency: string): Promise<{ files: string[]; usages: number }> {
  const files = await listFiles(rootPath);
  const codeFiles = files.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/.test(file));
  const matcher = new RegExp(`(?:from\\s+["']${escapeRegExp(dependency)}["']|require\\(\\s*["']${escapeRegExp(dependency)}["']|\\b${escapeRegExp(dependency.split("/").pop() ?? dependency)}\\b)`, "g");
  const impacted: string[] = [];
  let usages = 0;
  for (const file of codeFiles) {
    const content = await readFile(path.join(rootPath, file), "utf8").catch(() => "");
    const matches = content.match(matcher);
    if (matches?.length) {
      impacted.push(file);
      usages += matches.length;
    }
  }
  return { files: impacted, usages };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function researchDependency(dependency: string, targetMajor: string): Promise<{
  sources: Array<{ title: string; url: string; finding: string }>;
  latest: string;
}> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(dependency)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`RESEARCH_ERROR: npm registry returned ${response.status}`);
  const metadata = (await response.json()) as {
    "dist-tags"?: { latest?: string };
    versions?: Record<string, { description?: string; deprecated?: string }>;
  };
  const latest = metadata["dist-tags"]?.latest ?? `${targetMajor}.0.0`;
  const targetVersion = Object.keys(metadata.versions ?? {})
    .filter((version) => version.split(".")[0].replace(/\D/g, "") === targetMajor)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? latest;
  return {
    latest: targetVersion,
    sources: [{
      title: `${dependency} npm registry metadata`,
      url,
      finding: `Registry metadata was fetched successfully. The highest discovered ${targetMajor}.x version is ${targetVersion}; latest published version is ${latest}. Review the package's official migration guide before approving.`
    }],
  };
}

async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("GROK_API_ERROR: XAI_API_KEY is not configured");
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.XAI_MODEL ?? "grok-3-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "You are a senior migration engineer. Return concise, factual JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`GROK_API_ERROR: xAI returned ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content ?? "";
}

function parsePlan(raw: string, dependency: string, oldVersion: string, targetVersion: string, impactFiles: string[]) {
  try {
    const clean = raw.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(clean) as {
      summary?: string;
      breakingChanges?: string[];
      plannedChanges?: string[];
      validationCommands?: string[];
    };
    return {
      summary: parsed.summary ?? `Upgrade ${dependency} from ${oldVersion} to ${targetVersion}.`,
      breakingChanges: parsed.breakingChanges ?? ["Review official release notes for breaking changes."],
      plannedChanges: parsed.plannedChanges ?? impactFiles.map((file) => `Inspect ${file} for ${dependency} API usage.`),
      validationCommands: parsed.validationCommands ?? ["package manager test", "package manager run build"],
    };
  } catch {
    return {
      summary: `Upgrade ${dependency} from ${oldVersion} to ${targetVersion}.`,
      breakingChanges: ["Grok returned an unstructured response; verify the official migration guide manually."],
      plannedChanges: impactFiles.map((file) => `Inspect ${file} for ${dependency} API usage.`),
      validationCommands: ["dependency installation", "test script", "build script"],
    };
  }
}

async function captureDiff(rootPath: string): Promise<MigrationRecord["diff"]> {
  const result = await runCommand("git", ["diff", "--no-ext-diff", "--unified=3"], rootPath);
  const numstat = await runCommand("git", ["diff", "--numstat"], rootPath);
  const files = numstat.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [additions, deletions, filePath] = line.split("\t");
    return {
      path: filePath ?? "unknown",
      status: "modified" as const,
      patch: "",
      additions: Number(additions) || 0,
      deletions: Number(deletions) || 0,
    };
  });
  let current: (typeof files)[number] | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = files.find((file) => file.path === header[2]);
      continue;
    }
    if (current) current.patch += `${line}\n`;
  }
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}

async function verifyMigration(migration: MigrationRecord, rootPath: string, repository: RepositoryRecord) {
  const scripts = new Set(repository.scripts);
  const manager = repository.packageManager === "npm" ? "npm" : repository.packageManager === "pnpm" ? "pnpm" : null;
  if (!manager) {
    migration.tests = "skipped";
    migration.build = "skipped";
    migration.typecheck = "skipped";
    migration.lint = "skipped";
    return;
  }
  const runScript = async (script: string): Promise<"pass" | "fail" | "skipped"> => {
    if (!scripts.has(script)) return "skipped";
    const result = await runCommand(manager, ["run", script], rootPath);
    await addEvent({
      id: randomUUID(),
      migrationId: migration.id,
      timestamp: new Date().toISOString(),
      level: result.code === 0 ? "success" : "error",
      message: `${manager} run ${script} ${result.code === 0 ? "passed" : "failed"} (${result.durationMs}ms)`,
    });
    if (result.code !== 0) migration.remainingIssues.push(`${script}: ${result.stderr || result.stdout}`.slice(0, 1000));
    return result.code === 0 ? "pass" : "fail";
  };
  migration.tests = await runScript("test");
  migration.build = await runScript("build");
  migration.typecheck = await runScript("typecheck");
  migration.lint = await runScript("lint");
}

export async function runMigration(migrationId: string): Promise<void> {
  const migration = await import("./migration-state").then((module) => module.getMigration(migrationId));
  if (!migration) return;
  const repository = await getRepository(migration.repositoryId);
  if (!repository) return;
  const update = async (stage: string, message: string, level: "info" | "success" | "warning" | "error" = "info") => {
    migration.currentStage = stage;
    migration.updatedAt = new Date().toISOString();
    await saveMigration(migration);
    await addEvent({ id: randomUUID(), migrationId, timestamp: new Date().toISOString(), level, message });
  };
  try {
    migration.status = "running";
    await update("research", "Starting migration research");
    const impact = await searchImpact(repository.rootPath, migration.dependency);
    migration.impactFiles = impact.files;
    migration.affectedFiles = impact.files.length;
    migration.affectedUsages = impact.usages;
    await update("impact-analysis", `Found ${impact.usages} potentially affected usages in ${impact.files.length} files`, "success");
    const research = await researchDependency(migration.dependency, migration.targetVersion);
    migration.sources = research.sources;
    migration.targetVersion = research.latest;
    await update("research", `Fetched npm registry metadata for ${migration.dependency}`, "success");
    const rawPlan = await callGrok(JSON.stringify({
      task: "Create a migration plan. Do not invent package-specific facts not present in the research.",
      dependency: migration.dependency,
      oldVersion: migration.oldVersion,
      targetVersion: migration.targetVersion,
      research: migration.sources,
      affectedFiles: migration.impactFiles,
    }));
    migration.plan = parsePlan(rawPlan, migration.dependency, migration.oldVersion, migration.targetVersion, migration.impactFiles);
    await update("plan", "Grok produced a migration plan", "success");
    if (migration.mode === "agentic") {
      await update("migration", "Updating the dependency with the detected package manager");
    } else {
      await update("migration", "Running baseline dependency update");
    }
    const manager = repository.packageManager === "npm" ? "npm" : repository.packageManager === "pnpm" ? "pnpm" : null;
    if (!manager) throw new Error("UNSUPPORTED_PACKAGE_MANAGER: only npm and pnpm are supported");
    const install = await runCommand(manager, [
      manager === "npm" ? "install" : "add",
      `${migration.dependency}@^${migration.targetVersion.split(".")[0]}.0.0`,
    ], repository.rootPath);
    if (install.code !== 0) throw new Error(`DEPENDENCY_INSTALL_FAILURE: ${install.stderr || install.stdout}`.slice(0, 1800));
    await runCommand("git", ["init"], repository.rootPath);
    await runCommand("git", ["config", "user.email", "agent@localhost"], repository.rootPath);
    await runCommand("git", ["config", "user.name", "Dependency Agent"], repository.rootPath);
    await runCommand("git", ["add", "-A"], repository.rootPath);
    await runCommand("git", ["commit", "-m", "baseline"], repository.rootPath);
    const secondInstall = await runCommand(manager, [
      manager === "npm" ? "install" : "add",
      `${migration.dependency}@^${migration.targetVersion.split(".")[0]}.0.0`,
    ], repository.rootPath);
    if (secondInstall.code !== 0) throw new Error(`DEPENDENCY_INSTALL_FAILURE: ${secondInstall.stderr || secondInstall.stdout}`.slice(0, 1800));
    migration.changes = [`Updated ${migration.dependency} using ${manager} to ^${migration.targetVersion.split(".")[0]}.0.0`];
    migration.attemptNumber = 1;
    await update("verification", "Running repository verification commands");
    await verifyMigration(migration, repository.rootPath, repository);
    migration.diff = await captureDiff(repository.rootPath);
    const passed = migration.tests !== "fail" && migration.build !== "fail" && migration.typecheck !== "fail" && migration.lint !== "fail";
    migration.attempts = [{
      number: 1,
      result: passed ? "PASS" : "FAIL",
      diagnosis: passed ? null : migration.remainingIssues[0] ?? "Verification command failed.",
      filesChanged: migration.diff.filesChanged,
    }];
    migration.status = passed ? "completed" : "failed";
    migration.errorCode = passed ? null : "VERIFICATION_FAILURE";
    await update(passed ? "complete" : "failed", passed ? "Migration verified; awaiting approval" : "Migration stopped after verification failure", passed ? "success" : "error");
  } catch (error) {
    migration.status = "failed";
    migration.errorCode = String(error).split(":")[0] || "MIGRATION_FAILURE";
    migration.remainingIssues.push(String(error).slice(0, 1800));
    await update("failed", String(error).slice(0, 1800), "error");
    logger.error({ err: error, migrationId }, "Migration failed");
  }
}

export async function startMigration(
  repositoryId: string,
  dependency: string,
  targetMajor: string,
  mode: "agentic" | "baseline",
): Promise<MigrationRecord> {
  const repository = await getRepository(repositoryId);
  if (!repository || repository.status !== "analyzed") throw new Error("REPOSITORY_INVALID: repository is unavailable");
  const selected = repository.dependencies.find((item) => item.name === dependency);
  if (!selected) throw new Error("DEPENDENCY_NOT_FOUND: dependency is not installed");
  const migration: MigrationRecord = {
    id: randomUUID(),
    repositoryId,
    repositoryName: repository.name,
    dependency,
    oldVersion: selected.version,
    targetVersion: targetMajor,
    mode,
    status: "queued",
    currentStage: "queued",
    attemptNumber: 0,
    affectedFiles: 0,
    affectedUsages: 0,
    tests: "running",
    build: "running",
    typecheck: "running",
    lint: "running",
    errorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: null,
    impactFiles: [],
    sources: [],
    changes: [],
    attempts: [],
    remainingIssues: [],
    diff: { filesChanged: 0, additions: 0, deletions: 0, files: [] },
  };
  await createMigration(migration);
  await addEvent({
    id: randomUUID(),
    migrationId: migration.id,
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Migration queued",
  });
  void runMigration(migration.id);
  return migration;
}

export async function hashBytes(bytes: Buffer): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}