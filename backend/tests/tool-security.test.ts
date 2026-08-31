import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildToolWorkspace, cleanup, makeToolContext } from "./helpers";
import { resolveInWorkspace, ToolError } from "../src/agents/tools/path";
import listFiles from "../src/agents/tools/list-files";
import readFileTool from "../src/agents/tools/read-file";
import writeFileTool from "../src/agents/tools/write-file";
import searchCode from "../src/agents/tools/search-code";
import { executeTool } from "../src/agents/tools";
import type { ToolContext } from "../src/agents/tools/context";

test("path resolution rejects traversal", () => {
  const root = "C:\\tmp\\ws";
  assert.throws(() => resolveInWorkspace(root, "../secret.txt"), ToolError);
  assert.throws(() => resolveInWorkspace(root, "a/../../secret.txt"), ToolError);
  assert.throws(() => resolveInWorkspace(root, "/etc/passwd"), ToolError);
  assert.throws(() => resolveInWorkspace(root, "C:\\windows\\system32"), ToolError);
});

test("path resolution rejects escapes even when normalized", () => {
  // "a//.." collapses but explicit ".." is rejected up front; a plainly
  // absolute path must also fail after backslash->slash normalization.
  const root = "C:\\tmp\\ws";
  assert.throws(() => resolveInWorkspace(root, "C:/tmp/ws/../../../etc"), ToolError);
});

test("list_files stays inside workspace and bounds output", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const ok = await listFiles.run({ directory: "src" }, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const entries = ok.result as { entries: Array<{ path: string; type: string }> };
      assert.ok(entries.entries.length >= 2);
      assert.ok(entries.entries.every((e) => !e.path.includes("..")));
    }
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("read_file refuses outside workspace and directories", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const outside = await readFileTool.run({ path: "../outside.txt" }, ctx);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.errorType, "INVALID_PATH");

    const dir = await readFileTool.run({ path: "src" }, ctx);
    assert.equal(dir.ok, false);
    if (!dir.ok) assert.equal(dir.errorType, "IS_DIRECTORY");

    const missing = await readFileTool.run({ path: "nope.js" }, ctx);
    assert.equal(missing.ok, false);
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("write_file refuses to overwrite existing files", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const dup = await writeFileTool.run({ path: "src/index.js", content: "x" }, ctx);
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.errorType, "FILE_EXISTS");

    const created = await writeFileTool.run({ path: "src/new.js", content: "module.exports = 1;" }, ctx);
    assert.equal(created.ok, true);
    const content = await readFile(path.join(root, "src/new.js"), "utf8");
    assert.equal(content, "module.exports = 1;");
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("search_code returns real matches with line numbers", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const ok = await searchCode.run({ query: "axios" }, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const matches = (ok.result as { matches: Array<{ file: string; line: number; text: string }> }).matches;
      assert.ok(matches.length >= 2, `expected >=2 matches, got ${matches.length}`);
      assert.ok(matches.some((m) => m.file.endsWith("src/index.js")));
    }
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("unknown tool returns structured error", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const result = await executeTool("definitely_not_a_tool", {}, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorType, "UNKNOWN_TOOL");
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("read_config blocks arbitrary files", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const blocked = await executeTool("read_config", { path: "src/index.js" }, ctx);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.errorType, "CONFIG_NOT_ALLOWED");
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("run_command rejects disallowed commands", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const blocked = await executeTool("run_command", { command: "rm", args: ["-rf", "/"] }, ctx);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.errorType, "COMMAND_NOT_ALLOWED");

    const blocked2 = await executeTool("run_command", { command: "git", args: ["push"] }, ctx);
    assert.equal(blocked2.ok, false);
    if (!blocked2.ok) assert.equal(blocked2.errorType, "COMMAND_NOT_ALLOWED");
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("run_command cwd escape rejected", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const blocked = await executeTool("run_command", { command: "npm", args: ["run", "test"], cwd: "../../" }, ctx);
    assert.equal(blocked.ok, false);
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("write_file absolute path rejected", async () => {
  const { root, original } = await buildToolWorkspace();
  try {
    const ctx = await makeToolContext(root, original);
    const blocked = await writeFileTool.run({ path: path.join(root, "escaped.js"), content: "x" }, ctx);
    assert.equal(blocked.ok, false);
  } finally {
    await cleanup(root);
    await cleanup(original);
  }
});

test("ToolContext type sanity", () => {
  void (null as unknown as ToolContext);
});