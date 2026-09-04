import { Link, useParams } from 'wouter';
import { ArrowLeft, ArrowRight, FolderGit2, GitBranch, Loader2, Package, Plus, Terminal, Clock } from 'lucide-react';
import {
  getGetRepositoryQueryKey, getGetRepositoryMigrationsQueryKey,
  useGetRepository, useGetRepositoryMigrations,
  type Migration, type Repository,
} from '@dua/api-client-react';
import { ErrorState, StatusPill, formatDate } from './shared';

/* ── Repository Info ──────────────────────────────────────────────────────── */

function RepoInfo({ repo }: { repo: Repository }) {
  return <section className="card report-card" data-testid="section-repo-info">
    <div className="panel-head"><div><h2>{repo.name}</h2><p>{repo.source} repository · analyzed {formatDate(repo.createdAt)}</p></div></div>
    <div className="summary-stats">
      <div className="summary-stat"><span>Language</span><strong>{repo.language}</strong></div>
      <div className="summary-stat"><span>Package manager</span><strong>{repo.packageManager}</strong></div>
      {repo.framework ? <div className="summary-stat"><span>Framework</span><strong>{repo.framework}</strong></div> : null}
      <div className="summary-stat"><span>Status</span><StatusPill status={repo.status} /></div>
      {repo.lockfile ? <div className="summary-stat"><span>Lockfile</span><strong>{repo.lockfile}</strong></div> : null}
    </div>
  </section>;
}

/* ── Dependencies List ────────────────────────────────────────────────────── */

function DependenciesList({ repo }: { repo: Repository }) {
  if (repo.dependencies.length === 0) return <section className="card report-card" data-testid="section-deps"><div className="panel-head"><div><h2>Dependencies</h2><p>No dependencies detected</p></div></div></section>;
  const deps = repo.dependencies.filter((d) => d.section === 'dependencies');
  const devDeps = repo.dependencies.filter((d) => d.section === 'devDependencies');
  const peerDeps = repo.dependencies.filter((d) => d.section === 'peerDependencies');
  return <section className="card report-card" data-testid="section-deps">
    <div className="panel-head"><div><h2>Dependencies</h2><p>{repo.dependencies.length} total · {deps.length} production · {devDeps.length} dev</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Section</th><th /></tr></thead><tbody>
      {repo.dependencies.map((dep) => <tr key={`${dep.name}-${dep.section}`} className="migration-row" data-testid={`dep-${dep.name}`}>
        <td><span className="dependency">{dep.name}</span></td>
        <td><span className="version">{dep.version}</span></td>
        <td style={{ color: 'hsl(var(--muted-foreground))' }}>{dep.section}</td>
        <td><Link href={`/new?repo=${repo.id}&dep=${dep.name}`} className="btn btn-quiet" data-testid={`dep-upgrade-${dep.name}`}>Upgrade <ArrowRight size={12} /></Link></td>
      </tr>)}
    </tbody></table></div>
    {peerDeps.length > 0 ? <details style={{ marginTop: 12 }}><summary style={{ fontSize: 12, cursor: 'pointer', color: 'hsl(var(--muted-foreground))' }}>Peer dependencies ({peerDeps.length})</summary><div className="table-wrap"><table><thead><tr><th>Name</th><th>Version</th></tr></thead><tbody>{peerDeps.map((dep) => <tr key={dep.name}><td>{dep.name}</td><td><span className="version">{dep.version}</span></td></tr>)}</tbody></table></div></details> : null}
  </section>;
}

/* ── Scripts List ──────────────────────────────────────────────────────────── */

function ScriptsList({ scripts }: { scripts: string[] }) {
  if (scripts.length === 0) return null;
  return <section className="card report-card" data-testid="section-scripts">
    <div className="panel-head"><div><h2>Scripts</h2><p>Available npm scripts</p></div></div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {scripts.map((s) => <span key={s} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6, background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--app-font-mono)' }}>{s}</span>)}
    </div>
  </section>;
}

/* ── Active Migration ──────────────────────────────────────────────────────── */

function ActiveMigration({ migration }: { migration: Migration }) {
  const isRunning = migration.status === 'running' || migration.status === 'queued';
  return <section className="card report-card" data-testid="section-active-migration">
    <div className="panel-head"><div><h2>Active migration</h2><p>{isRunning ? 'Currently in progress' : 'Most recent run'}</p></div></div>
    <div className="migration-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center' }}>
      <div>
        <div style={{ fontWeight: 600 }}>{migration.dependency} <span style={{ fontWeight: 400 }}>{migration.oldVersion}</span> <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> <span style={{ fontWeight: 400 }}>{migration.targetVersion}</span></div>
        <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginTop: 4 }}>
          {migration.currentStage} · attempt {migration.attemptNumber}
          {migration.filesChanged ? <> · {migration.filesChanged} files changed</> : null}
          {migration.firstIssue ? <> · {migration.firstIssue}</> : null}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPill status={migration.status} />
        <Link href={`/migration/${migration.id}`} className="btn btn-secondary" data-testid="link-active-view">View workspace</Link>
      </div>
    </div>
  </section>;
}

/* ── Migration History ────────────────────────────────────────────────────── */

function MigrationHistory({ migrations, repoId }: { migrations: Migration[]; repoId: string }) {
  if (migrations.length === 0) return <section className="card report-card" data-testid="section-migration-history"><div className="panel-head"><div><h2>Migration history</h2><p>No migrations have been started for this repository yet.</p></div></div></section>;
  return <section className="card report-card" data-testid="section-migration-history">
    <div className="panel-head"><div><h2>Migration history</h2><p>{migrations.length} migration{migrations.length !== 1 ? 's' : ''}</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Dependency</th><th>Upgrade</th><th>Mode</th><th>Status</th><th>Files changed</th><th>Updated</th><th /></tr></thead><tbody>
      {migrations.map((m) => <tr className="migration-row" key={m.id} data-testid={`history-${m.id}`}>
        <td><span className="dependency">{m.dependency}</span></td>
        <td><span className="version">{m.oldVersion}<span className="arrow">→</span>{m.targetVersion}</span></td>
        <td style={{ color: 'hsl(var(--muted-foreground))' }}>{m.mode}</td>
        <td><StatusPill status={m.status} /></td>
        <td>{m.filesChanged ?? 0}</td>
        <td style={{ color: 'hsl(var(--muted-foreground))', whiteSpace: 'nowrap' }}>{formatDate(m.updatedAt)}</td>
        <td><Link href={`/migration/${m.id}`} className="btn btn-quiet" data-testid={`link-history-${m.id}`}>View</Link></td>
      </tr>)}
    </tbody></table></div>
  </section>;
}

/* ── Main Repository Workspace Page ───────────────────────────────────────── */

export function RepositoryWorkspace() {
  const { id = '' } = useParams<{ id: string }>();
  const repo = useGetRepository(id, { query: { enabled: !!id, queryKey: getGetRepositoryQueryKey(id) } });
  const migrations = useGetRepositoryMigrations(id, { query: { enabled: !!id, queryKey: getGetRepositoryMigrationsQueryKey(id) } });

  if (repo.isLoading || migrations.isLoading) return <div className="page">
    <div className="skeleton" style={{ width: 240, height: 14 }} />
    <div className="skeleton" style={{ width: 380, height: 40, marginTop: 12 }} />
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
      <div className="card skeleton" style={{ height: 200 }} />
      <div className="card skeleton" style={{ height: 200 }} />
    </div>
  </div>;

  if (repo.isError || !repo.data) return <div className="page"><ErrorState message="This repository is not available." retry={() => void repo.refetch()} /></div>;

  const r = repo.data;
  const allMigrations = migrations.data ?? [];
  const activeMigration = allMigrations.find((m) => m.status === 'running' || m.status === 'queued');
  const historyMigrations = allMigrations.filter((m) => m.id !== activeMigration?.id);

  return <div className="page">
    <div className="workspace-head">
      <div>
        <div className="eyebrow">Repository workspace</div>
        <div className="migration-title">
          <h1>{r.name}</h1>
          <StatusPill status={r.status} />
        </div>
        <div className="migration-sub">
          <FolderGit2 size={14} style={{ verticalAlign: 'middle' }} /> {r.source} · {r.language} · {r.packageManager}
          {r.framework ? <> · {r.framework}</> : null}
        </div>
      </div>
      <div className="workspace-actions">
        <Link href={`/new?repo=${r.id}`} className="btn btn-primary" data-testid="button-new-migration"><Plus size={14} /> New migration</Link>
      </div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
      <RepoInfo repo={r} />
      {activeMigration ? <ActiveMigration migration={activeMigration} /> : null}
      <DependenciesList repo={r} />
      <ScriptsList scripts={r.scripts} />
      <MigrationHistory migrations={historyMigrations} repoId={r.id} />
    </div>
  </div>;
}
