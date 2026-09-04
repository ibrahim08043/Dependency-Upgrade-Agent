import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, CircleDot,
  Code2, FileCode2, FolderGit2, GitBranch, Layers3, Loader2, Play, RefreshCw, ScrollText,
  ShieldCheck, Terminal, X, XCircle, Zap, Clock,
} from 'lucide-react';
import {
  getGetMigrationQueryKey, getGetMigrationEventsQueryKey, getListMigrationsQueryKey,
  useCancelMigration, useGetMigration, useGetMigrationEvents, useListMigrations,
  type Migration, type MigrationEvent,
} from '@dua/api-client-react';
import { ErrorState, StatusPill, formatDate, statusLabel, SummaryCard, ConfChip, ResearchGroup, Patch } from './shared';
import { stages } from './dashboard';

/* ── Stage Track ────────────────────────────────────────────────────────────── */

/** Map backend currentStage to the 9-stage frontend pipeline index. */
function mapBackendStageToIndex(backendStage?: string): number {
  if (!backendStage) return -1;
  const s = backendStage.toLowerCase();
  if (s === 'queued') return 0;                        // Intake
  if (s === 'research') return 1;                       // Research
  if (s === 'impact-analysis') return 2;                // Impact analysis
  if (s === 'migration') return 4;                      // Approval → Apply (migration covers both)
  if (s === 'heal') return 7;                           // Self-heal
  if (s === 'complete' || s === 'failed' || s === 'cancelled') return 8; // Final report
  return -1;
}

function StageTrack({ current, status }: { current?: string; status: string }) {
  const completed = status === 'completed' || status === 'approved';
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';
  const activeIndex = mapBackendStageToIndex(current);
  return <div className="stage-track" data-testid="migration-stage-track">{stages.map((stage, index) => {
    const isDone = completed || (activeIndex >= 0 && index < activeIndex);
    const isActive = activeIndex === index;
    const isFailedStage = isActive && (failed || cancelled);
    return <div className={`stage ${isDone ? 'done' : ''} ${isActive ? (isFailedStage ? 'active fail' : 'active') : ''}`} key={stage} data-testid={`stage-${stage.toLowerCase().replaceAll(' ', '-')}`}><div className="stage-dot">{isDone ? <Check size={12} /> : isFailedStage ? <X size={12} /> : index + 1}</div><div className="stage-name">{stage}</div></div>;
  })}</div>;
}

/* ── Workspace Navigation ───────────────────────────────────────────────────── */

function WorkspaceNav({ id, active }: { id: string; active: string }) {
  return <nav className="subnav" aria-label="Migration views"><Link href={`/migration/${id}`} className={`subnav-link ${active === 'workspace' ? 'active' : ''}`} data-testid="link-workspace-tab">Workspace</Link><Link href={`/migration/${id}/diff`} className={`subnav-link ${active === 'diff' ? 'active' : ''}`} data-testid="link-diff-tab">Actual diff</Link><Link href={`/migration/${id}/report`} className={`subnav-link ${active === 'report' ? 'active' : ''}`} data-testid="link-report-tab">Final report</Link></nav>;
}

/* ── Event Log ──────────────────────────────────────────────────────────────── */

function EventLog({ rows }: { rows: MigrationEvent[] }) {
  return <div className="event-list">{rows.map((event) => <div className="event-row" key={event.id} data-testid={`event-${event.id}`}><div className="event-time">{formatDate(event.timestamp)}</div><div className={`event-dot ${event.level}`} /><div className="event-message"><span className="event-level">{event.level}</span>{event.message}</div></div>)}</div>;
}

/* ── Agent Activity (detailed tool lifecycle) ──────────────────────────────── */

function AgentActivity({ agent }: { agent: Migration['agentState'] }) {
  const sLabel = (s?: string) => (s ? s.replaceAll('_', ' ') : 'idle');
  const filesModified = agent?.filesModified ?? [];
  const filesInspected = agent?.filesInspected ?? [];
  const toolCalls = agent?.toolCalls ?? [];
  return <div className="agent-activity">
    <div className="agent-status-row"><span className={`agent-dot ${agent?.status === 'running' ? 'pulse' : ''}`} />{sLabel(agent?.status)}{agent?.currentAction ? <small>· {agent.currentAction}</small> : null}</div>
    {agent?.agentSummary ? <p className="agent-summary">{agent.agentSummary}</p> : null}
    {agent?.patchesApplied && agent.patchesApplied > 0 ? <div className="agent-patches-applied"><strong>{agent.patchesApplied}</strong> patch{agent.patchesApplied !== 1 ? 'es' : ''} applied</div> : null}
    {filesModified.length > 0 ? <div className="agent-files"><strong>Files modified ({filesModified.length})</strong><ul>{filesModified.map((file) => <li key={file} className="file-row modified">{file}</li>)}</ul></div> : null}
    {filesInspected.length > 0 ? <details className="agent-inspected"><summary>Inspected ({filesInspected.length})</summary><ul>{filesInspected.map((file) => <li key={file} className="file-row">{file}</li>)}</ul></details> : null}
    {toolCalls.length > 0 ? <details className="agent-tools" open><summary>Tool calls ({toolCalls.length})</summary><div className="tool-list">{toolCalls.slice(-20).map((call) => <div className="tool-row" key={`${call.tool}-${call.timestamp}`}><span className={`tool-dot ${call.success ? 'ok' : 'err'}`} /><div className="tool-detail"><span className="tool-name">{call.tool}</span><span className="tool-time">{call.durationMs}ms</span></div><small>{call.success ? call.resultSummary : `${call.errorType ?? 'error'}: ${call.resultSummary}`}</small></div>)}</div></details> : null}
    {agent?.error ? <div className="agent-error">{agent.error}</div> : null}
  </div>;
}

/* ── Checks ─────────────────────────────────────────────────────────────────── */

function Checks({ migration }: { migration: Migration }) {
  return <div className="checks">{[['Tests', migration.tests], ['Build', migration.build], ['Typecheck', migration.typecheck], ['Lint', migration.lint]].map(([label, value]) => <div className="check" key={label as string}><span>{label}</span><strong className={value as string}>{statusLabel(value as string)}</strong></div>)}</div>;
}

/* ── Research Section ────────────────────────────────────────────────────────── */

function ResearchSection({ research }: { research: Migration['research'] }) {
  if (!research) return null;
  const sources = research.sources ?? [];
  return <section className="card report-card research-panel" data-testid="section-research">
    <div className="panel-head" style={{ marginBottom: 6 }}><div><h2>Migration research</h2><p>Real documentation retrieved for {research.dependency} {research.currentVersion} → {research.targetVersion}</p></div></div>
    <div className="research-conf">Confidence <ConfChip confidence={research.confidence} /></div>
    {research.confidence === 'none' ? <p className="helper">Reliable migration information could not be established from the retrieved sources.</p> : null}
    <div className="research-groups">
      <ResearchGroup label="Breaking changes" items={research.breakingChanges} tone="break" />
      <ResearchGroup label="Removed APIs" items={research.removedApis} tone="break" />
      <ResearchGroup label="Renamed APIs" items={research.renamedApis} tone="break" />
      <ResearchGroup label="Changed APIs" items={research.changedApis} />
      <ResearchGroup label="Configuration changes" items={research.configurationChanges} />
      <ResearchGroup label="Import changes" items={research.importChanges} />
      <ResearchGroup label="Compatibility" items={research.compatibilityRequirements} />
      <ResearchGroup label="Upgrade notes" items={research.upgradeNotes} />
    </div>
    {sources.length > 0 ? <div className="research-groups" data-testid="research-sources"><div className="research-group"><h4>Sources ({sources.length})</h4>
      {sources.map((source) => (
        <div className="source-card" key={source.id ?? source.url} data-testid={`source-${source.status}`}>
          <div className="source-title">
            <span className={`source-status ${source.status}`}>{source.status}</span>
            {source.url && source.status === 'retrieved' ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <strong style={{ fontSize: 12 }}>{source.title}</strong>}
          </div>
          <div className="source-meta">{source.source_type} · retrieved {formatDate(source.retrieved_at)}</div>
          {source.status === 'unavailable' ? <p className="source-reason">{source.reason || 'Source unavailable'}</p> : null}
          {source.key_findings && source.key_findings.length > 0 ? <ul className="source-findings">{source.key_findings.map((f, i) => <li key={i}>{f}</li>)}</ul> : null}
        </div>
      ))}
    </div></div> : null}
  </section>;
}

/* ── Impact Map ─────────────────────────────────────────────────────────────── */

function ImpactRow({ finding }: { finding: Migration['riskSummary'] extends { findings?: (infer F)[] } ? F : never }) {
  const [open, setOpen] = useState(false);
  const f = finding as { filePath: string; line: number; usageType: string; symbol: string; matchedCode: string; reason: string; risk: string };
  return <div className="impact-row">
    <div className="impact-line">L{f.line}</div>
    <div className="impact-main">
      <span className="impact-api">{f.symbol}</span> <span className="impact-type">{f.usageType}</span>
      <div className="impact-reason">{f.reason || f.matchedCode}</div>
      {open ? <pre className="impact-code">{f.matchedCode}</pre> : null}
    </div>
    <button className="btn btn-quiet" style={{ padding: '2px 8px' }} onClick={() => setOpen((o) => !o)} aria-label="Toggle code snippet">{open ? 'Hide' : 'Code'}</button>
  </div>;
}

function ImpactMap({ risk }: { risk: Migration['riskSummary'] }) {
  if (!risk) return null;
  const findings = risk.findings ?? [];
  const byFile = new Map<string, typeof findings>();
  for (const f of findings) {
    if (!byFile.has(f.filePath)) byFile.set(f.filePath, []);
    byFile.get(f.filePath)!.push(f);
  }
  return <section className="card report-card" data-testid="section-impact-map">
    <div className="panel-head"><div><h2>Impact map</h2><p>How the repository uses this dependency</p></div></div>
    <div className="summary-stats">
      <div className="summary-stat"><span>Affected files</span><strong>{risk.affectedFiles}</strong></div>
      <div className="summary-stat"><span>Usages</span><strong>{risk.affectedUsages}</strong></div>
      <div className="summary-stat"><span>High</span><strong style={{ color: 'hsl(var(--destructive))' }}>{risk.high}</strong></div>
      <div className="summary-stat"><span>Medium</span><strong style={{ color: 'hsl(var(--primary))' }}>{risk.medium}</strong></div>
    </div>
    <div className="risk-legend"><span><i className="risk-swatch high" />High</span><span><i className="risk-swatch medium" />Medium</span><span><i className="risk-swatch low" />Low</span><span><i className="risk-swatch informational" />Info</span></div>
    {findings.length === 0 ? <p className="helper" style={{ marginTop: 14 }}>No source usages of this dependency were detected.</p> : <div className="impact-map">
      {[...byFile.entries()].map(([file, rows]) => (
        <details className="impact-file" key={file}>
          <summary className="impact-file-head"><span className="path">{file}</span><span className="count">{rows.length} usage{rows.length > 1 ? 's' : ''}</span></summary>
          <div className="impact-findings">{rows.map((row, i) => <div key={`${file}-${i}`}><ImpactRow finding={row as never} /></div>)}</div>
        </details>
      ))}
    </div>}
    {risk.affectedApis && risk.affectedApis.length > 0 ? <div className="research-groups"><ResearchGroup label="Affected APIs" items={risk.affectedApis} /></div> : null}
  </section>;
}

/* ── Plan Section ───────────────────────────────────────────────────────────── */

function PlanSection({ plan }: { plan: Migration['plan'] }) {
  if (!plan) return null;
  return <section className="card report-card" data-testid="section-plan">
    <div className="panel-head"><div><h2>Migration plan</h2><p>Structured migration strategy</p></div></div>
    {plan.summary && <div style={{ marginBottom: 16 }}><p>{plan.summary}</p></div>}
    {plan.breakingChanges && plan.breakingChanges.length > 0 && (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Breaking changes</h3>
        <ul style={{ fontSize: '0.85rem', lineHeight: 1.6, paddingLeft: 20 }}>
          {plan.breakingChanges.map((change, i) => <li key={i}>{change}</li>)}
        </ul>
      </div>
    )}
    {plan.plannedChanges && plan.plannedChanges.length > 0 && (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Planned changes</h3>
        <ul style={{ fontSize: '0.85rem', lineHeight: 1.6, paddingLeft: 20 }}>
          {plan.plannedChanges.map((change, i) => <li key={i}>{change}</li>)}
        </ul>
      </div>
    )}
    {plan.validationCommands && plan.validationCommands.length > 0 && (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Validation commands</h3>
        <div style={{ fontSize: '0.85rem', fontFamily: 'monospace', backgroundColor: '#f5f5f5', padding: 8, borderRadius: 4 }}>
          {plan.validationCommands.map((cmd, i) => <div key={i}>{cmd}</div>)}
        </div>
      </div>
    )}
    {plan.riskAssessment && (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Risk assessment</h3>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>{plan.riskAssessment}</p>
      </div>
    )}
  </section>;
}

/* ── AI Stages ──────────────────────────────────────────────────────────────── */

function AiStagesSection({ aiStages }: { aiStages: Migration['aiStages'] }) {
  if (!aiStages || aiStages.length === 0) return null;
  return <section className="card report-card" data-testid="section-ai-stages">
    <div className="panel-head"><div><h2>AI agent stages</h2><p>Provider execution history</p></div></div>
    <div className="ai-stages-list">
      {aiStages.map((stage, i) => (
        <div className="ai-stage-row" key={i}>
          <div className="ai-stage-header">
            <span className="ai-stage-name">{stage.stage?.replace(/_/g, ' ') || 'unknown'}</span>
            <span className={`ai-stage-status ${stage.requestStatus}`}>
              {stage.requestStatus === 'success' ? '✓' : stage.requestStatus === 'error' ? '✕' : '—'}
            </span>
            {stage.attempt && <span className="ai-stage-attempt">attempt {stage.attempt}</span>}
          </div>
          <div className="ai-stage-meta">
            Provider: {stage.provider || 'unknown'} {stage.model ? `(${stage.model})` : ''}
          </div>
          {stage.durationMs != null && <div className="ai-stage-duration">{(stage.durationMs / 1000).toFixed(2)}s</div>}
          {stage.error && <div className="ai-stage-error">{stage.error.slice(0, 200)}</div>}
        </div>
      ))}
    </div>
  </section>;
}

/* ── Attempts Timeline ──────────────────────────────────────────────────────── */

function AttemptsTimeline({ attempts, cancelled }: { attempts: Migration['attempts']; cancelled?: boolean }) {
  if (!attempts || attempts.length === 0) return null;
  return <section className="card report-card" data-testid="section-attempts">
    <div className="panel-head"><div><h2>Attempts</h2><p>{cancelled ? 'Run cancelled by user' : 'Self-healing verification attempts'}</p></div></div>
    <div className="attempts-list">
      {attempts.map((attempt) => (
        <div className="attempt" key={attempt.number} data-testid={`attempt-${attempt.number}`}>
          <span className="attempt-num">{attempt.number}</span>
          <span>
            <strong className={attempt.result === 'PASS' ? 'add-text' : 'del-text'}>{attempt.result}</strong>
            {attempt.failureType ? <small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>{attempt.failureType}</small> : null}
            {attempt.diagnosis ? <small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 3 }}>{attempt.diagnosis}</small> : null}
            {attempt.patch ? <details style={{ marginTop: 6 }}><summary style={{ fontFamily: 'var(--app-font-mono)', fontSize: 10 }}>Corrective patch</summary><pre className="impact-code">{attempt.patch}</pre></details> : null}
          </span>
          <span className="file-meta">{attempt.filesChanged} files</span>
        </div>
      ))}
    </div>
  </section>;
}

/* ── Verification Panel ─────────────────────────────────────────────────────── */

function VerificationPanel({ commands }: { commands: Migration['verificationCommands'] }) {
  if (!commands || commands.length === 0) return null;
  return <section className="card report-card" data-testid="section-verification">
    <div className="panel-head"><div><h2>Verification commands</h2><p>Real command output from the workspace</p></div></div>
    <div className="checks">
      {commands.map((cmd, i) => (
        <details key={i} className="verify-command" data-testid={`verify-${cmd.command}`}>
          <summary>
            <span className={`verify-status ${cmd.status.toLowerCase()}`}>{cmd.status}</span>
            <code className="verify-cmd">{cmd.command}</code>
            {cmd.exitCode != null ? <span className="verify-exit">exit {cmd.exitCode}</span> : null}
            <span className="verify-time">{cmd.durationMs}ms</span>
          </summary>
          {cmd.stdout ? <pre className="verify-output">{cmd.stdout.slice(0, 2000)}</pre> : null}
          {cmd.stderr ? <pre className="verify-output err">{cmd.stderr.slice(0, 2000)}</pre> : null}
        </details>
      ))}
    </div>
  </section>;
}

/* ── Loading State ──────────────────────────────────────────────────────────── */

function LoadingWorkspace() {
  return <div className="page"><div className="skeleton" style={{ width: 170, height: 12 }} /><div className="skeleton" style={{ width: 420, height: 45, marginTop: 12 }} /><div className="stage-track">{stages.map((stage) => <div className="stage" key={stage}><div className="skeleton" style={{ width: 24, height: 24, borderRadius: '50%' }} /><div className="skeleton" style={{ width: 70, height: 10 }} /></div>)}</div><div className="workspace-grid"><div className="card skeleton" style={{ height: 420 }} /><div className="card skeleton" style={{ height: 300 }} /></div></div>;
}

/* ── Migration History (same repository) ────────────────────────────────────── */

function HistorySection({ repositoryId, currentId }: { repositoryId: string; currentId: string }) {
  const all = useListMigrations({ query: { queryKey: getListMigrationsQueryKey() } });
  const rows = (all.data ?? []).filter((m) => m.repositoryId === repositoryId && m.id !== currentId);
  if (rows.length === 0) return null;
  return <section className="card report-card" data-testid="section-history">
    <div className="panel-head"><div><h2>Migration history</h2><p>Previous runs for this repository</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Dependency</th><th>Upgrade</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((m) => <tr className="migration-row" key={m.id}><td><span className="dependency">{m.dependency}</span></td><td><span className="version">{m.oldVersion}<span className="arrow">→</span>{m.targetVersion}</span></td><td><StatusPill status={m.status} /></td><td style={{ color: 'hsl(var(--muted-foreground))', whiteSpace: 'nowrap' }}>{formatDate(m.updatedAt)}</td><td><Link href={`/migration/${m.id}`} className="btn btn-quiet" data-testid={`link-history-${m.id}`}>View</Link></td></tr>)}</tbody></table></div>
  </section>;
}

/* ── Main Workspace Page ────────────────────────────────────────────────────── */

export function Workspace() {
  const { id = '' } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const migration = useGetMigration(id, { query: { enabled: !!id, queryKey: getGetMigrationQueryKey(id), refetchInterval: 4500 } });
  const events = useGetMigrationEvents(id, { query: { enabled: !!id, queryKey: getGetMigrationEventsQueryKey(id), refetchInterval: 4500 } });
  const cancel = useCancelMigration();
  const m = migration.data;
  const eventRows = events.data ?? [];
  const refreshAll = () => { void migration.refetch(); void events.refetch(); };
  if (migration.isLoading) return <LoadingWorkspace />;
  if (migration.isError || !m) return <div className="page"><ErrorState message="This migration run is not available." retry={refreshAll} /></div>;
  return <div className="page"><div className="workspace-head"><div><div className="eyebrow">Migration workspace <span className="migration-id">#{m.id}</span></div><div className="migration-title"><h1>{m.dependency}</h1><StatusPill status={m.status} /></div><div className="migration-sub"><b>{m.repositoryName}</b> · {m.oldVersion} <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> {m.targetVersion} · attempt {m.attemptNumber}</div></div><div className="workspace-actions"><button className="btn btn-quiet" onClick={refreshAll} disabled={migration.isFetching} data-testid="button-refresh-workspace"><RefreshCw className={migration.isFetching ? 'animate-spin' : ''} /> Refresh</button>{(m.status === 'running' || m.status === 'queued') ? <button className="btn btn-danger" onClick={() => { cancel.mutate({ id }); }} disabled={cancel.isPending} data-testid="button-cancel-migration">{cancel.isPending ? <Loader2 className="animate-spin" /> : <XCircle />} Cancel run</button> : null}</div></div><StageTrack current={m.currentStage} status={m.status} /><WorkspaceNav id={id} active="workspace" /><div className="workspace-grid"><section className="card event-panel"><div className="panel-head"><div><h2>Agent event log</h2><p>Live backend events · refreshes every 4.5 seconds</p></div><span className="top-status"><span className={`pulse ${m.status === 'failed' ? 'danger-pulse' : ''}`} /> {m.status === 'running' ? 'streaming' : 'synced'}</span></div>{eventRows.length === 0 ? <div className="empty" data-testid="state-empty-events"><div className="empty-icon"><Terminal /></div><h3>Waiting for events</h3><p>The backend has not emitted an event for this run yet.</p></div> : <EventLog rows={eventRows} />}</section><div className="summary-stack">{m.agentState ? <SummaryCard title="Agent activity" icon={<Terminal />}><AgentActivity agent={m.agentState} /></SummaryCard> : null}<SummaryCard title="Impact" icon={<Code2 />}><div className="summary-stats"><div className="summary-stat"><span>Affected files</span><strong>{m.affectedFiles}</strong></div><div className="summary-stat"><span>Usages</span><strong>{m.affectedUsages}</strong></div>{m.riskSummary ? <div className="summary-stat"><span>High risk</span><strong style={{ color: 'hsl(var(--destructive))' }}>{m.riskSummary.high}</strong></div> : null}{m.riskSummary ? <div className="summary-stat"><span>Medium risk</span><strong style={{ color: 'hsl(var(--primary))' }}>{m.riskSummary.medium}</strong></div> : null}</div></SummaryCard><SummaryCard title="Verification" icon={<ShieldCheck />}><Checks migration={m} /></SummaryCard><SummaryCard title="Artifacts" icon={<ScrollText />}><p className="helper">Inspect the actual patch and final report as soon as the agent makes them available.</p><div className="link-row"><Link href={`/migration/${id}/diff`} className="btn btn-secondary" data-testid="link-view-diff"><FileCode2 /> Diff</Link><Link href={`/migration/${id}/report`} className="btn btn-secondary" data-testid="link-view-report"><ScrollText /> Report</Link></div></SummaryCard></div></div><div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}><ResearchSection research={m.research ?? null} /><ImpactMap risk={m.riskSummary ?? null} /><PlanSection plan={m.plan ?? null} /><AiStagesSection aiStages={m.aiStages ?? []} /><AttemptsTimeline attempts={m.attempts ?? []} cancelled={m.cancelled} /><VerificationPanel commands={m.verificationCommands ?? []} />{m.baseline ? <section className="card report-card"><h2>Baseline mode result</h2><div className="checks">{[['Tests', m.baseline.tests], ['Build', m.baseline.build], ['Typecheck', m.baseline.typecheck], ['Lint', m.baseline.lint]].map(([label, value]) => <div className="check" key={label as string}><span>{label}</span><strong className={value as string}>{statusLabel(value as string)}</strong></div>)}</div><p className="helper" style={{ marginTop: 10 }}>Baseline result: <strong>{m.baseline.result}</strong> · {m.baseline.filesChanged} files changed.</p></section> : null}<HistorySection repositoryId={m.repositoryId} currentId={m.id} /></div></div>;
}
