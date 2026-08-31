import { randomUUID } from "node:crypto";
import type { ChatMessage, GrokProvider, ToolCallRequest } from "../services/ai/types";
import { GrokApiError, GrokConfigError } from "../services/ai/types";
import { runCommand } from "../lib/run-command";
import { addEvent, saveMigration, getMigration } from "../lib/migration-state";
import type { MigrationRecord } from "../lib/migration-state";
import { loadToolContext } from "./tools/context";
import type { ToolContext } from "./tools/context";
import { executeTool, getToolDefinitions } from "./tools";
import type { AgentToolCall, AgentState } from "./agent-state";
import { createInitialAgentState } from "./agent-state";
import type { AgentPlan } from "./agent-plan";

export interface AgentContext {
  migrationId: string;
  workspaceRoot: string;
  originalRoot: string;
  dependency: string;
  currentVersion: string;
  targetMajor: string;
  mode: "agentic" | "baseline";
}

export interface AgentRunResult {
  status: "completed" | "no_changes";
  agentState: AgentState;
  plan: AgentPlan | null;
  filesModified: string[];
  patchesApplied: number;
  summary: string;
}

export interface AgentFailureContext {
  diagnosis: string;
  failedCommands: string[];
}

export interface AgentRunHooks {
  /** Persist updated migration + agentState. Filled in by the loop. */
  persist?: (migration: MigrationRecord, state: AgentState) => Promise<void>;
  /** Emit a real event. Filled in by the loop. */
  event?: (level: "info" | "success" | "warning" | "error", message: string) => Promise<void>;
}

const MAX_TOOL_ROUNDS = 25;

const SYSTEM_PROMPT_TEMPLATE = `You are the Dependency Upgrade Migration Agent. You are working inside an isolated
copy of a JavaScript/TypeScript repository. Your job is to perform a real
dependency major-version upgrade by making the smallest safe set of code changes.

Repository context:
- Dependency to upgrade: {{dependency}}
- Current version: {{currentVersion}}
- Target major: {{targetMajor}}
- Package manager: {{packageManager}}

Workflow:
1. Use read_package_json to confirm the current dependency and scripts.
2. Use list_files, read_file, and search_code to find affected usages of the dependency.
3. Call create_migration_plan ONCE with a concise structured plan BEFORE editing files.
   Keep summaries short; never output chain-of-thought.
4. Inspect the exact files you plan to edit (read_file) before patching.
5. Use apply_patch for minimal edits to EXISTING files; write_file to create NEW files.
   Never rewrite whole files if a small patch will do.
6. After making changes, call get_git_diff to review the real diff, and optionally run
   run_command to sanity-check (e.g. "npx tsc --noEmit") if useful.
7. When your changes are complete, respond with a short final JSON summary and NO tool calls.
   The final message must be valid JSON:
   {"summary":"...", "no_changes_required":false}

Rules:
- Only use the provided tools. The backend validates every request.
- Never attempt to read files outside the workspace or use shell tricks.
- Do not invent diffs or results — tools return real data from the actual filesystem.
- If no code changes are required for this dependency upgrade, respond with
  {"summary":"...", "no_changes_required":true} and do not call tools pointlessly.
- Keep tool inputs and outputs concise.`;

function buildSystemPrompt(ctx: AgentContext, repository: ToolContext["repository"]): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{{dependency}}", ctx.dependency)
    .replaceAll("{{currentVersion}}", ctx.currentVersion)
    .replaceAll("{{targetMajor}}", ctx.targetMajor)
    .replaceAll("{{packageManager}}", repository.packageManager || "npm");
}

function truncate(value: unknown, max = 180): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseFinalJson(content: string): { summary?: string; no_changes_required?: boolean } | null {
  try {
    const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(cleaned) as { summary?: string; no_changes_required?: boolean };
  } catch {
    return null;
  }
}

interface RunLoop {
  toolCtx: ToolContext;
  state: AgentState;
  planRef: { current: AgentPlan | null };
  persist: (state: AgentState) => Promise<void>;
  event: (level: "info" | "success" | "warning" | "error", message: string) => Promise<void>;
  migration: MigrationRecord;
}

async function executeOneToolCall(
  call: ToolCallRequest,
  loop: RunLoop,
): Promise<{ ok: boolean; result?: unknown; errorType?: string; message?: string }> {
  const started = Date.now();
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    input = {};
  }

  const record: AgentToolCall = {
    timestamp: new Date().toISOString(),
    tool: call.name,
    inputSummary: truncate(input),
    resultSummary: "",
    success: false,
    durationMs: 0,
  };
  loop.state.currentAction = `running ${call.name}`;
  await loop.persist(loop.state);
  await loop.event("info", `Running ${call.name}`).catch(() => undefined);

  const outcome = await executeTool(call.name, input, loop.toolCtx);

  // Track inspected/modified files from tool outcomes.
  if (outcome.ok && call.name === "read_file") {
    const p = (outcome.result as { path?: string } | undefined)?.path;
    if (p && !loop.state.filesInspected.includes(p)) loop.state.filesInspected.push(p);
  }
  if (call.name === "write_file") {
    const rel = String(input.path ?? "");
    if (rel && !loop.state.filesModified.includes(rel)) loop.state.filesModified.push(rel);
    loop.state.fileChanges = loop.state.fileChanges ?? [];
    loop.state.fileChanges.push({ path: rel, action: "created" });
  }
  if (call.name === "apply_patch") {
    const rel = String(input.path ?? "");
    if (rel && !loop.state.filesModified.includes(rel)) loop.state.filesModified.push(rel);
    loop.state.fileChanges = loop.state.fileChanges ?? [];
    loop.state.fileChanges.push({ path: rel, action: "patched" });
    if (outcome.ok) loop.state.patchesApplied += 1;
  }
  if (call.name === "create_migration_plan" && outcome.ok) {
    const maybePlan = (outcome.result as { __plan?: AgentPlan } | undefined)?.__plan;
    if (maybePlan && !loop.planRef.current) {
      loop.planRef.current = maybePlan;
      loop.state.planSummary = `${maybePlan.plannedChanges.length} planned change(s)`;
    }
  }

  record.durationMs = Date.now() - started;
  record.success = outcome.ok;
  record.resultSummary = truncate(outcome.ok ? outcome.result : outcome.message);
  if (!outcome.ok) record.errorType = outcome.errorType;
  loop.state.toolCalls.push(record);
  await loop.persist(loop.state);

  if (call.name === "create_migration_plan" && outcome.ok) {
    const { __plan: _drop, ...rest } = outcome.result as { __plan?: AgentPlan };
    return { ok: true, result: rest };
  }
  return outcome;
}

/**
 * Run the migration coding agent against a Grok provider.
 *
 * The agent loops: model → tool requests → backend executes validated tools →
 * results returned → model continues. Reusable by Phase 4 via `opts.failureContext`
 * to drive a repair pass.
 */
export async function runCodingAgent(
  provider: GrokProvider,
  ctx: AgentContext,
  opts: {
    failureContext?: AgentFailureContext;
    onEvent?: (level: string, message: string) => void;
  } = {},
): Promise<AgentRunResult> {
  const migration = await getMigration(ctx.migrationId);
  if (!migration) throw new Error("MIGRATION_NOT_FOUND");

  const state: AgentState = {
    ...(migration.agentState || createInitialAgentState()),
    status: "running",
    currentAction: "starting",
    toolCalls: migration.agentState?.toolCalls ?? [],
    filesInspected: migration.agentState?.filesInspected ?? [],
    filesModified: migration.agentState?.filesModified ?? [],
    fileChanges: migration.agentState?.fileChanges ?? [],
    error: undefined,
  };
  // planRef holds the richer AgentPlan from the create_migration_plan tool.
  const planRef: { current: AgentPlan | null } = { current: null };
  // Pre-seed from any previously stored display-plan shape (best effort).
  if (migration.plan) {
    planRef.current = {
      dependency: migration.dependency,
      fromVersion: migration.oldVersion,
      targetVersion: migration.targetVersion,
      breakingChanges: migration.plan.breakingChanges,
      affectedFiles: migration.impactFiles,
      plannedChanges: migration.plan.plannedChanges,
      verificationCommands: migration.plan.validationCommands,
    };
  }

  const event = async (level: "info" | "success" | "warning" | "error", message: string) => {
    await addEvent({ id: randomUUID(), migrationId: ctx.migrationId, timestamp: new Date().toISOString(), level, message });
    opts.onEvent?.(level, message);
  };
  const persist = async (nextState: AgentState) => {
    migration.agentState = nextState;
    migration.updatedAt = new Date().toISOString();
    await saveMigration(migration);
  };

  const toolCtx = await loadToolContext(
    ctx.migrationId,
    ctx.workspaceRoot,
    ctx.originalRoot,
    { targetMajor: ctx.targetMajor, dependency: ctx.dependency, currentVersion: ctx.currentVersion },
    (message, level = "info") => event(level, message),
  );

  const loop: RunLoop = { toolCtx, state, planRef, persist, event, migration };

  const contextIntro: string[] = [
    `I am starting a migration of ${ctx.dependency} from ${ctx.currentVersion} to major ${ctx.targetMajor} in "${toolCtx.repository.name}".`,
    `Repository: language=${toolCtx.repository.language}, packageManager=${toolCtx.repository.packageManager}.`,
  ];
  if (opts.failureContext) {
    contextIntro.push(`This is a REPAIR pass. Previous verification failed: ${opts.failureContext.diagnosis}`.slice(0, 800));
    contextIntro.push(`Failed commands: ${opts.failureContext.failedCommands.join(", ")}`);
  }

  await event("info", "Migration agent started");
  state.currentAction = "inspecting repository";
  await persist(state);
  await event("info", "Inspecting repository");

  let rounds = 0;
  let finishedWithSummary: string | null = null;
  let noChanges = false;

  try {
    const messageLog: ChatMessage[] = [];
    messageLog.push({ role: "system", content: buildSystemPrompt(ctx, toolCtx.repository) });
    messageLog.push({ role: "user", content: contextIntro.join("\n") });

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds += 1;
      state.currentAction = "reasoning";
      await persist(state);

      const completion = await provider.chat(messageLog, getToolDefinitions());
      const modelSummary = completion.summary?.trim();

      if (completion.toolCalls.length === 0) {
        const parsed = modelSummary ? parseFinalJson(modelSummary) : null;
        finishedWithSummary = (parsed?.summary ?? modelSummary) || "Agent completed.";
        noChanges = parsed?.no_changes_required === true;
        break;
      }

      messageLog.push({ role: "assistant", content: completion.summary ?? "" });
      for (const call of completion.toolCalls) {
        const done = await executeOneToolCall(call, loop);
        messageLog.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(done) });
      }
      state.currentAction = "continuing";
      await persist(state);
    }

    if (rounds >= MAX_TOOL_ROUNDS && !finishedWithSummary) {
      finishedWithSummary = "Agent reached the tool-call limit before producing a final summary.";
      await event("warning", "Agent reached step limit");
    }

    // Ensure intent-to-add so new files appear in `git diff` vs baseline.
    await runCommand("git", ["add", "-N", "."], { cwd: ctx.workspaceRoot });

    const finalSummary = finishedWithSummary ?? "Agent completed.";
    state.status = noChanges ? "no_changes" : "completed";
    state.currentAction = "complete";
    state.agentSummary = noChanges ? "No code changes were required." : finalSummary;
    await persist(state);

    if (noChanges) {
      await event("info", "Migration agent found no code changes required");
    } else {
      await event("success", "Migration agent completed file changes");
    }

    // Fold any captured plan into migration state for the report/UI.
    if (planRef.current && !migration.plan) {
      migration.plan = {
        summary: planRef.current.plannedChanges.join("; ") || `Upgrade ${ctx.dependency}.`,
        breakingChanges: planRef.current.breakingChanges,
        plannedChanges: planRef.current.plannedChanges,
        validationCommands: planRef.current.verificationCommands,
      };
      migration.updatedAt = new Date().toISOString();
      await saveMigration(migration);
    }

    return {
      status: noChanges ? "no_changes" : "completed",
      agentState: state,
      plan: planRef.current,
      filesModified: state.filesModified,
      patchesApplied: state.patchesApplied,
      summary: finalSummary,
    };
  } catch (error) {
    state.status = "failed";
    state.currentAction = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    await persist(state);
    const label = error instanceof GrokConfigError || error instanceof GrokApiError ? "Grok" : "agent";
    await event("error", `${label} error: ${state.error}`);
    throw error;
  }
}