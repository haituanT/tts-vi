'use client';

import WorkflowStudio from './WorkflowStudio';

export default function AppModeShell() {
  return (
    <main className="app-mode-shell">
      <nav className="app-mode-topbar" aria-label="DubFlow">
        <div className="app-mode-brand">
          <span className="app-mode-mark">DF</span>
          <div>
            <strong>DubFlow App</strong>
            <small>Dubbing workspace</small>
          </div>
        </div>
      </nav>
      <div className="app-mode-content">
        <WorkflowStudio />
      </div>
    </main>
  );
}
