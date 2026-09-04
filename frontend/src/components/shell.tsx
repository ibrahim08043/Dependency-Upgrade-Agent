import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ChevronRight, CircleDot, Layers3, Menu, PanelLeftClose, PanelLeftOpen, Zap,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const SIDEBAR_STORAGE_KEY = 'dua.sidebar.collapsed';

function readCollapsedPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function SidebarNavLink({ href, active, icon, label, testid, tooltip = true }: { href: string; active: boolean; icon: ReactNode; label: string; testid: string; tooltip?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} className={`nav-link ${active ? 'active' : ''}`} data-testid={testid}>
          {icon}
          <span className="nav-item-label">{label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" hidden={!tooltip}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const isMigration = location.startsWith('/migration');
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable — persistence is best-effort */
      }
      return next;
    });
  };
  return (
    <TooltipProvider delayDuration={0}>
      <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} data-testid="navigation-sidebar">
          <div className="brand">
            <img src="/logo.png" alt="Dependency Upgrade Agent logo" className="brand-logo" />
            <div className="brand-copy"><span className="brand-name">Dependency Upgrade</span><span className="brand-tag">Agent command center</span></div>
          </div>
          <div className="nav-label">Workspace</div>
          <nav className="nav" aria-label="Primary navigation">
            <SidebarNavLink href="/" icon={<Layers3 />} label="Overview" testid="link-dashboard" active={location === '/'} tooltip={collapsed} />
            <SidebarNavLink href="/new" icon={<Zap />} label="New migration" testid="link-new-migration" active={location === '/new'} tooltip={collapsed} />
          </nav>
          <div className="nav-label" style={{ marginTop: 28 }}>Current run</div>
          <nav className="nav">
            <SidebarNavLink href={isMigration ? location : '/'} icon={<CircleDot />} label={isMigration ? 'Migration workspace' : 'No active run'} testid="link-current-run" active={isMigration} tooltip={collapsed} />
          </nav>
          <div className="sidebar-foot"><strong>AGENT STATUS</strong><span>Ready for a repository. Every change is inspectable.</span></div>
          <button className="sidebar-toggle" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} data-testid="button-toggle-sidebar">{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}<span className="nav-item-label">{collapsed ? 'Expand' : 'Collapse'}</span></button>
        </aside>
        <main className="main">
          <header className="topbar">
            <div className="crumb"><button className="btn btn-quiet mobile-menu" onClick={() => setMobileOpen((open) => !open)} aria-label="Toggle navigation" data-testid="button-toggle-navigation"><Menu /></button><span>Command center</span><ChevronRight size={13} /><strong>{isMigration ? 'Migration run' : location === '/new' ? 'New migration' : 'Overview'}</strong></div>
            <div className="top-status"><span className="pulse" /> API connected</div>
          </header>
          {children}
        </main>
      </div>
    </TooltipProvider>
  );
}
