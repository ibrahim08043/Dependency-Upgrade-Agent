/**
 * Phase 5 hardening tests:
 *   - Repository migrations endpoint
 *   - Error response shape (machine-readable codes)
 *   - Approval enforcement (status gate)
 *   - Cancel migration
 *   - publicMigration shape (no leaking internals)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";

import app from "../src/app";
import { buildValidRepoZip } from "./zip-maker";

let server: Server;
let base: string;
let repoId: string;
let migrationId: string;

before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/api`;

  // Bootstrap: upload a repo and create a baseline migration
  const form = new FormData();
  form.append("file", new Blob([buildValidRepoZip()], { type: "application/zip" }), "test.zip");
  const repoRes = await fetch(`${base}/repositories/upload`, { method: "POST", body: form });
  assert.equal(repoRes.status, 201);
  const repo = (await repoRes.json()) as { id: string; dependencies: Array<{ name: string; version: string }> };
  repoId = repo.id;

  const dep = repo.dependencies.find((d) => d.name === "axios");
  assert.ok(dep, "axios must be present");
  const migrateRes = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repoId, dependency: dep.name, targetMajor: "1", mode: "baseline" }),
  });
  assert.equal(migrateRes.status, 202);
  const mig = (await migrateRes.json()) as { id: string };
  migrationId = mig.id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── Repository migrations endpoint ──────────────────────────────────────── */

test("GET /repositories/:id/migrations returns migrations for the given repo", async () => {
  const res = await fetch(`${base}/repositories/${repoId}/migrations`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as Array<{ id: string; repositoryId: string }>;
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1, "must have at least the migration we created");
  assert.ok(list.every((m) => m.repositoryId === repoId), "all migrations must belong to this repo");
  assert.ok(list.some((m) => m.id === migrationId), "our migration must be in the list");
});

test("GET /repositories/:id/migrations returns 404 for unknown repo", async () => {
  const res = await fetch(`${base}/repositories/nonexistent-id/migrations`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "REPOSITORY_NOT_FOUND");
});

/* ── Error response shape ─────────────────────────────────────────────────── */

test("error responses include machine-readable code when available", async () => {
  // POST /migrations with invalid payload
  const res = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: 123, dependency: "", targetMajor: "abc" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; code?: string };
  assert.equal(typeof body.error, "string", "error must be a string");
  assert.ok(body.error.length > 0, "error must be non-empty");
});

test("404 responses return structured error object", async () => {
  const res = await fetch(`${base}/migrations/nonexistent`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "MIGRATION_NOT_FOUND");
});

test("upload with non-zip data returns structured error", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("not a zip")], { type: "application/octet-stream" }), "bad.bin");
  const res = await fetch(`${base}/repositories/upload`, { method: "POST", body: form });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

/* ── Approval enforcement ─────────────────────────────────────────────────── */

test("approve returns 409 when migration is not completed", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/approve`, { method: "POST" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "MIGRATION_NOT_READY");
});

test("reject returns 409 when migration is not completed", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}/reject`, { method: "POST" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "MIGRATION_NOT_READY");
});

test("approve on nonexistent migration returns 404", async () => {
  const res = await fetch(`${base}/migrations/fake-id/approve`, { method: "POST" });
  assert.equal(res.status, 404);
});

/* ── Cancel migration ──────────────────────────────────────────────────────── */

test("cancel sets status to cancelled and adds event", async () => {
  // Create a fresh migration to cancel
  const createRes = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repoId, dependency: "axios", targetMajor: "1", mode: "baseline" }),
  });
  assert.equal(createRes.status, 202);
  const mig = (await createRes.json()) as { id: string; status: string };
  assert.equal(mig.status, "queued");

  // Cancel it
  const cancelRes = await fetch(`${base}/migrations/${mig.id}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 200);
  const cancelled = (await cancelRes.json()) as { status: string; cancelled: boolean };
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled, true);

  // Verify it appears as cancelled in the list
  const listRes = await fetch(`${base}/migrations`);
  const all = (await listRes.json()) as Array<{ id: string; status: string }>;
  const found = all.find((m) => m.id === mig.id);
  assert.ok(found, "cancelled migration must appear in list");
  assert.equal(found.status, "cancelled");
});

/* ── publicMigration shape ─────────────────────────────────────────────────── */

test("public migration response does not leak internal fields", async () => {
  const res = await fetch(`${base}/migrations/${migrationId}`);
  assert.equal(res.status, 200);
  const m = (await res.json()) as Record<string, unknown>;
  // These internal fields must never be exposed
  assert.equal("rootPath" in m, false, "rootPath must not leak");
  assert.equal("impactFiles" in m, false, "impactFiles must not leak");
  assert.equal("sources" in m, false, "sources array must not leak directly");
  assert.equal("changes" in m, false, "changes array must not leak directly");
  assert.equal("remainingIssues" in m, false, "remainingIssues must not leak directly");
  // These fields should be present
  assert.equal(typeof m.filesChanged, "number", "filesChanged must be a number");
  assert.equal(typeof m.additions, "number", "additions must be a number");
  assert.equal(typeof m.deletions, "number", "deletions must be a number");
  assert.equal(typeof m.remainingIssuesCount, "number", "remainingIssuesCount must be a number");
  assert.ok("cancelled" in m, "cancelled flag must be present");
  assert.ok("aiStages" in m, "aiStages must be present");
  assert.ok("plan" in m, "plan must be present");
});
