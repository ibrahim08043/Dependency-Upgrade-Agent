import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, ToolError, isAbsolutePath } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface WriteFileInput {
  path: string;
  content?: string;
}

const MAX_WRITE_BYTES = 512_000;

export default createTool<WriteFileInput>({
  name: "write_file",
  description:
    "Create a NEW file inside the workspace (fails if it already exists). For editing existing " +
    "files use apply_patch instead, which applies a minimal diff. This tool never overwrites " +
    "an existing file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path of the new file, e.g. src/new-module.js." },
      content: { type: "string", description: "Full contents for the new file." },
    },
    required: ["path", "content"],
  },
  async run(input, ctx) {
    const rel = String(input.path ?? "").trim();
    if (!rel) throw new ToolError("INVALID_PATH", "A file path is required.");
    if (isAbsolutePath(rel)) {
      throw new ToolError("INVALID_PATH", `Path must be relative inside the workspace: "${rel}"`, rel);
    }
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    const content = String(input.content ?? "");
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new ToolError("FILE_TOO_LARGE", `File contents exceed ${MAX_WRITE_BYTES} bytes.`, rel);
    }

    // Refuse to overwrite an existing file — use apply_patch for edits.
    const exists = await readFile(abs, "utf8")
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new ToolError("FILE_EXISTS", `"${rel}" already exists. Use apply_patch to modify existing files.`, rel);
    }

    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    ctx.log(`Created ${rel}`);
    return { ok: true, result: { path: rel, action: "created" } };
  },
});