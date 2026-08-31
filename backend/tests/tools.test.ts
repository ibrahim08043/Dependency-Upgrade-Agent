import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, seedRepo, cleanup, initGitRepo, makeToolContext } from "./helpers";
import readPackageJson from "../src/agents/tools/read-package-json";
import readConfig from "../src/agents/tools/read-config";
import applyPatch from "../src/agents/tools/apply-patch";
import getGitDiff from "../src/agents/tools/get-git-diff";
import runCommandTool from "../src/agents/tools/run-command";

// The fixture src/index.js has these exact lines:
// 1: const axios = require("axios");
// 2: const { get } = require("lodash");
// 3: async function fetchUser(id) {
// The patch below replaces lines 1-2 with one new import line.
// Old hunk: 3 lines (2 deletions + 1 context). New hunk: 2 lines (1 addition + 1 context).
const FIXTURE_PATCH = [
  "@@ -1,3 +1,2 @@",
  "-const axios = require(\"axios\");",
  "-const { get } = require(\"lodash\");",
  "+import axios from \"axios\";",
  " async function fetchUser(id) {",
].join("\n");

test("read_package_json returns structured dependencies and scripts", async () => {
  const root = await makeTempDir("dua-pkg-");
  try {
    await seedRepo(root);
    const ctx = await makeToolContext(root, root);
    const ok = await readPackageJson.run({}, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const result = ok.result as { dependencies: Record<string, string>; scripts: Record<string, string> };
      assert.equal(result.dependencies.axios, "^0.27.2");
      assert.ok("test" in result.scripts);
    }
  } finally {
    await cleanup(root);
  }
});

test("read_config reads allowed config and rejects others", async () => {
  const root = await makeTempDir("dua-cfg-");
  try {
    await seedRepo(root);
    await (await import("node:fs/promises")).writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
    const ctx = await makeToolContext(root, root);
    const ok = await readConfig.run({ path: "tsconfig.json" }, ctx);
    assert.equal(ok.ok, true);
    const blocked = await readConfig.run({ path: ".env" }, ctx);
    assert.equal(blocked.ok, false);
  } finally {
    await cleanup(root);
  }
});

test("apply_patch modifies a real file on disk", async () => {
  const root = await makeTempDir("dua-apply-");
  try {
    await seedRepo(root);
    await initGitRepo(root);
    const ctx = await makeToolContext(root, root);

    const contentBefore = await readFile(path.join(root, "src/index.js"), "utf8");
    const ok = await applyPatch.run({ path: "src/index.js", patch: FIXTURE_PATCH }, ctx);
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const after = await readFile(path.join(root, "src/index.js"), "utf8");
    assert.notEqual(after, contentBefore);
    assert.ok(after.includes("import axios from \"axios\";"));
    assert.ok(!after.includes("const axios = require"));

    // Backup was recorded under .agent-backups.
    // (We also add -N so new files appear; here existing file so direct check.)
    const backupDir = path.join(root, ".agent-backups");
    const entries = await (await import("node:fs/promises")).readdir(backupDir);
    assert.ok(entries.some((e) => e.includes("index")));
  } finally {
    await cleanup(root);
  }
});

test("get_git_diff returns real working-tree changes", async () => {
  const root = await makeTempDir("dua-diff-");
  try {
    await seedRepo(root);
    await initGitRepo(root);

    // Make a real modification on disk.
    const { writeFile } = await import("node:fs/promises");
    const indexPath = path.join(root, "src/index.js");
    const content = await readFile(indexPath, "utf8");
    await writeFile(indexPath, content.replace("const axios = require(\"axios\");", "import axios from \"axios\";"), "utf8");
    // New file too.
    await writeFile(path.join(root, "src/new.js"), "module.exports = 1;", "utf8");

    const ctx = await makeToolContext(root, root);
    const ok = await getGitDiff.run({}, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const result = ok.result as { filesChanged: number; files: Array<{ path: string; patch: string }> };
      assert.ok(result.filesChanged >= 2, `expected >=2, got ${result.filesChanged}`);
      const indexPatch = result.files.find((f) => f.path === "src/index.js");
      assert.ok(indexPatch, "src/index.js should be in the diff");
      assert.ok(indexPatch!.patch.includes("axios"));
    }
  } finally {
    await cleanup(root);
  }
});

test("run_command executes inside workspace and reports exit code", async () => {
  const root = await makeTempDir("dua-cmd-");
  try {
    await seedRepo(root);
    const ctx = await makeToolContext(root, root);
    const ok = await runCommandTool.run({ command: "node", args: ["-e", "console.log('hi')"] }, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const result = ok.result as { stdout: string; exit_code: number };
      assert.equal(result.exit_code, 0);
      assert.ok(result.stdout.includes("hi"));
    }
    // Failing command returns structured failure
    const fail = await runCommandTool.run({ command: "node", args: ["-e", "process.exit(3)"] }, ctx);
    assert.equal(fail.ok, false);
  } finally {
    await cleanup(root);
  }
});