import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createRepositoryWorkspace,
  analyzeRepository,
  startMigration,
  setMigrationAgentProviderOverride,
} from "../src/lib/repository-agent";
import { getMigration, saveRepository } from "../src/lib/migration-state";
import { makeTempDir, cleanup } from "./helpers";

const execFileAsync = promisify(execFile);

// This test performs a REAL provider-powered migration with a REAL source edit.
// It is gated on any configured provider key (Groq/xAI/Gemini) so the normal CI
// suite never hits the live provider.
const hasKey = Boolean(process.env.XAI_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
const maybe = hasKey ? test : test.skip;

let fixtureDir: string;

before(async () => {
  fixtureDir = await makeTempDir("dua-real-fixture-");
  // Minimal disposable repo: chalk 4 as CommonJS require. Chalk 5 is pure ESM,
  // so the migration requires a real source change (ESM import + type:module).
  await mkdir(path.join(fixtureDir, "src"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "chalk-min",
        version: "1.0.0",
        scripts: {
          test: "node test.js",
          typecheck: "echo typecheck-ok",
          build: "echo build-ok",
          lint: "echo lint-ok",
        },
        dependencies: { chalk: "^4.1.2" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "src/index.js"),
    'const chalk = require("chalk");\nfunction hello(name) { return chalk.blue(`Hello, ${name}!`); }\nmodule.exports = { hello };\n',
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "test.js"),
    'const { hello } = require("./src/index.js");\nconst out = hello("world");\nif (typeof out !== "string" || out.length === 0) { throw new Error("bad output"); }\nconsole.log(out);\n',
    "utf8",
  );
});

after(async () => {
  await cleanup(fixtureDir);
  setMigrationAgentProviderOverride(null);
});

maybe(
  "REAL provider: coding agent performs a real source edit in a disposable repo",
  async () => {
    // Git init + baseline commit so the DIFF endpoint reflects real changes.
    await execFileAsync("git", ["init", "-q"], { cwd: fixtureDir });
    await execFileAsync("git", ["add", "-A"], { cwd: fixtureDir });
    await execFileAsync("git", ["commit", "-q", "-m", "baseline"], {
      cwd: fixtureDir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    await execFileAsync("git", ["archive", "--format=zip", "-o", "fixture.zip", "HEAD"], { cwd: fixtureDir });
    const zipPath = path.join(fixtureDir, "fixture.zip");
    const bytes = await readFile(zipPath);

    const workspace = await createRepositoryWorkspace(bytes, "fixture.zip");
    const repository = await analyzeRepository(workspace.rootPath, "zip");
    await saveRepository(repository);
    assert.ok(repository.dependencies.some((d) => d.name === "chalk"));

    // NO scripted override — the live provider (from the configured key) runs
    // research, synthesis, the coding agent, verification, and self-healing.
    setMigrationAgentProviderOverride(null);
    const migration = await startMigration(repository.id, "chalk", "5", "agentic");
    assert.equal(migration.status, "queued");

    const deadline = Date.now() + 300_000; // real provider + real install can take a while
    let finalMigration;
    let lastStatus: string = migration.status;
    while (Date.now() < deadline) {
      finalMigration = await getMigration(migration.id);
      if (finalMigration && finalMigration.status !== "queued" && finalMigration.status !== "running") break;
      if (finalMigration && finalMigration.status !== lastStatus) {
        lastStatus = finalMigration.status;
        console.log(`  [e2e] status -> ${lastStatus} (stage ${finalMigration?.currentStage})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(finalMigration, "migration must reach a terminal state");
    console.log(`  [e2e] FINAL status=${finalMigration.status} errorCode=${finalMigration.errorCode} stage=${finalMigration.currentStage}`);

    // THE core assertion: the coding agent made >=1 real patch (patchesApplied).
    const st = finalMigration.agentState;
    assert.ok(st, "agentState must be populated");
    assert.ok(
      (st.patchesApplied ?? 0) > 0,
      `coding agent must apply >=1 patch, got patchesApplied=${st.patchesApplied}, toolCalls=${JSON.stringify((st.toolCalls ?? []).map((t) => t.tool))}`,
    );
    assert.ok((st.filesModified ?? []).length > 0, "filesModified must be non-empty");

    // The dependency must be at the target major (5.x) after real npm install.
    const pkg = JSON.parse(await readFile(path.join(workspace.rootPath, "package.json"), "utf8"));
    assert.match(String(pkg.dependencies?.chalk ?? ""), /^\^?5\./, `chalk must be at major 5 (got ${pkg.dependencies?.chalk})`);

    // The real source edit must be visible on disk.
    const src = await readFile(path.join(workspace.rootPath, "src/index.js"), "utf8");
    console.log("  [e2e] src/index.js now:\n" + src.split("\n").slice(0, 6).map((l) => "    " + l).join("\n"));
    assert.ok(
      src.includes("import chalk") || src.includes('from "chalk"'),
      "source must reflect the ESM migration the agent chose",
    );

    // The final diff must contain BOTH source changes AND dependency changes.
    assert.ok(finalMigration.diff.filesChanged >= 1, "diff must be non-empty");
    const diffFilePaths = (finalMigration.diff.files ?? []).map((f) => f.path);
    console.log("  [e2e] diff files:", JSON.stringify(diffFilePaths));
    assert.ok(
      diffFilePaths.includes("src/index.js"),
      "diff must include the source file the agent edited",
    );
    assert.ok(
      (diffFilePaths.includes("package.json") || diffFilePaths.includes("package-lock.json")),
      "diff must include the dependency change",
    );
  },
);
