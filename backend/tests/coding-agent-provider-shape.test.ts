import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, seedRepo, cleanup, initGitRepo } from "./helpers";
import { runCodingAgent } from "../src/agents/coding-agent";
import { XaiGrokProvider } from "../src/services/ai/grok";
import { saveRepository, createMigration, getMigration } from "../src/lib/migration-state";
import type { MigrationRecord, RepositoryRecord } from "../src/lib/migration-state";
import type { ToolCallRequest } from "../src/services/ai/types";

/**
 * Regression test for the coding-agent tool-loop REQUEST SHAPE.
 *
 * The multi-round tool loop previously sent assistant messages WITHOUT the
 * `tool_calls` array they must declare, so the follow-up `tool` result messages
 * referenced tool_call_ids the API never saw. Strict providers (Groq's Harmony
 * templater) reject this with a 400:
 *   "HarmonyError: EncodingError: Message=render failed: Tools should have a name!"
 *
 * This drives the REAL runCodingAgent orchestration against the REAL
 * XaiGrokProvider (with a recording fetch that returns scripted tool responses)
 * and asserts every outbound chat-completions request declares tool calls on
 * assistant messages and binds tool results to a matching declared id.
 */
let root: string;

// A fake but schema-valid gsk_ key (never a real credential): passes the
// invalidXaiKeyReason structural check, used only to construct the provider.
const FAKE_KEY = "gsk_" + "a".repeat(48);

interface RecordedRequest {
  body: {
    model: string;
    messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown }>;
    tools?: unknown;
  };
}

/** Returns scripted tool responses while recording each request body. */
function makeRecordingFetch(traces: RecordedRequest[]) {
  let round = 0;
  return async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as RecordedRequest["body"];
    round += 1;
    traces.push({ body });

    const make = (id: string, name: string, args: Record<string, unknown>): ToolCallRequest => ({
      id, name, arguments: JSON.stringify(args),
    });

    const calls: ToolCallRequest[] = [];
    if (round === 1) calls.push(make("call_r1", "read_package_json", {}));
    else if (round === 2) calls.push(make("call_r2", "list_files", {}));
    else if (round === 3) calls.push(make("call_r3", "search_code", { query: "require\\([\"']axios" }));
    else if (round === 4) calls.push(make("call_r4", "create_migration_plan", {
      dependency: "axios",
      from_version: "^0.27.2",
      target_version: "1.0.0",
      breaking_changes: ["CJS require works but ES import is preferred."],
      affected_files: ["src/index.js", "src/example.js"],
      planned_changes: ["Replace CommonJS requires with ES imports."],
      verification_commands: ["npm run build"],
    }));
    else if (round === 5) calls.push(make("call_r5", "read_file", { path: "src/index.js" }));
    else if (round === 6) calls.push(make("call_r6", "apply_patch", {
      path: "src/index.js",
      patch: [
        "@@ -1,3 +1,2 @@",
        "-const axios = require(\"axios\");",
        "-const { get } = require(\"lodash\");",
        "+import axios from \"axios\";",
        " async function fetchUser(id) {",
      ].join("\n"),
    }));
    else if (round === 7) calls.push(make("call_r7", "get_git_diff", {}));

    const content = round === 8
      ? JSON.stringify({ summary: "Migration complete.", no_changes_required: false })
      : `stable text round ${round}`;
    const message = {
      content,
      ...(calls.length
        ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ choices: [{ message }] }); },
      async json() { return { choices: [{ message }] }; },
    } as unknown as Response;
  };
}

before(async () => {
  root = await makeTempDir("dua-shape-");
  await seedRepo(root);
  await initGitRepo(root);

  const repository: RepositoryRecord = {
    id: "repo-shape", name: "fixture-repo", source: "zip", language: "JavaScript",
    packageManager: "npm", hasPackageJson: true, lockfile: null, framework: null,
    dependencies: [{ name: "axios", version: "^0.27.2", section: "dependencies" }],
    scripts: ["test", "build"], status: "analyzed", createdAt: new Date().toISOString(), rootPath: root,
  };
  const migration: MigrationRecord = {
    id: "mig-shape", repositoryId: repository.id, repositoryName: repository.name,
    dependency: "axios", oldVersion: "^0.27.2", targetVersion: "1.0.0", mode: "agentic",
    status: "running", currentStage: "agent", attemptNumber: 1,
    affectedFiles: 1, affectedUsages: 2, tests: "running", build: "running",
    typecheck: "running", lint: "running", errorCode: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    plan: null, impactFiles: ["src/index.js"], sources: [], changes: [], attempts: [],
    remainingIssues: [], diff: { filesChanged: 0, additions: 0, deletions: 0, files: [] },
  };
  await saveRepository(repository);
  await createMigration(migration);
});

after(async () => {
  await cleanup(root);
});

test("coding agent sends protocol-compliant tool_calls on assistant messages (Groq Harmony fix)", async () => {
  const mig = await getMigration("mig-shape");
  assert.ok(mig);

  const traces: RecordedRequest[] = [];
  const provider = new XaiGrokProvider({ XAI_API_KEY: FAKE_KEY }, makeRecordingFetch(traces));

  const result = await runCodingAgent(
    provider,
    {
      migrationId: mig!.id, workspaceRoot: root, originalRoot: root,
      dependency: "axios", currentVersion: "^0.27.2", targetMajor: "1", mode: "agentic",
    },
    { onEvent: () => {} },
  );

  // The real orchestration completed and the real tools changed the file.
  assert.equal(result.status, "completed");
  assert.equal(result.patchesApplied, 1);
  const after = await readFile(path.join(root, "src/index.js"), "utf8");
  assert.ok(after.includes("import axios from \"axios\";"), "real apply_patch changed the file");

  // Every assistant message that precedes tool results must DECLARE its tool_calls;
  // every tool message must bind to a tool_call_id declared by some assistant message.
  const allDeclaredIds = new Set<string>();
  let sawToolResult = false;
  for (const trace of traces) {
    for (const msg of trace.body.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<{ id?: string }>) {
          assert.ok(tc.id, "assistant tool_calls entry must have an id");
          allDeclaredIds.add(tc.id!);
        }
        assert.ok(msg.tool_calls.length > 0, "assistant message with tool_calls must be non-empty");
      }
      if (msg.role === "tool") {
        sawToolResult = true;
        assert.ok(msg.tool_call_id, "tool message must carry tool_call_id");
        assert.ok(
          allDeclaredIds.has(msg.tool_call_id!),
          `tool result tool_call_id ${msg.tool_call_id} must be declared by a prior assistant message`,
        );
      }
    }
  }
  assert.ok(sawToolResult, "at least one tool result was sent in the loop");
  assert.ok(allDeclaredIds.size >= 6, `expected >=6 tool calls declared, got ${allDeclaredIds.size}`);
});
