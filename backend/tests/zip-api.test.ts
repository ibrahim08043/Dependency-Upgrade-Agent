import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";
import { rm } from "node:fs/promises";

import app from "../src/app";
import { getZipLimits } from "../src/lib/zip";
import { buildValidRepoZip, buildZip } from "./zip-maker";

let server: Server;
let base: string;

before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function upload(bytes: Buffer, filename: string, opts: { size?: boolean; name?: string } = {}): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/zip" }),
    opts.name ?? filename,
  );
  const headers: Record<string, string> = {};
  if (opts.size) headers["x-repository-name"] = filename;
  return fetch(`${base}/repositories/upload`, { method: "POST", body: form, headers });
}

test("api: ZIP upload success returns analyzed repository with real dependencies", async () => {
  const bytes = buildValidRepoZip();
  const res = await upload(bytes, "fixture.zip");
  assert.equal(res.status, 201);
  const repo = (await res.json()) as {
    id: string;
    status: string;
    packageManager: string;
    dependencies: Array<{ name: string; version: string }>;
    scripts: string[];
    language: string;
    rootPath?: never;
  };
  assert.equal(repo.status, "analyzed");
  assert.equal(repo.packageManager, "npm");
  assert.ok(repo.dependencies.some((d) => d.name === "axios"), "real dependency surfaced");
  assert.ok(repo.scripts.includes("test"), "scripts populated");
  assert.ok(repo.id, "unique repository id returned");
  // Root path must never leak to the client.
  assert.equal("rootPath" in repo, false, "rootPath must be stripped");
});

test("api: nested repo ZIP upload detects the nested root and dependency", async () => {
  const bytes = buildValidRepoZip({ nested: true, name: "nested-app" });
  const res = await upload(bytes, "nested.zip");
  assert.equal(res.status, 201);
  const repo = (await res.json()) as { name: string; status: string; dependencies: Array<{ name: string }> };
  assert.equal(repo.name, "nested-app");
  assert.equal(repo.status, "analyzed");
  assert.ok(repo.dependencies.some((d) => d.name === "axios"));
});

test("api: invalid (non-zip) upload returns 400 with a machine-readable error", async () => {
  const res = await upload(Buffer.from("this is definitely not a zip archive, just some long text padding"), "garbage.txt");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /INVALID_ZIP|INVALID_FILE_TYPE/, `expected a zip error, got: ${body.error}`);
});

test("api: empty upload returns 400 INVALID_FILE_TYPE", async () => {
  const res = await upload(Buffer.alloc(0), "empty.zip");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /INVALID_FILE_TYPE|EMPTY/);
});

test("api: path-traversal ZIP is rejected with ZIP_PATH_TRAVERSAL", async () => {
  const bytes = buildZip([{ name: "../../evil.txt", data: Buffer.from("bad") }]);
  const res = await upload(bytes, "malicious.zip");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /ZIP_PATH_TRAVERSAL/, `expected traversal error, got: ${body.error}`);
});

test("api: oversized upload (compressed > limit) is rejected with FILE_TOO_LARGE", async () => {
  // An upload larger than both the app's own maxUploadBytes and the 30MB
  // express.raw body cap is rejected. Depending on which guard trips first the
  // status is 400 (zip-config check) or 413 (body-parser), but both surface a
  // JSON { error: FILE_TOO_LARGE }.
  const bytes = Buffer.alloc(getZipLimits().maxUploadBytes + 50_000, 0x00);
  const res = await upload(bytes, "too-big.zip");
  assert.ok(res.status === 400 || res.status === 413, `expected 400/413, got ${res.status}`);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /FILE_TOO_LARGE/, `expected FILE_TOO_LARGE, got: ${body.error}`);
});

test("api: ZIP with no package.json returns an analyzed=invalid repo (honest, no fake deps)", async () => {
  const bytes = buildZip([{ name: "README.md", data: Buffer.from("# readme") }]);
  const res = await upload(bytes, "readme.zip");
  assert.equal(res.status, 201); // still 201 — analysis completes with status 'invalid'
  const repo = (await res.json()) as { status: string; hasPackageJson: boolean; dependencies: unknown[] };
  assert.equal(repo.status, "invalid");
  assert.equal(repo.hasPackageJson, false);
  assert.equal(repo.dependencies.length, 0);
});

test("api: startMigration rejects a dependency that isn't in the uploaded repo", async () => {
  // Upload a repo, then try to start a migration on a dependency it does not have.
  const bytes = buildValidRepoZip();
  const res = await upload(bytes, "fixture.zip");
  const repo = (await res.json()) as { id: string };
  const migrate = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repo.id, dependency: "not-a-real-dep", targetMajor: "9", mode: "agentic" }),
  });
  assert.equal(migrate.status, 400);
  const body = (await migrate.json()) as { error: string };
  assert.match(body.error, /DEPENDENCY_NOT_FOUND/);
});

test("api e2e: full intake flow — upload → analysis → dependency selection → migration creation", async () => {
  const bytes = buildValidRepoZip();
  const res = await upload(bytes, "full-e2e.zip");
  assert.equal(res.status, 201);
  const repo = (await res.json()) as { id: string; status: string; dependencies: Array<{ name: string; version: string }> };
  assert.equal(repo.status, "analyzed");
  const dep = repo.dependencies.find((d) => d.name === "axios");
  assert.ok(dep, "axios must be selectable");
  assert.match(dep!.version, /^[\d^~]/, "version present");
  // Create a migration on the real repo — validates the full chain up to queuing.
  const migrate = await fetch(`${base}/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repo.id, dependency: dep!.name, targetMajor: dep!.version.match(/\d+/)?.[0] ?? "0", mode: "baseline" }),
  });
  assert.equal(migrate.status, 202);
  const mig = (await migrate.json()) as { id: string; status: string; dependency: string; mode: string };
  assert.equal(mig.dependency, "axios");
  assert.equal(mig.mode, "baseline");
  assert.equal(mig.status, "queued");
  // Confirm the migration record appears in the list.
  const list = await fetch(`${base}/migrations`);
  const all = (await list.json()) as Array<{ id: string }>;
  assert.ok(all.some((m) => m.id === mig.id), "newly created migration must appear in list");
});