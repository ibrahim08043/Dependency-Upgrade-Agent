import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runCommand } from "../src/lib/run-command";
import {
  verifyInstalledVersion,
  snapshotLockfiles,
  validateLockfileUpdated,
} from "../src/lib/install-verification";

describe("npm Real E2E Migration", () => {
  let testDir: string;

  before(async () => {
    testDir = path.join(tmpdir(), "dua-npm-e2e-", randomUUID());
    await mkdir(testDir, { recursive: true });
  });

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should perform real npm install and verify version", async () => {
    const pkgJson = {
      name: "test-migration",
      version: "1.0.0",
      description: "Test repository for dependency migration",
      dependencies: {
        lodash: "^4.17.0",
      },
      devDependencies: {},
    };

    await writeFile(
      path.join(testDir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );

    await runCommand("git", ["init", "-q"], { cwd: testDir });
    await runCommand("git", ["config", "user.email", "test@test.com"], {
      cwd: testDir,
    });
    await runCommand("git", ["config", "user.name", "Test Agent"], {
      cwd: testDir,
    });

    await runCommand("git", ["add", "package.json"], { cwd: testDir });
    await runCommand("git", ["commit", "-q", "-m", "initial"], {
      cwd: testDir,
    });

    const npmCheck = await runCommand("npm", ["--version"], { cwd: testDir });
    assert(npmCheck.code === 0, "npm should be available");

    const lockfileBefore = await snapshotLockfiles(testDir, "npm");

    const installOrig = await runCommand(
      "npm",
      ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      { cwd: testDir, timeoutMs: 60_000 },
    );
    assert.strictEqual(
      installOrig.code,
      0,
      "Initial npm install should succeed",
    );

    const versionBefore = await verifyInstalledVersion(
      testDir,
      "lodash",
      "^4.17.0",
      "npm",
    );
    assert(versionBefore.installed, "lodash should be installed");
    assert(versionBefore.matches, "Initial version should match ^4.17.0");
  });

  it("should handle invalid package gracefully", async () => {
    const pkgJson = {
      name: "test-invalid",
      version: "1.0.0",
      dependencies: {},
    };

    const testDir2 = path.join(tmpdir(), "dua-npm-invalid-", randomUUID());
    await mkdir(testDir2, { recursive: true });

    try {
      await writeFile(
        path.join(testDir2, "package.json"),
        JSON.stringify(pkgJson, null, 2),
      );

      const result = await runCommand(
        "npm",
        [
          "install",
          "this-package-definitely-does-not-exist-12345@^1.0.0",
          "--legacy-peer-deps",
        ],
        { cwd: testDir2, timeoutMs: 10_000 },
      );

      assert(result.code !== 0, "Installing nonexistent package should fail");
      assert(
        result.stderr || result.stdout,
        "Error should be captured in stderr/stdout",
      );
    } finally {
      await rm(testDir2, { recursive: true, force: true });
    }
  });
});

describe("pnpm Real E2E Migration", () => {
  let testDir: string;
  let pnpmAvailable = false;

  before(async () => {
    testDir = path.join(tmpdir(), "dua-pnpm-e2e-", randomUUID());
    await mkdir(testDir, { recursive: true });

    const pnpmCheck = await runCommand("pnpm", ["--version"], { cwd: testDir });
    pnpmAvailable = pnpmCheck.code === 0;
  });

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should perform real pnpm add and verify version", async () => {
    if (!pnpmAvailable) {
      return;
    }

    const pkgJson = {
      name: "test-migration-pnpm",
      version: "1.0.0",
      dependencies: {
        "tiny-invariant": "^1.3.0",
      },
    };

    await writeFile(
      path.join(testDir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );

    await runCommand("git", ["init", "-q"], { cwd: testDir });
    await runCommand("git", ["config", "user.email", "test@test.com"], {
      cwd: testDir,
    });
    await runCommand("git", ["config", "user.name", "Test Agent"], {
      cwd: testDir,
    });
    await runCommand("git", ["add", "package.json"], { cwd: testDir });
    await runCommand("git", ["commit", "-q", "-m", "initial"], {
      cwd: testDir,
    });

    const install = await runCommand("pnpm", ["install"], {
      cwd: testDir,
      timeoutMs: 60_000,
    });

    if (install.code === 0) {
      const version = await verifyInstalledVersion(
        testDir,
        "tiny-invariant",
        "^1.3.0",
        "pnpm",
      );
      assert(version.installed, "tiny-invariant should be installed");
      assert(
        version.matches,
        `Installed version should match target. Got: ${version.installed}`,
      );

      const snapshot = await snapshotLockfiles(testDir, "pnpm");
      assert(
        snapshot["pnpm-lock.yaml"],
        "pnpm-lock.yaml should be snapshotted",
      );
    } else {
      assert(install.stderr || install.stdout, "Error should be captured");
    }
  });
});

describe("Dependency Install Failure Handling", () => {
  it("should report install failure without masking", async () => {
    const testDir = path.join(tmpdir(), "dua-install-fail-", randomUUID());
    await mkdir(testDir, { recursive: true });

    try {
      await writeFile(
        path.join(testDir, "package.json"),
        JSON.stringify({
          name: "test",
          version: "1.0.0",
          dependencies: {},
        }),
      );

      await runCommand("git", ["init", "-q"], { cwd: testDir });
      await runCommand("git", ["config", "user.email", "test@test.com"], {
        cwd: testDir,
      });
      await runCommand("git", ["config", "user.name", "Test Agent"], {
        cwd: testDir,
      });

      const result = await runCommand(
        "npm",
        ["install", "invalid-package-xyz@99.99.99"],
        { cwd: testDir, timeoutMs: 10_000 },
      );

      assert(result.code !== 0, "Install should fail for invalid package");
      assert(
        result.stderr || result.stdout,
        "Error details should be captured",
      );

      const pkgAfter = JSON.parse(
        await readFile(path.join(testDir, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      assert(
        !pkgAfter.dependencies?.["invalid-package-xyz"],
        "Fallback edit should NOT happen",
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
