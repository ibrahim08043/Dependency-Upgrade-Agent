import { readFile, stat } from "node:fs/promises";
import { resolveInWorkspace, ToolError } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface ReadFileInput {
  path: string;
  max_bytes?: number;
}

const MAX_FILE_BYTES = 256_000;

export default createTool<ReadFileInput>({
  name: "read_file",
  description:
    "Read the contents of a file inside the workspace by its relative path. " +
    "Rejects paths that escape the workspace and files larger than 256KB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path of the file to read, e.g. src/index.js." },
      max_bytes: { type: "integer", description: "Optional read cap in bytes (default 256000)." },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const info = await stat(abs);
    if (info.isDirectory()) {
      throw new ToolError("IS_DIRECTORY", `"${input.path}" is a directory; use list_files instead.`, input.path);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError("FILE_TOO_LARGE", `"${input.path}" is ${info.size} bytes (limit ${MAX_FILE_BYTES}).`, input.path);
    }
    const content = await readFile(abs, "utf8");
    return { ok: true, result: { path: input.path, size: info.size, content } };
  },
});