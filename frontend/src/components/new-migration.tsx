import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ArrowRight, FileArchive, FolderGit2, GitBranch, GitBranchIcon, Loader2, Play, RefreshCw, Trash2, Upload, Zap,
} from 'lucide-react';
import {
  getGetRepositoryQueryKey, useCreateMigration, useGetRepository, useImportGithubRepository,
  useUploadRepository, type Repository,
} from '@dua/api-client-react';
import { ErrorState, StatusPill } from './shared';

/** Max ZIP upload size (compressed). Mirrors the backend DUA_MAX_UPLOAD_BYTES default. */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function selectZipFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return 'Only .zip archives are supported. Please choose a ZIP file.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `This file is ${formatBytes(file.size)}, which exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`;
  }
  return null;
}

function extractUploadError(error: unknown): string {
  const data =
    typeof error === 'object' && error !== null && 'data' in error
      ? (error as { data: unknown }).data
      : null;
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const message = (data as { error: unknown }).error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The archive could not be uploaded.';
}

function ZipUploadPane({ onRepo }: { onRepo: (repo: Repository) => void }) {
  const upload = useUploadRepository();
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (next: File) => {
    const validation = selectZipFile(next);
    if (validation) {
      setLocalError(validation);
      return;
    }
    setFile(next);
    upload.mutate({ data: { file: next } }, {
      onSuccess: (repository) => onRepo(repository),
    });
  };

  const onDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) submit(dropped);
  };

  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    if (chosen) submit(chosen);
  };

  const clear = () => {
    setFile(null);
    setLocalError(null);
    upload.reset();
  };

  const uploadError = upload.isError ? extractUploadError(upload.error) : null;

  return (
    <div>
      {!file && !upload.isPending ? (
        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => document.getElementById('zip-file')?.click()}
          data-testid="zip-dropzone"
        >
          <div className="upload-icon"><Upload /></div>
          <strong>Drop a repository ZIP here</strong>
          <span>or click to browse · .zip only · up to {formatBytes(MAX_UPLOAD_BYTES)}</span>
          <input
            id="zip-file"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={pick}
            style={{ display: 'none' }}
            data-testid="input-zip-file"
          />
          <span className="btn btn-secondary" style={{ marginTop: 12, pointerEvents: 'none', display: 'inline-flex' }}>
            <FileArchive /> Choose ZIP
          </span>
        </div>
      ) : null}

      {upload.isPending ? (
        <div className="file-chip" style={{ justifyContent: 'center', padding: '22px' }} data-testid="state-uploading">
          <Loader2 className="animate-spin" /> Uploading <strong>{file?.name}</strong> and analyzing…
        </div>
      ) : null}

      {!upload.isPending && file ? (
        <div className="file-chip" data-testid="file-chip-selected">
          <FileArchive />
          <strong>{file.name}</strong>
          <span>{formatBytes(file.size)}</span>
          <button onClick={clear} aria-label="Remove selected ZIP" data-testid="button-remove-zip"><Trash2 /></button>
        </div>
      ) : null}

      {upload.isSuccess && file ? (
        <div className="repo-banner" style={{ marginTop: 12 }} data-testid="state-upload-success">
          <div className="repo-symbol"><FolderGit2 size={17} /></div>
          <div><strong>Upload ready</strong><span>{file.name} was extracted and analysed.</span></div>
        </div>
      ) : null}

      {localError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-zip-validation"><strong>Invalid file</strong><p>{localError}</p><button className="btn btn-danger" onClick={clear} data-testid="button-dismiss-import-error"><RefreshCw /> Choose another file</button></div> : null}
      {uploadError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-upload-error"><strong>Upload failed</strong><p>{uploadError}</p><button className="btn btn-danger" onClick={clear} data-testid="button-retry-upload"><RefreshCw /> Try again</button></div> : null}
    </div>
  );
}

function RepositoryDetails({ repo, dependency, setDependency, targetMajor, setTargetMajor, mode, setMode }: { repo: Repository; dependency: string; setDependency: (value: string) => void; targetMajor: string; setTargetMajor: (value: string) => void; mode: 'agentic' | 'baseline'; setMode: (value: 'agentic' | 'baseline') => void }) {
  return <><div className="repo-banner"><div className="repo-symbol"><FolderGit2 size={17} /></div><div><strong>{repo.name}</strong><span>{repo.language} · {repo.packageManager} · {repo.framework ?? 'framework not detected'} · {repo.dependencies.length} dependencies</span></div><StatusPill status={repo.status} /></div><div className="section-rule">Select dependency</div><div className="dep-picker"><div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{repo.dependencies.map((item) => <button className={`dep-option ${dependency === item.name ? 'selected' : ''}`} onClick={() => { setDependency(item.name); setTargetMajor(item.version.match(/\d+/)?.[0] ?? ''); }} key={item.name} data-testid={`button-dependency-${item.name}`}><span className="dep-option-left"><strong>{item.name}</strong><small>{item.section}</small></span><span className="dep-version">{item.version}</span></button>)}</div><div className="field"><label htmlFor="target-major">Target major</label><input id="target-major" className="input" inputMode="numeric" pattern="[0-9]*" value={targetMajor} onChange={(event) => setTargetMajor(event.target.value.replace(/\D/g, ''))} placeholder="e.g. 5" data-testid="input-target-major" /><span className="helper">The agent resolves the latest compatible release in this major.</span></div></div><div className="section-rule">Execution mode</div><div className="mode-row"><button className={`mode-card ${mode === 'agentic' ? 'selected' : ''}`} onClick={() => setMode('agentic')} data-testid="button-mode-agentic"><strong>Agentic migration</strong><span>Researches release notes, applies changes, and iterates through verification failures.</span></button><button className={`mode-card ${mode === 'baseline' ? 'selected' : ''}`} onClick={() => setMode('baseline')} data-testid="button-mode-baseline"><strong>Baseline upgrade</strong><span>Updates the dependency and runs the repository verification suite without repair loops.</span></button></div></>;
}

export function NewMigration() {
  const [, setLocation] = useLocation();
  const [source, setSource] = useState<'github' | 'zip'>('github');
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState<Repository | null>(null);
  const [dependency, setDependency] = useState('');
  const [targetMajor, setTargetMajor] = useState('');
  const [mode, setMode] = useState<'agentic' | 'baseline'>('agentic');
  const github = useImportGithubRepository();
  const create = useCreateMigration();
  const repositoryQuery = useGetRepository(repo?.id ?? '', { query: { enabled: !!repo?.id, queryKey: getGetRepositoryQueryKey(repo?.id ?? '') } });
  const isImporting = github.isPending;
  const isReady = !!repo && !!dependency && !!targetMajor;

  const analyzeGithub = () => {
    if (!url.trim()) return;
    github.mutate({ data: { url: url.trim() } }, { onSuccess: (result) => { setRepo(result); setDependency(result.dependencies[0]?.name ?? ''); setTargetMajor(result.dependencies[0]?.version.match(/\d+/)?.[0] ?? ''); } });
  };
  const beginMigration = () => {
    if (!repo || !dependency || !targetMajor) return;
    create.mutate({ data: { repositoryId: repo.id, dependency, targetMajor, mode } }, { onSuccess: (migration) => { setLocation(`/migration/${migration.id}`); } });
  };
  const resetRepo = () => { setRepo(null); };

  return (
    <div className="page"><div className="form-layout">
      <div className="page-head"><div><div className="eyebrow">New migration / intake</div><h1>Bring a repository in.</h1><p className="subhead">The agent starts with a read-only analysis. Choose the dependency and target major once the repository is indexed.</p></div></div>
      <section className="card import-card">
        {!repo ? <div className="source-tabs">
          <button className={`source-tab ${source === 'github' ? 'active' : ''}`} onClick={() => setSource('github')} data-testid="tab-github"><GitBranch /> GitHub URL</button>
          <button className={`source-tab ${source === 'zip' ? 'active' : ''}`} onClick={() => setSource('zip')} data-testid="tab-zip"><FileArchive /> Upload ZIP</button>
        </div> : null}
        {!repo && source === 'github' ? (
          <div className="url-field">
            <label htmlFor="github-url">GitHub repository URL</label>
            <input id="github-url" className="input" placeholder="https://github.com/owner/repository" value={url} onChange={(event) => setUrl(event.target.value)} data-testid="input-github-url" />
            <span className="helper">Public GitHub repositories are cloned for analysis; no changes are pushed.</span>
            <button className="btn btn-primary" style={{ marginTop: 8, alignSelf: 'flex-start' }} onClick={analyzeGithub} disabled={!url.trim() || isImporting} data-testid="button-analyze-github">{isImporting ? <Loader2 className="animate-spin" /> : <GitBranch />} Analyze repository</button>
            {github.isError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-import-error"><strong>Repository analysis failed</strong><p>Check the source and try again. The server returned an analysis error.</p><button className="btn btn-danger" onClick={analyzeGithub} data-testid="button-retry-import"><RefreshCw /> Retry analysis</button></div> : null}
          </div>
        ) : null}
        {!repo && source === 'zip' ? <ZipUploadPane onRepo={(next) => { setRepo(next); setDependency(next.dependencies[0]?.name ?? ''); setTargetMajor(next.dependencies[0]?.version.match(/\d+/)?.[0] ?? ''); }} /> : null}
        {repo ? <RepositoryDetails repo={repositoryQuery.data ?? repo} dependency={dependency} setDependency={setDependency} targetMajor={targetMajor} setTargetMajor={setTargetMajor} mode={mode} setMode={setMode} /> : null}
        {repo ? <div className="form-actions"><button className="btn btn-quiet" onClick={resetRepo} data-testid="button-reset-repository">Choose another</button><button className="btn btn-primary" onClick={beginMigration} disabled={!isReady || create.isPending} data-testid="button-create-migration">{create.isPending ? <Loader2 className="animate-spin" /> : <Play />} Start migration <ArrowRight /></button></div> : null}
        {create.isError ? <div className="error-box" style={{ marginTop: 15 }} data-testid="state-create-error"><strong>Migration could not start</strong><p>The repository remains indexed. Review the target and retry.</p><button className="btn btn-danger" onClick={beginMigration} data-testid="button-retry-create">Try again</button></div> : null}
      </section>
    </div></div>
  );
}
