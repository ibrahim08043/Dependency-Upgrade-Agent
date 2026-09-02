import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { saveMigration, getMigration, createMigration } from "../src/lib/migration-state";
import type { MigrationRecord } from "../src/lib/migration-state";
import { randomUUID } from "node:crypto";

function makeMigration(overrides: Partial<MigrationRecord> = {}): MigrationRecord {
  return {
    id: overrides.id ?? randomUUID(),
    repositoryId: "repo",
    repositoryName: "r",
    dependency: "express",
    oldVersion: "^4.21.0",
    targetVersion: "5",
    mode: "agentic",
    status: "queued",
    currentStage: "queued",
    attemptNumber: 0,
    affectedFiles: 0,
    affectedUsages: 0,
    tests: "running",
    build: "running",
    typecheck: "running",
    lint: "running",
    errorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: null,
    impactFiles: [],
    sources: [],
    changes: [],
    attempts: [],
    remainingIssues: [],
    diff: { filesChanged: 0, additions: 0, deletions: 0, files: [] },
    ...overrides,
  };
}

let createdIds: string[] = [];

before(async () => {
  createdIds = [];
});

after(async () => {
  // Clean up the created migrations from the shared state file.
  for (const id of createdIds) {
    const m = await getMigration(id);
    if (m) { m.status = "rejected"; await saveMigration(m); }
  }
});

test("state: attempts array persists rich self-healing fields", async () => {
  const m = makeMigration({ attempts: [{ number: 1, result: "FAIL", diagnosis: "TS error", filesChanged: 0, command: "npm run build", exitCode: 1, stderr: "Cannot find module" }] });
  await createMigration(m);
  createdIds.push(m.id);
  const loaded = await getMigration(m.id);
  assert.ok(loaded);
  assert.equal(loaded!.attempts[0].command, "npm run build");
  assert.equal(loaded!.attempts[0].exitCode, 1);
});

test("state: cancelled flag persists", async () => {
  const m = makeMigration({ cancelled: true });
  await createMigration(m);
  createdIds.push(m.id);
  const loaded = await getMigration(m.id);
  assert.equal(loaded!.cancelled, true);
});

test("state: verification command records persist", async () => {
  const m = makeMigration({
    verificationCommands: [{ command: "npm run typecheck", status: "SKIPPED", exitCode: null, stdout: "", stderr: "SKIPPED — no script found", durationMs: 0 }],
  });
  await createMigration(m);
  createdIds.push(m.id);
  const loaded = await getMigration(m.id);
  assert.equal(loaded!.verificationCommands![0].status, "SKIPPED");
});

test("state: baseline snapshot persists", async () => {
  const m = makeMigration({ baseline: { result: "FAIL", tests: "pass", build: "fail", typecheck: "fail", lint: "skipped", filesChanged: 2 } });
  await createMigration(m);
  createdIds.push(m.id);
  const loaded = await getMigration(m.id);
  assert.equal(loaded!.baseline!.result, "FAIL");
});
