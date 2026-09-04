import { Link } from 'wouter';
import { ArrowRight, GitBranch, Zap, Check, ShieldCheck } from 'lucide-react';
import {
  getGetDashboardQueryKey, getListMigrationsQueryKey, useGetDashboard, useListMigrations,
  type Migration,
} from '@dua/api-client-react';
import { ErrorState, formatDate, StatusPill, statusLabel } from './shared';

export const stages = ['Intake', 'Research', 'Impact analysis', 'Migration plan', 'Approval', 'Apply', 'Verify', 'Self-heal', 'Final report'];

function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: 'ok' | 'primary' | 'danger' }) {
  return <div className="card stat-card" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="stat-label">{label}</div><div className={`stat-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="stat-note">{note}</div></div>;
}

function MigrationTable({ rows }: { rows: Migration[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Dependency</th><th>Upgrade</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((migration) => <tr className="migration-row" key={migration.id} data-testid={`row-migration-${migration.id}`}><td><Link href={`/repository/${migration.repositoryId}`} className="repo-name" data-testid={`link-repo-${migration.repositoryId}`}><span>{migration.repositoryName}</span><small>run {migration.id.slice(0, 8)}</small></Link></td><td><span className="dependency">{migration.dependency}</span><small style={{ display: 'block', color: 'hsl(var(--muted-foreground))', marginTop: 3 }}>{migration.mode} mode</small></td><td><span className="version">{migration.oldVersion}<span className="arrow">→</span>{migration.targetVersion}</span></td><td><StatusPill status={migration.status} /></td><td style={{ color: 'hsl(var(--muted-foreground))', whiteSpace: 'nowrap' }}>{formatDate(migration.updatedAt)}</td><td><Link href={`/migration/${migration.id}`} className="btn btn-quiet" aria-label={`Open migration ${migration.id}`} data-testid={`button-open-migration-${migration.id}`}><ArrowRight /></Link></td></tr>)}</tbody></table></div>;
}

export function Dashboard() {
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
