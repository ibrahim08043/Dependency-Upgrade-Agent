import { getMigration, getRepository } from "../../lib/migration-state";
import type { RepositoryRecord } from "../../lib/migration-state";
import { ToolError } from "./path";

export interface ToolContext {
  migrationId: string;
  repositoryId: string;
  workspaceRoot: string;
  originalRoot: string;
  repository: RepositoryRecord;
  /** Read-only copy of relevant env/configuration exposed to tools. */
  env: { targetMajor: string; dependency: string; currentVersion: string };
  /** Emit a real agent event (level "info") for the workspace UI. */
  log: (message: string, level?: "info" | "success" | "warning" | "error") => Promise<void> | void;
}

/**
 * Load the context for an agent run: the repository record plus a validated
 * workspace root.  Throws if the migration/repository is unavailable.
 */
export async function loadToolContext(
  migrationId: string,
  workspaceRoot: string,
  originalRoot: string,
  env: ToolContext["env"],
  log: ToolContext["log"],
): Promise<ToolContext> {
  const migration = await getMigration(migrationId);
  if (!migration) throw new ToolError("MIGRATION_NOT_FOUND", `Migration ${migrationId} not found.`);
  const repository = await getRepository(migration.repositoryId);
  if (!repository) throw new ToolError("REPOSITORY_NOT_FOUND", `Repository ${migration.repositoryId} not found.`);
  return {
    migrationId,
    repositoryId: migration.repositoryId,
    workspaceRoot,
    originalRoot,
    repository,
    env,
    log,
  };
}