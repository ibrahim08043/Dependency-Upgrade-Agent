/**
 * Correlate migration research with actual repository usage to produce evidence-based
 * risk levels. A usage is HIGH risk only when the repository actually references an API
 * that the research identifies as removed/renamed/changed (or a broad breaking change).
 * Otherwise it stays informational/low/medium — we do NOT classify everything as high risk.
 */
import type { MigrationFinding, MigrationResearch } from "./research-types";
import type { ImpactFinding, ImpactSummary, RiskLevel } from "./impact";

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/['"`]/g, "").replace(/\\/g, "");
}

function lowerKey(name: string): string {
  return name.replace(/[-_/]/g, "").toLowerCase();
}

/**
 * Return a set of normalized "at risk" API tokens derived from research: removed,
 * renamed (old name), and changed (old name) APIs are treated as the symbols a repo
 * should be checked against.
 */
export function researchRiskTokens(research: MigrationResearch): {
  removed: string[];
  renamed: string[];
  changed: string[];
  broad: boolean;
} {
  const norm = (list: string[]) =>
    list
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeSymbol)
      .map((s) => s.replace(/^(?:new\s+|old\s+)?/, ""))
      .map((s) => s.replace(/[().]/g, "").trim());

  const removed = norm(research.removedApis);
  const renamed = norm(research.renamedApis.map((r) => r.split(/(?:→|->|=>| is now renamed to | renamed to )/i)[0].trim()));
  const changed = norm(research.changedApis.map((c) => c.split(/ (?:→|->|=>) /i)[0].trim()));

  // Broad breaking changes (e.g. "Node 16 minimum") that aren't tied to one symbol.
  const broad =
    research.breakingChanges.some((b) => /node|engine|default export|esm|commonjs|cjs|minimum version|peer dependency/i.test(b)) &&
    research.breakingChanges.some((b) => /minimum|removed|no longer|breaking/i.test(b));

  return { removed, renamed, changed, broad };
}

function classify(usageLower: string, riskSet: { removed: string[]; renamed: string[]; changed: string[] }): RiskLevel {
  if (riskSet.removed.some((token) => usageLower.includes(lowerKey(token)))) return "high";
  if (riskSet.renamed.some((token) => usageLower.includes(lowerKey(token)))) return "high";
  if (riskSet.changed.some((token) => usageLower.includes(lowerKey(token)))) return "medium";
  return "informational";
}

export interface RiskInput {
  findings: ImpactFinding[];
  research: MigrationResearch;
}

export interface RiskResult {
  findings: ImpactFinding[];
  summary: ImpactSummary;
}

export function applyRiskToFindings({ findings, research }: RiskInput): RiskResult {
  const risk = researchRiskTokens(research);
  const out: ImpactFinding[] = findings.map((f) => {
    const usageLower = lowerKey(`${f.symbol} ${f.matchedCode} ${f.filePath}`);
    let level: RiskLevel = f.risk; // start from base classification

    // Research correlation overrides when a specific at-risk API is referenced.
    const correlated = classify(usageLower, risk);
    if (correlated === "high" || correlated === "medium") level = correlated;
    // Broad breaking changes raise informational config/manifest to medium.
    else if (risk.broad && level === "informational") level = "medium";

    return { ...f, risk: level };
  });

  const affectedFiles = new Set<string>();
  let high = 0;
  let medium = 0;
  let low = 0;
  const affectedApis = new Set<string>();
  const affectedConfig = new Set<string>();
  const affectedTests = new Set<string>();
  const affectedBuildLint = new Set<string>();

  for (const f of out) {
    affectedFiles.add(f.filePath);
    if (f.risk === "high") high += 1;
    else if (f.risk === "medium") medium += 1;
    else if (f.risk === "low") low += 1;

    if (f.usageType === "API_USAGE") affectedApis.add(f.symbol);
    if (f.usageType === "CONFIGURATION") affectedConfig.add(f.filePath);
    if (/test|spec/.test(f.filePath) || f.usageType === "TEST_USAGE") affectedTests.add(f.filePath);
    if (/tsconfig|vite|webpack|rollup|eslint|babel|build|\.config/.test(f.filePath)) affectedBuildLint.add(f.filePath);
  }

  return {
    findings: out,
    summary: {
      affectedFiles: affectedFiles.size,
      affectedUsages: out.length,
      high,
      medium,
      low,
      affectedApis: [...affectedApis],
      affectedConfig: [...affectedConfig],
      affectedTests: [...affectedTests],
      affectedBuildLint: [...affectedBuildLint],
      findings: out,
    },
  };
}
