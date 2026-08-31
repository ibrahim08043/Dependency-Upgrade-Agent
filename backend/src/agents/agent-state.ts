/** Public agent activity recorded on the migration job (no chain-of-thought). */

export interface AgentToolCall {
  timestamp: string;
  tool: string;
  inputSummary: string;
  resultSummary: string;
  success: boolean;
  durationMs: number;
  errorType?: string;
}

export interface AgentState {
  status: "idle" | "running" | "completed" | "failed" | "no_changes";
  currentAction: string;
  toolCalls: AgentToolCall[];
  filesInspected: string[];
  filesModified: string[];
  patchesApplied: number;
  planSummary?: string;
  fileChanges?: Array<{ path: string; action: string }>;
  agentSummary?: string;
  error?: string;
}

export function createInitialAgentState(): AgentState {
  return {
    status: "idle",
    currentAction: "idle",
    toolCalls: [],
    filesInspected: [],
    filesModified: [],
    patchesApplied: 0,
    fileChanges: [],
  };
}

/** Single mutable record for agent runs. Only an id appended; schema folds into MigrationRecord. */
export interface AgentRunRecord {
  agentState: AgentState;
}