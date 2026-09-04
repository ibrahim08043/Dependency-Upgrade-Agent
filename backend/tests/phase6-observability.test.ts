/**
 * Phase 6 observability tests:
 *   - Enhanced event shape (stage, eventType, tool, durationMs)
 *   - Tool-call details in events
 *   - Command execution recording
 *   - Error classification
 *   - Secret redaction (no .env / API keys in events)
 *   - Bounded output (events capped at 5000)
 *   - Self-healing attempt tracking
 *   - Event ordering
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";

import app from "../src/app";
import { buildValidRepoZip } from "./zip-maker";
import type { MigrationEvent } from "../src/lib/migration-state";

let server: Server;
let base: string;
let migrationId: string;

before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/api`;

  // Bootstrap: upload a repo and create a migration
  const form = new FormData();
  form.append("file", new Blob([buildValidRepoZip()], { type: "application/zip" }), "test.zip");
  const repoRes = await fetch(`${base}/repositories/upload`, { method: "POST", body: form });
  assert.equal(repoRes.status, 201);
  const repo = (await repoRes.json()) as { id: string; dependencies: Array<{ name: string; version: string }> };
  const dep = repo.dependencies.find((d) => d.name === "axios");
  assert.ok(dep);
  const migrateRes = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repo.id, dependency: dep.name, targetMajor: "1", mode: "baseline" }),
  });
  assert.equal(migrateRes.status, 202);
  const mig = (await migrateRes.json()) as { id: string };
  migrationId = mig.id;

  // Wait for migration to finish (baseline mode is fast)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusRes = await fetch(`${base}/migrations/${migrationId}`);
    const status = (await statusRes.json()) as { status: string };
    if (status.status === "completed" || status.status === "failed") break;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── Enhanced event shape ──────────────────────────────────────────────────── */

test("events have required fields: id, migrationId, timestamp, level, message", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  assert.equal(res.status, 200);
  const events = (await res.json()) as MigrationEvent[];
  assert.ok(events.length > 0, "must have events");
  for (const event of events) {
    assert.equal(typeof event.id, "string", "event.id must be a string");
    assert.ok(event.id.length > 0, "event.id must be non-empty");
    assert.equal(event.migrationId, migrationId, "event.migrationId must match");
    assert.equal(typeof event.timestamp, "string", "event.timestamp must be a string");
    assert.ok(["info", "success", "warning", "error"].includes(event.level), `event.level must be valid, got: ${event.level}`);
    assert.equal(typeof event.message, "string", "event.message must be a string");
    assert.ok(event.message.length > 0, "event.message must be non-empty");
  }
});

test("events have structured fields when available (stage, eventType)", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  // At least some events should have the new structured fields
  const withStage = events.filter((e) => e.stage);
  const withEventType = events.filter((e) => e.eventType);
  assert.ok(withStage.length > 0, "at least some events should have a stage");
  assert.ok(withEventType.length > 0, "at least some events should have an eventType");
});

test("events are ordered by timestamp ascending", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  for (let i = 1; i < events.length; i++) {
    const prev = new Date(events[i - 1].timestamp).getTime();
    const curr = new Date(events[i].timestamp).getTime();
    assert.ok(prev <= curr, `events must be ordered: ${events[i - 1].timestamp} > ${events[i].timestamp}`);
  }
});

/* ── Tool-call details ─────────────────────────────────────────────────────── */

test("tool-related events have tool field and toolArgs/toolResult when available", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const toolEvents = events.filter((e) => e.eventType?.startsWith("tool_call"));
  // In baseline mode there may be no tool events — that's fine
  if (toolEvents.length > 0) {
    for (const e of toolEvents) {
      assert.ok(e.tool, `tool event ${e.id} must have a tool field`);
      assert.equal(typeof e.tool, "string");
    }
  }
});

/* ── Command execution recording ───────────────────────────────────────────── */

test("command-related events have command field and durationMs", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const cmdEvents = events.filter((e) => e.eventType?.startsWith("command_"));
  assert.ok(cmdEvents.length > 0, "must have command events (verification)");
  for (const e of cmdEvents) {
    assert.ok(e.command, `command event ${e.id} must have a command field`);
    assert.equal(typeof e.command, "string");
    assert.ok(e.command.length > 0);
    if (e.eventType !== "command_skip") {
      assert.equal(typeof e.durationMs, "number", "command events must have durationMs");
    }
  }
});

test("command events have exitCode when completed", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const completedCmds = events.filter((e) => e.eventType === "command_pass" || e.eventType === "command_fail");
  for (const e of completedCmds) {
    assert.equal(typeof e.exitCode, "number", `command event ${e.id} must have exitCode`);
  }
});

/* ── Error classification ──────────────────────────────────────────────────── */

test("failed events have errorCategory when applicable", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const errorEvents = events.filter((e) => e.level === "error");
  // Error events may or may not have errorCategory depending on the failure
  // But if they do, it must be a string
  for (const e of errorEvents) {
    if (e.errorCategory) {
      assert.equal(typeof e.errorCategory, "string");
      assert.ok(e.errorCategory.length > 0);
    }
  }
});

/* ── Secret redaction ──────────────────────────────────────────────────────── */

test("events never contain API keys, tokens, or .env contents", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const allText = JSON.stringify(events).toLowerCase();
  // Check for common secret patterns
  assert.ok(!allText.includes("api_key"), "events must not contain api_key");
  assert.ok(!allText.includes("secret_key"), "events must not contain secret_key");
  assert.ok(!allText.includes("access_token"), "events must not contain access_token");
  assert.ok(!allText.includes("bearer "), "events must not contain bearer tokens");
  assert.ok(!allText.includes("sk-"), "events must not contain OpenAI-style keys");
  assert.ok(!allText.includes("ghp_"), "events must not contain GitHub tokens");
  assert.ok(!allText.includes("password="), "events must not contain passwords");
});

test("toolArgs and toolResult are truncated (bounded)", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  for (const e of events) {
    if (e.toolArgs) {
      assert.ok(e.toolArgs.length <= 500, `toolArgs must be bounded, got length: ${e.toolArgs.length}`);
    }
    if (e.toolResult) {
      assert.ok(e.toolResult.length <= 500, `toolResult must be bounded, got length: ${e.toolResult.length}`);
    }
  }
});

/* ── Bounded event history ─────────────────────────────────────────────────── */

test("events endpoint returns a bounded list (not millions)", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  assert.ok(events.length <= 5000, `event count must be bounded, got: ${events.length}`);
});

/* ── Self-healing attempt tracking ─────────────────────────────────────────── */

test("attemptNumber is present on self-healing events when applicable", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/events`);
  const events = (await res.json()) as MigrationEvent[];
  const healEvents = events.filter((e) => e.eventType?.includes("diagnosis") || e.eventType?.includes("repair") || e.eventType?.includes("verify_retry"));
  for (const e of healEvents) {
    if (e.attemptNumber) {
      assert.equal(typeof e.attemptNumber, "number");
      assert.ok(e.attemptNumber >= 1, "attemptNumber must be >= 1");
    }
  }
});

/* ── Migration record has structured attempts ──────────────────────────────── */

test("migration attempts array has structured data with failureType and diagnosis", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}`);
  const mig = (await res.json()) as {
    attempts: Array<{
      number: number;
      result: string;
      failureType?: string;
      diagnosis?: string | null;
      filesChanged: number;
      command?: string;
      exitCode?: number;
      filesModified?: string[];
      filesInspected?: string[];
      patchResult?: string;
    }>;
  };
  assert.ok(Array.isArray(mig.attempts));
  if (mig.attempts.length > 0) {
    const first = mig.attempts[0];
    assert.equal(typeof first.number, "number");
    assert.ok(["PASS", "FAIL"].includes(first.result));
    assert.equal(typeof first.filesChanged, "number");
    if (first.result === "FAIL" && first.failureType) {
      assert.ok(typeof first.failureType === "string");
      assert.ok(first.failureType.length > 0);
    }
  }
});

/* ── AiStages tracking ──────────────────────────────────────────────────────── */

test("aiStages array tracks provider requests with stage/provider/model/status", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}`);
  const mig = (await res.json()) as {
    aiStages: Array<{
      stage: string;
      provider: string;
      model: string;
      requestStatus: string;
      success: boolean;
      timestamp: string;
    }>;
  };
  assert.ok(Array.isArray(mig.aiStages));
  // In baseline mode there should be no aiStages (no AI calls)
  // In agentic mode there would be — but we can't test that without quota
  for (const s of mig.aiStages) {
    assert.ok(s.stage, "aiStage must have a stage");
    assert.ok(s.provider, "aiStage must have a provider");
    assert.ok(typeof s.success === "boolean", "aiStage must have a success boolean");
    assert.ok(s.timestamp, "aiStage must have a timestamp");
  }
});

/* ── Verification commands ─────────────────────────────────────────────────── */

test("verificationCommands are recorded with structured data", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}`);
  const mig = (await res.json()) as {
    verificationCommands: Array<{
      command: string;
      status: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
    }>;
  };
  assert.ok(Array.isArray(mig.verificationCommands));
  assert.ok(mig.verificationCommands.length > 0, "must have verification commands");
  for (const cmd of mig.verificationCommands) {
    assert.ok(cmd.command, "verification command must have a command");
    assert.ok(["PASS", "FAIL", "SKIPPED", "TIMEOUT"].includes(cmd.status), `invalid status: ${cmd.status}`);
    assert.equal(typeof cmd.durationMs, "number");
    // Output must be bounded
    assert.ok(cmd.stdout.length <= 4000, "stdout must be bounded");
    assert.ok(cmd.stderr.length <= 4000, "stderr must be bounded");
  }
});
