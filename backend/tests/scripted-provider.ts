import type { ChatMessage, GrokCompletionResponse, GrokProvider, ToolCallRequest, ToolDefinition } from "../src/services/ai/types";

/**
 * A scripted Grok provider used in tests. It plays the role of the xAI API
 * boundary (the ONLY mocked external component) while every tool call goes
 * through the real backend tool implementations against the real filesystem.
 *
 * The script drives the agent to: read package.json → list files → search →
 * plan → read index.js → apply_patch → get_git_diff → final summary.
 */
export class ScriptedGrokProvider implements GrokProvider {
  calls: number;
  tools: ToolDefinition[];
  planSubmitted: boolean;
  patched: boolean;

  constructor() {
    this.calls = 0;
    this.tools = [];
    this.planSubmitted = false;
    this.patched = false;
  }

  isConfigured(): boolean {
    return true;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    this.calls += 1;
    if (tools) this.tools = tools;
    // Walk the message history to see what happened.
    const history = messages.map((m) => `${m.role}:${m.content.slice(0, 90)}`).join(" | ");
    const toolResults = messages.filter((m) => m.role === "tool");
    const lastSystem = messages.find((m) => m.role === "system")?.content ?? "";

    // If we already patched, produce the final summary.
    if (this.patched) {
      const diff = toolResults[toolResults.length - 1]?.content ?? "";
      return {
        summary: JSON.stringify({
          summary: "Replaced CommonJS require with ES import for axios across the fixture.",
          no_changes_required: false,
          diff_seen: diff.slice(0, 80),
        }),
        toolCalls: [],
      };
    }

    // Step 1: read package.json via the tool.
    if (this.calls === 1) {
      return {
        summary: "Inspecting package.json.",
        toolCalls: [makeCall("call_1", "read_package_json", {})],
      };
    }

    // Step 2: list files to see the layout.
    if (this.calls === 2) {
      return {
        summary: "Listing repository files.",
        toolCalls: [makeCall("call_2", "list_files", {})],
      };
    }

    // Step 3: search for the deprecated usage.
    if (this.calls === 3) {
      return {
        summary: "Searching for axios usage.",
        toolCalls: [makeCall("call_3", "search_code", { query: "require\\([\"']axios" })],
      };
    }

    // Step 4: submit the structured plan.
    if (this.calls === 4) {
      return {
        summary: "Submitting migration plan.",
        toolCalls: [
          makeCall("call_4", "create_migration_plan", {
            dependency: "axios",
            from_version: "^0.27.2",
            target_version: "1.0.0",
            breaking_changes: ["Modern axios is ESM-friendly; CJS require still works but import is preferred."],
            affected_files: ["src/index.js", "src/example.js"],
            planned_changes: ["Replace CommonJS requires with ES imports in src files."],
            verification_commands: ["npm run build"],
          }),
        ],
      };
    }

    // Step 5: read the file we will patch.
    if (this.calls === 5) {
      return {
        summary: "Inspecting src/index.js.",
        toolCalls: [makeCall("call_5", "read_file", { path: "src/index.js" })],
      };
    }

    // Step 6: apply a real patch.
    if (this.calls === 6) {
      this.patched = true;
      return {
        summary: "Applying targeted patch.",
        toolCalls: [
          makeCall("call_6", "apply_patch", {
            path: "src/index.js",
            patch: [
              "@@ -1,3 +1,2 @@",
              "-const axios = require(\"axios\");",
              "-const { get } = require(\"lodash\");",
              "+import axios from \"axios\";",
              " async function fetchUser(id) {",
            ].join("\n"),
          }),
        ],
      };
    }

    // Step 7: get the real diff and then finish in the next call (no tools).
    if (this.calls === 7) {
      return {
        summary: "Reviewing the real diff.",
        toolCalls: [makeCall("call_7", "get_git_diff", {})],
      };
    }

    // Safety: default to final summary.
    return {
      summary: JSON.stringify({ summary: "Migration complete.", no_changes_required: false }),
      toolCalls: [],
    };
  }
}

function makeCall(id: string, name: string, argumentsObj: Record<string, unknown>): ToolCallRequest {
  return { id, name, arguments: JSON.stringify(argumentsObj) };
}