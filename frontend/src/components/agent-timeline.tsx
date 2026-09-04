import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Check, X, Clock, FileCode2, Search, PenLine,
  Terminal, GitBranch, AlertTriangle, Wrench, RotateCcw,
} from 'lucide-react';
import type { MigrationEvent, AgentToolCall, Migration } from '@dua/api-client-react';
import { formatDate } from './shared';

/* ── Event type icons and labels ──────────────────────────────────────────── */

const EVENT_ICONS: Record<string, typeof Terminal> = {
  tool_call_start: Terminal,
  tool_call_complete: Check,
  tool_call_error: X,
  command_pass: Check,
  command_fail: X,
  command_skip: Clock,
  stage_transition: GitBranch,
  research_start: Search,
  impact_scan_start: FileCode2,
  diagnosis_start: Wrench,
  diagnosis_result: Wrench,
  repair_start: RotateCcw,
  self_heal_skip: AlertTriangle,
  verify_retry: RotateCcw,
};

const ERROR_CATEGORY_LABELS: Record<string, string> = {
  TEST_FAILURE: 'Test failure',
  BUILD_FAILURE: 'Build failure',
  TYPECHECK_FAILURE: 'Typecheck failure',
  LINT_FAILURE: 'Lint failure',
  TIMEOUT: 'Command timed out',
  VERIFICATION_FAILURE: 'Verification failure',
  QUOTA_ERROR: 'API quota exhausted',
  TOOL_ERROR: 'Tool error',
  COMMAND_NOT_ALLOWED: 'Command blocked',
  INVALID_PATH: 'Invalid path',
  DEPENDENCY_INSTALL_FAILURE: 'Install failed',
  DEPENDENCY_VERSION_MISMATCH: 'Version mismatch',
};

/* ── Duration formatting ──────────────────────────────────────────────────── */

function formatDuration(ms?: number): string {
  if (ms == null || ms === 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Tool-call detail view ────────────────────────────────────────────────── */

function ToolCallDetail({ event }: { event: MigrationEvent }) {
  const tool = event.tool ?? '';
  const args = event.toolArgs ?? '';
  const result = event.toolResult ?? '';
  const isWrite = tool === 'write_file' || tool === 'apply_patch';
  const isRead = tool === 'read_file' || tool === 'read_package_json';
  const isSearch = tool === 'search_code';
  const isCommand = tool === 'run_command';
  const isDiff = tool === 'get_git_diff';

  return <div className="tool-detail-view">
    {event.toolArgs ? <div className="tool-detail-section">
      <div className="tool-detail-label">Input</div>
      <pre className="tool-detail-code">{args}</pre>
    </div> : null}
    {event.toolResult ? <div className="tool-detail-section">
      <div className="tool-detail-label">Result</div>
      <pre className="tool-detail-code">{result}</pre>
    </div> : null}
    {event.filesAffected && event.filesAffected.length > 0 ? <div className="tool-detail-section">
      <div className="tool-detail-label">Files ({event.filesAffected.length})</div>
      <ul className="tool-detail-files">{event.filesAffected.map((f) => <li key={f}>{f}</li>)}</ul>
    </div> : null}
    {event.durationMs ? <div className="tool-detail-meta">
      Duration: {formatDuration(event.durationMs)}
    </div> : null}
  </div>;
}

/* ── Command detail view ──────────────────────────────────────────────────── */

function CommandDetail({ event }: { event: MigrationEvent }) {
  return <div className="tool-detail-view">
    {event.command ? <div className="tool-detail-section">
      <div className="tool-detail-label">Command</div>
      <pre className="tool-detail-code">{event.command}</pre>
    </div> : null}
    {event.exitCode != null ? <div className="tool-detail-meta">
      Exit code: <strong className={event.exitCode === 0 ? 'add-text' : 'del-text'}>{event.exitCode}</strong>
    </div> : null}
    {event.durationMs ? <div className="tool-detail-meta">
      Duration: {formatDuration(event.durationMs)}
    </div> : null}
    {event.filesAffected && event.filesAffected.length > 0 ? <div className="tool-detail-section">
      <div className="tool-detail-label">Files affected ({event.filesAffected.length})</div>
      <ul className="tool-detail-files">{event.filesAffected.map((f) => <li key={f}>{f}</li>)}</ul>
    </div> : null}
  </div>;
}

/* ── Self-healing lifecycle view ──────────────────────────────────────────── */

function SelfHealLifecycle({ events, attemptNumber }: { events: MigrationEvent[]; attemptNumber: number }) {
  const related = events.filter((e) => e.attemptNumber === attemptNumber);
  if (related.length === 0) return null;
  return <div className="selfheal-lifecycle">
    {related.map((e) => <div className="selfheal-step" key={e.id}>
      <span className={`selfheal-dot ${e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'ok'}`} />
      <span className="selfheal-msg">{e.message}</span>
      {e.durationMs ? <span className="selfheal-duration">{formatDuration(e.durationMs)}</span> : null}
    </div>)}
  </div>;
}

/* ── Single event row ─────────────────────────────────────────────────────── */

function EventRow({ event, allEvents }: { event: MigrationEvent; allEvents: MigrationEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = EVENT_ICONS[event.eventType ?? ''] ?? GitBranch;
  const isToolEvent = event.eventType?.startsWith('tool_call');
  const isCommandEvent = event.eventType?.startsWith('command_');
  const isSelfHeal = event.eventType === 'diagnosis_start' || event.eventType === 'diagnosis_result' || event.eventType === 'repair_start';
  const isError = event.level === 'error' || event.level === 'warning';
  const hasExpandable = isToolEvent || isCommandEvent || isSelfHeal;

  return <div className={`event-row phase6-event ${isError ? 'has-error' : ''} ${expanded ? 'expanded' : ''}`}>
    <button className="event-expand-btn" onClick={() => hasExpandable && setExpanded((e) => !e)} disabled={!hasExpandable} data-testid={`event-expand-${event.id}`}>
      {hasExpandable ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
    </button>
    <div className={`event-dot ${event.level}`} />
    <div className="event-main">
      <div className="event-header">
        <Icon size={13} className="event-icon" />
        <span className="event-message">{event.message}</span>
        {event.tool ? <span className="event-tool-badge">{event.tool}</span> : null}
        {event.attemptNumber ? <span className="event-attempt-badge">attempt {event.attemptNumber}</span> : null}
        {event.errorCategory ? <span className="event-error-badge">{ERROR_CATEGORY_LABELS[event.errorCategory] ?? event.errorCategory}</span> : null}
      </div>
      <div className="event-meta">
        <span className="event-time">{formatDate(event.timestamp)}</span>
        {event.stage ? <span className="event-stage">{event.stage}</span> : null}
        {event.durationMs ? <span className="event-duration">{formatDuration(event.durationMs)}</span> : null}
      </div>
      {expanded && isToolEvent ? <ToolCallDetail event={event} /> : null}
      {expanded && isCommandEvent ? <CommandDetail event={event} /> : null}
      {expanded && isSelfHeal ? <SelfHealLifecycle events={allEvents} attemptNumber={event.attemptNumber ?? 1} /> : null}
    </div>
  </div>;
}

/* ── Agent Tool Calls from agentState (complementary to events) ────────────── */

function ToolCallsList({ toolCalls }: { toolCalls: AgentToolCall[] }) {
  if (toolCalls.length === 0) return null;
  return <div className="agent-tools-detail">
    {toolCalls.map((call, i) => <ToolCallRow key={`${call.tool}-${i}`} call={call} />)}
  </div>;
}

function ToolCallRow({ call }: { call: AgentToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = call.tool === 'read_file' || call.tool === 'read_package_json' ? FileCode2
    : call.tool === 'search_code' ? Search
    : call.tool === 'apply_patch' || call.tool === 'write_file' ? PenLine
    : call.tool === 'run_command' ? Terminal
    : call.tool === 'get_git_diff' ? GitBranch
    : call.tool === 'create_migration_plan' ? Wrench
    : Terminal;

  return <div className={`tool-call-row ${call.success ? '' : 'failed'}`}>
    <button className="tool-call-expand" onClick={() => setOpen((o) => !o)}>
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <Icon size={12} />
      <span className="tool-call-name">{call.tool}</span>
      <span className={`tool-call-status ${call.success ? 'ok' : 'err'}`}>{call.success ? '✓' : '✕'}</span>
      <span className="tool-call-duration">{formatDuration(call.durationMs)}</span>
    </button>
    {open ? <div className="tool-call-detail">
      <div className="tool-call-io">
        {call.inputSummary ? <div><strong>Input:</strong><pre className="tool-detail-code">{call.inputSummary}</pre></div> : null}
        {call.resultSummary ? <div><strong>Result:</strong><pre className="tool-detail-code">{call.resultSummary}</pre></div> : null}
      </div>
      {call.errorType ? <div className="tool-call-error">{call.errorType}</div> : null}
    </div> : null}
  </div>;
}

/* ── Main timeline component ──────────────────────────────────────────────── */

export function AgentTimeline({ events, migration }: { events: MigrationEvent[]; migration: Migration }) {
  const toolCalls = migration.agentState?.toolCalls ?? [];
  const filesModified = migration.agentState?.filesModified ?? [];
  const filesInspected = migration.agentState?.filesInspected ?? [];

  if (events.length === 0 && toolCalls.length === 0) return null;

  return <div className="agent-timeline">
    {/* Activity summary */}
    <div className="timeline-summary">
      {migration.agentState?.status ? <span className={`agent-status-chip ${migration.agentState.status}`}>{migration.agentState.status}</span> : null}
      {migration.agentState?.currentAction ? <span className="agent-action-text">{migration.agentState.currentAction}</span> : null}
      {(migration.agentState?.patchesApplied ?? 0) > 0 ? <span className="agent-patches-badge">{migration.agentState?.patchesApplied} patch{(migration.agentState?.patchesApplied ?? 0) !== 1 ? 'es' : ''} applied</span> : null}
      {filesModified.length > 0 ? <span className="agent-files-badge">{filesModified.length} file{filesModified.length !== 1 ? 's' : ''} modified</span> : null}
      {filesInspected.length > 0 ? <span className="agent-inspected-badge">{filesInspected.length} inspected</span> : null}
    </div>

    {/* Chronological event timeline */}
    {events.length > 0 ? <div className="timeline-events">
      <h3 className="timeline-section-title">Event timeline</h3>
      {events.map((event) => <EventRow key={event.id} event={event} allEvents={events} />)}
    </div> : null}

    {/* Agent summary */}
    {migration.agentState?.agentSummary ? <div className="agent-summary-block">
      <h3 className="timeline-section-title">Agent summary</h3>
      <p>{migration.agentState.agentSummary}</p>
    </div> : null}

    {/* Error */}
    {migration.agentState?.error ? <div className="agent-error-block">
      <AlertTriangle size={14} />
      <span>{migration.agentState.error}</span>
    </div> : null}

    {/* Tool calls detail (from agentState) */}
    {toolCalls.length > 0 ? <details className="tool-calls-section">
      <summary className="timeline-section-title">Tool calls ({toolCalls.length})</summary>
      <ToolCallsList toolCalls={toolCalls} />
    </details> : null}
  </div>;
}
