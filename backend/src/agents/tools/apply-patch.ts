import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, ToolError, isAbsolutePath } from "./path";
import { createTool } from "./tool-factory";
import { runCommand } from "../../lib/run-command";
import type { ToolContext } from "./context";

interface ApplyPatchInput {
  path: string;
  // The patch body WITHOUT the ---/+++ header lines; those are synthesized.
  patch: string;
}

const MAX_PATCH_BYTES = 512_000;

/**
 * Build a full unified-diff (with proper a/ b/ prefixes) for git apply.
 * The `content` is the CURRENT file contents; `patch` lines are
 * "@@ ... context-or-changes" hunks. We strip any ---/+++ the model sends and
 * prepend our own using the file path.
 */
function buildUnifiedDiff(relPath: string, currentContent: string, hunks: string): string {
  const header = `--- a/${relPath}\n+++ b/${relPath}\n`;
  return header + (hunks.endsWith("\n") ? hunks : hunks + "\n");
}

/** Guard: reject anything that isn't a @@ hunk (e.g. model tried to embed raw file content). */
function validateHunks(patchBody: string, relPath: string): void {
  const lines = patchBody.split(/\r?\n/);
  let hunkCount = 0;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) continue;
    if (line.startsWith("@@")) {
      hunkCount += 1;
      continue;
    }
    if (line.trim() === "") continue;
    throw new ToolError(
      "INVALID_PATCH",
      `apply_patch only accepts unified-diff hunks (lines starting with @@, +, -, or space). ` +
        `Unexpected line in patch for "${relPath}": ${JSON.stringify(line.slice(0, 60))}`,
      relPath,
    );
  }
  if (hunkCount === 0) {
    throw new ToolError("INVALID_PATCH", `apply_patch for "${relPath}" must contain at least one @@ hunk.`, relPath);
  }
}

export default createTool<ApplyPatchInput>({
  name: "apply_patch",
  description:
    "Apply a minimal unified-diff patch to an EXISTING file inside the workspace. " +
    "The patch must contain one or more git-style hunks (@@ -l,c +l,c @@) anchored by surrounding " +
    "context lines. Do NOT include the --- a/path / +++ b/path header lines — supply only the hunks. " +
    "The file must exist; to create a new file use write_file. Backup copies are kept under " +
    ".agent-backups.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path of the file to edit, e.g. src/index.js." },
      patch: {
        type: "string",
        description:
          "Unified-diff hunks only (lines starting with @@, +, -, or space), WITHOUT ---/+++ headers.",
      },
    },
    required: ["path", "patch"],
  },
  async run(input, ctx) {
    const rel = String(input.path ?? "").trim();
    const hunks = String(input.patch ?? "");
    if (!rel) throw new ToolError("INVALID_PATH", "A file path is required.");
    if (!hunks) throw new ToolError("INVALID_PATCH", "A patch body is required.");
    if (isAbsolutePath(rel)) {
      throw new ToolError("INVALID_PATH", `Path must be relative inside the workspace: "${rel}"`, rel);
    }
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel);

    let current: string;
    try {
      current = await readFile(abs, "utf8");
    } catch {
      throw new ToolError("FILE_NOT_FOUND", `Cannot patch "${rel}": file does not exist. Use write_file to create it.`, rel);
    }
    if (Buffer.byteLength(hunks, "utf8") > MAX_PATCH_BYTES) {
      throw new ToolError("PATCH_TOO_LARGE", "Patch exceeds size limit.", rel);
    }

    validateHunks(hunks, rel);
    const unified = buildUnifiedDiff(rel, current, hunks);

    // Apply via a temp patch file so `git apply` resolves context against the
    // workspace repo (which has the baseline commit).
    const tempPatch = path.join(ctx.workspaceRoot, ".agent-patch.tmp");
    await writeFile(tempPatch, unified, "utf8");
    const applied = await runCommand("git", ["apply", "--whitespace=nowarn", tempPatch], {
      cwd: ctx.workspaceRoot,
    });
    await (await import("node:fs/promises")).rm(tempPatch, { force: true });
    if (applied.code !== 0) {
      throw new ToolError(
        "PATCH_FAILED",
        `git apply rejected the patch for "${rel}". Check that context lines match the file exactly. ` +
          `git stderr: ${(applied.stderr || applied.stdout).slice(0, 600)}`,
        rel,
      );
    }

    // Track a backup of the previous content under the (git-ignored) backups dir.
    const backupRel = path.posix.join(".agent-backups", `${rel.replace(/\//g, "__")}.before`);
    const backupAbs = path.join(ctx.workspaceRoot, backupRel);
    await (async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(backupAbs), { recursive: true });
    })();
    // Only write the backup if we haven't already (first patch wins for the baseline).
    const backupExists = await readFile(backupAbs, "utf8")
      .then(() => true)
      .catch(() => false);
    if (!backupExists) {
      await writeFile(backupAbs, current, "utf8");
    }

    ctx.log(`Applied patch to ${rel}`);
    return {
      ok: true,
      result: {
        path: rel,
        action: "patched",
        backup: backupRel,
        applied_hunks: hunks.split(/\r?\n/).filter((l) => l.startsWith("@@")).length,
      },
    };
  },
});