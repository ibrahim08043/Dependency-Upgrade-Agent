import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Shell } from '@/components/shell';
import { Dashboard } from '@/components/dashboard';
import { NewMigration } from '@/components/new-migration';
import { Workspace } from '@/components/workspace';
import { DiffPage } from '@/components/diff-page';
import { ReportPage } from '@/components/report-page';
import { RepositoryWorkspace } from '@/components/repository-workspace';
import NotFound from '@/pages/not-found';
import '@/index.css';

const queryClient = new QueryClient();

function AppRouter() {
  return <ErrorBoundary><Shell><Switch><Route path="/" component={Dashboard} /><Route path="/new" component={NewMigration} /><Route path="/repository/:id" component={RepositoryWorkspace} /><Route path="/migration/:id/diff" component={DiffPage} /><Route path="/migration/:id/report" component={ReportPage} /><Route path="/migration/:id" component={Workspace} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><AppRouter /></QueryClientProvider>;
}
