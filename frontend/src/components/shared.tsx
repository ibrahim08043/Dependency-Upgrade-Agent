import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

export function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function statusLabel(status?: string) {
  return status ? status.replace('_', ' ') : 'unknown';
}

export function StatusPill({ status }: { status?: string }) {
  return <span className={`status status-${status ?? 'cancelled'}`} data-testid={`status-${status ?? 'unknown'}`}>{statusLabel(status)}</span>;
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-box" data-testid="state-error"><strong>Could not load this view</strong><p>{message}</p><button className="btn btn-danger" onClick={retry} data-testid="button-retry"><RefreshCw /> Retry</button></div>;
}

export function SummaryCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="card summary-card"><h3>{icon}{title}</h3>{children}</section>;
}

export function ConfChip({ confidence }: { confidence?: string }) {
  const tone = confidence === 'high' ? 'high' : confidence === 'medium' ? 'medium' : 'low';
  return <span className={`conf-chip ${tone}`}>{confidence ?? 'none'}</span>;
}

export function ResearchGroup({ label, items, tone }: { label: string; items?: string[]; tone?: 'break' }) {
  if (!items || items.length === 0) return null;
  return <div className="research-group"><h4>{label}</h4><div className="research-tags">{items.map((item, i) => <span className={`research-tag ${tone ?? ''}`} key={`${label}-${i}`}>{item}</span>)}</div></div>;
}

export function Patch({ text }: { text: string }) {
  return <pre className="patch">{text.split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'plus' : line.startsWith('-') && !line.startsWith('---') ? 'minus' : ''} key={`${index}-${line}`}>{line}{'\n'}</span>)}</pre>;
}
