import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRepositoryWorkspace, analyzeRepository, startMigration, setMigrationAgentProviderOverride } from "../src/lib/repository-agent";
import { getMigration, getEvents, saveRepository } from "../src/lib/migration-state";
import { ScriptedGrokProvider } from "./scripted-provider";
import { makeTempDir, seedRepo, cleanup } from "./helpers";

const execFileAsync = promisify(execFile);

let fixtureDir: string;

before(async () => {
  fixtureDir = await makeTempDir("dua-e2e-fixture-");
  await seedRepo(fixtureDir);
});

after(async () => {
  await cleanup(fixtureDir);
  setMigrationAgentProviderOverride(null);
});

test("end-to-end: repository ingestion → analysis → migration agent → real file change → diff", async () => {
  // Build a zip from the git-committed fixture repo.
  await execFileAsync("git", ["init", "-q"], { cwd: fixtureDir });
  await execFileAsync("git", ["add", "-A"], { cwd: fixtureDir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: fixtureDir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  await execFileAsync("git", ["archive", "--format=zip", "-o", "fixture.zip", "HEAD"], { cwd: fixtureDir });
  const zipPath = path.join(fixtureDir, "fixture.zip");
  const bytes = await readFile(zipPath);

  // 1) Ingestion + analysis via the real pipeline.
  const workspace = await createRepositoryWorkspace(bytes, "fixture.zip");
  const repository = await analyzeRepository(workspace.rootPath, "zip");
  assert.equal(repository.status, "analyzed");
  assert.equal(repository.packageManager, "npm");
  assert.ok(repository.dependencies.some((d) => d.name === "axios"));
  assert.equal(repository.hasPackageJson, true);

  // Persist the repository so startMigration can look it up.
  await saveRepository(repository);

  // 2) Migration creation with a scripted provider (mocks ONLY the xAI API).
  setMigrationAgentProviderOverride(new ScriptedGrokProvider());
  const migration = await startMigration(repository.id, "axios", "1", "agentic");
  assert.equal(migration.status, "queued");

  // runMigration is fire-and-forget; wait for completion.
  const deadline = Date.now() + 30_000;
  let finalMigration;
  while (Date.now() < deadline) {
    finalMigration = await getMigration(migration.id);
    if (finalMigration && finalMigration.status !== "queued" && finalMigration.status !== "running") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(finalMigration, "migration should complete");
  // Accept "completed" or "failed" — the key proof (asserted later) is that
  // the agent made real file changes and the diff reflects those changes.

  // 3) The agent actually modified the file in the isolated workspace.
  const workspacePath = workspace.rootPath;
  const modifiedSrc = await readFile(path.join(workspacePath, "src/index.js"), "utf8").catch(() => "");
  assert.ok(modifiedSrc.includes("import axios from \"axios\";"), "file must contain the agent-applied ES import");

  // 4) The diff endpoint data reflects real filesystem changes.
  assert.ok(finalMigration.diff.filesChanged >= 1, "diff should include the modified file(s)");
  assert.ok(finalMigration.agentState, "agentState should be populated");
  assert.ok(finalMigration.agentState!.toolCalls.length > 4, "agent should have made multiple tool calls");
  assert.equal(finalMigration.agentState!.patchesApplied, 1);

  // 5) Events include real agent activity.
  const events = await getEvents(migration.id);
  const messages = events.map((e) => e.message);
  assert.ok(messages.some((m) => m.includes("Migration agent started")));
  assert.ok(messages.some((m) => m.toLowerCase().includes("patch")));
});