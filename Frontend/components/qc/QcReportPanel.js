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
  { key: 'all', label: 'Tất cả' },
  { key: 'source', label: 'Nguồn' },
  { key: 'translation', label: 'Dịch thuật' },
  { key: 'readability', label: 'Độ đọc' },
  { key: 'tts', label: 'Giọng đọc TTS' },
  { key: 'sync', label: 'Đồng bộ' },
];

function issueTone(status) {
  if (status === 'error') return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
  if (status === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
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
    <div className="grid w-full gap-2.5">
      {fitSummary ? (
        <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 backdrop-blur-md">
          TTS fit: {fitSummary.speed_up || 0} speed up - {fitSummary.rewrite || 0} rewrite - {fitSummary.manual_review || 0} review
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {reports.map((report) => (
          <a
            key={report.key}
            className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-300 transition-colors hover:bg-indigo-500/20"
            href={`${apiBase}${outputs[report.key]}`}
            download
          >
            {report.label}
          </a>
        ))}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 backdrop-blur-md">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
            <span className={`rounded-md px-2.5 py-0.5 text-xs ${summary?.status === 'error' ? 'bg-rose-500 text-white' : summary?.status === 'warn' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-emerald-500 text-white'}`}>
              {summary?.status === 'error' ? 'Errors' : summary?.status === 'warn' ? 'Warnings' : 'OK'}
            </span>
            <span className="text-slate-300">
              {summary?.counts ? `${summary.counts.error || 0} error - ${summary.counts.warning || 0} warning - ${summary.counts.total || 0} total` : loading ? 'Đang tải kiểm tra QC...' : 'Không có tổng hợp QC'}
            </span>
          </div>
          {error ? <span className="text-[11px] text-rose-400 font-medium">{error}</span> : null}
        </div>

        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all ${filter === item.key ? 'border-indigo-500 bg-indigo-600 text-white shadow-sm' : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {visibleIssues.length ? (
          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
            {visibleIssues.map((issue) => {
              const metrics = issueMetricText(issue.metrics);
              return (
                <div key={issue.id} className={`grid gap-1.5 rounded-lg border p-2.5 backdrop-blur-sm ${issueTone(issue.status)}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-left text-xs font-bold tracking-tight underline-offset-2 hover:underline"
                      onClick={() => onSelectIssue?.(issue)}
                    >
                      {reportLabel(issue.report)} - {issue.code}
                    </button>
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{issue.status}</span>
                  </div>
                  <div className="text-[11px] leading-relaxed text-slate-200">{issue.message}</div>
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-slate-400">
                    {issue.rowId ? <span>row {issue.rowId}</span> : null}
                    {Number.isFinite(Number(issue.start)) ? <span>{Number(issue.start).toFixed(2)}s</span> : null}
                    {metrics ? <span>{metrics}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {issue.rowId ? (
                      <button type="button" className="rounded-md border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700" onClick={() => onSelectIssue?.(issue)}>
                        Xem dòng
                      </button>
                    ) : null}
                    {issue.action === 'repair_tts' ? (
                      <button type="button" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/20" onClick={() => onRepairTtsIssue?.(issue)}>
                        Sửa TTS
                      </button>
                    ) : null}
                    {issue.action === 'rerun_tts' ? (
                      <button type="button" className="rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-500/20" onClick={() => onRerunTtsIssue?.(issue)}>
                        Tạo lại TTS
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200">
            {loading ? 'Đang tải thông tin QC...' : 'Không phát hiện vấn đề nào trong bộ lọc này.'}
          </div>
        )}
      </div>
    </div>
  );
}
