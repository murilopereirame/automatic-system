/** Application shell: login gate, navigation and page routing. */
import { useEffect, useState } from 'react';
import { api, setSignedOutHandler } from './api.ts';
import { useLoad } from './hooks.ts';
import { useLive } from './live.ts';
import { InboxPage } from './pages/InboxPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { RunsPage } from './pages/RunsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { WorkflowEditorPage } from './pages/WorkflowEditorPage.tsx';
import { WorkflowsPage } from './pages/WorkflowsPage.tsx';
import { useRoute } from './router.ts';

export function App() {
  const [signedIn, setSignedIn] = useState<boolean>();

  useEffect(() => {
    setSignedOutHandler(() => setSignedIn(false));
    api.session().then((session) => setSignedIn(session.authenticated));
  }, []);

  if (signedIn === undefined) return null;
  if (!signedIn) return <LoginPage onSignedIn={() => setSignedIn(true)} />;
  return <Shell onSignOut={() => api.logout().then(() => setSignedIn(false))} />;
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute();
  const section = route[0] ?? 'workflows';
  const pending = useLoad(api.pendingApprovals);
  useLive({ onRun: pending.reload });
  const pendingCount = pending.data?.length ?? 0;

  const link = (target: string, label: string, badge?: number) => (
    <a href={`#/${target}`} className={section === target ? 'nav-link active' : 'nav-link'}>
      {label}
      {badge ? <span className="badge attention">{badge}</span> : null}
    </a>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/workflows" className="brand">
          Auto Worker
        </a>
        <nav>
          {link('workflows', 'Workflows')}
          {link('runs', 'Runs')}
          {link('inbox', 'Inbox', pendingCount)}
          {link('settings', 'Settings')}
        </nav>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main className={section === 'workflows' && route[1] ? 'wide' : undefined}>
        {/* Keyed by the route so each page plays its short entry animation. */}
        <div className="page" key={route.slice(0, 2).join('/')}>
          {renderPage(route)}
        </div>
      </main>
    </div>
  );
}

function renderPage(route: string[]) {
  const [section, id] = route;
  if (section === 'workflows' && id) return <WorkflowEditorPage key={id} workflowId={id === 'new' ? undefined : id} />;
  if (section === 'runs' && id) return <RunPage key={id} runId={id} />;
  if (section === 'runs') return <RunsPage />;
  if (section === 'inbox') return <InboxPage />;
  if (section === 'settings') return <SettingsPage />;
  return <WorkflowsPage />;
}
