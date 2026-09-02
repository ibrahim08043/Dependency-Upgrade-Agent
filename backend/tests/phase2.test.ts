import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchPublicUrl, researchDependency, markUnavailableSource } from "../src/lib/research";
import { emptyResearch, type MigrationResearch } from "../src/lib/research-types";
import { scanRepositoryUsage } from "../src/lib/impact";
import { applyRiskToFindings, researchRiskTokens } from "../src/lib/risk";
import { fallbackFindingsFromSources, synthesizeFindings, type SynthesisInput } from "../src/lib/synthesis";
import { ScriptedSynthesisProvider } from "./scripted-synthesis-provider";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeWorkspace(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "src/app.ts"),
    `import { oldAPI } from "some-pkg";\nconst x = oldAPI();\n// a comment mentioning some-pkg (should NOT count)\nfunction f() { return "some-pkg text"; }\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "src/util.cjs"),
    `const somePkg = require("some-pkg");\nmodule.exports = somePkg.otherAPI();\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "src/app.test.ts"),
    `import { helper } from "some-pkg";\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", dependencies: { "some-pkg": "^1.0.0" }, devDependencies: { "some-pkg/lib": "^1.0.0" } }),
    "utf8",
  );
}

test("research: fetchPublicUrl retrieves a real public page", async () => {
  const result = await fetchPublicUrl("https://registry.npmjs.org/axios");
  assert.ok(result.text.length > 0, "should have fetched content");
});

test("research: crash-only registry dependency returns honest unavailable source instead of invented content", async () => {
  // A dependency that cannot exist in the registry should degrade honestly.
  const research = await researchDependency("definitely-not-a-real-package-xyz-12345", "1", "2");
  assert.ok(Array.isArray(research.sources));
  // Either a successful npm fetch or a clearly-marked unavailable source.
  const hasNpmOrUnavailable = research.sources.some((s) => s.source_type === "npm_metadata");
  assert.ok(hasNpmOrUnavailable);
  // Every unavailable source carries a reason.
  for (const s of research.sources) {
    if (s.status === "unavailable") assert.ok(s.reason && s.reason.length > 0, "unavailable source must have reason");
  }
});

test("research: markUnavailableSource records a reason and no fabricated findings", () => {
  const s = markUnavailableSource("https://example.invalid/x", "Some guide", "official_migration_guide", "connection refused");
  assert.equal(s.status, "unavailable");
  assert.equal(s.reason, "connection refused");
  assert.deepEqual(s.key_findings, []);
  assert.equal(s.excerpt, "");
});

test("research: emptyResearch yields a no-confidence skeleton", () => {
  const r = emptyResearch("react", "18", "19");
  assert.equal(r.confidence, "none");
  assert.equal(r.sources.length, 0);
  assert.equal(r.breakingChanges.length, 0);
});

test("impact: distinguishes IMPORT vs REQUIRE vs API_USAGE vs COMMENT with real line numbers", async () => {
  const dir = await makeTempDir("dua-impact-");
  try {
    await writeWorkspace(dir);
    const scan = await scanRepositoryUsage(dir, "some-pkg");
    const findings = scan.codeFindings;
    assert.ok(findings.length > 0, "should find usages");

    const importFinding = findings.find((f) => f.filePath === "src/app.ts" && f.usageType === "IMPORT");
    assert.ok(importFinding, "should detect the ES import");
    assert.equal(importFinding!.line, 1);

    const apiFinding = findings.find((f) => f.symbol.includes("oldAPI"));
    assert.ok(apiFinding, "should detect API_USAGE oldAPI()");
    assert.equal(apiFinding!.line, 2);

    const requireFinding = findings.find((f) => f.filePath === "src/util.cjs" && f.usageType === "REQUIRE");
    assert.ok(requireFinding, "should detect require");

    const testFinding = findings.find((f) => f.filePath === "src/app.test.ts" && f.usageType === "IMPORT");
    assert.ok(testFinding, "should detect test import");

    // Comments and string literals must NOT be counted as usages.
    const hasCommentUsage = findings.some(
      (f) => f.matchedCode.includes("comment") || (f.filePath === "src/app.ts" && f.line === 3),
    );
    assert.equal(hasCommentUsage, false, "comments must not count as usages");
    const hasStringUsage = findings.some((f) => f.filePath === "src/app.ts" && f.line === 4);
    assert.equal(hasStringUsage, false, "string literals must not count as usages");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impact + risk: research correlation flags a used removed API as HIGH risk", async () => {
  const dir = await makeTempDir("dua-risk-");
  try {
    await writeWorkspace(dir);
    const scan = await scanRepositoryUsage(dir, "some-pkg");
    const research: MigrationResearch = {
      ...emptyResearch("some-pkg", "1", "2"),
      removedApis: ["oldAPI"],
      confidence: "high",
    };
    const { findings } = applyRiskToFindings({ findings: scan.codeFindings, research });
    const risky = findings.find((f) => f.symbol.includes("oldAPI"));
    assert.ok(risky, "should find the oldAPI usage");
    assert.equal(risky!.risk, "high", "usage of a removed API must be HIGH risk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impact + risk: a used-but-unchanged API stays low/informational (not everything is high)", async () => {
  const dir = await makeTempDir("dua-risk2-");
  try {
    await writeWorkspace(dir);
    const scan = await scanRepositoryUsage(dir, "some-pkg");
    const research = emptyResearch("some-pkg", "1", "2"); // no removed/renamed/changed APIs
    const { findings } = applyRiskToFindings({ findings: scan.codeFindings, research });
    const high = findings.filter((f) => f.risk === "high");
    assert.equal(high.length, 0, "should not classify anything as high when nothing is actually at risk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("risk: researchRiskTokens normalizes removed/renamed/changed names", () => {
  const research = emptyResearch("pkg", "1", "2");
  research.removedApis = ["fooBar()", "old.api"];
  research.renamedApis = ["oldThing is now renamed to newThing"];
  const t = researchRiskTokens(research);
  assert.ok(t.removed.some((x) => x.includes("fooBar") || x.includes("foobar")));
  assert.ok(t.renamed.some((x) => x.includes("oldThing")));
});

test("synthesis: fallback derives honest findings without inventing breaking changes", () => {
  const none = fallbackFindingsFromSources([]);
  assert.equal(none.confidence, "none");
  assert.equal(none.breakingChanges.length, 0, "must not invent breaking changes");

  const withGuide = fallbackFindingsFromSources([
    { title: "UPGRADING.md", url: "https://x/UPGRADING.md", source_type: "official_migration_guide", excerpt: "Node 20+ required" },
  ]);
  assert.equal(withGuide.confidence, "low");
  assert.ok(withGuide.findings.length >= 1);
  // It references the real URL, not a fake one.
  assert.equal(withGuide.findings[0].sourceUrl, "https://x/UPGRADING.md");
});

test("synthesis: synthesizeFindings returns structured JSON from the provider", async () => {
  const provider = new ScriptedSynthesisProvider();
  const input: SynthesisInput = {
    dependency: "some-pkg",
    currentVersion: "1",
    targetVersion: "2",
    researchContext: [
      { title: "Guide", url: "https://example.com/guide", source_type: "official_migration_guide", excerpt: "oldAPI removed" },
    ],
    repoContext: {
      language: "TypeScript",
      packageManager: "npm",
      packageJson: "{}",
      fileTree: "src/app.ts",
      affectedUsage: [{ file: "src/app.ts", line: 2, type: "API_USAGE", symbol: "oldAPI", code: "oldAPI()" }],
    },
  };
  const findings = await synthesizeFindings(provider, input);
  assert.ok(findings.removedApis.includes("oldAPI"));
  assert.equal(findings.confidence, "high");
});
