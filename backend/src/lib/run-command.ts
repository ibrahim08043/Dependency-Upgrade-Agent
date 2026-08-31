import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tempRoot } from "./workspace";

const execFileAsync = promisify(execFile);

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
// Set npm offline to prevent hanging in sandboxed/test environments without network.
const NPM_OFFLINE_ENV = {
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
};

/**
 * Run a controlled subprocess inside `cwd` (which MUST already be validated by
 * the caller as being inside the job workspace). Output is bounded, the
 * process is killed after the timeout, and a minimal safe environment is set.
 * A non-zero exit code is NOT thrown — callers inspect `result.code`.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT, maxOutput = DEFAULT_MAX_OUTPUT, env: userEnv } = options;
  const started = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxOutput,
      env: {
        HOME: process.env.HOME ?? tempRoot(),
        TEMP: process.env.TEMP ?? tempRoot(),
        TMP: process.env.TMP ?? tempRoot(),
        PATH: process.env.PATH ?? "",
        CI: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        ...userEnv,
      },
    });
    return {
      code: 0,
      stdout: result.stdout.slice(0, maxOutput),
      stderr: result.stderr.slice(0, maxOutput),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof result.code === "number" ? result.code : 1,
      stdout: (result.stdout ?? "").slice(0, maxOutput),
      stderr: (result.stderr ?? String(error)).slice(0, maxOutput),
      durationMs: Date.now() - started,
    };
  }
}