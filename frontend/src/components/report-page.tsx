import { useParams, Link } from 'wouter';
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMigrationQueryKey, getGetMigrationReportQueryKey, useApproveMigration, useGetMigration,
  useGetMigrationReport, useRejectMigration, type Migration, type MigrationReport,
} from '@dua/api-client-react';
import { ErrorState, formatDate, statusLabel } from './shared';
import { stages } from './dashboard';

/* ── Re-import shared sub-sections from workspace for reuse ──────────────────── */
/* We inline the small helpers here to avoid circular imports. In a future pass
   these can be deduplicated into a shared sections file. */

function ConfChip({ confidence }: { confidence?: string }) {
  const tone = confidence === 'high' ? 'high' : confidence === 'medium' ? 'medium' : 'low';
  return <span className={`conf-chip ${tone}`}>{confidence ?? 'none'}</span>;
}

function ResearchGroup({ label, items, tone }: { label: string; items?: string[]; tone?: 'break' }) {
  if (!items || items.length === 0) return null;
  return <div className="research-group"><h4>{label}</h4><div className="research-tags">{items.map((item, i) => <span className={`research-tag ${tone ?? ''}`} key={`${label}-${i}`}>{item}</span>)}</div></div>;
}

function ResearchSection({ research }: { research: MigrationReport['research'] }) {
  if (!research) return null;
  const sources = research.sources ?? [];
  return <section className="card report-card research-panel" data-testid="section-research">
    <div className="panel-head" style={{ marginBottom: 6 }}><div><h2>Migration research</h2><p>Real documentation retrieved for {research.dependency} {research.currentVersion} → {research.targetVersion}</p></div></div>
    <div className="research-conf">Confidence <ConfChip confidence={research.confidence} /></div>
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
          {source.key_findings && source.key_findings.length > 0 ? <ul className="source-findings">{source.key_findings.map((f, i) => <li key={i}>{f}</li>)}</ul> : null}
        </div>
      ))}
    </div></div> : null}
  </section>;
}

function ImpactMap({ risk }: { risk: MigrationReport['riskSummary'] }) {
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
    </div>
    {risk.affectedApis && risk.affectedApis.length > 0 ? <div className="research-groups"><ResearchGroup label="Affected APIs" items={risk.affectedApis} /></div> : null}
  </section>;
}

function PlanSection({ plan }: { plan: MigrationReport['plan'] }) {
  if (!plan) return null;
  return <section className="card report-card" data-testid="section-plan">
    <div className="panel-head"><div><h2>Migration plan</h2><p>Structured migration strategy</p></div></div>
    {plan.summary && <div style={{ marginBottom: 16 }}><p>{plan.summary}</p></div>}
    {plan.breakingChanges && plan.breakingChanges.length > 0 && (
      <div style={{ marginBottom: 16 }}><h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Breaking changes</h3><ul style={{ fontSize: '0.85rem', lineHeight: 1.6, paddingLeft: 20 }}>{plan.breakingChanges.map((change, i) => <li key={i}>{change}</li>)}</ul></div>
    )}
    {plan.plannedChanges && plan.plannedChanges.length > 0 && (
      <div style={{ marginBottom: 16 }}><h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Planned changes</h3><ul style={{ fontSize: '0.85rem', lineHeight: 1.6, paddingLeft: 20 }}>{plan.plannedChanges.map((change, i) => <li key={i}>{change}</li>)}</ul></div>
    )}
  </section>;
}

function AiStagesSection({ aiStages }: { aiStages: MigrationReport['aiStages'] }) {
  if (!aiStages || aiStages.length === 0) return null;
  return <section className="card report-card" data-testid="section-ai-stages">
    <div className="panel-head"><div><h2>AI agent stages</h2><p>Provider execution history</p></div></div>
    <div className="ai-stages-list">
      {aiStages.map((stage, i) => (
        <div className="ai-stage-row" key={i}>
          <div className="ai-stage-header">
            <span className="ai-stage-name">{stage.stage?.replace(/_/g, ' ') || 'unknown'}</span>
            <span className={`ai-stage-status ${stage.requestStatus}`}>{stage.requestStatus === 'success' ? '✓' : stage.requestStatus === 'error' ? '✕' : '—'}</span>
          </div>
          <div className="ai-stage-meta">Provider: {stage.provider || 'unknown'} {stage.model ? `(${stage.model})` : ''}</div>
          {stage.durationMs != null && <div className="ai-stage-duration">{(stage.durationMs / 1000).toFixed(2)}s</div>}
          {stage.error && <div className="ai-stage-error">{stage.error.slice(0, 200)}</div>}
        </div>
      ))}
    </div>
  </section>;
}

function AttemptsTimeline({ attempts }: { attempts: MigrationReport['attempts'] }) {
  if (!attempts || attempts.length === 0) return null;
  return <section className="card report-card" data-testid="section-attempts">
    <div className="panel-head"><div><h2>Attempts</h2><p>Self-healing verification attempts</p></div></div>
    <div className="attempts-list">
      {attempts.map((attempt) => (
        <div className="attempt" key={attempt.number} data-testid={`attempt-${attempt.number}`}>
          <span className="attempt-num">{attempt.number}</span>
          <span>
            <strong className={attempt.result === 'PASS' ? 'add-text' : 'del-text'}>{attempt.result}</strong>
            {attempt.failureType ? <small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>{attempt.failureType}</small> : null}
            {attempt.diagnosis ? <small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 3 }}>{attempt.diagnosis}</small> : null}
          </span>
          <span className="file-meta">{attempt.filesChanged} files</span>
        </div>
      ))}
    </div>
  </section>;
}

function VerificationPanel({ commands }: { commands: MigrationReport['verificationCommands'] }) {
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

/* ── Migration Frame ────────────────────────────────────────────────────────── */

function MigrationFrame({ children, active }: { children: React.ReactNode; active: 'workspace' | 'diff' | 'report' }) {
  const { id = '' } = useParams<{ id: string }>();
  const migration = useGetMigration(id, { query: { enabled: !!id, queryKey: getGetMigrationQueryKey(id), refetchInterval: 5000 } });
  if (migration.isLoading) return <div className="page"><div className="skeleton" style={{ width: 170, height: 12 }} /><div className="skeleton" style={{ width: 420, height: 45, marginTop: 12 }} /><div className="stage-track">{stages.map((stage) => <div className="stage" key={stage}><div className="skeleton" style={{ width: 24, height: 24, borderRadius: '50%' }} /><div className="skeleton" style={{ width: 70, height: 10 }} /></div>)}</div><div className="workspace-grid"><div className="card skeleton" style={{ height: 420 }} /><div className="card skeleton" style={{ height: 300 }} /></div></div>;
  if (migration.isError || !migration.data) return <div className="page"><ErrorState message="This migration run is not available." retry={() => void migration.refetch()} /></div>;
  const m = migration.data;
  return <div className="page"><div className="workspace-head"><div><div className="eyebrow">Migration artifact <span className="migration-id">#{m.id}</span></div><div className="migration-title"><h1>{active === 'diff' ? 'Actual diff' : 'Final report'}</h1><span className={`status status-${m.status}`}>{m.status}</span></div><div className="migration-sub"><b>{m.repositoryName}</b> · {m.dependency} · {m.oldVersion} → {m.targetVersion}</div></div><Link href={`/migration/${id}`} className="btn btn-quiet" data-testid="link-back-workspace"><ArrowLeft /> Back to workspace</Link></div><div className="stage-track">{stages.map((stage, index) => { const activeIdx = m.currentStage === 'queued' ? 0 : m.currentStage === 'research' ? 1 : m.currentStage === 'impact-analysis' ? 2 : m.currentStage === 'migration' ? 4 : m.currentStage === 'heal' ? 7 : (m.currentStage === 'complete' || m.currentStage === 'failed' || m.currentStage === 'cancelled') ? 8 : -1; const isDone = m.status === 'completed' || m.status === 'approved' || (activeIdx >= 0 && index < activeIdx); const isActive = activeIdx === index; const isFailedStage = isActive && (m.status === 'failed' || m.status === 'cancelled'); return <div className={`stage ${isDone ? 'done' : ''} ${isActive ? (isFailedStage ? 'active fail' : 'active') : ''}`} key={stage}><div className="stage-dot">{isDone ? '✓' : index + 1}</div><div className="stage-name">{stage}</div></div>; })}</div><nav className="subnav"><Link href={`/migration/${id}`} className={`subnav-link ${active === 'workspace' ? 'active' : ''}`}>Workspace</Link><Link href={`/migration/${id}/diff`} className={`subnav-link ${active === 'diff' ? 'active' : ''}`}>Actual diff</Link><Link href={`/migration/${id}/report`} className={`subnav-link ${active === 'report' ? 'active' : ''}`}>Final report</Link></nav>{children}</div>;
}

/* ── Report Content ─────────────────────────────────────────────────────────── */

function ReportContent({ report, approve, reject, approving, rejecting }: { report: MigrationReport; approve: () => void; reject: () => void; approving: boolean; rejecting: boolean }) {
  const status = report.approvalStatus ?? report.status;
  const isDone = status === 'APPROVED' || status === 'REJECTED';
  return <div className="report-grid"><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><section className="card report-card"><div className="eyebrow">Agent conclusion</div><h2 style={{ marginTop: 7 }}>{report.status}</h2><p className="report-summary">{report.summary}</p></section><section className="card report-card"><h2>Changes made</h2>{report.changes.length === 0 ? <p className="helper">No change notes were returned.</p> : <ul className="report-list">{report.changes.map((change, index) => <li key={`${change}-${index}`} data-testid={`change-${index}`}>{change}</li>)}</ul>}</section><section className="card report-card"><h2>Research sources</h2>{report.sources.length === 0 ? <p className="helper">No external sources were recorded for this run.</p> : report.sources.map((source, index) => <div className="source" key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer" data-testid={`link-source-${index}`}>{source.title}</a><p>{source.finding}</p></div>)}</section><ResearchSection research={report.research ?? null} /><ImpactMap risk={report.riskSummary ?? null} /><PlanSection plan={report.plan ?? null} /><AiStagesSection aiStages={report.aiStages ?? []} /></div><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><section className="card report-card"><h2>Impact summary</h2><div className="summary-stats"><div className="summary-stat"><span>Files touched</span><strong>{report.impact.affectedFiles}</strong></div><div className="summary-stat"><span>Usages</span><strong>{report.impact.affectedUsages}</strong></div></div>{report.impact.files.length > 0 ? <ul className="report-list">{report.impact.files.map((file) => <li key={file}>{file}</li>)}</ul> : null}</section><AttemptsTimeline attempts={report.attempts ?? []} /><VerificationPanel commands={report.verificationCommands ?? []} />{report.baseline ? <section className="card report-card"><h2>Baseline result</h2><div className="checks">{[['Tests', report.baseline.tests], ['Build', report.baseline.build], ['Typecheck', report.baseline.typecheck], ['Lint', report.baseline.lint]].map(([label, value]) => <div className="check" key={label as string}><span>{label}</span><strong className={value as string}>{statusLabel(value as string)}</strong></div>)}</div><p className="helper" style={{ marginTop: 8 }}>Result: <strong>{report.baseline.result}</strong> · {report.baseline.filesChanged} files changed.</p></section> : null}<section className="approval"><h3>Approval gate · {status}</h3><p>Review the diff and verification checks before accepting this migration into your repository workflow.</p><div className="approval-actions"><button className="btn btn-primary" onClick={approve} disabled={approving || isDone} data-testid="button-approve-migration">{approving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {status === 'APPROVED' ? 'Approved' : 'Approve migration'}</button><button className="btn btn-danger" onClick={reject} disabled={rejecting || isDone} data-testid="button-reject-migration">{rejecting ? <Loader2 className="animate-spin" /> : <XCircle />} {status === 'REJECTED' ? 'Rejected' : 'Reject'}</button></div></section>{report.remainingIssues.length > 0 ? <section className="card report-card"><h2>Remaining issues</h2><ul className="report-list">{report.remainingIssues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></section> : null}</div></div>;
}

/* ── Report Page ────────────────────────────────────────────────────────────── */

export function ReportPage() {
  const { id = '' } = useParams<{ id: string }>();
  const report = useGetMigrationReport(id, { query: { enabled: !!id, queryKey: getGetMigrationReportQueryKey(id) } });
  const approve = useApproveMigration();
  const reject = useRejectMigration();
  const qc = useQueryClient();
  const localRefresh = (result: Migration) => { qc.setQueryData(getGetMigrationQueryKey(id), result); qc.invalidateQueries({ queryKey: getGetMigrationReportQueryKey(id) }); };
  const approveRun = () => approve.mutate({ id }, { onSuccess: localRefresh });
  const rejectRun = () => reject.mutate({ id }, { onSuccess: localRefresh });
  return <MigrationFrame active="report">{report.isLoading ? <div className="report-grid"><div className="card skeleton" style={{ height: 420 }} /><div className="card skeleton" style={{ height: 260 }} /></div> : report.isError || !report.data ? <ErrorState message="The final report is not available yet. Complete verification before reviewing it." retry={() => void report.refetch()} /> : <ReportContent report={report.data} approve={approveRun} reject={rejectRun} approving={approve.isPending} rejecting={reject.isPending} />}</MigrationFrame>;
}
