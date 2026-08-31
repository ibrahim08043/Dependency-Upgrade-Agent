import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, seedRepo, cleanup, initGitRepo } from "./helpers";
import { ScriptedGrokProvider } from "./scripted-provider";
import { runCodingAgent } from "../src/agents/coding-agent";
import { saveRepository, createMigration, getMigration } from "../src/lib/migration-state";
import type { MigrationRecord, RepositoryRecord } from "../src/lib/migration-state";

let root: string;

before(async () => {
  root = await makeTempDir("dua-agent-");
  await seedRepo(root);
  await initGitRepo(root);

  const repository: RepositoryRecord = {
    id: "repo-test",
    name: "fixture-repo",
    source: "zip",
    language: "JavaScript",
    packageManager: "npm",
    hasPackageJson: true,
    lockfile: null,
    framework: null,
    dependencies: [{ name: "axios", version: "^0.27.2", section: "dependencies" }],
    scripts: ["test", "build"],
    status: "analyzed",
    createdAt: new Date().toISOString(),
    rootPath: root,
  };
  const migration: MigrationRecord = {
    id: "mig-test",
    repositoryId: repository.id,
    repositoryName: repository.name,
    dependency: "axios",
    oldVersion: "^0.27.2",
    targetVersion: "1.0.0",
    mode: "agentic",
    status: "running",
    currentStage: "agent",
    attemptNumber: 1,
    affectedFiles: 1,
    affectedUsages: 2,
    tests: "running",
    build: "running",
    typecheck: "running",
    lint: "running",
    errorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: null,
    impactFiles: ["src/index.js"],
    sources: [],
    changes: [],
    attempts: [],
    remainingIssues: [],
    diff: { filesChanged: 0, additions: 0, deletions: 0, files: [] },
  };
  await saveRepository(repository);
  await createMigration(migration);
});

after(async () => {
  await cleanup(root);
});

test("coding agent runs real tools, modifies files, and records state", async () => {
  const mig = await getMigration("mig-test");
  assert.ok(mig, "fixture migration should be persisted");

  const provider = new ScriptedGrokProvider();
  const result = await runCodingAgent(
    provider,
    {
      migrationId: mig!.id,
      workspaceRoot: root,
      originalRoot: root,
      dependency: "axios",
      currentVersion: "^0.27.2",
      targetMajor: "1",
      mode: "agentic",
    },
    { onEvent: () => {} },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.patchesApplied, 1);
  assert.deepEqual(result.filesModified, ["src/index.js"]);

  // REAL filesystem change:
  const after = await readFile(path.join(root, "src/index.js"), "utf8");
  assert.ok(after.includes("import axios from \"axios\";"), "file must actually change on disk");

  assert.ok(result.agentState.toolCalls.length > 4, `expected >4 tool calls, got ${result.agentState.toolCalls.length}`);
  assert.ok(result.agentState.filesInspected.includes("src/index.js"));
  assert.ok(result.plan, "plan should be captured");
  assert.equal(result.plan!.dependency, "axios");
});

test("agent state and plan are persisted on the migration", async () => {
  const mig = await getMigration("mig-test");
  if (!mig) throw new Error("migration not found");
  assert.equal(mig.agentState?.patchesApplied, 1, "patchesApplied should be 1");
  assert.deepEqual(mig.agentState?.filesModified, ["src/index.js"]);
  assert.ok(mig.plan, "plan persisted on migration");
  assert.ok(mig.plan!.plannedChanges.length >= 0);
  assert.ok(mig.plan!.summary.length > 0);
});