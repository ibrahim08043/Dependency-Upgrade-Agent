import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../src/services/ai/gemini";
import type { ChatMessage, ToolDefinition } from "../src/services/ai/types";

/**
 * Deterministic test of the GeminiProvider message translation layer — no
 * network. It drives the REAL GeminiProvider with a recording fetch (the only
 * mocked boundary) and asserts the OpenAI-style message log is translated to
 * Gemini's generateContent format correctly (system -> systemInstruction,
 * assistant tool_calls -> functionCall parts, tool results -> functionResponse
 * parts bound to the declaring call) and that functionCall parts are converted
 * back into ToolCallRequests for the coding-agent loop.
 */

const FAKE_KEY = "AIzaFAKEKEY".padEnd(39, "x"); // structurally believable, never real

interface RecordedReq {
  systemInstruction?: { parts: [{ text: string }] };
  contents: Array<{ role: string; parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: unknown }> }>;
  tools?: Array<{ functionDeclarations: unknown[] }>;
}

function makeGeminiResponse(...parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }>) {
  return {
    candidates: [{ content: { role: "model", parts } }],
  };
}

test("GeminiProvider translates OpenAI-style messages and tool calls", async () => {
  const traces: RecordedReq[] = [];
  const rounds = [
    // Round 1 -> model returns a functionCall.
    makeGeminiResponse({ text: "I'll inspect the package.", functionCall: { name: "read_package_json", args: {} } }),
  ];

  let round = 0;
  const fetchImpl = async (_url: unknown, init: unknown) => {
    traces.push(JSON.parse(String((init as { body?: string }).body ?? "{}")));
    const resp = rounds[round++ % rounds.length];
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(resp); },
      async json() { return resp; },
    } as unknown as Response;
  };

  const provider = new GeminiProvider({ GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: "gemini-2.5-flash" }, fetchImpl);
  assert.equal(provider.isConfigured(), true);
  assert.equal(provider.model, "gemini-2.5-flash");

  const tools: ToolDefinition[] = [
    { name: "read_package_json", description: "Read package.json", parameters: { type: "object", properties: {} } },
  ];

  // First call: a system message + a user message. The provider returns a functionCall.
  const first: ChatMessage[] = [
    { role: "system", content: "You are the migration agent." },
    { role: "user", content: "Upgrade chalk to 5." },
  ];
  const resp1 = await provider.chat(first, tools);
  assert.equal(resp1.toolCalls.length, 1);
  assert.equal(resp1.toolCalls[0].name, "read_package_json");
  assert.equal(resp1.toolCalls[0].id, "fc_1"); // generated id when Gemini omits one
  assert.ok(resp1.toolCalls[0].arguments.includes("{}"));

  // Inspect the first outbound request: system must map to systemInstruction.
  const req1 = traces[0];
  assert.deepEqual(req1.systemInstruction?.parts[0]?.text, "You are the migration agent.");
  assert.equal(req1.contents.length, 1);
  assert.equal(req1.contents[0].role, "user");
  assert.equal(req1.tools?.[0]?.functionDeclarations?.length, 1);

  // Second call: an assistant message declaring the tool call + a tool result.
  // The provider must map them to a model turn (functionCall) then a user turn
  // (functionResponse) so a real (strict) provider can continue the loop.
  const second: ChatMessage[] = [
    { role: "system", content: "You are the migration agent." },
    { role: "user", content: "Upgrade chalk to 5." },
    {
      role: "assistant",
      content: "I'll inspect.",
      tool_calls: [{ id: "fc_1", type: "function", function: { name: "read_package_json", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "fc_1", content: JSON.stringify({ ok: true, result: { name: "chalk-min" } }) },
  ];
  await provider.chat(second, tools);

  const req2 = traces[1];
  // contents: user -> model(functionCall) -> user(functionResponse)
  const roles = req2.contents.map((c) => c.role);
  assert.deepEqual(roles, ["user", "model", "user"]);
  const modelTurn = req2.contents[1];
  const fcPart = modelTurn.parts.find((p) => p.functionCall);
  assert.ok(fcPart, "assistant tool_calls must become a functionCall part");
  assert.equal((fcPart.functionCall as { name: string }).name, "read_package_json");
  const frPart = req2.contents[2].parts.find((p) => p.functionResponse);
  assert.ok(frPart, "tool result must become a functionResponse part");
  assert.equal((frPart.functionResponse as { name: string }).name, "read_package_json");
});
