import { resolveInWorkspace, ToolError } from "./path";
import { createTool } from "./tool-factory";
import { runCommand as execControlled } from "../../lib/run-command";
import type { ToolContext } from "./context";
import type { ToolResult } from "./types";

interface RunCommandInput {
  command: string;
  args?: string[];
  cwd?: string; // relative
}

// Package-manager and inspection commands the agent may run IN the workspace.
const ALLOWED_COMMANDS = new Map<string, (args: string[]) => boolean>([
  ["npm", () => true],
  ["pnpm", () => true],
  ["yarn", () => true],
  // node -e "code" is allowed (starts with -e, not --); only block -- flags
  ["node", (args) => args[0] !== undefined && !args[0].startsWith("--")],
  ["npx", (args) => args[0] !== undefined && !args[0].startsWith("--")],
  ["tsc", () => true],
  ["git", (args) => !args.includes("push") && !args.includes("remote") && !args[0]?.startsWith("clone")],
]);

const MAX_ARGS = 24;

export default createTool<RunCommandInput>({
  name: "run_command",
  description:
    "Run an allowed repository command INSIDE the migration workspace, e.g. `npm test`, " +
    "`npm run build`, `tsc --noEmit`, `node --version`, or read-only `git` commands (git push/clone/remote " +
    "are blocked). Output is bounded and the command is killed after 120s.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command name: one of npm, pnpm, yarn, node, npx, tsc, git." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments.",
      },
      cwd: { type: "string", description: "Optional relative working directory inside the workspace." },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    const command = String(input.command ?? "").trim();
    const validator = ALLOWED_COMMANDS.get(command);
    if (!validator) {
      throw new ToolError(
        "COMMAND_NOT_ALLOWED",
        `"${command}" is not an allowed command. Allowed: ${[...ALLOWED_COMMANDS.keys()].join(", ")}.`,
      );
    }
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (args.length > MAX_ARGS) throw new ToolError("COMMAND_NOT_ALLOWED", "Too many arguments.");
    if (!validator(args)) {
      throw new ToolError(
        "COMMAND_NOT_ALLOWED",
        `Command "${command}" with these arguments is not allowed.`,
      );
    }

    const cwdRel = (input.cwd ?? "").trim() || ".";
    if (cwdRel.includes("..")) throw new ToolError("INVALID_PATH", "cwd must be inside the workspace.");
    const cwdAbs = cwdRel === "." ? ctx.workspaceRoot : resolveInWorkspace(ctx.workspaceRoot, cwdRel);

    const result = await execControlled(command, args, { cwd: cwdAbs });
    const succeeded = result.code === 0;
    ctx.log(`${command} ${args.join(" ")}${succeeded ? "" : ` (exit ${result.code})`}`.trim());
    if (succeeded) {
      return {
        ok: true as const,
        result: {
          command,
          args,
          exit_code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
        },
      };
    }
    return {
      ok: false as const,
      errorType: "COMMAND_FAILED",
      message: `Command exited with code ${result.code}. stderr: ${(result.stderr || result.stdout).slice(0, 700)}`,
    } satisfies ToolResult;
  },
});