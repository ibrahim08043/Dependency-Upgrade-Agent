import { spawn } from "node:child_process";
import { tempRoot } from "./workspace";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunCommandOptions {
  /** Working directory for the process. */
  cwd: string;
  /** Timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number;
  /** Max captured stdout/stderr bytes. Defaults to 24_000. */
  maxOutput?: number;
  /** Additional environment variables merged over the base safe env. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 24_000;

// npm/pnpm/yarn/npx/tsc are .cmd shims on Windows. execFile refuses to execute
// .cmd/.bat (spawn EINVAL/ENOENT). We resolve the real shim and route it through
// cmd.exe so package-manager and compiler commands actually run on Windows.
const WIN2CMD = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "npx", "npx.cmd"]);

async function runRaw(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutput: number; env: Record<string, string> },
): Promise<CommandResult> {
  const { cwd, timeoutMs, maxOutput, env } = options;
  const started = Date.now();

  let resolvedCommand = command;
  let resolvedArgs = args;

  // On Windows, .cmd/.bat package-manager shims cannot be spawned directly.
  if (process.platform === "win32" && WIN2CMD.has(command.toLowerCase())) {
    // cmd.exe /c npm <args> — correctly executes the npm.cmd shim.
    resolvedCommand = "cmd.exe";
    resolvedArgs = ["/c", command, ...args];
  }

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      env,
      // .cmd/.bat shims on Windows require spawning through the shell.
      shell: process.platform === "win32" && WIN2CMD.has(command.toLowerCase()),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: stdout.slice(0, maxOutput),
        stderr: stderr.slice(0, maxOutput),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutput) {
        stdout += chunk;
        if (stdout.length > maxOutput) stdout = stdout.slice(0, maxOutput);
      }
      // Keep draining (and discarding) so the child never blocks on a full pipe.
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxOutput) {
        stderr += chunk;
        if (stderr.length > maxOutput) stderr = stderr.slice(0, maxOutput);
      }
      // Keep draining so the child never blocks on a full pipe.
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      finish(1);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(typeof code === "number" ? code : 1);
    });
  });
}

/**
 * Run a controlled subprocess inside `cwd` (which MUST already be validated by
 * the caller as being inside the job workspace). Output is bounded, the
 * process is killed after the timeout, and a minimal safe environment is set.
 * A non-zero exit code is NOT thrown — callers inspect `result.code`.
 *
 * On Windows this correctly executes npm/pnpm/yarn/npx .cmd shims via cmd.exe,
 * which raw `execFile` cannot do (it refuses .cmd/bat files).
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT, maxOutput = DEFAULT_MAX_OUTPUT, env: userEnv } = options;
  return await runRaw(command, args, {
    cwd,
    timeoutMs,
    maxOutput,
    env: {
      HOME: process.env.HOME ?? tempRoot(),
      TEMP: process.env.TEMP ?? tempRoot(),
      TMP: process.env.TMP ?? tempRoot(),
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.windir ?? "",
      PATH: process.env.PATH ?? "",
      CI: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...userEnv,
    },
  });
}
