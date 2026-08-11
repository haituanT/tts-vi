const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPreviewRepairResults,
  preparePreviewRepairItems,
  previewItemsToAimaxSegments,
} = require('../services/ttsRepairPreviewService');

test('preparePreviewRepairItems uses repaired text and skips missing repairs', () => {
  const prepared = preparePreviewRepairItems([
    {
      row_id: 'row-2',
      start: 5,
      end: 8,
      current_translation: 'Không dùng dòng cũ',
      repaired_translation: 'Dùng bản sửa này',
    },
    {
      row_id: 'row-1',
      start: 1,
      end: 3,
      current_translation: 'Thiếu bản sửa',
    },
  ]);

  assert.equal(prepared.items.length, 1);
  assert.equal(prepared.items[0].row_id, 'row-2');
  assert.equal(prepared.items[0].repaired_translation, 'Dùng bản sửa này');
  assert.deepEqual(prepared.skipped, [
    { row_id: 'row-1', input_index: 1, reason: 'missing_repaired_translation' },
  ]);
});

test('previewItemsToAimaxSegments sorts SRT by timeline but keeps row ids', () => {
  const prepared = preparePreviewRepairItems([
    { row_id: 'row-2', start: 5, end: 8, repaired_translation: 'Hai' },
    { row_id: 'row-1', start: 1, end: 3, repaired_translation: 'Một' },
  ]);
  const segments = previewItemsToAimaxSegments(prepared.items);

  assert.deepEqual(segments.map((segment) => segment.id), ['row-1', 'row-2']);
  assert.deepEqual(segments.map((segment) => segment.text), ['Một', 'Hai']);
});

test('buildPreviewRepairResults returns overflow and slack per row id in input order', () => {
  const prepared = preparePreviewRepairItems([
    { row_id: 'row-2', start: 5, end: 9, repaired_translation: 'Hai' },
    { row_id: 'row-1', start: 1, end: 5, repaired_translation: 'Một' },
  ]);
  const rows = buildPreviewRepairResults(prepared.items, {
    segments: [
      {
        id: 'row-1',
        availableSlotDurationSeconds: 4,
        actualDurationSeconds: 4.6,
        aimaxBatchIndex: 0,
        aimaxEntryIndex: 0,
        aimaxSegmentFileName: 'line_001.mp3',
      },
      {
        id: 'row-2',
        availableSlotDurationSeconds: 4,
        actualDurationSeconds: 3.8,
        aimaxBatchIndex: 0,
        aimaxEntryIndex: 1,
        aimaxSegmentFileName: 'line_002.mp3',
      },
    ],
  });

  assert.deepEqual(rows.map((row) => row.row_id), ['row-2', 'row-1']);
  assert.equal(rows[0].status, 'slack');
  assert.equal(rows[0].slack_seconds, 0.2);
  assert.equal(rows[1].status, 'overflow');
  assert.equal(rows[1].overflow_seconds, 0.6);
  assert.equal(rows[1].aimax_segment_file_name, 'line_001.mp3');
});
