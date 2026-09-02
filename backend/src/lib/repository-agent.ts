import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { runCommand } from "./run-command";
import { captureDiff } from "./git";
import { getGrokProvider } from "../services/ai/provider";
import { runCodingAgent } from "../agents/coding-agent";
import { extractZipToWorkspace } from "./zip";
import {
  addEvent,
  createMigration,
  getMigration,
  getRepository,
  saveMigration,
  type AiStageRecord,
  type MigrationRecord,
  type PackageManager,
  type RepositoryRecord,
} from "./migration-state";
import type { GrokProvider } from "../services/ai/types";
import { researchDependency as fetchResearch, ResearchError } from "./research";
import { scanRepositoryUsage } from "./impact";
import { applyRiskToFindings } from "./risk";
import { synthesizeFindings, fallbackFindingsFromSources } from "./synthesis";
import { diagnoseFailure, HealError } from "./heal";
import { buildFallbackPlan } from "./plan";
import {
  validateDependency,
  validateTargetVersion,
  validatePackageManager,
  DependencyValidationError,
} from "./dependency-validation";
import {
  verifyInstalledVersion,
  snapshotLockfiles,
  validateLockfileUpdated,
} from "./install-verification";

/** Test-only seam: allows a scripted provider to be injected. */
let __migAgentProvider: GrokProvider | null = null;
export function setMigrationAgentProviderOverride(provider: GrokProvider | null): void {
  __migAgentProvider = provider;
}

/** Distinguish the injected test seam from the real xAI provider for metadata. */
function providerKind(provider: GrokProvider | null): string {
  if (!provider) return "none";
  return provider === __migAgentProvider ? "scripted" : "grok";
}

/**
 * Resolve the Grok provider for the coding/repair agent WITHOUT throwing when
 * unconfigured. Returns the injected scripted provider (tests), the live provider
 * when XAI_API_KEY is set, else null.
 */
function getGrokProviderOrNull(): GrokProvider | null {
  if (__migAgentProvider) return __migAgentProvider;
  if (process.env.XAI_API_KEY) return getGrokProvider();
  return null;
}

/**
 * Resolve ONLY the live Grok provider (ignoring the test seam). Used for research
 * synthesis so a scripted test provider drives only the coding agent deterministically.
 */
function getLiveGrokProviderOrNull(): GrokProvider | null {
  if (process.env.XAI_API_KEY) return getGrokProvider();
  return null;
}

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/**
 * Find the repository root: the directory containing the project's manifest
 * (`package.json`). Handles both a flat archive (`package.json` at the root) and
 * a nested wrapper (`my-project/package.json`). Searches a bounded depth and
 * scores candidates so a monorepo root is picked over an unrelated nested
 * package (the candidate carrying the most dependency entries wins).
 *
 * We deliberately DO NOT assume the first directory is the root.
 */
const MANIFEST_ROOT_MAX_DEPTH = 3;

async function findPackageRoot(rootPath: string): Promise<string | null> {
  interface Candidate { dir: string; depth: number; depCount: number }
  const candidates: Candidate[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MANIFEST_ROOT_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // package.json present here?
    const manifest = path.join(dir, "package.json");
    try {
      const raw = await readFile(manifest, "utf8");
      let depCount = 0;
      try {
        const parsed = JSON.parse(raw) as { dependencies?: unknown; devDependencies?: unknown };
        depCount =
          (typeof parsed.dependencies === "object" && parsed.dependencies ? Object.keys(parsed.dependencies).length : 0) +
          (typeof parsed.devDependencies === "object" && parsed.devDependencies ? Object.keys(parsed.devDependencies).length : 0);
      } catch {
        depCount = 0;
      }
      candidates.push({ dir, depth, depCount });
    } catch {
      // no manifest at this level
    }
    // Recurse into directories (skip hidden/node_modules) to a bounded depth.
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(rootPath, 0);
  if (candidates.length === 0) return null;

  // Prefer the shallowest directory with the most dependency entries
  // (ties broken by depth). This prefers a real project root over an empty
  // boilerplate nested package.
  candidates.sort((a, b) => b.depCount - a.depCount || a.depth - b.depth || a.dir.localeCompare(b.dir));
  return candidates[0].dir;
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
  // The secure ZIP path validates (size, entries, uncompressed sizes, traversal)
  // BEFORE extraction and removes the partial job root on any failure.
  const job = await extractZipToWorkspace(bytes, filename);
  return { rootPath: job.rootPath, originalPath: job.originalPath };
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

/**
 * Run the repository verification pipeline (test/build/typecheck/lint) against real
 * scripts. Only scripts actually present in the repository are executed; missing ones
 * are SKIPPED. Records a rich per-command record and marks TIMEOUT when the process is
 * killed. Returns the failed commands so the self-healing loop can act on them.
 */
async function verifyMigration(
  migration: MigrationRecord,
  rootPath: string,
  repository: RepositoryRecord,
): Promise<Array<{ command: string; exitCode: number; stdout: string; stderr: string }>> {
  const manager = repository.packageManager === "npm" ? "npm" : repository.packageManager === "pnpm" ? "pnpm" : null;
  const failed: Array<{ command: string; exitCode: number; stdout: string; stderr: string }> = [];
  if (!manager) {
    migration.tests = "skipped";
    migration.build = "skipped";
    migration.typecheck = "skipped";
    migration.lint = "skipped";
    addEvent({ id: randomUUID(), migrationId: migration.id, timestamp: new Date().toISOString(), level: "warning", message: "Verification skipped — unsupported package manager" }).catch(() => undefined);
    return failed;
  }
  migration.verificationCommands = migration.verificationCommands ?? [];

  const runScript = async (script: string): Promise<"pass" | "fail" | "skipped" | "timeout"> => {
    if (!repository.scripts.includes(script)) {
      migration.verificationCommands!.push({
        command: `${manager} run ${script}`,
        status: "SKIPPED",
        exitCode: null,
        stdout: "",
        stderr: "SKIPPED — no script found",
        durationMs: 0,
      });
      await addEvent({
        id: randomUUID(),
        migrationId: migration.id,
        timestamp: new Date().toISOString(),
        level: "warning",
        message: `${script}: SKIPPED — no ${script} script found`,
      }).catch(() => undefined);
      return "skipped";
    }
    const scriptStart = Date.now();
    logger.info({ migrationId: migration.id, manager, script, cwd: rootPath }, `[VERIFY] Running ${manager} run ${script}`);
    const result = await runCommand(manager, ["run", script], { cwd: rootPath });
    const scriptDuration = Date.now() - scriptStart;
    const isTimeout = result.code === 124;
    const status = result.code === 0 ? "PASS" : isTimeout ? "TIMEOUT" : "FAIL";
    migration.verificationCommands!.push({
      command: `${manager} run ${script}`,
      status,
      exitCode: result.code,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      durationMs: result.durationMs || scriptDuration,
    });
    logger.info(
      { migrationId: migration.id, script, code: result.code, status, durationMs: result.durationMs || scriptDuration, stderr: result.stderr.slice(0, 500) },
      `[VERIFY] ${manager} run ${script} → ${status}`,
    );
    await addEvent({
      id: randomUUID(),
      migrationId: migration.id,
      timestamp: new Date().toISOString(),
      level: result.code === 0 ? "success" : "error",
      message: `${manager} run ${script} ${result.code === 0 ? "passed" : isTimeout ? "timed out" : "failed"} (${result.durationMs}ms)`,
    }).catch(() => undefined);
    if (result.code !== 0) {
      const issue = `${script}: ${(result.stderr || result.stdout).slice(0, 1000)}`;
      if (!migration.remainingIssues.includes(issue)) migration.remainingIssues.push(issue);
      failed.push({ command: `${manager} run ${script}`, exitCode: result.code, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) });
    }
    return result.code === 0 ? "pass" : isTimeout ? "timeout" : "fail";
  };

  const norm = (s: "pass" | "fail" | "skipped" | "timeout"): "pass" | "fail" | "skipped" => (s === "timeout" ? "fail" : s);
  migration.tests = norm(await runScript("test"));
  migration.build = norm(await runScript("build"));
  migration.typecheck = norm(await runScript("typecheck"));
  migration.lint = norm(await runScript("lint"));
  return failed;
}

/** True when the verification result is a pass (no FAIL, TIMEOUT treated as fail). */
function verificationPassed(migration: MigrationRecord): boolean {
  return migration.tests !== "fail" && migration.build !== "fail" && migration.typecheck !== "fail" && migration.lint !== "fail";
}

/**
 * Map a failed verification command to the precise failure code the spec wants
 * (TEST_FAILURE / BUILD_FAILURE / TYPECHECK_FAILURE / TIMEOUT), falling back to
 * the generic VERIFICATION_FAILURE. Derived from the real command + exit code.
 */
function failureTypeOf(
  failed: Array<{ command: string; exitCode: number }>,
): "TEST_FAILURE" | "BUILD_FAILURE" | "TYPECHECK_FAILURE" | "LINT_FAILURE" | "TIMEOUT" | "VERIFICATION_FAILURE" {
  if (failed.length === 0) return "VERIFICATION_FAILURE";
  const first = failed[0];
  if (first.exitCode === 124) return "TIMEOUT";
  if (first.command.endsWith("test")) return "TEST_FAILURE";
  if (first.command.endsWith("build")) return "BUILD_FAILURE";
  if (first.command.endsWith("typecheck")) return "TYPECHECK_FAILURE";
  if (first.command.endsWith("lint")) return "LINT_FAILURE";
  return "VERIFICATION_FAILURE";
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

  /**
   * Phase 3 — persist a non-sensitive record of every real AI request. Never
   * stores the API key or chain-of-thought, only stage/provider/model/status.
   */
  const recordAiStage = async (
    stage: AiStageRecord["stage"],
    provider: GrokProvider | null,
    requestStatus: AiStageRecord["requestStatus"],
    extra: { durationMs?: number; attempt?: number; error?: string } = {},
  ) => {
    migration.aiStages = migration.aiStages ?? [];
    migration.aiStages.push({
      stage,
      provider: providerKind(provider),
      model: provider?.model ?? "unknown",
      requestStatus,
      success: requestStatus === "success",
      timestamp: new Date().toISOString(),
      durationMs: extra.durationMs,
      attempt: extra.attempt,
      error: extra.error ? String(extra.error).slice(0, 200) : undefined,
    });
    if (migration.aiStages.length > 200) migration.aiStages = migration.aiStages.slice(-200);
    migration.updatedAt = new Date().toISOString();
    await saveMigration(migration);
  };

  try {
    migration.status = "running";
    logger.info({ migrationId, cwd: repository.rootPath }, "[MIGRATION] Starting migration");
    await update("research", "Starting migration research");

    // ---- Phase 2: REAL migration research (documentation retrieval + synthesis) ----
    await update("research", "Starting migration research");
    await addEvent({ id: randomUUID(), migrationId, timestamp: new Date().toISOString(), level: "info", message: "Searching official documentation" });

    let research: import("./research-types").MigrationResearch;
    const currentMajor = (migration.oldVersion.match(/\d+/) ?? ["0"])[0];
    const targetMajor = migration.targetVersion.split(".")[0];
    try {
      research = await fetchResearch(migration.dependency, currentMajor, targetMajor);
      migration.targetVersion = research.sources.find((s) => s.status === "retrieved" && s.source_type === "npm_metadata")
        ? (research.targetVersion || migration.targetVersion)
        : migration.targetVersion;
    } catch (error) {
      // Preserve the original queued/npm-sourced targetVersion as a best-effort
      // value, but surface that reliable research could not be established.
      research = {
        dependency: migration.dependency,
        currentVersion: migration.oldVersion,
        targetVersion: migration.targetVersion,
        sources: [],
        breakingChanges: [],
        removedApis: [], renamedApis: [], changedApis: [], configurationChanges: [],
        importChanges: [], compatibilityRequirements: [], upgradeNotes: [],
        findings: [], confidence: "none",
      };
      migration.remainingIssues.push(
        `RESEARCH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    migration.research = research;
    migration.sources = research.sources.map((s) => ({ title: s.title, url: s.url, finding: s.key_findings.join("; ") || s.excerpt.slice(0, 200) }));

    const retrievedCount = research.sources.filter((s) => s.status === "retrieved").length;
    const unavailableCount = research.sources.filter((s) => s.status === "unavailable").length;
    await update("research", `Fetched ${retrievedCount} documentation source(s)${unavailableCount ? ` (${unavailableCount} unavailable)` : ""}`, retrievedCount > 0 ? "success" : "warning");

    // Grok research synthesis (uses only retrieved sources).
    const retrieved = research.sources.filter((s) => s.status === "retrieved").map((s) => ({
      title: s.title, url: s.url, source_type: s.source_type, excerpt: s.excerpt,
    }));
    let synthesized: import("./research-types").MigrationFindings;
    try {
      const provider = getLiveGrokProviderOrNull();
      const synthesisStart = Date.now();
      synthesized = provider
        ? await synthesizeFindings(provider, {
            dependency: migration.dependency,
            currentVersion: migration.oldVersion,
            targetVersion: migration.targetVersion,
            researchContext: retrieved,
            repoContext: {
              language: repository.language,
              packageManager: repository.packageManager,
              packageJson: await readFile(path.join(repository.rootPath, "package.json"), "utf8").catch(() => "{}"),
              fileTree: (await listFiles(repository.rootPath)).slice(0, 200).join("\n"),
              affectedUsage: [],
            },
          })
        : fallbackFindingsFromSources(retrieved);
      await recordAiStage("research_synthesis", provider, "success", { durationMs: Date.now() - synthesisStart });
      await update("research", "Research synthesis completed", "success");
    } catch (error) {
      const provider = getLiveGrokProviderOrNull();
      await recordAiStage("research_synthesis", provider, "error", { error: String(error) });
      synthesized = fallbackFindingsFromSources(retrieved);
      migration.remainingIssues.push(`RESEARCH_SYNTHESIS_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      await update("research", "Research synthesis degraded to retrieved-source summary", "warning");
    }
    research.breakingChanges = synthesized.breakingChanges;
    research.removedApis = synthesized.removedApis;
    research.renamedApis = synthesized.renamedApis;
    research.changedApis = synthesized.changedApis;
    research.configurationChanges = synthesized.configurationChanges;
    research.importChanges = synthesized.importChanges;
    research.compatibilityRequirements = synthesized.compatibilityRequirements;
    research.upgradeNotes = synthesized.upgradeNotes;
    research.findings = synthesized.findings;
    if (synthesized.confidence === "high" || synthesized.confidence === "medium" || synthesized.confidence === "low") {
      research.confidence = synthesized.confidence;
    }
    migration.research = research;
    if (research.confidence === "none") {
      const why = unavailableCount
        ? `${unavailableCount} of ${research.sources.length} source(s) could not be accessed`
        : "no documentation sources were retrieved";
      migration.remainingIssues.push("Migration research confidence: LOW. No reliable migration information was retrieved.");
      migration.research.explicitLowConfidenceReason =
        `Migration research confidence: LOW — ${why} for ${migration.dependency}.`;
      await update("research", `Migration research confidence: LOW — ${why}`, "warning");
      await addEvent({
        id: randomUUID(),
        migrationId,
        timestamp: new Date().toISOString(),
        level: "warning",
        message: `Migration research confidence: LOW. Reason: ${why}.`,
      });
    } else if (research.confidence === "low") {
      migration.remainingIssues.push("Migration research confidence: LOW — only one documentation source was retrieved.");
      await update("research", "Migration research confidence: LOW (single source)", "warning");
    }

    // ---- Phase 2: repository-aware impact analysis + research correlation ----
    await update("impact-analysis", "Starting impact analysis");
    await addEvent({ id: randomUUID(), migrationId, timestamp: new Date().toISOString(), level: "info", message: "Scanning repository for dependency usage" });

    const scan = await scanRepositoryUsage(repository.rootPath, migration.dependency);
    const riskResult = applyRiskToFindings({ findings: scan.codeFindings, research });
    migration.impactFiles = riskResult.summary.affectedApis.length > 0 ? [...new Set(scan.impactedFiles)] : scan.impactedFiles;
    migration.affectedFiles = riskResult.summary.affectedFiles;
    migration.affectedUsages = riskResult.summary.affectedUsages;
    migration.riskSummary = riskResult.summary;
    await update("impact-analysis", `Found ${riskResult.summary.affectedUsages} dependency usages across ${riskResult.summary.affectedFiles} files`, "success");
    await update("impact-analysis", `Impact classified: ${riskResult.summary.high} high, ${riskResult.summary.medium} medium, ${riskResult.summary.low} low risk`, "success");

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
      ".agent-backups/\n.agent-patch.tmp\nnode_modules/\ndist/\nbuild/\n",
      "utf8",
    );
    await runCommand("git", ["add", "-A"], { cwd: repository.rootPath });
    await runCommand("git", ["commit", "-q", "-m", "baseline"], { cwd: repository.rootPath });

    // 4) Dependency install: real package manager execution with verification.
    // Capture lockfile state before installation for verification.
    const lockfileBefore = await snapshotLockfiles(repository.rootPath, manager);

    await update("migration", "Updating the dependency with the detected package manager");
    const installStart = Date.now();
    const installTarget = migration.targetVersion;
    logger.info(
      {
        migrationId,
        manager,
        dependency: migration.dependency,
        target: installTarget,
        cwd: repository.rootPath,
      },
      "[MIGRATION] Running dependency install",
    );

    const install = await runCommand(
      manager,
      [manager === "npm" ? "install" : "add", `${migration.dependency}@${installTarget}`],
      { cwd: repository.rootPath },
    );

    const installDuration = Date.now() - installStart;
    logger.info(
      {
        migrationId,
        code: install.code,
        durationMs: installDuration,
        stderr: install.stderr.slice(0, 300),
        stdout: install.stdout.slice(0, 300),
      },
      "[MIGRATION] Dependency install completed",
    );

    if (install.code !== 0) {
      const errorMsg = `Package manager ${manager} install failed: ${(install.stderr || install.stdout).slice(0, 500)}`;
      migration.remainingIssues.push(errorMsg);
      await update(
        "migration",
        `Dependency install failed: ${errorMsg.slice(0, 200)}`,
        "error",
      );
      throw new DependencyValidationError(
        "DEPENDENCY_INSTALL_FAILURE",
        errorMsg,
      );
    }

    // Verify lockfile was actually updated
    const lockfileCheck = await validateLockfileUpdated(
      repository.rootPath,
      manager,
      lockfileBefore,
    );

    if (!lockfileCheck.changed) {
      const errorMsg = lockfileCheck.reason || "Lockfile was not updated after install";
      migration.remainingIssues.push(errorMsg);
      await update("migration", `Lockfile verification failed: ${errorMsg}`, "warning");
    }

    // Verify the installed version matches the target
    const versionCheck = await verifyInstalledVersion(
      repository.rootPath,
      migration.dependency,
      installTarget,
      manager,
    );

    logger.info(
      {
        migrationId,
        dependency: migration.dependency,
        requested: installTarget,
        installed: versionCheck.installed,
        matches: versionCheck.matches,
      },
      "[MIGRATION] Dependency version verification",
    );

    if (!versionCheck.matches) {
      const errorMsg = `Installed version does not match target: requested "${installTarget}", got "${versionCheck.installed}"`;
      migration.remainingIssues.push(errorMsg);
      await update("migration", errorMsg, "error");
      throw new DependencyValidationError(
        "DEPENDENCY_VERSION_MISMATCH",
        errorMsg,
      );
    }

    await update(
      "migration",
      `Dependency successfully updated to ${versionCheck.installed}`,
      "success",
    );
    migration.changes = [
      `Updated ${migration.dependency} from ${migration.oldVersion} to ${versionCheck.installed} using ${manager}`,
    ];
    migration.attemptNumber = 1;
    await update("migration", "Dependency updated; agent will now migrate code usages");

    // 5) Run the coding agent against the live Grok provider (agentic mode only).
    // Baseline mode deliberately skips AI source edits — research/impact (read-only),
    // install, and a single verification still run, but no agent patches are made.
    let agentState: import("../agents/agent-state").AgentState | undefined;
    let agentFinished = true;
    if (migration.mode === "baseline") {
      await addEvent({
        id: randomUUID(),
        migrationId,
        timestamp: new Date().toISOString(),
        level: "info",
        message: "Baseline mode: skipping agent code migration (no AI source edits)",
      });
    } else {
      logger.info({ migrationId, dependency: migration.dependency, workspaceRoot: repository.rootPath }, "[MIGRATION] Starting coding agent");
      let agentProviderUsed: GrokProvider | null = null;
      try {
        // Tests may inject a scripted provider; otherwise use the live xAI/Grok one.
        const provider = __migAgentProvider ?? getGrokProvider();
        agentProviderUsed = provider;
        logger.info({ migrationId, providerConfigured: provider.isConfigured(), model: provider.constructor.name }, "[MIGRATION] Agent provider resolved");
        logger.info(
          { migrationId, XAI_API_KEY_present: Boolean(process.env.XAI_API_KEY), XAI_API_KEY_length: process.env.XAI_API_KEY?.length ?? 0 },
          "[MIGRATION] Environment check before Grok call",
        );
        const agentStart = Date.now();
        const research = migration.research;
        const riskS = migration.riskSummary;
        const researchSummary = research
          ? [
              `- Confidence: ${research.confidence}`,
              research.breakingChanges.length ? `- Breaking changes: ${research.breakingChanges.join("; ")}` : null,
              research.removedApis.length ? `- Removed APIs: ${research.removedApis.join("; ")}` : null,
              research.renamedApis.length ? `- Renamed APIs: ${research.renamedApis.join("; ")}` : null,
              research.changedApis.length ? `- Changed APIs: ${research.changedApis.join("; ")}` : null,
              research.configurationChanges.length ? `- Config changes: ${research.configurationChanges.join("; ")}` : null,
              research.importChanges.length ? `- Import changes: ${research.importChanges.join("; ")}` : null,
            ]
              .filter(Boolean)
              .join("\n")
          : "";
        const impactSummary = scan.codeFindings.length
          ? scan.codeFindings
              .slice(0, 80)
              .map((f) => `${f.filePath}:${f.line} [${f.usageType}] ${f.symbol} — ${f.matchedCode}`)
              .join("\n")
          : "";
        const riskSummary = riskS
          ? `High=${riskS.high}, Medium=${riskS.medium}, Low=${riskS.low}. Affected APIs: ${riskS.affectedApis.join(", ") || "none"}.`
          : "";
        const result = await runCodingAgent(provider, {
          migrationId,
          workspaceRoot: repository.rootPath,
          originalRoot: path.join(path.dirname(repository.rootPath), "original"),
          dependency: migration.dependency,
          currentVersion: migration.oldVersion,
          targetMajor: migration.targetVersion.split(".")[0],
          mode: migration.mode,
          researchSummary,
          impactSummary,
          riskSummary,
        }, {
          onEvent: (level, message) => void emitAgentEvent(level as "info" | "success" | "warning" | "error", message),
        });
        await recordAiStage("coding_agent", provider, "success", { durationMs: Date.now() - agentStart });
        logger.info(
          {
            migrationId,
            resultStatus: result.status,
            patchesApplied: result.patchesApplied,
            toolCalls: result.agentState?.toolCalls?.length ?? 0,
            filesModified: result.agentState?.filesModified?.length ?? 0,
            filesInspected: result.agentState?.filesInspected?.length ?? 0,
            durationMs: Date.now() - agentStart,
          },
          "[MIGRATION] Coding agent completed",
        );
        agentState = result.agentState;
        migration.plan = result.plan
          ? {
              summary: result.plan.plannedChanges.join("; ") || `Upgrade ${migration.dependency}.`,
              breakingChanges: result.plan.breakingChanges,
              plannedChanges: result.plan.plannedChanges,
              validationCommands: result.plan.verificationCommands,
              migrationFindings: result.plan.migrationFindings ?? [],
              affectedApis: result.plan.affectedApis ?? [],
              riskAssessment: result.plan.riskAssessment ?? [],
              plannedPackageChanges: result.plan.plannedPackageChanges ?? [],
              plannedSourceChanges: result.plan.plannedSourceChanges ?? [],
              plannedConfigChanges: result.plan.plannedConfigChanges ?? [],
              potentialFailurePoints: result.plan.potentialFailurePoints ?? [],
              researchConfidence: result.plan.researchConfidence,
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
        await recordAiStage("coding_agent", agentProviderUsed, "error", { error: String(agentError) });
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
    }
    // If no agent plan was produced (baseline, Grok outage, or the agent returned
    // none), build an honest structured plan from real research + impact + repo
    // metadata — never a fabricated one.
    if (!migration.plan) {
      migration.plan = buildFallbackPlan({
        dependency: migration.dependency,
        currentVersion: migration.oldVersion,
        targetVersion: migration.targetVersion,
        research: migration.research,
        riskSummary: migration.riskSummary,
        packageManager: repository.packageManager,
        scripts: repository.scripts,
        language: repository.language,
        changes: migration.changes,
        agentRan: migration.mode === "agentic" && agentFinished,
      });
    }

    // 6) Verification + self-healing retry loop (agentic only).
    const healProvider = () => __migAgentProvider ?? getGrokProviderOrNull();
    const researchText = migration.research
      ? [
          `- Confidence: ${migration.research.confidence}`,
          migration.research.breakingChanges.length ? `- Breaking changes: ${migration.research.breakingChanges.join("; ")}` : null,
          migration.research.removedApis.length ? `- Removed APIs: ${migration.research.removedApis.join("; ")}` : null,
          migration.research.renamedApis.length ? `- Renamed APIs: ${migration.research.renamedApis.join("; ")}` : null,
          migration.research.changedApis.length ? `- Changed APIs: ${migration.research.changedApis.join("; ")}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    const impactText = scan.codeFindings.length
      ? scan.codeFindings.slice(0, 60).map((f) => `${f.filePath}:${f.line} [${f.usageType}] ${f.symbol}`).join("\n")
      : "";
    const planText = migration.plan ? `${migration.plan.summary || ""}\n${(migration.plan.plannedChanges ?? []).join("\n")}` : "";

    migration.attemptNumber = 1;
    let healRounds = 0;
    let lastRepairPatchResult: "applied" | "failed" | "skipped" = "skipped";
    const isCancelled = () => migration.cancelled === true;

    // Record a verification attempt into state.
    const recordAttempt = async (
      number: number,
      passedNow: boolean,
      diagnosis: string | null,
      failureInfo: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>,
      patchOverride?: string,
      patchResult?: "applied" | "failed" | "skipped",
    ) => {
      const filesModified = migration.agentState?.filesModified ?? [];
      migration.attempts[number - 1] = {
        number,
        result: passedNow ? "PASS" : "FAIL",
        // The precise check that failed, derived from the real command + exit code.
        failureType: passedNow ? undefined : failureTypeOf(failureInfo),
        diagnosis,
        filesChanged: migration.diff?.filesChanged ?? 0,
        command: failureInfo[0]?.command,
        exitCode: failureInfo[0]?.exitCode,
        stdout: failureInfo[0]?.stdout.slice(0, 2000),
        stderr: failureInfo[0]?.stderr.slice(0, 2000),
        filesModified,
        filesInspected: migration.agentState?.filesInspected ?? [],
        patch: patchOverride,
        patchResult,
      };
      migration.attemptNumber = number;
      await saveMigration(migration);
      await emitAgentEvent(passedNow ? "success" : "error", `Attempt ${number} — ${passedNow ? "PASS" : "FAIL"}${passedNow ? "" : ` (${failureTypeOf(failureInfo)})`}`);
    };

    const refreshedMigration = async () => (await getMigration(migrationId)) ?? migration;

    let failed = await verifyMigration(migration, repository.rootPath, repository);
    await runCommand("git", ["add", "-N", "."], { cwd: repository.rootPath });
    migration.diff = await captureDiff(repository.rootPath);

    let passed = verificationPassed(migration) && !isCancelled();
    await recordAttempt(
      1,
      passed && !isCancelled(),
      passed ? null : (failed[0]?.stderr || failed[0]?.stdout || "Verification command failed.").slice(0, 900),
      failed,
      undefined,
      "skipped", // attempt 1 has no corrective patch yet
    );

    // Baseline mode: no autonomous diagnosis/repair. Agentic mode self-heals.
    if (migration.mode === "baseline") {
      migration.baseline = {
        result: passed ? "PASS" : "FAIL",
        tests: migration.tests,
        build: migration.build,
        typecheck: migration.typecheck,
        lint: migration.lint,
        filesChanged: migration.diff.filesChanged,
      };
    }

    // Self-healing (agentic only): diagnose + corrective repair, bounded to a max
    // of 3 total verification attempts (MAX_HEAL_ATTEMPTS). Never infinite.
    while (migration.mode !== "baseline" && !passed && migration.attemptNumber < 3 && !isCancelled()) {
      healRounds += 1;
      await update("heal", `Verification failed — diagnosing (attempt ${migration.attemptNumber + 1})`);
      await emitAgentEvent("info", "Sending failure to Grok for diagnosis");

      let diagnosis = "Verification failed; see command output.";
      let diagnosisOk = false;
      try {
        const provider = healProvider();
        if (!provider) throw new HealError("HEAL_UNAVAILABLE: no Grok provider");
        const diagStart = Date.now();
        const d = await diagnoseFailure(provider, {
          dependency: migration.dependency,
          oldVersion: migration.oldVersion,
          targetVersion: migration.targetVersion,
          researchSummary: researchText,
          planSummary: planText,
          impactSummary: impactText,
          failedCommands: failed.map((f) => ({ ...f })),
          filesModified: migration.agentState?.filesModified ?? [],
          affectedFiles: migration.impactFiles,
        });
        await recordAiStage("failure_diagnosis", provider, "success", {
          durationMs: Date.now() - diagStart,
          attempt: migration.attemptNumber + 1,
        });
        diagnosis = d.summary;
        diagnosisOk = true;
      } catch (diagError) {
        await recordAiStage("failure_diagnosis", healProvider(), "error", {
          error: String(diagError),
          attempt: migration.attemptNumber + 1,
        });
        const msg = diagError instanceof Error ? diagError.message : String(diagError);
        const short = msg.slice(0, 500);
        if (!migration.remainingIssues.includes(short)) migration.remainingIssues.push(short);
        diagnosis = `Automatic diagnosis unavailable (${msg.slice(0, 120)}). Repairing based on failed command output.`;
      }
      await emitAgentEvent("info", `Diagnosis: ${diagnosis.slice(0, 300)}`);

      // Corrective repair pass — reuse the live migration state + coding agent.
      await update("heal", `Applying corrective patch (attempt ${migration.attemptNumber + 1})`);
      await emitAgentEvent("info", "Corrective patch generation in progress");

      const repairProvider = healProvider();
      if (repairProvider) {
        try {
          const current = await refreshedMigration();
          const repairStart = Date.now();
          const repairResult = await runCodingAgent(repairProvider, {
            migrationId,
            workspaceRoot: repository.rootPath,
            originalRoot: path.join(path.dirname(repository.rootPath), "original"),
            dependency: migration.dependency,
            currentVersion: migration.oldVersion,
            targetMajor: migration.targetVersion.split(".")[0],
            mode: migration.mode,
            researchSummary: researchText,
            impactSummary: impactText,
            riskSummary: migration.riskSummary
              ? `High=${migration.riskSummary.high}, Medium=${migration.riskSummary.medium}.`
              : "",
          }, {
            failureContext: { diagnosis, failedCommands: failed.map((f) => f.command) },
            onEvent: (level, message) => void emitAgentEvent(level as "info" | "success" | "warning" | "error", message),
          });
          await recordAiStage("repair", repairProvider, "success", {
            durationMs: Date.now() - repairStart,
            attempt: migration.attemptNumber + 1,
          });
          await refreshedMigration();
          lastRepairPatchResult = repairResult.patchesApplied > 0 ? "applied" : "skipped";
          if (repairResult.patchesApplied > 0) {
            migration.changes.push(`Corrective patch (attempt ${migration.attemptNumber + 1}): ${repairResult.patchesApplied} patch(es)`);
          }
          void current;
        } catch (repairError) {
          await recordAiStage("repair", repairProvider, "error", {
            error: String(repairError),
            attempt: migration.attemptNumber + 1,
          });
          lastRepairPatchResult = "failed";
          const short = `Corrective patch failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`.slice(0, 500);
          if (!migration.remainingIssues.includes(short)) migration.remainingIssues.push(short);
        }
      } else {
        lastRepairPatchResult = "skipped";
        const short = "Corrective patch skipped — no Grok provider available for repair.";
        if (!migration.remainingIssues.includes(short)) migration.remainingIssues.push(short);
      }

      await update("heal", `Retrying verification (attempt ${migration.attemptNumber + 1})`);
      migration.agentState = (await refreshedMigration()).agentState ?? migration.agentState;
      failed = await verifyMigration(migration, repository.rootPath, repository);
      await runCommand("git", ["add", "-N", "."], { cwd: repository.rootPath });
      migration.diff = await captureDiff(repository.rootPath);
      passed = verificationPassed(migration) && !isCancelled();
      await recordAttempt(
        migration.attemptNumber + 1,
        passed && !isCancelled(),
        passed ? null : (failed[0]?.stderr || failed[0]?.stdout || "Verification command failed.").slice(0, 900),
        failed,
        undefined,
        lastRepairPatchResult,
      );
    }

    // 7) Final status + diff.
    if (isCancelled()) {
      migration.status = "cancelled";
      migration.errorCode = null;
      if (migration.agentState) { migration.agentState.status = "cancelled"; migration.agentState.currentAction = "cancelled"; }
      await update("cancelled", "Migration cancelled", "warning");
      return;
    }

    migration.status = passed ? "completed" : "failed";
    // Precise failure code (TEST_FAILURE / BUILD_FAILURE / TYPECHECK_FAILURE /
    // TIMEOUT / VERIFICATION_FAILURE) derived from the real failing command.
    migration.errorCode = passed ? null : failureTypeOf(failed);
    if (migration.agentState) {
      migration.agentState.status = passed ? "completed" : "failed";
      migration.agentState.currentAction = passed ? "complete" : "failed";
    }
    if (!passed && migration.attemptNumber >= 3) {
      migration.remainingIssues.push("Migration could not be automatically repaired after 3 attempts.");
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

  // Validate dependency exists
  const depValidation = validateDependency(repository, dependency);
  if (!depValidation.isValid) {
    throw new DependencyValidationError(
      depValidation.error!,
      depValidation.message || "Dependency validation failed",
    );
  }

  // Validate target version format
  const versionValidation = validateTargetVersion(targetMajor);
  if (!versionValidation.isValid) {
    throw new DependencyValidationError(
      versionValidation.error!,
      versionValidation.message || "Target version validation failed",
    );
  }

  // Validate package manager is supported
  const pmValidation = validatePackageManager(repository.packageManager);
  if (!pmValidation.isValid) {
    throw new DependencyValidationError(
      pmValidation.error!,
      pmValidation.message || "Package manager not supported",
    );
  }

  const migration: MigrationRecord = {
    id: randomUUID(),
    repositoryId,
    repositoryName: repository.name,
    dependency,
    oldVersion: depValidation.currentVersion,
    targetVersion: versionValidation.normalized!,
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
    aiStages: [],
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

