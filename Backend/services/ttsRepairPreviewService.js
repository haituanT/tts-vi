const TIMING_FIT_TOLERANCE_SECONDS = 0.02;
const MAX_REPAIR_PREVIEW_CUES = 200;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function roundMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function preparePreviewRepairItems(items = []) {
  const normalized = [];
  const skipped = [];
  const seen = new Set();

  (Array.isArray(items) ? items : []).forEach((item, inputIndex) => {
    const rowId = normalizeText(item?.row_id || item?.rowId || item?.id);
    const repairedTranslation = normalizeText(
      item?.repaired_translation
      || item?.repairedTranslation
      || item?.repairText
      || item?.text
    );
    if (!rowId) {
      skipped.push({ row_id: '', input_index: inputIndex, reason: 'missing_row_id' });
      return;
    }
    if (seen.has(rowId)) {
      skipped.push({ row_id: rowId, input_index: inputIndex, reason: 'duplicate_row_id' });
      return;
    }
    seen.add(rowId);
    if (!repairedTranslation) {
      skipped.push({ row_id: rowId, input_index: inputIndex, reason: 'missing_repaired_translation' });
      return;
    }
    const start = Number(item?.start);
    const duration = Number(item?.duration);
    const end = Number(item?.end);
    const safeStart = Number.isFinite(start) ? start : 0;
    const safeEnd = Number.isFinite(end)
      ? end
      : safeStart + Math.max(0.1, Number.isFinite(duration) ? duration : 1);
    normalized.push({
      row_id: rowId,
      input_index: inputIndex,
      cue_index: Number(item?.index) || inputIndex + 1,
      start: roundMetric(safeStart),
      end: roundMetric(Math.max(safeStart + 0.05, safeEnd)),
      repaired_translation: repairedTranslation,
    });
  });

  return { items: normalized, skipped };
}

function previewItemsToAimaxSegments(items = []) {
  return [...items]
    .sort((a, b) => (Number(a.start) - Number(b.start)) || (Number(a.input_index) - Number(b.input_index)))
    .map((item, index) => ({
      id: item.row_id,
      index: index + 1,
      start: item.start,
      end: item.end,
      duration: roundMetric(Math.max(0.05, item.end - item.start)),
      text: item.repaired_translation,
      translatedText: item.repaired_translation,
      finalText: item.repaired_translation,
      ttsText: item.repaired_translation,
    }));
}

function previewStatus(deltaSeconds, toleranceSeconds = TIMING_FIT_TOLERANCE_SECONDS) {
  if (deltaSeconds > toleranceSeconds) return 'overflow';
  if (deltaSeconds < -toleranceSeconds) return 'slack';
  return 'fit';
}

function buildPreviewRepairResults(items = [], report = {}, options = {}) {
  const toleranceSeconds = Number(options.toleranceSeconds) >= 0
    ? Number(options.toleranceSeconds)
    : TIMING_FIT_TOLERANCE_SECONDS;
  const reportById = new Map((Array.isArray(report?.segments) ? report.segments : [])
    .map((segment) => [String(segment.id || segment.sourceRowIds?.[0] || segment.sourceIds?.[0] || ''), segment])
    .filter(([id]) => id));

  return items.map((item) => {
    const reportSegment = reportById.get(String(item.row_id)) || {};
    const slotSeconds = roundMetric(
      reportSegment.availableSlotDurationSeconds
      ?? reportSegment.expectedDurationSeconds
      ?? Math.max(0.05, Number(item.end) - Number(item.start))
    );
    const audioSeconds = roundMetric(
      reportSegment.actualDurationSeconds
      ?? Math.max(0.05, Number(reportSegment.actualEndSeconds || 0) - Number(reportSegment.actualStartSeconds || 0))
      ?? slotSeconds
    );
    const deltaSeconds = roundMetric(audioSeconds - slotSeconds);
    const overflowSeconds = roundMetric(Math.max(0, deltaSeconds));
    const slackSeconds = roundMetric(Math.max(0, -deltaSeconds));
    const status = previewStatus(deltaSeconds, toleranceSeconds);
    return {
      row_id: item.row_id,
      cue_index: item.cue_index,
      input_index: item.input_index,
      start: item.start,
      end: item.end,
      repaired_translation: item.repaired_translation,
      slot_seconds: slotSeconds,
      audio_seconds: audioSeconds,
      delta_seconds: deltaSeconds,
      overflow_seconds: status === 'overflow' ? overflowSeconds : 0,
      slack_seconds: status === 'slack' ? slackSeconds : 0,
      status,
      aimax_batch_index: reportSegment.aimaxBatchIndex,
      aimax_entry_index: reportSegment.aimaxEntryIndex,
      aimax_segment_file_name: reportSegment.aimaxSegmentFileName || '',
      report_segment: reportSegment,
    };
  });
}

module.exports = {
  MAX_REPAIR_PREVIEW_CUES,
  TIMING_FIT_TOLERANCE_SECONDS,
  buildPreviewRepairResults,
  preparePreviewRepairItems,
  previewItemsToAimaxSegments,
  _private: {
    previewStatus,
    roundMetric,
  },
};
