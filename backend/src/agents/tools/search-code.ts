import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, ToolError } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface SearchCodeInput {
  query: string;
  path?: string;
  pattern?: string; // file glob, e.g. "*.ts"
  max_results?: number;
}

// Skip heavy/noise directories.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".data", "coverage"]);

const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 2000;

function toRegex(query: string): RegExp | null {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
}

/** Very light glob: `*` anywhere becomes `.*`. Used only to pre-filter file names. */
function simpleGlob(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

async function discoverFiles(ctx: ToolContext, startRel: string): Promise<string[]> {
  const out: string[] = [];
  const startAbs = resolveInWorkspace(ctx.workspaceRoot, startRel);
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
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await visit(childRel, childAbs);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await visit(startRel === "." || startRel === "" ? "" : startRel.replace(/\/$/, ""), startAbs);
  return out;
}

export default createTool<SearchCodeInput>({
  name: "search_code",
  description:
    "Search the repository for text or a regular expression and return matching lines " +
    "with file paths and line numbers. Uses a case-insensitive regex. Optionally scope to a " +
    "subdirectory and/or a filename pattern (e.g. *.ts, *.tsx).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain text or a JavaScript regular expression to search for." },
      path: { type: "string", description: "Optional relative subdirectory to search within." },
      pattern: { type: "string", description: "Optional filename glob filter, e.g. *.tsx or src/**." },
      max_results: { type: "integer", description: "Optional cap on returned matches." },
    },
    required: ["query"],
  },
  async run(input, ctx) {
    if (!input.query || typeof input.query !== "string") throw new ToolError("INVALID_INPUT", "A query is required.");
    const regex = toRegex(input.query);
    if (!regex) throw new ToolError("INVALID_REGEX", `Could not parse query as a regular expression: "${input.query}"`);
    const scopeRel = (input.path ?? "").trim() || ".";
    const filePattern = input.pattern ? simpleGlob(String(input.pattern)) : null;

    const files = await discoverFiles(ctx, scopeRel);
    const results: Array<{ file: string; line: number; text: string }> = [];
    for (const rel of files) {
      if (results.length >= MAX_MATCHES) break;
      if (filePattern && !filePattern.test(path.basename(rel))) continue;
      const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
      let info;
      try {
        info = await (await import("node:fs/promises")).stat(abs);
      } catch {
        continue;
      }
      if (info.size > MAX_FILE_BYTES) continue;
      let lines: string[];
      try {
        lines = (await readFile(abs, "utf8")).split(/\r?\n/);
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          results.push({ file: rel, line: i + 1, text: lines[i].slice(0, 240) });
          if (results.length >= MAX_MATCHES) break;
        }
      }
    }
    const capped = input.max_results ? results.slice(0, Math.max(1, Math.floor(input.max_results))) : results;
    return { ok: true, result: { matches: capped, truncated: capped.length < results.length, total: results.length } };
  },
});