import { runCommand } from "./run-command";
import type { MigrationRecord } from "./migration-state";

const MAX_PATCH_BYTES = 512_000;

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted";
  patch: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  files: DiffFile[];
}

/**
 * Capture the ACTUAL diff of the workspace against the baseline commit.
 * Callers MUST run `git add -N .` (intent-to-add) first so brand-new files are
 * included in the `git diff` output even before they are staged.
 */
export async function captureDiff(workspacePath: string): Promise<DiffSummary> {
  const result = await runCommand("git", ["diff", "--no-ext-diff", "--unified=3"], {
    cwd: workspacePath,
    maxOutput: MAX_PATCH_BYTES,
  });
  const numstat = await runCommand("git", ["diff", "--numstat"], { cwd: workspacePath });

  const files = numstat.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
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

export type DiffField = MigrationRecord["diff"];