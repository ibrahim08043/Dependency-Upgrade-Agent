import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface ListFilesInput {
  directory?: string; // relative
  depth?: number;
  max_results?: number;
}

const MAX_ENTRIES = 400;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".data"]);

async function walk(
  ctx: ToolContext,
  currentAbs: string,
  rel: string,
  depth: number,
): Promise<Array<{ path: string; type: "directory" | "file" }>> {
  let entries;
  try {
    entries = await readdir(currentAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; type: "directory" | "file" }> = [];
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) break;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ path: entryRel, type: "directory" });
      if (depth > 1) {
        out.push(...(await walk(ctx, path.join(currentAbs, entry.name), entryRel, depth - 1)));
      }
    } else {
      out.push({ path: entryRel, type: "file" });
    }
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

export default createTool<ListFilesInput>({
  name: "list_files",
  description:
    "List files and directories inside the migration workspace. Returns up to 400 entries " +
    "at a bounded depth. Pass a relative `directory` to scope the listing.",
  parameters: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Optional relative directory to list. Defaults to the workspace root.",
      },
      depth: { type: "integer", description: "Maximum recursion depth (1-4). Default 2." },
      max_results: { type: "integer", description: "Optional cap on returned entries." },
    },
  },
  async run(input, ctx) {
    const depth = Math.min(Math.max(Math.floor(input.depth ?? 2), 1), MAX_DEPTH);
    const rel = (input.directory ?? "").trim() || ".";
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel === "." ? "." : rel);
    const relForOutput = rel === "." ? "" : rel;
    const entries = await walk(ctx, abs, relForOutput, depth);
    const capped = input.max_results ? entries.slice(0, Math.max(1, Math.floor(input.max_results))) : entries;
    return { ok: true, result: { entries: capped, truncated: capped.length < entries.length } };
  },
});