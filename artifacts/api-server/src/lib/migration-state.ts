import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  } | null;
  impactFiles: string[];
  sources: Array<{ title: string; url: string; finding: string }>;
  changes: string[];
  attempts: Array<{
    number: number;
    result: string;
    diagnosis: string | null;
    filesChanged: number;
  }>;
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
}

export interface MigrationEvent {
  id: string;
  migrationId: string;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

interface State {
  repositories: RepositoryRecord[];
  migrations: MigrationRecord[];
  events: MigrationEvent[];
}

const dataDir = path.resolve(process.cwd(), ".data");
const statePath = path.join(dataDir, "migration-state.json");

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
  writeQueue = next.catch(() => undefined);
  await next;
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