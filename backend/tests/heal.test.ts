import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure, HealError, MAX_HEAL_ATTEMPTS } from "../src/lib/heal";
import { ScriptedDiagnosisProvider } from "./scripted-diagnosis-provider";
import type { FailureDiagnosisInput } from "../src/lib/heal";

const baseInput: FailureDiagnosisInput = {
  dependency: "express",
  oldVersion: "4",
  targetVersion: "5",
  researchSummary: "Confidence low",
  planSummary: "Upgrade express",
  impactSummary: "src/server.ts:1 IMPORT",
  failedCommands: [{ command: "npm run build", exitCode: 1, stdout: "error TS", stderr: "Cannot find module" }],
  filesModified: ["src/server.ts"],
  affectedFiles: ["src/server.ts"],
};

test("heal: MAX_HEAL_ATTEMPTS is bounded to 2", () => {
  assert.equal(MAX_HEAL_ATTEMPTS, 2);
});

test("heal: failure diagnosis returns a concise parsed summary", async () => {
  const provider = new ScriptedDiagnosisProvider({ valid: true, summary: "TS error: missing import in src/server.ts" });
  const d = await diagnoseFailure(provider, baseInput);
  assert.ok(d.summary.includes("src/server.ts"));
  assert.ok(d.failedCommands.includes("npm run build"));
});

test("heal: diagnosis surfaces failed commands even on empty summary", async () => {
  const provider = new ScriptedDiagnosisProvider({ valid: true, summary: "" });
  const d = await diagnoseFailure(provider, baseInput);
  assert.equal(d.summary, "No diagnosis summary returned.");
  assert.deepEqual(d.failedCommands, ["npm run build"]);
});

test("heal: unparseable Grok output throws HealError (never silent success)", async () => {
  const provider = new ScriptedDiagnosisProvider({ valid: false, summary: "not json at all" });
  await assert.rejects(() => diagnoseFailure(provider, baseInput), HealError);
});
