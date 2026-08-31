import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Locate the user's temporary directory.  On native Windows use %TEMP%;
 * on Git-Bash `/tmp` maps to the user's AppData\Local\Temp already.
 */
export function tempRoot(): string {
  if (process.platform === "win32") {
    return process.env.TEMP || process.env.TMP || tmpdir();
  }
  return "/tmp";
}

/**
 * Create a fresh, isolated workspace directory for one repository job and
 * return its absolute path.  Never inside the application's own source tree.
 */
export async function createWorkspaceRoot(prefix: string): Promise<string> {
  const parent = path.join(tempRoot(), "dependency-agent");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, prefix));
}

/**
 * Windows `tar` (bsdtar) treats a backslash path like "C:\foo" as a remote
 * host connection.  Normalize to forward slashes so it parses it as a local
 * file: C:/foo.
 */
function tarSafePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * True when `command` can be launched.  Probes with `-v`: Info-ZIP `unzip`
 * exits non-zero on `--version`, so the short flag keeps both unzip and tar
 * resolvable.
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-v"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

type ArchiveEngine = "unzip" | "tar" | "powershell" | null;

/**
 * Find a usable archive engine.  Prefers Info-ZIP `unzip` (Git-Bash / Unix),
 * then `tar` (Windows ships bsdtar which can read ZIP archives), then
 * PowerShell's Expand-Archive as a native-Windows last resort.
 */
async function findEngine(): Promise<ArchiveEngine> {
  if (await commandExists("unzip")) return "unzip";
  if (await commandExists("tar")) return "tar";
  if (process.platform === "win32") return "powershell";
  return null;
}

/** List ZIP entries WITHOUT extracting. Returns [] when no listing tool is found. */
export async function listZipEntries(archivePath: string): Promise<string[]> {
  const engine = await findEngine();
  if (engine === "unzip") {
    const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath], { timeout: 60_000 });
    return stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  }
  if (engine === "tar") {
    const { stdout } = await execFileAsync("tar", ["-tf", tarSafePath(archivePath)], { timeout: 60_000 });
    return stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  }
  return [];
}

/**
 * Extract `archivePath` into `destination` (created if missing).  Returns the
 * engine used.  Throws if no engine is available or extraction fails.
 */
export async function extractArchive(archivePath: string, destination: string): Promise<ArchiveEngine> {
  const engine = await findEngine();
  if (engine === "unzip") {
    await execFileAsync("unzip", ["-q", archivePath, "-d", destination], { timeout: 120_000 });
    return "unzip";
  }
  if (engine === "tar") {
    await execFileAsync("tar", ["-xf", tarSafePath(archivePath), "-C", tarSafePath(destination)], { timeout: 120_000 });
    return "tar";
  }
  if (engine === "powershell") {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(destination)} -Force`,
      ],
      { timeout: 120_000 },
    );
    return "powershell";
  }
  throw new Error("REPOSITORY_INVALID: no ZIP extractor is available on this system");
}

/** Recursively copy a directory using the filesystem API (portable). */
export async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(from, to);
    }
  }
}