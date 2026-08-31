import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, CircleDot,
  Code2, FileArchive, FileCode2, FolderGit2, GitBranch, Github, Layers3, Loader2,
  Menu, Play, RefreshCw, ScrollText, ShieldCheck, Terminal,
  Upload, X, XCircle, Zap,
} from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetMigrationDiffQueryKey, getGetMigrationEventsQueryKey,
  getGetMigrationQueryKey, getGetMigrationReportQueryKey, getGetRepositoryQueryKey,
  getListMigrationsQueryKey, useApproveMigration, useCancelMigration,
  useCreateMigration, useGetDashboard, useGetMigration, useGetMigrationDiff,
  useGetMigrationEvents, useGetMigrationReport, useGetRepository, useImportGithubRepository,
  useListMigrations, useUploadRepository,
  type Migration, type MigrationAgentState, type MigrationEvent, type MigrationReport, type Repository,
} from '@dua/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import '@/index.css';

const queryClient = new QueryClient();

const stages = ['Intake', 'Research', 'Impact map', 'Apply', 'Verify'];

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function statusLabel(status?: string) {
  return status ? status.replace('_', ' ') : 'unknown';
}

function StatusPill({ status }: { status?: string }) {
  return <span className={`status status-${status ?? 'cancelled'}`} data-testid={`status-${status ?? 'unknown'}`}>{statusLabel(status)}</span>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMigration = location.startsWith('/migration');
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} data-testid="navigation-sidebar">
        <div className="brand">
          <div className="brand-mark">DU</div>
          <div className="brand-copy"><span className="brand-name">Dependency Upgrade</span><span className="brand-tag">Agent command center</span></div>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-dashboard"><Layers3 /> Overview</Link>
          <Link href="/new" className={`nav-link ${location === '/new' ? 'active' : ''}`} data-testid="link-new-migration"><Zap /> New migration</Link>
        </nav>
        <div className="nav-label" style={{ marginTop: 28 }}>Current run</div>
        <nav className="nav">
          <Link href={isMigration ? location : '/'} className={`nav-link ${isMigration ? 'active' : ''}`} data-testid="link-current-run"><CircleDot /> {isMigration ? 'Migration workspace' : 'No active run'}</Link>
        </nav>
        <div className="sidebar-foot"><strong>AGENT STATUS</strong><span>Ready for a repository. Every change is inspectable.</span></div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb"><button className="btn btn-quiet mobile-menu" onClick={() => setMobileOpen((open) => !open)} aria-label="Toggle navigation" data-testid="button-toggle-navigation"><Menu /></button><span>Command center</span><ChevronRight size={13} /><strong>{isMigration ? 'Migration run' : location === '/new' ? 'New migration' : 'Overview'}</strong></div>
          <div className="top-status"><span className="pulse" /> API connected</div>
        </header>
        {children}
      </main>
    </div>
  );
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-box" data-testid="state-error"><strong>Could not load this view</strong><p>{message}</p><button className="btn btn-danger" onClick={retry} data-testid="button-retry"><RefreshCw /> Retry</button></div>;
}

function Dashboard() {
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const migrations = useListMigrations({ query: { queryKey: getListMigrationsQueryKey() } });
  const data = dashboard.data;
  const rows = data?.recent ?? migrations.data ?? [];
  const capabilities = data?.capabilities ?? [];
  if (dashboard.isLoading && migrations.isLoading) return <div className="page"><div className="page-head"><div><div className="skeleton" style={{ width: 90, height: 12 }} /><div className="skeleton" style={{ width: 250, height: 42, marginTop: 10 }} /></div></div><div className="stat-grid">{[1, 2, 3, 4].map((item) => <div className="card stat-card skeleton" key={item} style={{ height: 128 }} />)}</div><div className="card loading-grid" style={{ padding: 20 }}>{[1, 2, 3, 4].map((item) => <div className="skeleton loading-line" key={item} />)}</div></div>;
  if (dashboard.isError && migrations.isError) return <div className="page"><ErrorState message="The command center did not return a dashboard summary." retry={() => { void dashboard.refetch(); void migrations.refetch(); }} /></div>;
  return (
    <div className="page">
      <div className="page-head"><div><div className="eyebrow">Dependency upgrade agent / overview</div><h1>Safe upgrades, visible work.</h1><p className="subhead">A precise operating view for dependency migrations. The agent handles the tedious path; you keep the decision trail.</p></div><Link href="/new" className="btn btn-primary" data-testid="link-start-migration"><Zap /> Start a migration <ArrowRight /></Link></div>
      <div className="stat-grid">
        <Stat label="Total migrations" value={data?.totalMigrations ?? rows.length} note="all repository runs" />
        <Stat label="Completed" value={data?.completedMigrations ?? rows.filter((row) => row.status === 'completed' || row.status === 'approved').length} note="ready for review" tone="ok" />
        <Stat label="Running now" value={data?.runningMigrations ?? rows.filter((row) => row.status === 'running' || row.status === 'queued').length} note="agent activity" tone="primary" />
        <Stat label="Needs attention" value={data?.failedMigrations ?? rows.filter((row) => row.status === 'failed').length} note="failed or blocked" tone="danger" />
      </div>
      <div className="dashboard-grid">
        <section className="card">
          <div className="panel-head"><div><h2>Recent migrations</h2><p>Latest dependency work across imported repositories</p></div><Link href="/new" className="btn btn-quiet" data-testid="link-add-migration">New run <ArrowRight /></Link></div>
          {rows.length === 0 ? <div className="empty" data-testid="state-empty-migrations"><div className="empty-icon"><GitBranch /></div><h3>No migrations yet</h3><p>Import a repository and let the agent map the upgrade before it touches a file.</p><Link href="/new" className="btn btn-primary" data-testid="link-empty-start">Import repository</Link></div> : <MigrationTable rows={rows} />}
        </section>
        <section className="card">
          <div className="panel-head"><div><h2>Agent capabilities</h2><p>What is verified on every run</p></div><ShieldCheck size={18} color="hsl(var(--primary))" /></div>
          {capabilities.length === 0 ? <div className="empty" data-testid="state-empty-capabilities"><p>Capability details are not available yet.</p></div> : <ul className="cap-list">{capabilities.map((capability, index) => <li className="cap-item" key={`${capability}-${index}`} data-testid={`capability-${index}`}><span className="cap-icon"><Check /></span><span>{capability}</span></li>)}</ul>}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: 'ok' | 'primary' | 'danger' }) {
  return <div className="card stat-card" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="stat-label">{label}</div><div className={`stat-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="stat-note">{note}</div></div>;
}

function MigrationTable({ rows }: { rows: Migration[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Dependency</th><th>Upgrade</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((migration) => <tr className="migration-row" key={migration.id} data-testid={`row-migration-${migration.id}`}><td><Link href={`/migration/${migration.id}`} className="repo-name" data-testid={`link-migration-${migration.id}`}><span>{migration.repositoryName}</span><small>run {migration.id.slice(0, 8)}</small></Link></td><td><span className="dependency">{migration.dependency}</span><small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 3 }}>{migration.mode} mode</small></td><td><span className="version">{migration.oldVersion}<span className="arrow">→</span>{migration.targetVersion}</span></td><td><StatusPill status={migration.status} /></td><td style={{ color: 'hsl(var(--muted-foreground))', whiteSpace: 'nowrap' }}>{formatDate(migration.updatedAt)}</td><td><Link href={`/migration/${migration.id}`} className="btn btn-quiet" aria-label={`Open migration ${migration.id}`} data-testid={`button-open-migration-${migration.id}`}><ArrowRight /></Link></td></tr>)}</tbody></table></div>;
}

function NewMigration() {
  const [, setLocation] = useLocation();
  const [source, setSource] = useState<'zip' | 'github'>('zip');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState<Repository | null>(null);
  const [dependency, setDependency] = useState('');
  const [targetMajor, setTargetMajor] = useState('');
  const [mode, setMode] = useState<'agentic' | 'baseline'>('agentic');
  const [dragging, setDragging] = useState(false);
  const upload = useUploadRepository();
  const github = useImportGithubRepository();
  const create = useCreateMigration();
  const repositoryQuery = useGetRepository(repo?.id ?? '', { query: { enabled: !!repo?.id, queryKey: getGetRepositoryQueryKey(repo?.id ?? '') } });
  const isImporting = upload.isPending || github.isPending;
  const isReady = !!repo && !!dependency && !!targetMajor;

  const analyzeFile = (nextFile: File | null) => {
    if (!nextFile) return;
    setFile(nextFile);
    upload.mutate({ data: { file: nextFile as unknown as string } }, { onSuccess: (result) => { setRepo(result); setDependency(result.dependencies[0]?.name ?? ''); setTargetMajor(result.dependencies[0]?.version.match(/\d+/)?.[0] ?? ''); } });
  };
  const analyzeGithub = () => {
    if (!url.trim()) return;
    github.mutate({ data: { url: url.trim() } }, { onSuccess: (result) => { setRepo(result); setDependency(result.dependencies[0]?.name ?? ''); setTargetMajor(result.dependencies[0]?.version.match(/\d+/)?.[0] ?? ''); } });
  };
  const beginMigration = () => {
    if (!repo || !dependency || !targetMajor) return;
    create.mutate({ data: { repositoryId: repo.id, dependency, targetMajor, mode } }, { onSuccess: (migration) => { setLocation(`/migration/${migration.id}`); } });
  };
  return (
    <div className="page"><div className="form-layout">
      <div className="page-head"><div><div className="eyebrow">New migration / intake</div><h1>Bring a repository in.</h1><p className="subhead">The agent starts with a read-only analysis. Choose the dependency and target major once the repository is indexed.</p></div></div>
      <section className="card import-card">
        <div className="source-tabs"><button className={`source-tab ${source === 'zip' ? 'active' : ''}`} onClick={() => { setSource('zip'); setRepo(null); }} data-testid="button-source-zip"><FileArchive /> Upload ZIP</button><button className={`source-tab ${source === 'github' ? 'active' : ''}`} onClick={() => { setSource('github'); setRepo(null); }} data-testid="button-source-github"><Github /> GitHub URL</button></div>
        {source === 'zip' ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); analyzeFile(event.dataTransfer.files[0] ?? null); }} data-testid="dropzone-repository"><div className="upload-icon">{isImporting ? <Loader2 className="animate-spin" /> : <Upload />}</div><strong>{isImporting ? 'Indexing repository…' : 'Drop a .zip here, or choose a file'}</strong><span>We inspect package.json, lockfiles, scripts, and dependency usage.</span><label className="btn btn-secondary" style={{ marginTop: 15 }}><input type="file" accept=".zip,application/zip" hidden onChange={(event) => analyzeFile(event.target.files?.[0] ?? null)} data-testid="input-repository-zip" />Choose ZIP</label></div> : <div className="url-field"><label htmlFor="github-url">Repository URL</label><input id="github-url" className="input" placeholder="https://github.com/owner/repository" value={url} onChange={(event) => setUrl(event.target.value)} data-testid="input-github-url" /><span className="helper">Public GitHub repositories are cloned for analysis; no changes are pushed.</span><button className="btn btn-primary" style={{ marginTop: 8, alignSelf: 'flex-start' }} onClick={analyzeGithub} disabled={!url.trim() || isImporting} data-testid="button-analyze-github">{isImporting ? <Loader2 className="animate-spin" /> : <GitBranch />} Analyze repository</button></div>}
        {file && source === 'zip' ? <div className="file-chip"><FileArchive size={14} /> {file.name}<button onClick={() => { setFile(null); setRepo(null); }} aria-label="Remove selected ZIP" data-testid="button-remove-zip"><X size={14} /></button></div> : null}
        {upload.isError || github.isError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-import-error"><strong>Repository analysis failed</strong><p>Check the source and try again. The server returned an analysis error.</p><button className="btn btn-danger" onClick={() => { if (source === 'zip' && file) analyzeFile(file); else analyzeGithub(); }} data-testid="button-retry-import"><RefreshCw /> Retry analysis</button></div> : null}
        {repo ? <RepositoryDetails repo={repositoryQuery.data ?? repo} dependency={dependency} setDependency={setDependency} targetMajor={targetMajor} setTargetMajor={setTargetMajor} mode={mode} setMode={setMode} /> : null}
        {repo ? <div className="form-actions"><button className="btn btn-quiet" onClick={() => { setRepo(null); setFile(null); }} data-testid="button-reset-repository">Choose another</button><button className="btn btn-primary" onClick={beginMigration} disabled={!isReady || create.isPending} data-testid="button-create-migration">{create.isPending ? <Loader2 className="animate-spin" /> : <Play />} Start migration <ArrowRight /></button></div> : null}
        {create.isError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-create-error"><strong>Migration could not start</strong><p>The repository remains indexed. Review the target and retry.</p><button className="btn btn-danger" onClick={beginMigration} data-testid="button-retry-create">Try again</button></div> : null}
      </section>
    </div></div>
  );
}

function RepositoryDetails({ repo, dependency, setDependency, targetMajor, setTargetMajor, mode, setMode }: { repo: Repository; dependency: string; setDependency: (value: string) => void; targetMajor: string; setTargetMajor: (value: string) => void; mode: 'agentic' | 'baseline'; setMode: (value: 'agentic' | 'baseline') => void }) {
  return <><div className="repo-banner"><div className="repo-symbol"><FolderGit2 size={17} /></div><div><strong>{repo.name}</strong><span>{repo.language} · {repo.packageManager} · {repo.framework ?? 'framework not detected'} · {repo.dependencies.length} dependencies</span></div><StatusPill status={repo.status} /></div><div className="section-rule">Select dependency</div><div className="dep-picker"><div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{repo.dependencies.map((item) => <button className={`dep-option ${dependency === item.name ? 'selected' : ''}`} onClick={() => { setDependency(item.name); setTargetMajor(item.version.match(/\d+/)?.[0] ?? ''); }} key={item.name} data-testid={`button-dependency-${item.name}`}><span className="dep-option-left"><strong>{item.name}</strong><small>{item.section}</small></span><span className="dep-version">{item.version}</span></button>)}</div><div className="field"><label htmlFor="target-major">Target major</label><input id="target-major" className="input" inputMode="numeric" pattern="[0-9]*" value={targetMajor} onChange={(event) => setTargetMajor(event.target.value.replace(/\D/g, ''))} placeholder="e.g. 5" data-testid="input-target-major" /><span className="helper">The agent resolves the latest compatible release in this major.</span></div></div><div className="section-rule">Execution mode</div><div className="mode-row"><button className={`mode-card ${mode === 'agentic' ? 'selected' : ''}`} onClick={() => setMode('agentic')} data-testid="button-mode-agentic"><strong>Agentic migration</strong><span>Researches release notes, applies changes, and iterates through verification failures.</span></button><button className={`mode-card ${mode === 'baseline' ? 'selected' : ''}`} onClick={() => setMode('baseline')} data-testid="button-mode-baseline"><strong>Baseline upgrade</strong><span>Updates the dependency and runs the repository verification suite without repair loops.</span></button></div></>;
}

function Workspace() {
  const { id = '' } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const migration = useGetMigration(id, { query: { enabled: !!id, queryKey: getGetMigrationQueryKey(id), refetchInterval: 4500 } });
  const events = useGetMigrationEvents(id, { query: { enabled: !!id, queryKey: getGetMigrationEventsQueryKey(id), refetchInterval: 4500 } });
  const cancel = useCancelMigration();
  const m = migration.data;
  const eventRows = events.data ?? [];
  const stageIndex = Math.max(0, stages.findIndex((stage) => stage.toLowerCase() === m?.currentStage?.toLowerCase()));
  const refreshAll = () => { void migration.refetch(); void events.refetch(); };
  const cancelRun = () => cancel.mutate({ id }, { onSuccess: (result) => { qc.setQueryData(getGetMigrationQueryKey(id), result); void events.refetch(); } });
  if (migration.isLoading) return <LoadingWorkspace />;
  if (migration.isError || !m) return <div className="page"><ErrorState message="This migration run is not available." retry={refreshAll} /></div>;
  return <div className="page"><div className="workspace-head"><div><div className="eyebrow">Migration workspace <span className="migration-id">#{m.id}</span></div><div className="migration-title"><h1>{m.dependency}</h1><StatusPill status={m.status} /></div><div className="migration-sub"><b>{m.repositoryName}</b> · {m.oldVersion} <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> {m.targetVersion} · attempt {m.attemptNumber}</div></div><div className="workspace-actions"><button className="btn btn-quiet" onClick={refreshAll} disabled={migration.isFetching} data-testid="button-refresh-workspace"><RefreshCw className={migration.isFetching ? 'animate-spin' : ''} /> Refresh</button>{(m.status === 'running' || m.status === 'queued') ? <button className="btn btn-danger" onClick={cancelRun} disabled={cancel.isPending} data-testid="button-cancel-migration">{cancel.isPending ? <Loader2 className="animate-spin" /> : <XCircle />} Cancel run</button> : null}</div></div><StageTrack current={m.currentStage} status={m.status} activeIndex={stageIndex} /><WorkspaceNav id={id} active="workspace" /><div className="workspace-grid"><section className="card event-panel"><div className="panel-head"><div><h2>Agent event log</h2><p>Live backend events · refreshes every 4.5 seconds</p></div><span className="top-status"><span className={`pulse ${m.status === 'failed' ? 'danger-pulse' : ''}`} /> {m.status === 'running' ? 'streaming' : 'synced'}</span></div>{eventRows.length === 0 ? <div className="empty" data-testid="state-empty-events"><div className="empty-icon"><Terminal /></div><h3>Waiting for events</h3><p>The backend has not emitted an event for this run yet.</p></div> : <EventLog rows={eventRows} />}</section><div className="summary-stack">{m.agentState ? <SummaryCard title="Agent activity" icon={<Terminal />}><AgentActivity agent={m.agentState} /></SummaryCard> : null}<SummaryCard title="Impact" icon={<Code2 />}><div className="summary-stats"><div className="summary-stat"><span>Affected files</span><strong>{m.affectedFiles}</strong></div><div className="summary-stat"><span>Usages</span><strong>{m.affectedUsages}</strong></div></div></SummaryCard><SummaryCard title="Verification" icon={<ShieldCheck />}><Checks migration={m} /></SummaryCard><SummaryCard title="Artifacts" icon={<ScrollText />}><p className="helper">Inspect the actual patch and final report as soon as the agent makes them available.</p><div className="link-row"><Link href={`/migration/${id}/diff`} className="btn btn-secondary" data-testid="link-view-diff"><FileCode2 /> Diff</Link><Link href={`/migration/${id}/report`} className="btn btn-secondary" data-testid="link-view-report"><ScrollText /> Report</Link></div></SummaryCard></div></div></div>;
}

function LoadingWorkspace() {
  return <div className="page"><div className="skeleton" style={{ width: 170, height: 12 }} /><div className="skeleton" style={{ width: 420, height: 45, marginTop: 12 }} /><div className="stage-track">{stages.map((stage) => <div className="stage" key={stage}><div className="skeleton" style={{ width: 24, height: 24, borderRadius: '50%' }} /><div className="skeleton" style={{ width: 70, height: 10 }} /></div>)}</div><div className="workspace-grid"><div className="card skeleton" style={{ height: 420 }} /><div className="card skeleton" style={{ height: 300 }} /></div></div>;
}

function StageTrack({ current, status, activeIndex }: { current?: string; status: string; activeIndex: number }) {
  const completed = status === 'completed' || status === 'approved';
  return <div className="stage-track" data-testid="migration-stage-track">{stages.map((stage, index) => <div className={`stage ${completed || index < activeIndex ? 'done' : ''} ${!completed && index === activeIndex ? 'active' : ''}`} key={stage} data-testid={`stage-${stage.toLowerCase().replaceAll(' ', '-')}`}><div className="stage-dot">{completed || index < activeIndex ? <Check size={12} /> : index + 1}</div><div className="stage-name">{stage}</div></div>)}</div>;
}

function WorkspaceNav({ id, active }: { id: string; active: string }) {
  return <nav className="subnav" aria-label="Migration views"><Link href={`/migration/${id}`} className={`subnav-link ${active === 'workspace' ? 'active' : ''}`} data-testid="link-workspace-tab">Workspace</Link><Link href={`/migration/${id}/diff`} className={`subnav-link ${active === 'diff' ? 'active' : ''}`} data-testid="link-diff-tab">Actual diff</Link><Link href={`/migration/${id}/report`} className={`subnav-link ${active === 'report' ? 'active' : ''}`} data-testid="link-report-tab">Final report</Link></nav>;
}

function AgentActivity({ agent }: { agent: MigrationAgentState | null }) {
  const statusLabel = (s?: string) => (s ? s.replaceAll('_', ' ') : 'idle');
  const filesModified = agent?.filesModified ?? [];
  const filesInspected = agent?.filesInspected ?? [];
  const toolCalls = agent?.toolCalls ?? [];
  return <div className="agent-activity">
    <div className="agent-status-row"><span className={`agent-dot ${agent?.status === 'running' ? 'pulse' : ''}`} />{statusLabel(agent?.status)}{agent?.currentAction ? <small>· {agent.currentAction}</small> : null}</div>
    {agent?.agentSummary ? <p className="agent-summary">{agent.agentSummary}</p> : null}
    {filesModified.length > 0 ? <div className="agent-files"><strong>Files modified</strong><ul>{filesModified.map((file) => <li key={file} className="file-row">{file}</li>)}</ul></div> : null}
    {filesInspected.length > 0 ? <details className="agent-inspected"><summary>Inspected ({filesInspected.length})</summary><ul>{filesInspected.map((file) => <li key={file} className="file-row">{file}</li>)}</ul></details> : null}
    {toolCalls.length > 0 ? <details className="agent-tools"><summary>Tool calls ({toolCalls.length})</summary><div className="tool-list">{toolCalls.slice(-20).map((call) => <div className="tool-row" key={`${call.tool}-${call.timestamp}`}><span className={`tool-dot ${call.success ? 'ok' : 'err'}`} />{call.tool}<small>{call.success ? call.resultSummary : `${call.errorType ?? 'error'}: ${call.resultSummary}`}</small></div>)}</div></details> : null}
  </div>;
}

function EventLog({ rows }: { rows: MigrationEvent[] }) {
  return <div className="event-list">{rows.map((event) => <div className="event-row" key={event.id} data-testid={`event-${event.id}`}><div className="event-time">{formatDate(event.timestamp)}</div><div className={`event-dot ${event.level}`} /><div className="event-message"><span className="event-level">{event.level}</span>{event.message}</div></div>)}</div>;
}

function SummaryCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="card summary-card"><h3>{icon}{title}</h3>{children}</section>;
}

function Checks({ migration }: { migration: Migration }) {
  return <div className="checks">{[['Tests', migration.tests], ['Build', migration.build], ['Typecheck', migration.typecheck], ['Lint', migration.lint]].map(([label, value]) => <div className="check" key={label as string}><span>{label}</span><strong className={value as string}>{statusLabel(value as string)}</strong></div>)}</div>;
}

function MigrationFrame({ children, active }: { children: React.ReactNode; active: 'workspace' | 'diff' | 'report' }) {
  const { id = '' } = useParams<{ id: string }>();
  const migration = useGetMigration(id, { query: { enabled: !!id, queryKey: getGetMigrationQueryKey(id), refetchInterval: 5000 } });
  if (migration.isLoading) return <LoadingWorkspace />;
  if (migration.isError || !migration.data) return <div className="page"><ErrorState message="This migration run is not available." retry={() => void migration.refetch()} /></div>;
  const m = migration.data;
  const stageIndex = Math.max(0, stages.findIndex((stage) => stage.toLowerCase() === m.currentStage?.toLowerCase()));
  return <div className="page"><div className="workspace-head"><div><div className="eyebrow">Migration artifact <span className="migration-id">#{m.id}</span></div><div className="migration-title"><h1>{active === 'diff' ? 'Actual diff' : 'Final report'}</h1><StatusPill status={m.status} /></div><div className="migration-sub"><b>{m.repositoryName}</b> · {m.dependency} · {m.oldVersion} <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> {m.targetVersion}</div></div><Link href={`/migration/${id}`} className="btn btn-quiet" data-testid="link-back-workspace"><ArrowLeft /> Back to workspace</Link></div><StageTrack current={m.currentStage} status={m.status} activeIndex={stageIndex} /><WorkspaceNav id={id} active={active} />{children}</div>;
}

function DiffPage() {
  const { id = '' } = useParams<{ id: string }>();
  const diff = useGetMigrationDiff(id, { query: { enabled: !!id, queryKey: getGetMigrationDiffQueryKey(id) } });
  return <MigrationFrame active="diff">{diff.isLoading ? <div className="card loading-grid" style={{ padding: 20 }}>{[1, 2, 3].map((item) => <div className="skeleton" style={{ height: 130 }} key={item} />)}</div> : diff.isError || !diff.data ? <ErrorState message="The actual diff is not available yet." retry={() => void diff.refetch()} /> : <div><div className="diff-summary"><div className="card diff-stat"><span>Files changed</span><strong>{diff.data.filesChanged}</strong></div><div className="card diff-stat add"><span>Additions</span><strong>+{diff.data.additions}</strong></div><div className="card diff-stat del"><span>Deletions</span><strong>−{diff.data.deletions}</strong></div></div>{diff.data.files.length === 0 ? <div className="card empty" data-testid="state-empty-diff"><div className="empty-icon"><FileCode2 /></div><h3>No file changes reported</h3><p>The agent has not produced a patch for this migration yet.</p></div> : diff.data.files.map((file) => <section className="card diff-file" key={file.path} data-testid={`diff-file-${file.path}`}><div className="diff-file-head"><span className="path">{file.path}</span><span className="file-meta"><span className="add-text">+{file.additions}</span><span className="del-text">−{file.deletions}</span><span>{file.status}</span></span></div><Patch text={file.patch} /></section>)}</div>}</MigrationFrame>;
}

function Patch({ text }: { text: string }) {
  return <pre className="patch">{text.split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'plus' : line.startsWith('-') && !line.startsWith('---') ? 'minus' : ''} key={`${index}-${line}`}>{line}{'\n'}</span>)}</pre>;
}

function ReportPage() {
  const { id = '' } = useParams<{ id: string }>();
  const report = useGetMigrationReport(id, { query: { enabled: !!id, queryKey: getGetMigrationReportQueryKey(id) } });
  const approve = useApproveMigration();
  const qc = useQueryClient();
  const approveRun = () => approve.mutate({ id }, { onSuccess: (result) => { qc.setQueryData(getGetMigrationQueryKey(id), result); qc.invalidateQueries({ queryKey: getGetMigrationReportQueryKey(id) }); } });
  return <MigrationFrame active="report">{report.isLoading ? <div className="report-grid"><div className="card skeleton" style={{ height: 420 }} /><div className="card skeleton" style={{ height: 260 }} /></div> : report.isError || !report.data ? <ErrorState message="The final report is not available yet. Complete verification before reviewing it." retry={() => void report.refetch()} /> : <ReportContent report={report.data} approve={approveRun} approving={approve.isPending} />}</MigrationFrame>;
}

function ReportContent({ report, approve, approving }: { report: MigrationReport; approve: () => void; approving: boolean }) {
  return <div className="report-grid"><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><section className="card report-card"><div className="eyebrow">Agent conclusion</div><h2 style={{ marginTop: 7 }}>{report.status}</h2><p className="report-summary">{report.summary}</p></section><section className="card report-card"><h2>Changes made</h2>{report.changes.length === 0 ? <p className="helper">No change notes were returned.</p> : <ul className="report-list">{report.changes.map((change, index) => <li key={`${change}-${index}`} data-testid={`change-${index}`}>{change}</li>)}</ul>}</section><section className="card report-card"><h2>Research sources</h2>{report.sources.length === 0 ? <p className="helper">No external sources were recorded for this run.</p> : report.sources.map((source, index) => <div className="source" key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer" data-testid={`link-source-${index}`}>{source.title}</a><p>{source.finding}</p></div>)}</section></div><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><section className="card report-card"><h2>Impact summary</h2><div className="summary-stats"><div className="summary-stat"><span>Files touched</span><strong>{report.impact.affectedFiles}</strong></div><div className="summary-stat"><span>Usages</span><strong>{report.impact.affectedUsages}</strong></div></div>{report.impact.files.length > 0 ? <ul className="report-list">{report.impact.files.map((file) => <li key={file}>{file}</li>)}</ul> : null}</section><section className="card report-card"><h2>Attempts</h2>{report.attempts.length === 0 ? <p className="helper">No attempt history was returned.</p> : report.attempts.map((attempt) => <div className="attempt" key={attempt.number}><span className="attempt-num">{attempt.number}</span><span>{attempt.result}{attempt.diagnosis ? <small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 3 }}>{attempt.diagnosis}</small> : null}</span><span className="file-meta">{attempt.filesChanged} files</span></div>)}</section><section className="approval"><h3>Approval gate</h3><p>Review the diff and verification checks before accepting this migration into your repository workflow.</p><div className="approval-actions"><button className="btn btn-primary" onClick={approve} disabled={approving || report.status === 'approved'} data-testid="button-approve-migration">{approving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {report.status === 'approved' ? 'Approved' : 'Approve migration'}</button></div></section>{report.remainingIssues.length > 0 ? <section className="card report-card"><h2>Remaining issues</h2><ul className="report-list">{report.remainingIssues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></section> : null}</div></div>;
}

function AppRouter() {
  return <ErrorBoundary><Shell><Switch><Route path="/" component={Dashboard} /><Route path="/new" component={NewMigration} /><Route path="/migration/:id/diff" component={DiffPage} /><Route path="/migration/:id/report" component={ReportPage} /><Route path="/migration/:id" component={Workspace} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><AppRouter /></QueryClientProvider>;
}