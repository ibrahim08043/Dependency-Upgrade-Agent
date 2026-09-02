import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRepositoryWorkspace, analyzeRepository, startMigration, setMigrationAgentProviderOverride } from "../src/lib/repository-agent";
import { getMigration, saveRepository } from "../src/lib/migration-state";
import { ScriptedHealProvider } from "./scripted-heal-provider";

const execFileAsync = promisify(execFile);

let fixtureDir: string;

async function seedFailingRepo(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "heal-fixture",
      version: "1.0.0",
      scripts: { build: "tsc --noEmit", typecheck: "tsc --noEmit" },
      dependencies: { express: "^4.21.0" },
      devDependencies: { typescript: "^5.6.0", "@types/express": "^4.17.21", "@types/node": "^22.0.0" },
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, esModuleInterop: true, skipLibCheck: true } }),
    "utf8",
  );
  // Line 3 is a REAL type error that makes `tsc` fail.
  await writeFile(
    path.join(dir, "src/server.ts"),
    'import express from "express";\nconst app = express();\nconst broken: number = "bad";\n',
    "utf8",
  );
}

// The corrective patch fixes line 3 so `tsc` passes on the next attempt.
const FIX_PATCH = [
  "@@ -3 +3 @@",
  '-const broken: number = "bad";',
  "+const broken: number = 1;",
].join("\n");

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "dua-heal-"));
  await seedFailingRepo(fixtureDir);
  setMigrationAgentProviderOverride(new ScriptedHealProvider(FIX_PATCH));
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  setMigrationAgentProviderOverride(null);
});

test("self-healing: a genuinely-failing build is repaired within the 3-attempt bound (FAIL → PASS)", async () => {
  // Build a real zip from the git-committed failing fixture.
  await execFileAsync("git", ["init", "-q"], { cwd: fixtureDir });
  await execFileAsync("git", ["add", "-A"], { cwd: fixtureDir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: fixtureDir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  await execFileAsync("git", ["archive", "--format=zip", "-o", "fixture.zip", "HEAD"], { cwd: fixtureDir });
  const zipPath = path.join(fixtureDir, "fixture.zip");

  const workspace = await createRepositoryWorkspace(await readFile(zipPath), "heal.zip");
  const repository = await analyzeRepository(workspace.rootPath, "zip");
  await saveRepository(repository);

  const migration = await startMigration(repository.id, "express", "5", "agentic");
  const deadline = Date.now() + 180_000;
  let final;
  while (Date.now() < deadline) {
    final = await getMigration(migration.id);
    if (final && final.status !== "queued" && final.status !== "running") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(final, "migration should reach a terminal state");
  assert.equal(final.status, "completed", "the self-healing loop should repair the build");

  // At least attempts 1 (FAIL) and 2 (PASS), bounded to a max of 3.
  const attempts = final.attempts;
  assert.ok(attempts.length >= 2 && attempts.length <= 3, `expected 2-3 attempts, got ${attempts.length}`);
  assert.equal(attempts[0].result, "FAIL", "attempt 1 should fail on the genuine build error");
  assert.ok(attempts.some((a) => a.result === "PASS"), "a later attempt should pass after repair");

  // The corrective patch actually modified the file.
  const src = await readFile(path.join(workspace.rootPath, "src/server.ts"), "utf8");
  assert.ok(src.includes("const broken: number = 1;"), "repair should have fixed the type error");
});
