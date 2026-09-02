import type { RepositoryRecord } from "./migration-state";

/**
 * Failure classification for dependency operations.
 */
export type DependencyErrorCode =
  | "DEPENDENCY_NOT_FOUND"
  | "INVALID_DEPENDENCY_NAME"
  | "INVALID_TARGET_VERSION"
  | "UNSUPPORTED_PACKAGE_MANAGER"
  | "PACKAGE_MANAGER_NOT_INSTALLED"
  | "DEPENDENCY_INSTALL_FAILURE"
  | "LOCKFILE_UPDATE_FAILURE"
  | "DEPENDENCY_VERSION_MISMATCH"
  | "COMMAND_TIMEOUT"
  | "VERIFICATION_FAILURE";

export class DependencyValidationError extends Error {
  constructor(public code: DependencyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DependencyValidationError";
  }
}

/**
 * Result of validating a dependency selection before migration starts.
 */
export interface DependencyValidationResult {
  isValid: boolean;
  dependency: string;
  currentVersion: string;
  section: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  error?: DependencyErrorCode;
  message?: string;
}

/**
 * Validate that a selected dependency actually exists in the repository's manifest.
 *
 * Checks:
 * - dependency name is well-formed (allows @scope/package)
 * - dependency exists in at least one of the 4 manifest sections
 * - current version is extractable
 *
 * Returns a validation result with the section where the dependency was found,
 * or a structured error if validation fails.
 */
export function validateDependency(
  repository: RepositoryRecord,
  dependency: string,
): DependencyValidationResult {
  // Validate dependency name format (allow scoped packages like @org/pkg)
  if (!dependency || typeof dependency !== "string") {
    return {
      isValid: false,
      dependency,
      currentVersion: "",
      section: "dependencies",
      error: "INVALID_DEPENDENCY_NAME",
      message: `Invalid dependency name: "${String(dependency)}"`,
    };
  }

  const trimmed = dependency.trim();
  // Basic validation: non-empty, allow alphanumeric, dash, dot, @, and /
  if (!/^@?[a-zA-Z0-9._/-]+$/.test(trimmed)) {
    return {
      isValid: false,
      dependency: trimmed,
      currentVersion: "",
      section: "dependencies",
      error: "INVALID_DEPENDENCY_NAME",
      message: `Dependency name contains invalid characters: "${trimmed}"`,
    };
  }

  // Check all 4 manifest sections
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  for (const section of sections) {
    const dep = repository.dependencies.find(
      (d) => d.name === trimmed && d.section === section,
    );
    if (dep) {
      return {
        isValid: true,
        dependency: trimmed,
        currentVersion: dep.version,
        section,
      };
    }
  }

  return {
    isValid: false,
    dependency: trimmed,
    currentVersion: "",
    section: "dependencies",
    error: "DEPENDENCY_NOT_FOUND",
    message: `Dependency "${trimmed}" is not found in package.json`,
  };
}

/**
 * Validate that a target version is well-formed.
 *
 * Accepts:
 * - Major version: "19", "5", "1"
 * - Caret range: "^19.0.0", "^5.1.2"
 * - Tilde range: "~19.0.0"
 * - Exact: "19.0.0", "5.1.2"
 * - Latest: "latest"
 * - Major.x notation: "19.x", "5.x"
 *
 * Returns the normalized version or an error.
 */
export function validateTargetVersion(
  target: string,
): { isValid: boolean; normalized?: string; error?: DependencyErrorCode; message?: string } {
  if (!target || typeof target !== "string") {
    return {
      isValid: false,
      error: "INVALID_TARGET_VERSION",
      message: `Invalid target version: "${String(target)}"`,
    };
  }

  const trimmed = target.trim();

  // "latest" is always valid
  if (trimmed === "latest") {
    return { isValid: true, normalized: trimmed };
  }

  // Extract major version from various formats
  let major: string | null = null;

  // Try: "19" (digits only)
  if (/^\d+$/.test(trimmed)) {
    major = trimmed;
  }
  // Try: "19.x" or "19.x.x"
  else if (/^\d+\.x(\.x)?$/.test(trimmed)) {
    major = trimmed.split(".")[0];
  }
  // Try: "^19.0.0" or "^19.0.0" (caret)
  else if (/^\^?\d+\.\d+\.\d+$/.test(trimmed)) {
    major = trimmed.replace(/^\^/, "").split(".")[0];
  }
  // Try: "~19.0.0" (tilde)
  else if (/^~\d+\.\d+\.\d+$/.test(trimmed)) {
    major = trimmed.replace(/^~/, "").split(".")[0];
  }
  // Try: full semver like "19.0.0"
  else if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    major = trimmed.split(".")[0];
  }

  if (!major || !/^\d+$/.test(major)) {
    return {
      isValid: false,
      error: "INVALID_TARGET_VERSION",
      message: `Target version "${trimmed}" is not a valid version format`,
    };
  }

  // Normalize to caret range ^MAJOR.0.0
  const normalized = `^${major}.0.0`;

  return { isValid: true, normalized };
}

/**
 * Validate that the package manager is supported.
 */
export function validatePackageManager(
  packageManager: string,
): { isValid: boolean; error?: DependencyErrorCode; message?: string } {
  if (packageManager === "npm" || packageManager === "pnpm") {
    return { isValid: true };
  }

  if (packageManager === "unsupported") {
    return {
      isValid: false,
      error: "UNSUPPORTED_PACKAGE_MANAGER",
      message: `Package manager is not supported (detected: ${packageManager})`,
    };
  }

  return {
    isValid: false,
    error: "UNSUPPORTED_PACKAGE_MANAGER",
    message: `Unsupported package manager: ${packageManager}`,
  };
}
