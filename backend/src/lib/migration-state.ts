import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export type RepositorySource = "zip" | "github";
export type PackageManager = "npm" | "pnpm" | "yarn" | "unsupported";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "approved"
  | "rejected";
export type ResultStatus = "pass" | "fail" | "skipped" | "running";

export interface RepositoryRecord {
  id: string;
  name: string;
  source: RepositorySource;
  language: string;
  packageManager: PackageManager;
  hasPackageJson: boolean;
  lockfile: string | null;
  framework: string | null;
  dependencies: Array<{
    name: string;
    version: string;
    section:
      | "dependencies"
      | "devDependencies"
      | "peerDependencies"
      | "optionalDependencies";
  }>;
  scripts: string[];
  status: "analyzed" | "invalid";
  createdAt: string;
  rootPath: string;
}

export interface MigrationRecord {
  id: string;
  repositoryId: string;
  repositoryName: string;
  dependency: string;
  oldVersion: string;
  targetVersion: string;
  mode: "agentic" | "baseline";
  status: JobStatus;
  currentStage: string;
  attemptNumber: number;
  affectedFiles: number;
  affectedUsages: number;
  tests: ResultStatus;
  build: ResultStatus;
  typecheck: ResultStatus;
  lint: ResultStatus;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  plan: {
    summary: string;
    breakingChanges: string[];
    plannedChanges: string[];
    validationCommands: string[];
    /** Phase 2 research-driven plan sections. */
    migrationFindings?: string[];
    affectedApis?: string[];
    riskAssessment?: string[];
    plannedPackageChanges?: string[];
    plannedSourceChanges?: string[];
    plannedConfigChanges?: string[];
    potentialFailurePoints?: string[];
    researchConfidence?: "high" | "medium" | "low" | "none";
  } | null;
  impactFiles: string[];
  sources: Array<{ title: string; url: string; finding: string }>;
  changes: string[];
  attempts: Array<{
    number: number;
    result: string; // PASS | FAIL
    /** Which check failed this attempt (TEST_FAILURE / BUILD_FAILURE / TYPECHECK_FAILURE / VERIFICATION_FAILURE). */
    failureType?: string;
    diagnosis: string | null;
    filesChanged: number;
    command?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    filesInspected?: string[];
    filesModified?: string[];
    patch?: string;
    /** Outcome of the corrective-patch step for this attempt: "applied" | "failed" | "skipped". */
    patchResult?: string;
  }>;
  /** Rich per-command verification records (command, status, exit code, stdout, stderr, duration). */
  verificationCommands?: Array<{
    command: string;
    status: "PASS" | "FAIL" | "SKIPPED" | "TIMEOUT";
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  /** Cancellation flag — when true, running stages stop and retries are prevented. */
  cancelled?: boolean;
  /** Baseline-mode result snapshot for mode comparison. */
  baseline?: {
    result: string;
    tests: ResultStatus;
    build: ResultStatus;
    typecheck: ResultStatus;
    lint: ResultStatus;
    filesChanged: number;
  } | null;
  remainingIssues: string[];
  diff: {
    filesChanged: number;
    additions: number;
    deletions: number;
    files: Array<{
      path: string;
      status: "modified" | "added" | "deleted";
      patch: string;
      additions: number;
      deletions: number;
    }>;
  };
  /** Public agent activity recorded by the coding agent. */
  agentState?: {
    status: string;
    currentAction: string;
    toolCalls: Array<{
      timestamp: string;
      tool: string;
      inputSummary: string;
      resultSummary: string;
      success: boolean;
      durationMs: number;
      errorType?: string;
    }>;
    filesInspected: string[];
    filesModified: string[];
    patchesApplied: number;
    planSummary?: string;
    fileChanges?: Array<{ path: string; action: string }>;
    agentSummary?: string;
    error?: string;
  };
  /** Phase 2 — structured migration research (sources + synthesized findings). */
  research?: import("./research-types").MigrationResearch;
  /** Phase 2 — per-file risk classification after correlating research with usage. */
  riskSummary?: import("./impact").ImpactSummary;
  /**
   * Phase 3 — non-sensitive record of every real AI request made during the run
   * (synthesis / coding agent / diagnosis / repair). Never stores the API key or
   * chain-of-thought; only stage, provider, model, status, timestamp, duration.
   */
  aiStages?: AiStageRecord[];
}

export interface AiStageRecord {
  stage: "research_synthesis" | "coding_agent" | "failure_diagnosis" | "repair";
  provider: string; // "grok" | "scripted" (test seam)
  model: string; // resolved model name or "unknown"
  requestStatus: "success" | "error" | "skipped";
  success: boolean;
  timestamp: string;
  durationMs?: number;
  attempt?: number;
  error?: string; // short error code/message, never a secret
}

export interface MigrationEvent {
  id: string;
  migrationId: string;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  /** Pipeline stage when this event was emitted. */
  stage?: string;
  /** Semantic event type for UI rendering. */
  eventType?: string;
  /** Tool name when the event relates to a tool call. */
  tool?: string;
  /** Sanitized tool input summary (truncated, no secrets). */
  toolArgs?: string;
  /** Sanitized tool result summary (truncated, no secrets). */
  toolResult?: string;
  /** Duration in milliseconds for timed operations. */
  durationMs?: number;
  /** Files affected by this event's operation. */
  filesAffected?: string[];
  /** Command that was executed (for run_command / verification events). */
  command?: string;
  /** Machine-readable error category. */
  errorCategory?: string;
  /** Self-healing attempt number (1-based). */
  attemptNumber?: number;
  /** Exit code for command execution events. */
  exitCode?: number;
}

interface State {
  repositories: RepositoryRecord[];
  migrations: MigrationRecord[];
  events: MigrationEvent[];
}

// Anchor the state directory to the backend package root so the same file is
// used whether the server runs from src (TS) or from the bundled dist output.
// Walk up from this module until we find backend/package.json.
function findBackendDir(start: string): string {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(current, "package.json"), "utf8"),
      ) as { name?: string };
      if (pkg.name === "@dua/backend") return current;
    } catch {
      // continue up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

const backendDir = findBackendDir(import.meta.dirname);
const dataDir = path.join(backendDir, ".data");
const statePath = path.join(dataDir, "migration-state.json");

// Ensure the data directory exists eagerly so concurrent writes from tests
// don't race the mkdir inside updateState.
mkdir(dataDir, { recursive: true }).catch(() => undefined);

const initialState: State = { repositories: [], migrations: [], events: [] };

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as State;
    return {
      repositories: parsed.repositories ?? [],
      migrations: parsed.migrations ?? [],
      events: parsed.events ?? [],
    };
  } catch {
    return structuredClone(initialState);
  }
}

let statePromise = loadState();
let writeQueue = Promise.resolve();

async function updateState(mutator: (state: State) => void): Promise<void> {
  const next = writeQueue.then(async () => {
    const state = await statePromise;
    mutator(state);
    await mkdir(dataDir, { recursive: true });
    const tempPath = `${statePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, statePath);
    statePromise = Promise.resolve(state);
  });
  writeQueue = next.catch(async (error) => {
    // On failure, reset statePromise to a fresh load so the next write isn't
    // operating on stale/corrupt state.
    statePromise = loadState();
    throw error;
  });
  await next.catch(() => undefined);
}

export async function listRepositories(): Promise<RepositoryRecord[]> {
  return (await statePromise).repositories;
}

export async function getRepository(id: string): Promise<RepositoryRecord | undefined> {
  return (await statePromise).repositories.find((repository) => repository.id === id);
}

export async function saveRepository(repository: RepositoryRecord): Promise<void> {
  await updateState((state) => {
    state.repositories = [
      repository,
      ...state.repositories.filter((item) => item.id !== repository.id),
    ];
  });
}

export async function listMigrations(): Promise<MigrationRecord[]> {
  return (await statePromise).migrations;
}

export async function getMigration(id: string): Promise<MigrationRecord | undefined> {
  return (await statePromise).migrations.find((migration) => migration.id === id);
}

export async function saveMigration(migration: MigrationRecord): Promise<void> {
  await updateState((state) => {
    state.migrations = state.migrations.map((item) =>
      item.id === migration.id ? migration : item,
    );
  });
}

export async function createMigration(migration: MigrationRecord): Promise<void> {
  await updateState((state) => {
    state.migrations = [migration, ...state.migrations];
  });
}

export async function addEvent(event: MigrationEvent): Promise<void> {
  await updateState((state) => {
    state.events.push(event);
    if (state.events.length > 5000) state.events = state.events.slice(-5000);
  });
}

export async function getEvents(migrationId: string): Promise<MigrationEvent[]> {
  return (await statePromise).events.filter((event) => event.migrationId === migrationId);
}