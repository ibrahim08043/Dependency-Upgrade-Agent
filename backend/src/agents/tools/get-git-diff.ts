import { runCommand } from "../../lib/run-command";
import { captureDiff } from "../../lib/git";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface GetGitDiffInput {
  // optional, reserved for future scoping
}

/**
 * Return the REAL diff of the workspace against the baseline commit. This
 * reads the git state from disk — Grok never invents a diff.
 */
export default createTool<GetGitDiffInput>({
  name: "get_git_diff",
  description:
    "Return the actual current git diff of the workspace compared to the baseline commit. " +
    "This reflects real filesystem changes only.",
  parameters: {
    type: "object",
    properties: {},
  },
  async run(_input, ctx) {
    // Ensure intent-to-add so brand-new files appear in `git diff`.
    await runCommand("git", ["add", "-N", "."], { cwd: ctx.workspaceRoot });
    const diff = await captureDiff(ctx.workspaceRoot);
    return {
      ok: true,
      result: {
        filesChanged: diff.filesChanged,
        additions: diff.additions,
        deletions: diff.deletions,
        files: diff.files.map((f) => ({
          path: f.path,
          status: f.status,
          patch: f.patch.slice(0, 40_000),
          additions: f.additions,
          deletions: f.deletions,
        })),
      },
    };
  },
});