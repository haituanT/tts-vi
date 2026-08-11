const test = require('node:test');
const assert = require('node:assert/strict');

const { createQcSummary } = require('../domain/qcSummary');

test('qc summary normalizes multiple reports and counts issues', () => {
  const summary = createQcSummary('job-1', {
    source: {
      exists: true,
      path: 'source_qc_report.json',
      url: '/jobs/job-1/transcripts/source_qc_report.json',
      report: {
        status: 'ok',
        issues: [],
      },
    },
    readability: {
      exists: true,
      path: 'readability_qc_report.json',
      url: '/jobs/job-1/translations/readability_qc_report.json',
      report: {
        status: 'error',
        issues: [
          {
            status: 'error',
            code: 'READING_SPEED_TOO_HIGH',
            id: 'row-1',
            index: 0,
            start: 0,
            end: 1,
            charsPerSecond: 22.4,
          },
        ],
      },
    },
    tts: {
      exists: true,
      path: 'tts_qc_report.json',
      url: '/jobs/job-1/tts/tts_qc_report.json',
      report: {
        status: 'warn',
        issues: [
          {
            status: 'warn',
            code: 'TTS_OVERFLOW',
            id: 'row-2',
            index: 1,
            overflowSeconds: 0.5,
          },
        ],
      },
    },
    sync: { exists: false },
  });

  assert.equal(summary.status, 'error');
  assert.equal(summary.counts.error, 1);
  assert.equal(summary.counts.warning, 1);
  assert.equal(summary.counts.total, 2);
  assert.equal(summary.reports.sync.exists, false);
  assert.equal(summary.issues.find((issue) => issue.code === 'TTS_OVERFLOW').action, 'repair_tts');
  assert.equal(summary.issues.find((issue) => issue.code === 'READING_SPEED_TOO_HIGH').rowId, 'row-1');
});

test('qc summary exposes auto repair changed rows', () => {
  const summary = createQcSummary('job-2', {
    autoRepair: {
      exists: true,
      path: 'auto_tts_repair_report.json',
      url: '/jobs/job-2/tts/auto_tts_repair_report.json',
      report: {
        finalStatus: 'repaired',
        changedRows: [
          {
            rowId: 'row-8',
            before: 'Mot cau rat dai.',
            after: 'Mot cau ngan.',
            overflowSeconds: 0.8,
          },
        ],
      },
    },
  });

  assert.equal(summary.status, 'ok');
  assert.equal(summary.issues.length, 1);
  assert.equal(summary.issues[0].code, 'AUTO_TTS_REPAIR_CHANGED_ROW');
  assert.equal(summary.issues[0].rowId, 'row-8');
});
