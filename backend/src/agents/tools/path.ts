import path from "node:path";

export class ToolError extends Error {
  readonly errorType: string;
  readonly path?: string;

  constructor(errorType: string, message: string, p?: string) {
    super(message);
    this.name = "ToolError";
    this.errorType = errorType;
    this.path = p;
  }
}

export interface WorkspacePaths {
  /** Absolute path to the job workspace root (where tools operate). */
  workspaceRoot: string;
  /** Absolute path to the immutable original extract (backup / before-state). */
  originalRoot: string;
}

/** Detect POSIX and Windows-style absolute paths (e.g. "C:\foo", "/etc/passwd"). */
export function isAbsolutePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized)) return true;
  // Windows drive letter: "C:/..." or "C:\..."
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
  return false;
}

/**
 * Resolve a tool-supplied relative path inside the workspace.  Rejects:
 *   - absolute paths (POSIX and Windows drive-letter)
 *   - traversal via ".." segments
 *   - any path that escapes the workspace after normalization (defense in depth)
 * Returns the absolute path.
 */
export function resolveInWorkspace(workspaceRoot: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new ToolError("INVALID_PATH", "A file path is required.");
  }
  if (isAbsolutePath(relativePath)) {
    throw new ToolError("INVALID_PATH", `Path must be relative to the workspace: "${relativePath}"`, relativePath);
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!segments[0]) {
    throw new ToolError("INVALID_PATH", `Path must be relative to the workspace: "${relativePath}"`, relativePath);
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    // allow "." and collapse empties; reject explicit ".." only
  }
  if (segments.some((segment) => segment === "..")) {
    throw new ToolError("INVALID_PATH", `Path traversal is not allowed: "${relativePath}"`, relativePath);
  }
  const absolute = path.resolve(workspaceRoot, normalized);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (absolute !== workspaceRoot && !absolute.startsWith(rootWithSep)) {
    throw new ToolError("OUTSIDE_WORKSPACE", `Path escapes the workspace: "${relativePath}"`, relativePath);
  }
  return absolute;
}