import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Create a temp dir under os tempdir (Windows-friendly). */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function seedRepo(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-repo",
        version: "1.0.0",
        scripts: { test: "echo test-ok", build: "echo build-ok" },
        dependencies: { axios: "^0.27.2" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(dir, "src/index.js"),
    `const axios = require("axios");\nconst { get } = require("lodash");\nasync function fetchUser(id) {\n  const { data } = await axios.get(\`https://api.example.com/users/\${id}\`);\n  return get(data, "name", "unknown");\n}\nmodule.exports = { fetchUser };\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "src/example.js"),
    `const axios = require("axios");\nfunction listUsers() { return axios.get("/users"); }\nmodule.exports = { listUsers };\n`,
    "utf8",
  );
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Build a fake workspace for tools without git. */
export async function buildToolWorkspace(): Promise<{ root: string; original: string }> {
  const root = await makeTempDir("dua-tool-ws-");
  await seedRepo(root);
  // original = a copy for before-state tracking
  const original = await makeTempDir("dua-tool-orig-");
  await seedRepo(original);
  return { root, original };
}

export async function makeToolContext(workspaceRoot: string, originalRoot: string, migrationId = "test-migration") {
  return {
    migrationId,
    repositoryId: "test-repo",
    workspaceRoot,
    originalRoot,
    repository: {
      id: "test-repo",
      name: "fixture-repo",
      source: "zip" as const,
      language: "JavaScript",
      packageManager: "npm" as const,
      hasPackageJson: true,
      lockfile: null,
      framework: null,
      dependencies: [{ name: "axios", version: "^0.27.2", section: "dependencies" as const }],
      scripts: ["test", "build"],
      status: "analyzed" as const,
      createdAt: new Date().toISOString(),
      rootPath: workspaceRoot,
    },
    env: { targetMajor: "1", dependency: "axios", currentVersion: "^0.27.2" },
    log: () => undefined,
  };
}

export async function initGitRepo(dir: string): Promise<void> {
  const { runCommand } = await import("../src/lib/run-command");
  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@test"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "baseline"], { cwd: dir });
}

export function fixtureRepo(): { name: string; deps: Array<{ name: string; version: string }>; scripts: string[] } {
  return {
    name: "fixture-repo",
    deps: [{ name: "axios", version: "^0.27.2" }],
    scripts: ["test", "build"],
  };
}