'use client';

import WorkflowStudio from './WorkflowStudio';

export default function AppModeShell() {
  return (
    <main className="app-mode-shell">
      <nav className="app-mode-topbar" aria-label="DubFlow AI">
        <div className="app-mode-brand">
          <span className="app-mode-mark">DF</span>
          <div>
            <div className="flex items-center gap-2">
              <strong>DubFlow AI Studio</strong>
              <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300 border border-indigo-500/30">
                v2.5 Pro
              </span>
            </div>
            <small>Local Video Translation & Voice Dubbing Workspace</small>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-slate-400 bg-slate-900/60 px-3 py-1.5 rounded-lg border border-slate-800/80">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Local Engine Active
          </div>
        </div>
      </nav>
      <div className="app-mode-content p-4 md:p-6">
        <WorkflowStudio />
      </div>
    </main>
  );
}
