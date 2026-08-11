'use client';

import { useEffect, useMemo, useState } from 'react';

const REPORTS = [
  { key: 'sourceQcReportUrl', summaryKey: 'source', label: 'Source QC' },
  { key: 'translationQcReportUrl', summaryKey: 'translation', label: 'Translation QC' },
  { key: 'readabilityQcReportUrl', summaryKey: 'readability', label: 'Readability QC' },
  { key: 'ttsQcReportUrl', summaryKey: 'tts', label: 'TTS QC' },
  { key: 'syncQcReportUrl', summaryKey: 'sync', label: 'Sync QC' },
  { key: 'autoTtsRepairReportUrl', summaryKey: 'autoRepair', label: 'Auto repair' },
];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'source', label: 'Source' },
  { key: 'translation', label: 'Translation' },
  { key: 'readability', label: 'Readability' },
  { key: 'tts', label: 'TTS' },
  { key: 'sync', label: 'Sync' },
];

function issueTone(status) {
  if (status === 'error') return 'border-red-500/40 bg-red-500/10 text-red-100';
  if (status === 'warning') return 'border-amber-500/40 bg-amber-500/10 text-amber-100';
  return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-100';
}

function reportLabel(key) {
  return REPORTS.find((report) => report.summaryKey === key)?.label || key;
}

function formatMetricValue(value) {
  if (typeof value === 'number') return Number(value.toFixed(3));
  return String(value || '');
}

function issueMetricText(metrics = {}) {
  return Object.entries(metrics || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${formatMetricValue(value)}`)
    .join(' - ');
}

export default function QcReportPanel({
  apiBase,
  jobId = '',
  outputs = {},
  onSelectIssue,
  onRepairTtsIssue,
  onRerunTtsIssue,
  onSummaryLoaded,
}) {
  const [summary, setSummary] = useState(outputs.qcSummary || null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const reports = REPORTS.filter((report) => outputs[report.key]);
  const fitSummary = outputs.ttsFitPlan?.summary || null;
  const reportSignal = REPORTS.map((report) => outputs[report.key] || '').join('|');

  useEffect(() => {
    let stopped = false;
    if (!jobId) {
      setSummary(outputs.qcSummary || null);
      return undefined;
    }
    setLoading(true);
    setError('');
    fetch(`${apiBase}/api/manual/qc-summary/${encodeURIComponent(jobId)}`)
      .then((response) => (
        response.ok
          ? response.json()
          : response.json().then((data) => Promise.reject(new Error(data?.message || 'QC summary failed')))
      ))
      .then((data) => {
        if (stopped) return;
        setSummary(data);
        onSummaryLoaded?.(data);
      })
      .catch((fetchError) => {
        if (stopped) return;
        setError(fetchError.message || String(fetchError));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [apiBase, jobId, reportSignal]);

  const visibleIssues = useMemo(() => {
    const issues = Array.isArray(summary?.issues) ? summary.issues : [];
    return filter === 'all' ? issues : issues.filter((issue) => issue.report === filter);
  }, [summary, filter]);

  if (!reports.length && !fitSummary && !summary && !loading) return null;

  return (
    <div className="grid w-full gap-2">
      {fitSummary ? (
        <span className="rounded border border-amber-500/40 px-2 py-1 text-amber-100">
          TTS fit: {fitSummary.speed_up || 0} speed up - {fitSummary.rewrite || 0} rewrite - {fitSummary.manual_review || 0} review
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {reports.map((report) => (
          <a
            key={report.key}
            className="rounded border border-amber-500/40 px-2 py-1 text-amber-200 hover:bg-amber-500/10"
            href={`${apiBase}${outputs[report.key]}`}
            download
          >
            {report.label}
          </a>
        ))}
      </div>

      <div className="rounded-[6px] border border-[#263a5d] bg-[#071020] p-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-black">
            <span className={`rounded px-2 py-1 ${summary?.status === 'error' ? 'bg-red-500 text-white' : summary?.status === 'warn' ? 'bg-amber-400 text-black' : 'bg-emerald-500 text-white'}`}>
              {summary?.status === 'error' ? 'Errors' : summary?.status === 'warn' ? 'Warnings' : 'OK'}
            </span>
            <span className="text-slate-300">
              {summary?.counts ? `${summary.counts.error || 0} error - ${summary.counts.warning || 0} warning - ${summary.counts.total || 0} total` : loading ? 'Loading QC...' : 'No QC summary'}
            </span>
          </div>
          {error ? <span className="text-[11px] text-red-200">{error}</span> : null}
        </div>

        <div className="mb-2 flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`rounded border px-2 py-1 text-[10px] font-bold ${filter === item.key ? 'border-[#f1cc00] bg-[#f1cc00] text-black' : 'border-[#2a4166] text-slate-300 hover:bg-[#142540]'}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {visibleIssues.length ? (
          <div className="grid max-h-72 gap-1.5 overflow-y-auto pr-1">
            {visibleIssues.map((issue) => {
              const metrics = issueMetricText(issue.metrics);
              return (
                <div key={issue.id} className={`grid gap-1 rounded border p-2 ${issueTone(issue.status)}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-left text-[11px] font-black underline-offset-2 hover:underline"
                      onClick={() => onSelectIssue?.(issue)}
                    >
                      {reportLabel(issue.report)} - {issue.code}
                    </button>
                    <span className="text-[10px] uppercase">{issue.status}</span>
                  </div>
                  <div className="text-[11px] leading-4 text-slate-200">{issue.message}</div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                    {issue.rowId ? <span>row {issue.rowId}</span> : null}
                    {Number.isFinite(Number(issue.start)) ? <span>{Number(issue.start).toFixed(2)}s</span> : null}
                    {metrics ? <span>{metrics}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {issue.rowId ? (
                      <button type="button" className="rounded border border-slate-500/40 px-2 py-1 text-[10px] text-slate-100 hover:bg-slate-500/10" onClick={() => onSelectIssue?.(issue)}>
                        Go row
                      </button>
                    ) : null}
                    {issue.action === 'repair_tts' ? (
                      <button type="button" className="rounded border border-amber-400/50 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-400/10" onClick={() => onRepairTtsIssue?.(issue)}>
                        Repair TTS
                      </button>
                    ) : null}
                    {issue.action === 'rerun_tts' ? (
                      <button type="button" className="rounded border border-sky-400/50 px-2 py-1 text-[10px] text-sky-100 hover:bg-sky-400/10" onClick={() => onRerunTtsIssue?.(issue)}>
                        Rerun TTS
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-100">
            {loading ? 'Loading QC summary...' : 'No issue in this filter.'}
          </div>
        )}
      </div>
    </div>
  );
}
