import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./run-command";
import { logger } from "./logger";

export interface InstalledVersionCheckResult {
  installed: string | null;
  matches: boolean;
  error?: string;
}

/**
 * Verify that the installed dependency version matches the requested target.
 *
 * Strategy:
 * 1. Try to read node_modules/<dependency>/package.json for the "version" field
 * 2. Fall back to `npm list` or `pnpm list` if node_modules isn't directly readable
 * 3. Compare installed version against the requested target semver range
 *
 * Returns null if version cannot be determined.
 */
export async function verifyInstalledVersion(
  rootPath: string,
  dependency: string,
  requestedTarget: string, // e.g., "^19.0.0"
  packageManager: "npm" | "pnpm",
): Promise<InstalledVersionCheckResult> {
  let installed: string | null = null;

  // 1. Try node_modules direct read (fastest)
  try {
    const packageJsonPath = path.join(
      rootPath,
      "node_modules",
      dependency,
      "package.json",
    );
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) {
      installed = parsed.version;
      logger.debug(
        { dependency, installed, rootPath },
        "[VERIFY] Found installed version in node_modules",
      );
    }
  } catch (err) {
    // node_modules read failed; try package manager query
    logger.debug(
      { dependency, error: err instanceof Error ? err.message : String(err) },
      "[VERIFY] node_modules read failed; trying package manager list",
    );
  }

  // 2. Fall back to package manager list if node_modules didn't work
  if (!installed) {
    try {
      const listCmd = packageManager === "npm" ? "npm" : "pnpm";
      const result = await runCommand(listCmd, ["list", dependency, "--depth=0"], {
        cwd: rootPath,
        timeoutMs: 30_000,
        maxOutput: 8000,
      });

      // Parse output: "dependency@1.2.3"
      const match = result.stdout.match(new RegExp(`${dependency}@([\\d.]+(?:-[\\w.]+)?)`));
      if (match?.[1]) {
        installed = match[1];
        logger.debug(
          { dependency, installed, packageManager },
          "[VERIFY] Found installed version from package manager list",
        );
      }
    } catch (err) {
      logger.warn(
        {
          dependency,
          error: err instanceof Error ? err.message : String(err),
        },
        "[VERIFY] Package manager list also failed",
      );
    }
  }

  if (!installed) {
    return {
      installed: null,
      matches: false,
      error: `Could not determine installed version for ${dependency}`,
    };
  }

  // 3. Check if installed version matches the requested target
  const matches = semverSatisfies(installed, requestedTarget);

  return { installed, matches };
}

/**
 * Simple semver satisfaction check for basic ranges.
 * Handles: ^major.minor.patch, ~major.minor.patch, exact versions, and "latest".
 *
 * This is NOT a full semver library; it covers the most common patterns used
 * in dependency upgrades. For edge cases, return false (fail safe).
 */
function semverSatisfies(version: string, range: string): boolean {
  // Remove prerelease/build metadata for comparison
  const versionBase = version.split("+")[0].split("-")[0];
  const parts = versionBase.split(".").map((p) => parseInt(p, 10));

  if (range === "latest") return true;

  // Caret range: ^X.Y.Z allows changes to Y and Z when X > 0
  if (range.startsWith("^")) {
    const rangeParts = range
      .substring(1)
      .split(".")
      .map((p) => parseInt(p, 10));
    const [rangeMajor, rangeMinor = 0] = rangeParts;

    // Major must match exactly when caret
    if (parts[0] !== rangeMajor) return false;

    // For major > 0: minor and patch can be >= range
    if (rangeMajor > 0) return parts[1] >= rangeMinor;

    // For major = 0: minor must match exactly, patch >= range
    if (parts[1] !== rangeMinor) return false;
    return parts[2] >= (rangeParts[2] ?? 0);
  }

  // Tilde range: ~X.Y.Z allows changes to Z when minor is present
  if (range.startsWith("~")) {
    const rangeParts = range
      .substring(1)
      .split(".")
      .map((p) => parseInt(p, 10));
    const [rangeMajor, rangeMinor = 0, rangePatch = 0] = rangeParts;

    if (parts[0] !== rangeMajor) return false;
    if (parts[1] !== rangeMinor) return false;
    return parts[2] >= rangePatch;
  }

  // Exact match
  return versionBase === range;
}

/**
 * Check if a lockfile exists and would be modified by the package manager.
 *
 * Returns:
 * - "npm" if package-lock.json exists
 * - "pnpm" if pnpm-lock.yaml exists
 * - null if no recognized lockfile
 */
export async function detectLockfileType(
  rootPath: string,
): Promise<"npm" | "pnpm" | null> {
  try {
    await readFile(path.join(rootPath, "package-lock.json"), "utf8");
    return "npm";
  } catch {
    // not found
  }

  try {
    await readFile(path.join(rootPath, "pnpm-lock.yaml"), "utf8");
    return "pnpm";
  } catch {
    // not found
  }

  return null;
}

/**
 * Capture the current state of lockfile(s) before modification.
 * Used to detect whether the package manager actually updated them.
 *
 * Returns a map of lockfile path → hash/content snapshot.
 */
export async function snapshotLockfiles(
  rootPath: string,
  packageManager: "npm" | "pnpm",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  try {
    const lockPath =
      packageManager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    const fullPath = path.join(rootPath, lockPath);
    const content = await readFile(fullPath, "utf8");
    snapshot[lockPath] = hashContent(content);
  } catch (err) {
    logger.debug(
      {
        packageManager,
        error: err instanceof Error ? err.message : String(err),
      },
      "[INSTALL] Lockfile snapshot failed (may not exist yet)",
    );
  }

  return snapshot;
}

/**
 * Check if lockfile(s) have been modified since the snapshot.
 *
 * Returns:
 * - { changed: true } if any lockfile was updated
 * - { changed: false, reason: "..." } if no changes detected
 */
export async function validateLockfileUpdated(
  rootPath: string,
  packageManager: "npm" | "pnpm",
  beforeSnapshot: Record<string, string>,
): Promise<{ changed: boolean; reason?: string }> {
  const lockPath =
    packageManager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";

  try {
    const fullPath = path.join(rootPath, lockPath);
    const content = await readFile(fullPath, "utf8");
    const hash = hashContent(content);

    const before = beforeSnapshot[lockPath];
    if (!before) {
      // Lockfile didn't exist before; it was created
      logger.debug(
        { lockPath },
        "[INSTALL] Lockfile was created by package manager",
      );
      return { changed: true };
    }

    if (hash !== before) {
      logger.debug(
        { lockPath, before, after: hash },
        "[INSTALL] Lockfile was updated by package manager",
      );
      return { changed: true };
    }

    return {
      changed: false,
      reason: `Lockfile "${lockPath}" was not modified by package manager`,
    };
  } catch (err) {
    return {
      changed: false,
      reason: `Could not read lockfile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Simple hash for detecting changes (not cryptographic).
 * Used only to detect if file content changed, not for security.
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
