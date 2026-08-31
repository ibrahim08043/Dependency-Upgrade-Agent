import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, ToolError } from "./path";
import { createTool } from "./tool-factory";
import type { ToolContext } from "./context";

interface PackageJsonInput {
  path?: string; // optional directory or file within workspace
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export default createTool<PackageJsonInput>({
  name: "read_package_json",
  description:
    "Read the workspace's package.json and return its name, version, scripts, and all " +
    "dependency sections. Pass an optional relative directory to point at a sub-package.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional relative directory or package.json path." },
    },
  },
  async run(input, ctx) {
    const baseRel = (input.path ?? "").trim();
    const candidate =
      baseRel === ""
        ? resolveInWorkspace(ctx.workspaceRoot, "package.json")
        : baseRel.endsWith("package.json")
          ? resolveInWorkspace(ctx.workspaceRoot, baseRel)
          : path.join(resolveInWorkspace(ctx.workspaceRoot, baseRel), "package.json");

    // Guard: the resolved path must still be inside the workspace.
    if (!candidate.startsWith(ctx.workspaceRoot)) {
      throw new ToolError("OUTSIDE_WORKSPACE", "package.json path escapes the workspace.", baseRel);
    }

    let raw: string;
    try {
      raw = await readFile(candidate, "utf8");
    } catch {
      throw new ToolError("FILE_NOT_FOUND", `No package.json found at "${baseRel || "."}".`, baseRel);
    }
    let pkg: PackageJsonShape;
    try {
      pkg = JSON.parse(raw) as PackageJsonShape;
    } catch {
      throw new ToolError("PARSE_ERROR", `package.json at "${baseRel || "."}" is not valid JSON.`, baseRel);
    }
    const { dependencies = {}, devDependencies = {}, peerDependencies = {}, optionalDependencies = {} } = pkg;
    return {
      ok: true,
      result: {
        name: pkg.name,
        version: pkg.version,
        packageManager: pkg.packageManager ?? ctx.repository.packageManager,
        scripts: pkg.scripts ?? {},
        dependencies,
        devDependencies,
        peerDependencies,
        optionalDependencies,
      },
    };
  },
});