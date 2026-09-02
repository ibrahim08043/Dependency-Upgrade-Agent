/**
 * Repository-aware impact analysis.
 *
 * Unlike a naive "does the file mention <pkg>" search, this scanner classifies
 * *how* the dependency is actually used and records real line numbers. Comments
 * and unrelated string literals are not counted as usages.
 *
 * It is deliberately a lightweight structured-text scanner (regex + a small
 * state machine to skip comments/strings), not a full AST — matching the
 * project's "fallback: ripgrep / structured text search, do not overengineer"
 * guidance. It still distinguishes IMPORT, REQUIRE, API_USAGE, CONFIGURATION,
 * PACKAGE_MANIFEST, TEST_USAGE from COMMENT/IGNORED.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type UsageType =
  | "IMPORT"
  | "REQUIRE"
  | "API_USAGE"
  | "CONFIGURATION"
  | "PACKAGE_MANIFEST"
  | "TEST_USAGE"
  | "COMMENT";

export type RiskLevel = "high" | "medium" | "low" | "informational";

export interface ImpactFinding {
  filePath: string;
  line: number;
  usageType: UsageType;
  symbol: string;
  matchedCode: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  risk: RiskLevel;
}

export interface ImpactSummary {
  affectedFiles: number;
  affectedUsages: number;
  high: number;
  medium: number;
  low: number;
  affectedApis: string[];
  affectedConfig: string[];
  affectedTests: string[];
  affectedBuildLint: string[];
  /** Detailed per-file findings (persisted for the impact map). */
  findings?: ImpactFinding[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".data", "coverage", ".agent-backups"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|\.test-d\.)/;
const CONFIG_FILE_RE = /(?:tsconfig|vite\.config|next\.config|jest|vitest|eslint|babel|prettier|rollup|webpack|postcss|tailwind\.)/;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 700_000;

async function discoverFiles(workspaceRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(rel: string, abs: string) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await visit(childRel, childAbs);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await visit("", workspaceRoot);
  return out;
}

/**
 * Strip comments and string literals so only real code tokens remain, then scan.
 * Returns an array of "clean" lines aligned with the original line numbers.
 * (Single-line comments and literal strings are removed; block comments spanning
 * multiple lines are removed, preserving newlines so line numbers stay correct.)
 */
function maskCode(content: string): string[] {
  const lines: string[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") lineStarts.push(i + 1);

  // Build a masked copy where comments and string contents → spaces.
  let masked = "";
  let i = 0;
  const n = content.length;
  const pushSpaces = (from: number, to: number) => {
    while (from < to) { masked += content[from] === "\n" ? "\n" : " "; from += 1; }
  };
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    // line comment
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && content[j] !== "\n") j += 1;
      pushSpaces(i, j); i = j; continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j + 1 < n && !(content[j] === "*" && content[j + 1] === "/")) j += 1;
      const end = Math.min(n, j + 2);
      pushSpaces(i, end); i = end; continue;
    }
    // template literal (backtick) — treat inner content as non-code but keep the backticks
    if (ch === "`") {
      masked += "`";
      i += 1;
      let j = i;
      while (j < n && content[j] !== "`") {
        if (content[j] === "\\") { j += 2; continue; }
        masked += content[j] === "\n" ? "\n" : " ";
        j += 1;
      }
      i = j; continue;
    }
    // string literal
    if (ch === '"' || ch === "'") {
      masked += ch; i += 1; let j = i;
      while (j < n && content[j] !== ch) {
        if (content[j] === "\\") { masked += "  "; j += 2; continue; }
        // ${...} inside template-ish single quotes is rare; just blank it
        masked += content[j] === "\n" ? "\n" : " "; j += 1;
      }
      if (j < n) { masked += content[j]; j += 1; }
      i = j; continue;
    }
    masked += ch; i += 1;
  }

  // Split masked by original newlines.
  const out: string[] = [];
  let start = 0;
  for (const ls of lineStarts.slice(1)) {
    out.push(masked.slice(start, ls - 1));
    start = ls;
  }
  out.push(masked.slice(start));
  return out;
}

function detectImportsInLine(line: string, pkg: string): { symbol: string; matched: string } | null {
  // import { x } from "pkg";   import x from "pkg";   import * as x from "pkg";
  const importRe = new RegExp(
    `import\\s+(?:\\{[^}]*\\}|\\*\\s+as\\s+\\w+|\\w+)\\s+from\\s+["']${escapeRe(pkg)}["']`,
  );
  const m = line.match(importRe);
  if (m) return { symbol: pkg, matched: m[0].slice(0, 120) };
  // import "pkg";
  const sideRe = new RegExp(`import\\s+["']${escapeRe(pkg)}["']`);
  const sm = line.match(sideRe);
  if (sm) return { symbol: pkg, matched: sm[0].slice(0, 120) };
  // import { x } from "pkg/subpath"
  const subRe = new RegExp(`from\\s+["']${escapeRe(pkg)}\\/(?:[\\w.-]+)["']`);
  const subm = line.match(subRe);
  if (subm) return { symbol: pkg, matched: subm[0].slice(0, 120) };
  return null;
}

function detectRequireInLine(line: string, pkg: string): { symbol: string; matched: string } | null {
  const re = new RegExp(`require\\(\\s*["']${escapeRe(pkg)}(?:\\/[\\w.-]+)?["']\\s*\\)`);
  const m = line.match(re);
  if (m) return { symbol: pkg, matched: m[0].slice(0, 120) };
  return null;
}

/** Detect a member/namespace call like pkg.someApi(...) or pkg.someApi that references the package API. */
function detectApiUsageInLine(line: string, pkg: string, pkgShort: string): { symbol: string; matched: string; confidence: "high" | "medium" } | null {
  // full pkg: axios.get(..., _.get() style; also default-import alias usage
  const re = new RegExp(`\\b${escapeRe(pkg.replace(/[@/-]/g, "."))}\\.([A-Za-z_$][\\w$]*)`);
  const m = line.match(re);
  if (m) return { symbol: `${pkg}.${m[1]}`, matched: m[0].slice(0, 120), confidence: "high" };
  // scope package: @org/pkg
  if (pkg.startsWith("@")) {
    const scopedRe = new RegExp(`\\b${escapeRe(pkg.includes("/") ? pkg.substring(pkg.indexOf("/") + 1) : pkg)}\\.([A-Za-z_$][\\w$]*)`);
    const sm = line.match(scopedRe);
    if (sm) return { symbol: `${pkg}.${sm[1]}`, matched: sm[0].slice(0, 120), confidence: "medium" };
  }
  // bare short name used as an identifier (e.g. import default then foo.method)
  if (pkgShort && pkgShort !== pkg && !pkgShort.includes(".")) {
    const shortRe = new RegExp(`\\b${escapeRe(pkgShort)}\\.([A-Za-z_$][\\w$]*)`);
    const sm = line.match(shortRe);
    if (sm) return { symbol: `${pkgShort}.${sm[1]}`, matched: sm[0].slice(0, 120), confidence: "medium" };
  }
  return null;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect named/default imported symbols bound from the dependency in a line. */
function importedSymbols(line: string, pkg: string): string[] {
  const out: string[] = [];
  // import { a, b as c } from "pkg"
  const named = line.match(new RegExp(`import\\s+\\{([^}]*)\\}\\s+from\\s+["']${escapeRe(pkg)}(?:\\/[\\w.-]+)?["']`));
  if (named) {
    for (const part of named[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      // a as b  ->  b is the local name
      const as = t.split(/\s+as\s+/i);
      out.push((as[as.length - 1] ?? t).trim());
    }
  }
  // import default from "pkg"
  const def = line.match(new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["']${escapeRe(pkg)}["']`));
  if (def) out.push(def[1]);
  // const pkg = require("pkg")
  const req = line.match(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*["']${escapeRe(pkg)}(?:\\/[\\w.-]+)?["']`));
  if (req) out.push(req[1]);
  return out;
}

/** Detect bare use of an already-imported symbol (e.g. oldAPI() after import). */
function detectImportedSymbolUse(masked: string, symbol: string): boolean {
  const re = new RegExp(`\\b${escapeRe(symbol)}\\s*\\(`);
  return re.test(masked);
}

export interface ScanResult {
  /** Fine-grained findings (code files). */
  codeFindings: ImpactFinding[];
  /** Files that import/reference the dependency (deduped), for top-level summary. */
  impactedFiles: string[];
  /** Map of package.json → section presence. */
  manifestSections: string[];
  apiSymbols: Map<string, Set<string>>;
}

export async function scanRepositoryUsage(
  workspaceRoot: string,
  dependency: string,
): Promise<ScanResult> {
  const files = await discoverFiles(workspaceRoot);
  const codeFindings: ImpactFinding[] = [];
  const impactedFiles = new Set<string>();
  const manifestSections: string[] = [];
  const apiSymbols = new Map<string, Set<string>>();

  const pkgShort = dependency.includes("/") ? dependency.includes("@") && dependency.split("/").length > 1 ? dependency.split("/")[1] : dependency.split("/").pop() ?? dependency : dependency;

  const touch = (file: string, symbol: string) => {
    if (!apiSymbols.has(symbol)) apiSymbols.set(symbol, new Set());
    apiSymbols.get(symbol)!.add(file);
  };

  for (const rel of files) {
    const abs = path.join(workspaceRoot, rel);
    let size: number;
    let content: string;
    try {
      const info = await (await import("node:fs/promises")).stat(abs);
      size = info.size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    const ext = path.extname(rel);

    // package.json → PACKAGE_MANIFEST finding for the dependency's own entry.
    if (rel === "package.json" || rel.endsWith("/package.json")) {
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(content) as Record<string, unknown>;
      } catch {
        continue;
      }
      const foundSection = (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const).find((sec) =>
        typeof manifest[sec] === "object" && manifest[sec] != null && (manifest[sec] as Record<string, unknown>)[dependency] !== undefined,
      );
      if (foundSection) {
        manifestSections.push(foundSection);
        const version = (manifest[foundSection] as Record<string, string>)[dependency];
        codeFindings.push({
          filePath: rel,
          line: 0, // package.json has no meaningful import line; 0 = whole manifest
          usageType: "PACKAGE_MANIFEST",
          symbol: `${dependency}@${version}`,
          matchedCode: `${foundSection}.${dependency}`,
          reason: "Declared dependency version in package manifest",
          confidence: "high",
          risk: "informational",
        });
        impactedFiles.add(rel);
      }
      continue;
    }

    // Config files (JSON/JS) → CONFIGURATION when they reference the dependency.
    if (CONFIG_FILE_RE.test(rel) && (ext === ".json" || content.includes("require(") || content.includes("import "))) {
      const rawCfg = content.split(/\r?\n/);
      const maskedCfg = maskCode(content);
      for (let idx = 0; idx < Math.min(rawCfg.length, maskedCfg.length); idx += 1) {
        if (maskedCfg[idx].trim() === "") continue; // comment-only line
        if (rawCfg[idx].includes(dependency) && !/import\s+from|require\s*\(/.test(rawCfg[idx])) {
          codeFindings.push({
            filePath: rel, line: idx + 1, usageType: "CONFIGURATION",
            symbol: dependency, matchedCode: rawCfg[idx].trim().slice(0, 120),
            reason: "Dependency referenced in configuration file", confidence: "high", risk: "informational",
          });
          impactedFiles.add(rel);
          break;
        }
      }
      continue;
    }

    // Code files — two-pass: first collect the symbols imported from the
    // dependency, then detect direct + bare (imported-symbol) usages.
    if (!CODE_EXT.has(ext)) continue;
    const rawLines = content.split(/\r?\n/);
    const maskedLines = maskCode(content);
    const isTestFile = TEST_FILE_RE.test(rel);
    const n = Math.min(rawLines.length, maskedLines.length);

    const isRealCode = (idx: number) => (maskedLines[idx] ?? "").trim() !== "";
    const isImportOrRequireLine = (idx: number) => /import\s+|\brequire\s*\(/.test(maskedLines[idx] ?? "");

    // Pass 1 — imports/requires and their bound symbols.
    const localSymbols = new Set<string>();
    for (let idx = 0; idx < n; idx += 1) {
      if (!isRealCode(idx) || !isImportOrRequireLine(idx)) continue;
      const imp = detectImportsInLine(rawLines[idx], dependency);
      const req = detectRequireInLine(rawLines[idx], dependency);
      for (const sym of importedSymbols(rawLines[idx], dependency)) localSymbols.add(sym);
      if (!imp && !req) continue;
      const type: UsageType = imp ? "IMPORT" : "REQUIRE";
      const symbol = (imp ?? req)!.symbol;
      codeFindings.push({
        filePath: rel, line: idx + 1, usageType: type, symbol,
        matchedCode: (imp ?? req)!.matched,
        reason: isTestFile ? "Dependency imported in test file" : "Dependency imported in source file",
        confidence: "high",
        risk: isTestFile ? "low" : "medium",
      });
      impactedFiles.add(rel);
      touch(rel, symbol);
    }

    // Pass 2 — API usage: package.member, scoped short name, or bare imported symbol call.
    for (let idx = 0; idx < n; idx += 1) {
      if (!isRealCode(idx)) continue;
      const api = detectApiUsageInLine(maskedLines[idx], dependency, pkgShort);
      const bare = localSymbols.size > 0
        ? [...localSymbols].find((sym) => detectImportedSymbolUse(maskedLines[idx], sym))
        : undefined;
      if (api) {
        const symbol = api.symbol;
        codeFindings.push({
          filePath: rel, line: idx + 1, usageType: "API_USAGE", symbol,
          matchedCode: api.matched,
          reason: isTestFile ? "Dependency API used in test file" : "Dependency API used in source file",
          confidence: api.confidence,
          risk: isTestFile ? "low" : "medium",
        });
        impactedFiles.add(rel);
        touch(rel, symbol);
      } else if (bare) {
        codeFindings.push({
          filePath: rel, line: idx + 1, usageType: "API_USAGE", symbol: bare,
          matchedCode: maskedLines[idx].trim().slice(0, 120),
          reason: isTestFile ? `Imported ${bare} used in test file` : `Imported ${bare} used in source file`,
          confidence: "medium",
          risk: isTestFile ? "low" : "medium",
        });
        impactedFiles.add(rel);
        touch(rel, bare);
      }
    }
  }

  return { codeFindings, impactedFiles: [...impactedFiles], manifestSections, apiSymbols };
}
