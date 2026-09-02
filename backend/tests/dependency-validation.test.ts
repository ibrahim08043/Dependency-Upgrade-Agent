import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  validateDependency,
  validateTargetVersion,
  validatePackageManager,
  DependencyValidationError,
} from "../src/lib/dependency-validation";
import {
  verifyInstalledVersion,
  snapshotLockfiles,
  validateLockfileUpdated,
  detectLockfileType,
} from "../src/lib/install-verification";
import type { RepositoryRecord } from "../src/lib/migration-state";
import { runCommand } from "../src/lib/run-command";

describe("Dependency Validation", () => {
  describe("validateDependency", () => {
    it("should accept a valid dependency in dependencies section", () => {
      const repo: RepositoryRecord = {
        id: "test",
        name: "test-repo",
        source: "zip",
        language: "TypeScript",
        packageManager: "npm",
        hasPackageJson: true,
        lockfile: "package-lock.json",
        framework: "React",
        dependencies: [
          { name: "react", version: "18.2.0", section: "dependencies" },
        ],
        scripts: ["build", "test"],
        status: "analyzed",
        createdAt: new Date().toISOString(),
        rootPath: "/tmp/test",
      };

      const result = validateDependency(repo, "react");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.dependency, "react");
      assert.strictEqual(result.currentVersion, "18.2.0");
      assert.strictEqual(result.section, "dependencies");
    });

    it("should accept a scoped package name", () => {
      const repo: RepositoryRecord = {
        id: "test",
        name: "test-repo",
        source: "zip",
        language: "TypeScript",
        packageManager: "npm",
        hasPackageJson: true,
        lockfile: "package-lock.json",
        framework: null,
        dependencies: [
          {
            name: "@babel/core",
            version: "7.20.0",
            section: "devDependencies",
          },
        ],
        scripts: [],
        status: "analyzed",
        createdAt: new Date().toISOString(),
        rootPath: "/tmp/test",
      };

      const result = validateDependency(repo, "@babel/core");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.dependency, "@babel/core");
      assert.strictEqual(result.currentVersion, "7.20.0");
    });

    it("should reject nonexistent dependency", () => {
      const repo: RepositoryRecord = {
        id: "test",
        name: "test-repo",
        source: "zip",
        language: "TypeScript",
        packageManager: "npm",
        hasPackageJson: true,
        lockfile: "package-lock.json",
        framework: null,
        dependencies: [
          { name: "react", version: "18.2.0", section: "dependencies" },
        ],
        scripts: [],
        status: "analyzed",
        createdAt: new Date().toISOString(),
        rootPath: "/tmp/test",
      };

      const result = validateDependency(repo, "nonexistent");
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.error, "DEPENDENCY_NOT_FOUND");
    });

    it("should reject invalid dependency name with special chars", () => {
      const repo: RepositoryRecord = {
        id: "test",
        name: "test-repo",
        source: "zip",
        language: "TypeScript",
        packageManager: "npm",
        hasPackageJson: true,
        lockfile: null,
        framework: null,
        dependencies: [],
        scripts: [],
        status: "analyzed",
        createdAt: new Date().toISOString(),
        rootPath: "/tmp/test",
      };

      const result = validateDependency(repo, "react<>evil");
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.error, "INVALID_DEPENDENCY_NAME");
    });
  });

  describe("validateTargetVersion", () => {
    it("should accept major version only", () => {
      const result = validateTargetVersion("19");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "^19.0.0");
    });

    it("should accept major.x notation", () => {
      const result = validateTargetVersion("19.x");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "^19.0.0");
    });

    it("should accept caret range", () => {
      const result = validateTargetVersion("^19.0.0");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "^19.0.0");
    });

    it("should accept tilde range", () => {
      const result = validateTargetVersion("~19.0.0");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "^19.0.0");
    });

    it("should accept exact version", () => {
      const result = validateTargetVersion("19.0.0");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "^19.0.0");
    });

    it("should accept 'latest'", () => {
      const result = validateTargetVersion("latest");
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized, "latest");
    });

    it("should reject invalid format", () => {
      const result = validateTargetVersion("abc");
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.error, "INVALID_TARGET_VERSION");
    });
  });

  describe("validatePackageManager", () => {
    it("should accept npm", () => {
      const result = validatePackageManager("npm");
      assert.strictEqual(result.isValid, true);
    });

    it("should accept pnpm", () => {
      const result = validatePackageManager("pnpm");
      assert.strictEqual(result.isValid, true);
    });

    it("should reject unsupported manager", () => {
      const result = validatePackageManager("unsupported");
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.error, "UNSUPPORTED_PACKAGE_MANAGER");
    });

    it("should reject yarn", () => {
      const result = validatePackageManager("yarn");
      assert.strictEqual(result.isValid, false);
    });
  });
});

describe("Install Verification", () => {
  describe("detectLockfileType", () => {
    it("should detect npm lockfile", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        await writeFile(path.join(testDir, "package-lock.json"), "{}");
        const result = await detectLockfileType(testDir);
        assert.strictEqual(result, "npm");
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("should detect pnpm lockfile", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        await writeFile(path.join(testDir, "pnpm-lock.yaml"), "");
        const result = await detectLockfileType(testDir);
        assert.strictEqual(result, "pnpm");
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("should return null when no lockfile exists", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const result = await detectLockfileType(testDir);
        assert.strictEqual(result, null);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe("snapshotLockfiles", () => {
    it("should capture npm lockfile state", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const lockPath = path.join(testDir, "package-lock.json");
        await writeFile(lockPath, '{"version": 3}');

        const snapshot = await snapshotLockfiles(testDir, "npm");
        assert.ok(snapshot["package-lock.json"]);
        assert.strictEqual(typeof snapshot["package-lock.json"], "string");
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("should handle missing lockfile gracefully", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const snapshot = await snapshotLockfiles(testDir, "npm");
        assert.deepStrictEqual(snapshot, {});
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe("validateLockfileUpdated", () => {
    it("should detect lockfile changes", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const lockPath = path.join(testDir, "package-lock.json");
        const original = '{"version": 3}';
        await writeFile(lockPath, original);

        const before = await snapshotLockfiles(testDir, "npm");

        // Simulate a change
        await writeFile(lockPath, '{"version": 3, "packages": {}}');

        const result = await validateLockfileUpdated(testDir, "npm", before);
        assert.strictEqual(result.changed, true);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("should detect when lockfile is not changed", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const lockPath = path.join(testDir, "package-lock.json");
        const content = '{"version": 3}';
        await writeFile(lockPath, content);

        const before = await snapshotLockfiles(testDir, "npm");
        const result = await validateLockfileUpdated(testDir, "npm", before);
        assert.strictEqual(result.changed, false);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("should report success when lockfile is created", async () => {
      const testDir = path.join(tmpdir(), "dua-test-", randomUUID());
      await mkdir(testDir, { recursive: true });
      try {
        const before = {}; // No lockfile before
        await writeFile(path.join(testDir, "package-lock.json"), "{}");

        const result = await validateLockfileUpdated(testDir, "npm", before);
        assert.strictEqual(result.changed, true);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });
});

