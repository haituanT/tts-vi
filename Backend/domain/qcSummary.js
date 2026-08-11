function severityRank(status) {
  return status === 'error' ? 2 : status === 'warn' || status === 'warning' ? 1 : 0;
}

function normalizeStatus(value = '') {
  const status = String(value || '').toLowerCase();
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'warn' || status === 'warning' || status === 'needs_review') return 'warning';
  return 'ok';
}

function worstStatus(statuses = []) {
  return statuses.reduce((current, status) => (
    severityRank(normalizeStatus(status)) > severityRank(current) ? normalizeStatus(status) : current
  ), 'ok');
}

function roundMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function issueRowId(issue = {}) {
  return String(firstDefined(
    issue.rowId,
    issue.row_id,
    issue.sourceRowId,
    Array.isArray(issue.sourceRowIds) ? issue.sourceRowIds[0] : '',
    Array.isArray(issue.sourceIds) ? issue.sourceIds[0] : '',
    issue.id
  ) || '').trim();
}

function issueAction(reportKey, issue = {}) {
  const code = String(issue.code || '').toUpperCase();
  if (reportKey === 'tts' && ['TTS_OVERFLOW', 'TTS_MANUAL_REVIEW'].includes(code)) return 'repair_tts';
  if (reportKey === 'sync' && ['SYNC_OVERFLOW', 'SYNC_DRIFT'].includes(code)) return 'select_row';
  if (reportKey === 'autoRepair' && ['needs_manual_review', 'failed'].includes(String(issue.finalStatus || issue.status || ''))) return 'repair_tts';
  if (issueRowId(issue)) return 'select_row';
  return 'none';
}

function extractMetrics(issue = {}) {
  const metricKeys = [
    'charsPerSecond',
    'maxLineLength',
    'lineCount',
    'textLength',
    'duration',
    'slotDuration',
    'audioDuration',
    'overflowSeconds',
    'fitRatio',
    'overflowBefore',
    'maxOverflowSeconds',
    'maxDriftSeconds',
    'failedCount',
  ];
  const metrics = {};
  for (const key of metricKeys) {
    if (issue[key] !== undefined && issue[key] !== null && issue[key] !== '') {
      metrics[key] = typeof issue[key] === 'number' ? roundMetric(issue[key]) : issue[key];
    }
  }
  return metrics;
}

function normalizeIssue(reportKey, issue = {}, index = 0) {
  const status = normalizeStatus(issue.status);
  const code = String(issue.code || issue.finalStatus || 'QC_ISSUE').trim() || 'QC_ISSUE';
  const start = Number(firstDefined(issue.start, issue.expectedStartSeconds));
  const end = Number(firstDefined(issue.end, issue.expectedEndSeconds));
  return {
    id: `${reportKey}:${firstDefined(issue.id, issue.rowId, issue.row_id, issue.index, index)}:${code}`,
    report: reportKey,
    status,
    code,
    message: String(issue.message || issue.reason || code).trim(),
    rowId: issueRowId(issue),
    index: Number(issue.index ?? index),
    start: Number.isFinite(start) ? roundMetric(start) : undefined,
    end: Number.isFinite(end) ? roundMetric(end) : undefined,
    metrics: extractMetrics(issue),
    action: issueAction(reportKey, issue),
  };
}

function autoRepairIssues(report = {}) {
  if (!report || typeof report !== 'object') return [];
  const changedRows = Array.isArray(report.changedRows) ? report.changedRows : [];
  const finalStatus = String(report.finalStatus || '').trim();
  const rows = changedRows.map((row, index) => ({
    status: finalStatus === 'failed' || finalStatus === 'needs_manual_review' ? 'warn' : 'ok',
    code: 'AUTO_TTS_REPAIR_CHANGED_ROW',
    message: `Auto TTS repair changed row ${row.rowId || row.row_id || index + 1}.`,
    rowId: row.rowId || row.row_id,
    id: row.rowId || row.row_id || `changed-${index + 1}`,
    index,
    overflowSeconds: row.overflowSeconds,
    slotDuration: row.slotSeconds,
    audioDuration: row.audioSeconds,
    reason: row.reason,
  }));
  if (finalStatus && !['skipped', 'repaired'].includes(finalStatus)) {
    rows.unshift({
      status: finalStatus === 'failed' ? 'error' : 'warn',
      code: 'AUTO_TTS_REPAIR_STATUS',
      message: `Auto TTS repair finished with status ${finalStatus}.`,
      finalStatus,
    });
  }
  return rows;
}

function reportIssues(reportKey, report = {}) {
  if (!report || typeof report !== 'object') return [];
  if (reportKey === 'autoRepair') return autoRepairIssues(report);
  return Array.isArray(report.issues) ? report.issues : [];
}

function createQcSummary(jobId, reportEntries = {}) {
  const reports = {};
  const issues = [];

  for (const [reportKey, entry] of Object.entries(reportEntries)) {
    const exists = Boolean(entry?.exists);
    const report = entry?.report && typeof entry.report === 'object' ? entry.report : null;
    const reportStatus = report ? normalizeStatus(report.status || report.finalStatus) : 'ok';
    const reportIssueCount = report ? Number(report.issueCount ?? reportIssues(reportKey, report).length) || 0 : 0;
    const normalizedIssues = reportIssues(reportKey, report).map((issue, index) => normalizeIssue(reportKey, issue, index));
    issues.push(...normalizedIssues.filter((issue) => issue.status !== 'ok' || reportKey === 'autoRepair'));
    reports[reportKey] = {
      exists,
      path: entry?.path || '',
      url: entry?.url || '',
      status: exists && report ? reportStatus : 'missing',
      issueCount: exists && report ? reportIssueCount : 0,
      errorCount: exists && report ? Number(report.errorCount) || normalizedIssues.filter((issue) => issue.status === 'error').length : 0,
      warningCount: exists && report ? Number(report.warningCount) || normalizedIssues.filter((issue) => issue.status === 'warning').length : 0,
    };
  }

  const error = issues.filter((issue) => issue.status === 'error').length;
  const warning = issues.filter((issue) => issue.status === 'warning').length;
  return {
    success: true,
    jobId,
    status: error ? 'error' : warning ? 'warn' : 'ok',
    counts: {
      error,
      warning,
      total: issues.length,
    },
    reports,
    issues,
  };
}

module.exports = {
  createQcSummary,
  _private: {
    autoRepairIssues,
    normalizeIssue,
    normalizeStatus,
    reportIssues,
  },
};
