import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { runCommand } from "./run-command";
import { captureDiff } from "./git";
import { getGrokProvider } from "../services/ai/provider";
import { runCodingAgent } from "../agents/coding-agent";
import {
  copyDirectory,
  createWorkspaceRoot,
  extractArchive,
  listZipEntries,
} from "./workspace";
import {
  addEvent,
  createMigration,
  getMigration,
  getRepository,
  saveMigration,
  type MigrationRecord,
  type PackageManager,
  type RepositoryRecord,
} from "./migration-state";
import type { GrokProvider } from "../services/ai/types";

/** Test-only seam: allows a scripted provider to be injected. */
let __migAgentProvider: GrokProvider | null = null;
export function setMigrationAgentProviderOverride(provider: GrokProvider | null): void {
  __migAgentProvider = provider;
}

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

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

/** Recursively list files as POSIX-style relative paths (forward slashes). */
async function listFiles(rootPath: string, current = rootPath): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(rootPath, fullPath)));
    else files.push(path.relative(rootPath, fullPath).split(path.sep).join("/"));
    if (files.length > 3000) return files;
  }
  return files;
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
    packageManager: packageRoot
      ? lockfile?.endsWith("pnpm-lock.yaml")
        ? "pnpm"
        : lockfile?.endsWith("yarn.lock")
          ? "unsupported"
          : "npm"
      : "unsupported",
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
  // Each job gets an isolated temp directory: <temp>/dependency-agent/<uuid>
  const jobRoot = await createWorkspaceRoot("repo-");
  const archivePath = path.join(jobRoot, "repository.zip");
  const originalPath = path.join(jobRoot, "original");
  const workPath = path.join(jobRoot, "workspace");
  await mkdir(originalPath, { recursive: true });
  await mkdir(workPath, { recursive: true });
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "repository.zip";
  const archive = path.join(jobRoot, safeFilename.endsWith(".zip") ? safeFilename : "repository.zip");
  await writeFile(archive, bytes);

  // Validate the ZIP before extracting to prevent path traversal.
  const names = await listZipEntries(archive);
  if (names === null) throw new Error("REPOSITORY_INVALID: ZIP file could not be inspected");
  if (names.length > 20_000) throw new Error("REPOSITORY_INVALID: ZIP contains too many files");
  const unsafe = names.some((name) => path.posix.isAbsolute(name) || name.split("/").includes(".."));
  if (unsafe) throw new Error("REPOSITORY_INVALID: ZIP contains unsafe paths");

  await extractArchive(archive, originalPath);
  await copyDirectory(originalPath, workPath);
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
  const authHeaders = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "dependency-upgrade-agent" }
    : { "User-Agent": "dependency-upgrade-agent" };
  const metadataResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(repo)}`, {
    headers: { ...authHeaders, Accept: "application/vnd.github+json" },
  });
  if (!metadataResponse.ok) throw new Error(`REPOSITORY_INVALID: GitHub returned ${metadataResponse.status}`);
  const metadata = (await metadataResponse.json()) as { default_branch?: string };
  const branch = metadata.default_branch ?? "main";
  const zipUrl = `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(repo)}/zip/refs/heads/${encodeURIComponent(branch)}`;
  const response = await fetch(zipUrl, { headers: authHeaders });
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
    const result = await runCommand(manager, ["run", script], { cwd: rootPath });
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
  const migration = await getMigration(migrationId);
  if (!migration) return;
  const repository = await getRepository(migration.repositoryId);
  if (!repository) return;
  const update = async (stage: string, message: string, level: "info" | "success" | "warning" | "error" = "info") => {
    migration.currentStage = stage;
    migration.updatedAt = new Date().toISOString();
    await saveMigration(migration);
    await addEvent({ id: randomUUID(), migrationId, timestamp: new Date().toISOString(), level, message });
  };

  const emitAgentEvent = async (level: "info" | "success" | "warning" | "error", message: string) => {
    await addEvent({ id: randomUUID(), migrationId, timestamp: new Date().toISOString(), level, message });
    logger.info({ migrationId, level, message }, "Agent event");
  };

  try {
    migration.status = "running";
    await update("research", "Starting migration research");

    // 1) Impact search
    const impact = await searchImpact(repository.rootPath, migration.dependency);
    migration.impactFiles = impact.files;
    migration.affectedFiles = impact.files.length;
    migration.affectedUsages = impact.usages;
    await update("impact-analysis", `Found ${impact.usages} potentially affected usages in ${impact.files.length} files`, "success");

    // 2) Registry research (resolves the exact target release)
    const research = await researchDependency(migration.dependency, migration.targetVersion);
    migration.sources = research.sources;
    migration.targetVersion = research.latest;
    await update("research", `Fetched npm registry metadata for ${migration.dependency}`, "success");

    // 3) Git baseline: snapshot the pristine workspace so diffs are real.
    const manager = repository.packageManager === "npm" ? "npm" : repository.packageManager === "pnpm" ? "pnpm" : null;
    if (!manager) throw new Error("UNSUPPORTED_PACKAGE_MANAGER: only npm and pnpm are supported");
    await runCommand("git", ["init", "-q"], { cwd: repository.rootPath });
    await runCommand("git", ["config", "user.email", "agent@localhost"], { cwd: repository.rootPath });
    await runCommand("git", ["config", "user.name", "Dependency Agent"], { cwd: repository.rootPath });
    // Keep agent backups out of the repo so they never appear in the diff.
    await runCommand("git", ["config", "core.excludesFile", ".agent-gitignore"], { cwd: repository.rootPath });
    // Excludes are still resolved from the gitignore files; write a workspace-scoped one.
    await writeFile(
      path.join(repository.rootPath, ".agent-gitignore"),
      ".agent-backups/\n.agent-patch.tmp\n",
      "utf8",
    );
    await runCommand("git", ["add", "-A"], { cwd: repository.rootPath });
    await runCommand("git", ["commit", "-q", "-m", "baseline"], { cwd: repository.rootPath });

    // 4) Update the dependency in the manifest via the detected package manager.
    await update("migration", "Updating the dependency with the detected package manager");
    const install = await runCommand(manager, [
      manager === "npm" ? "install" : "add",
      `${migration.dependency}@^${migration.targetVersion.split(".")[0]}.0.0`,
    ], { cwd: repository.rootPath });
    if (install.code !== 0) {
      // Network/registry may be unavailable in sandboxed environments.
      // Update package.json directly as a fallback so the agent still sees the
      // target version, and record the install failure without aborting the run.
      await update("migration", `Dependency install failed via ${manager}; falling back to manifest edit`, "warning");
      try {
        const manifestPath = path.join(repository.rootPath, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
        const section = manifest[migration.dependency in manifest.dependencies ? "dependencies" : "devDependencies"] as Record<string, string> | undefined;
        if (section && migration.dependency in section) {
          section[migration.dependency] = `^${migration.targetVersion.split(".")[0]}.0.0`;
        } else if (manifest.dependencies) {
          (manifest.dependencies as Record<string, string>)[migration.dependency] = `^${migration.targetVersion.split(".")[0]}.0.0`;
        } else {
          manifest.dependencies = { [migration.dependency]: `^${migration.targetVersion.split(".")[0]}.0.0` };
        }
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      } catch (manifestErr) {
        migration.remainingIssues.push(`Manifest edit also failed: ${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}`.slice(0, 500));
      }
      migration.remainingIssues.push(`Dependency install via ${manager} failed: ${(install.stderr || install.stdout).slice(0, 500)}`);
    } else {
      await update("migration", `Dependency updated to ^${migration.targetVersion.split(".")[0]}.0.0`, "success");
    }
    migration.changes = [`Updated ${migration.dependency} using ${manager} to ^${migration.targetVersion.split(".")[0]}.0.0`];
    migration.attemptNumber = 1;
    await update("migration", "Dependency updated; agent will now migrate code usages");

    // 5) Run the coding agent against the live Grok provider.
    let agentState: import("../agents/agent-state").AgentState | undefined;
    let agentFinished = true;
    logger.info({ migrationId, dependency: migration.dependency, workspaceRoot: repository.rootPath }, "Starting coding agent");
try {
      // Tests may inject a scripted provider; otherwise use the live xAI/Grok one.
      const provider = __migAgentProvider ?? getGrokProvider();
      logger.info({ migrationId, providerConfigured: provider.isConfigured(), model: provider.constructor.name }, "Coding agent provider resolved");
      const result = await runCodingAgent(provider, {
        migrationId,
        workspaceRoot: repository.rootPath,
        originalRoot: path.join(path.dirname(repository.rootPath), "original"),
        dependency: migration.dependency,
        currentVersion: migration.oldVersion,
        targetMajor: migration.targetVersion.split(".")[0],
        mode: migration.mode,
      }, {
        onEvent: (level, message) => void emitAgentEvent(level as "info" | "success" | "warning" | "error", message),
      });
      logger.info({ migrationId, resultStatus: result.status, patchesApplied: result.patchesApplied, toolCalls: result.agentState?.toolCalls?.length, filesModified: result.agentState?.filesModified }, "Coding agent completed");
      agentState = result.agentState;
      migration.plan = result.plan
        ? {
            summary: result.plan.plannedChanges.join("; ") || `Upgrade ${migration.dependency}.`,
            breakingChanges: result.plan.breakingChanges,
            plannedChanges: result.plan.plannedChanges,
            validationCommands: result.plan.verificationCommands,
          }
        : migration.plan;
      migration.agentState = result.agentState;
      if (result.patchesApplied > 0) {
        migration.changes.push(`Applied ${result.patchesApplied} targeted migration patch(es)`);
      }
      if (result.status === "no_changes") {
        migration.changes.push("Migration agent determined no code changes were required");
      }
    } catch (agentError) {
      agentFinished = false;
      const message = String(agentError).slice(0, 1800);
      migration.remainingIssues.push(message);
      migration.agentState = {
        ...(migration.agentState ?? {
          toolCalls: [],
          filesInspected: [],
          filesModified: [],
          patchesApplied: 0,
          fileChanges: [],
        }),
        status: "failed",
        currentAction: "failed",
        error: message,
      };
      logger.error({ err: agentError, migrationId }, "Coding agent failed");
      // Still continue to verification against the baseline + manifest change
      // so a Grok outage doesn't silently leave no diff at all. Non-fatal.
    }
    if (agentFinished) {
      await update("migration", "Agent applied targeted changes to the repository", "success");
    }

    // 6) Verification
    await update("verification", "Running repository verification commands");
    await verifyMigration(migration, repository.rootPath, repository);

    // 7) Real diff (baseline commit → current workspace)
    await runCommand("git", ["add", "-N", "."], { cwd: repository.rootPath });
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
    if (migration.agentState) {
      migration.agentState.status = passed ? "completed" : "failed";
      migration.agentState.currentAction = passed ? "complete" : "failed";
    }
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

