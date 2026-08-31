import { readFile } from "node:fs/promises";
import { resolveInWorkspace, ToolError } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

/** Config files the agent may read. Everything else is denied. */
const CONFIG_FILENAMES = new Set([
  "tsconfig.json",
  "tsconfig.base.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  "babel.config.js",
  "babel.config.json",
  ".babelrc",
  ".babelrc.json",
  "jest.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  ".prettierrc",
  ".prettierrc.json",
  ".npmrc",
  ".nvmrc",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
]);

interface ReadConfigInput {
  path: string;
  max_bytes?: number;
}

const MAX_BYTES = 200_000;

export default createTool<ReadConfigInput>({
  name: "read_config",
  description:
    "Read a project configuration file by basename (tsconfig.json, vite.config.*, next.config.*, " +
    "eslint.config.*, .eslintrc*, babel.config.*, jest/vitest config, prettier, lockfiles). " +
    "This is limited to known configuration files — arbitrary filesystem access is denied.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to a known configuration file." },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const rel = String(input.path ?? "").trim();
    if (!rel) throw new ToolError("INVALID_PATH", "A config file path is required.");
    const basename = rel.split("/").pop() ?? rel;
    if (!CONFIG_FILENAMES.has(basename)) {
      throw new ToolError("CONFIG_NOT_ALLOWED", `"${rel}" is not in the allow-listed config files.`, rel);
    }
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      throw new ToolError("FILE_NOT_FOUND", `Configuration file "${rel}" does not exist.`, rel);
    }
    if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES) + "\n…(truncated)";
    return { ok: true, result: { path: rel, content } };
  },
});