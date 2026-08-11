const {
  buildMeaningUnits,
  buildTranslationPackets,
  mapMeaningUnitsToDisplayRows,
  redistributeTranslatedPackets,
  splitLongTranslatedDisplaySegments,
  ttsTextFromTranslation,
} = require('../services/timelineService');
const {
  createTimelineQcReport,
  createTranslationQcReport,
  createTtsQcReport,
} = require('./qcReport');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function segmentStart(segment = {}) {
  const value = Number(segment.start);
  return Number.isFinite(value) ? value : 0;
}

function segmentEnd(segment = {}) {
  const start = segmentStart(segment);
  const explicitEnd = Number(segment.end);
  if (Number.isFinite(explicitEnd)) return explicitEnd;
  const duration = Number(segment.duration);
  return start + Math.max(0.1, Number.isFinite(duration) ? duration : 0.8);
}

function normalizeSegments(segments = [], idPrefix = 'segment') {
  return (segments || [])
    .map((segment, index) => {
      const start = segmentStart(segment);
      const end = Math.max(start + 0.05, segmentEnd(segment));
      const text = normalizeText(segment.text || segment.sourceText || segment.originalText || segment.finalText || segment.translatedText);
      return {
        ...segment,
        id: String(segment.id || segment.segmentId || `${idPrefix}-${index + 1}`),
        index,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        text,
      };
    })
    .filter((segment) => segment.text && segment.end > segment.start)
    .sort((left, right) => left.start - right.start)
    .map((segment, index) => ({ ...segment, index }));
}

function sourceIdsForUnit(unit = {}) {
  const explicit = Array.isArray(unit.sourceRowIds) && unit.sourceRowIds.length
    ? unit.sourceRowIds
    : Array.isArray(unit.sourceIds) && unit.sourceIds.length
      ? unit.sourceIds
      : Array.isArray(unit.childSegments) && unit.childSegments.length
        ? unit.childSegments.map((segment) => segment?.id)
        : [unit.id];
  return explicit.map((value) => String(value || '').trim()).filter(Boolean);
}

function validateSourceCoverage(sourceSegments = [], groupedUnits = []) {
  const sourceIds = (sourceSegments || []).map((segment) => String(segment?.id || '').trim()).filter(Boolean);
  const sourceIdSet = new Set(sourceIds);
  const duplicateSourceIds = sourceIds.filter((id, index) => sourceIds.indexOf(id) !== index);
  const coveredIds = [];
  const unexpectedIds = [];

  for (const unit of groupedUnits || []) {
    for (const id of sourceIdsForUnit(unit)) {
      coveredIds.push(id);
      if (!sourceIdSet.has(id)) unexpectedIds.push(id);
    }
  }

  const counts = new Map();
  coveredIds.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
  const missingIds = sourceIds.filter((id) => !counts.has(id));
  const duplicateIds = sourceIds.filter((id) => (counts.get(id) || 0) > 1);
  const coveredSourceIds = coveredIds.filter((id) => sourceIdSet.has(id));
  const expectedOrder = sourceIds.join('\u0000');
  const actualOrder = coveredSourceIds.join('\u0000');
  const orderValid = expectedOrder === actualOrder;
  const uniqueUnexpectedIds = Array.from(new Set(unexpectedIds));
  const uniqueDuplicateIds = Array.from(new Set(duplicateIds));
  const uniqueDuplicateSourceIds = Array.from(new Set(duplicateSourceIds));
  const valid = Boolean(sourceIds.length)
    && !uniqueDuplicateSourceIds.length
    && !missingIds.length
    && !uniqueDuplicateIds.length
    && !uniqueUnexpectedIds.length
    && orderValid;

  return {
    name: 'source_coverage',
    status: valid ? 'ok' : 'error',
    checkedAt: new Date().toISOString(),
    valid,
    sourceCount: sourceIds.length,
    groupedUnitCount: Array.isArray(groupedUnits) ? groupedUnits.length : 0,
    coveredCount: coveredSourceIds.length,
    uniqueCoveredCount: new Set(coveredSourceIds).size,
    coveragePercent: sourceIds.length
      ? Number(((new Set(coveredSourceIds).size / sourceIds.length) * 100).toFixed(2))
      : 0,
    missingIds,
    duplicateIds: uniqueDuplicateIds,
    unexpectedIds: uniqueUnexpectedIds,
    duplicateSourceIds: uniqueDuplicateSourceIds,
    orderValid,
  };
}

function assertSourceCoverage(sourceSegments = [], groupedUnits = []) {
  const report = validateSourceCoverage(sourceSegments, groupedUnits);
  if (report.valid) return report;
  const reasons = [];
  if (report.duplicateSourceIds.length) reasons.push(`ID nguồn bị trùng: ${report.duplicateSourceIds.join(', ')}`);
  if (report.missingIds.length) reasons.push(`thiếu ID: ${report.missingIds.join(', ')}`);
  if (report.duplicateIds.length) reasons.push(`ID xuất hiện nhiều lần: ${report.duplicateIds.join(', ')}`);
  if (report.unexpectedIds.length) reasons.push(`ID không thuộc nguồn: ${report.unexpectedIds.join(', ')}`);
  if (!report.orderValid) reasons.push('thứ tự ID nguồn bị thay đổi');
  const error = new Error(`Phân cụm nguồn không an toàn (${reasons.join('; ') || 'không có dữ liệu nguồn'}).`);
  error.code = 'SOURCE_COVERAGE_INVALID';
  error.report = report;
  throw error;
}

function alignTranslatedUnitsById(inputUnits = [], translatedUnits = []) {
  const inputIds = inputUnits.map((unit) => String(unit?.id || '').trim());
  const translatedIds = translatedUnits.map((unit) => String(unit?.id || '').trim());
  const invalidInputIds = inputIds.filter((id) => !id);
  const duplicateInputIds = inputIds.filter((id, index) => id && inputIds.indexOf(id) !== index);
  if (invalidInputIds.length || duplicateInputIds.length) {
    throw new Error('Danh sách cụm dịch có ID nguồn rỗng hoặc bị trùng.');
  }

  const translatedById = new Map();
  const duplicateTranslatedIds = [];
  for (const unit of translatedUnits) {
    const id = String(unit?.id || '').trim();
    if (!id) continue;
    if (translatedById.has(id)) duplicateTranslatedIds.push(id);
    translatedById.set(id, unit);
  }

  const inputIdSet = new Set(inputIds);
  const missingIds = inputIds.filter((id) => !translatedById.has(id));
  const unexpectedIds = translatedIds.filter((id) => id && !inputIdSet.has(id));
  if (missingIds.length || duplicateTranslatedIds.length || unexpectedIds.length) {
    const reasons = [];
    if (missingIds.length) reasons.push(`thiếu kết quả: ${missingIds.join(', ')}`);
    if (duplicateTranslatedIds.length) reasons.push(`ID kết quả bị trùng: ${Array.from(new Set(duplicateTranslatedIds)).join(', ')}`);
    if (unexpectedIds.length) reasons.push(`ID kết quả không hợp lệ: ${Array.from(new Set(unexpectedIds)).join(', ')}`);
    const error = new Error(`Kết quả dịch không khớp ID cụm (${reasons.join('; ')}).`);
    error.code = 'TRANSLATION_ID_MISMATCH';
    error.missingIds = missingIds;
    error.duplicateIds = Array.from(new Set(duplicateTranslatedIds));
    error.unexpectedIds = Array.from(new Set(unexpectedIds));
    throw error;
  }

  return inputUnits.map((input) => ({
    ...input,
    ...translatedById.get(String(input.id)),
    id: String(input.id),
    sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds : translatedById.get(String(input.id))?.sourceIds,
    sourceRowIds: Array.isArray(input.sourceRowIds) ? input.sourceRowIds : translatedById.get(String(input.id))?.sourceRowIds,
  }));
}

function buildSourceTimeline(rawSegments = [], config = {}) {
  const sourceSegments = normalizeSegments(rawSegments, 'source');
  return {
    sourceSegments,
    qcReport: createTimelineQcReport('source', sourceSegments, config),
  };
}

function resolveMode(config = {}, options = {}) {
  return String(options.mode || config.timelinePipelineMode || 'translation_packets').trim();
}

function buildTranslationUnits(sourceSegments = [], config = {}, options = {}) {
  const mode = resolveMode(config, options);
  const normalizedSource = normalizeSegments(sourceSegments, 'source');
  const translationUnits = mode === 'meaning_units'
    ? buildMeaningUnits(normalizedSource, config)
    : buildTranslationPackets(normalizedSource, config);
  return {
    mode,
    sourceSegments: normalizedSource,
    translationUnits,
    qcReport: createTimelineQcReport('translation_units', translationUnits, config),
  };
}

function mapTranslatedUnitsToDisplayRows(translatedUnits = [], sourceSegments = [], config = {}, options = {}) {
  const mode = resolveMode(config, options);
  const normalizedSource = normalizeSegments(sourceSegments, 'source');
  const displayRows = mode === 'meaning_units'
    ? mapMeaningUnitsToDisplayRows(translatedUnits, normalizedSource, config)
    : redistributeTranslatedPackets(options.translationUnits || normalizedSource, translatedUnits, config);
  return {
    mode,
    displayRows,
    qcReport: createTranslationQcReport(normalizedSource, displayRows, config),
  };
}

function mapTranslatedUnitsToMergedDisplayRows(translatedUnits = [], sourceSegments = [], config = {}) {
  const normalizedSource = normalizeSegments(sourceSegments, 'source');
  const sourceById = new Map(normalizedSource.map((segment) => [String(segment.id), segment]));
  const displayRows = normalizeSegments(translatedUnits, 'meaning')
    .map((unit, index) => {
      const sourceRowIds = Array.from(new Set([
        ...(Array.isArray(unit.sourceRowIds) ? unit.sourceRowIds : []),
        ...(Array.isArray(unit.sourceIds) ? unit.sourceIds : []),
      ].map(String).filter(Boolean)));
      const sourceRows = sourceRowIds.map((id) => sourceById.get(id)).filter(Boolean);
      const sourceText = normalizeText(
        unit.sourceText
        || unit.originalText
        || sourceRows.map((row) => row.text || row.sourceText || row.originalText).filter(Boolean).join(' ')
      );
      const translatedText = normalizeText(unit.translatedText || unit.finalText || unit.text);
      const ttsText = normalizeText(unit.ttsText || translatedText);
      const start = segmentStart(unit);
      const end = Math.max(start + 0.05, segmentEnd(unit));
      return {
        ...unit,
        id: String(unit.id || `meaning-${String(index + 1).padStart(3, '0')}`),
        index,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        text: translatedText,
        translatedText,
        finalText: translatedText,
        ttsText,
        originalText: sourceText,
        sourceText,
        sourceIds: sourceRowIds,
        sourceRowIds,
        meaningUnitId: String(unit.id || `meaning-${String(index + 1).padStart(3, '0')}`),
        meaningUnitSourceIds: sourceRowIds,
        sourceSegmentCount: Number(unit.sourceSegmentCount) || sourceRowIds.length || 1,
      };
    })
    .filter((row) => row.text);
  const splitDisplayRows = splitLongTranslatedDisplaySegments(displayRows, config);
  return {
    mode: 'merged_meaning_units',
    displayRows: splitDisplayRows,
    qcReport: createTranslationQcReport(normalizedSource, splitDisplayRows, config),
  };
}

function buildFallbackTtsUnits(displayRows = [], config = {}) {
  const units = normalizeSegments(displayRows, 'tts')
    .map((row, index) => {
      const finalText = normalizeText(row.finalText || row.translatedText || row.text);
      const rawTtsText = normalizeText(row.ttsText || finalText);
      const ttsText = ttsTextFromTranslation(rawTtsText, config) || rawTtsText;
      return {
        ...row,
        id: String(row.id || `tts-${index + 1}`),
        index,
        text: ttsText,
        ttsText,
        prosodyText: ttsText,
        finalText,
        translatedText: normalizeText(row.translatedText || row.finalText || row.text),
        ttsCleanupMode: config.ttsTextCleanupMode || 'natural',
        sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds : [String(row.id || `display-${index + 1}`)],
        sourceRowIds: Array.isArray(row.sourceRowIds) ? row.sourceRowIds : [String(row.id || `display-${index + 1}`)],
      };
    })
    .filter((unit) => unit.text);
  return mergeContinuationTtsUnits(units, config);
}

function isHardSentenceEnd(text = '') {
  return /[.!?\u3002\uff01\uff1f]\s*$/.test(normalizeText(text));
}

function hasInternalHardSentenceBoundary(text = '') {
  return /[.!?\u3002\uff01\uff1f]\s+\S/u.test(normalizeText(text));
}

function foldBoundaryText(text = '') {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function startsWithDependentCue(text = '') {
  return /^(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi|da|dang|khien|thuc chat)\b/.test(foldBoundaryText(text));
}

function endsWithDependentCue(text = '') {
  return /\b(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi)$/.test(foldBoundaryText(text));
}

function shouldMergeContinuationTtsUnit(previous = {}, current = {}, config = {}) {
  const previousText = normalizeText(previous.ttsText || previous.text || previous.finalText || previous.translatedText);
  const currentText = normalizeText(current.ttsText || current.text || current.finalText || current.translatedText);
  if (!previousText || !currentText) return false;

  const gap = Math.max(0, segmentStart(current) - segmentEnd(previous));
  const mergeGap = Math.max(0, Math.min(0.8, Number(config.ttsMergeGapSeconds ?? 0.35)));
  if (gap > mergeGap) return false;

  const mergedDuration = Math.max(segmentEnd(previous), segmentEnd(current)) - segmentStart(previous);
  const mergedText = normalizeText(`${previousText} ${currentText}`);
  const previousEndsDependent = endsWithDependentCue(previousText);
  const currentStartsDependent = startsWithDependentCue(currentText);
  const continuationCandidate = !isHardSentenceEnd(previousText) || previousEndsDependent || currentStartsDependent;
  const normalMaxDuration = Math.max(4, Math.min(9, Number(config.maxTtsMergeDuration ?? config.ttsUnitHardMaxDuration ?? 7.5)));
  const normalMaxChars = Math.max(120, Math.min(320, Number(config.maxTtsMergeChars ?? 260)));
  const continuationMaxDuration = Math.max(
    normalMaxDuration,
    Math.min(12, Number(config.maxContinuationTtsMergeDuration ?? config.ttsContinuationHardMaxDuration ?? 10.5))
  );
  const continuationMaxChars = Math.max(
    normalMaxChars,
    Math.min(420, Number(config.maxContinuationTtsMergeChars ?? 340))
  );
  const maxDuration = continuationCandidate ? continuationMaxDuration : normalMaxDuration;
  const maxChars = continuationCandidate ? continuationMaxChars : normalMaxChars;
  if (mergedDuration > maxDuration || [...mergedText].length > maxChars) return false;

  if (hasInternalHardSentenceBoundary(previousText) && !previousEndsDependent) return currentStartsDependent;
  if (!isHardSentenceEnd(previousText)) return true;
  return previousEndsDependent || currentStartsDependent;
}

function mergeContinuationTtsUnits(units = [], config = {}) {
  const output = [];
  for (const unit of units) {
    const previous = output[output.length - 1];
    if (!previous || !shouldMergeContinuationTtsUnit(previous, unit, config)) {
      output.push(unit);
      continue;
    }
    const mergedText = normalizeText(`${previous.ttsText || previous.text} ${unit.ttsText || unit.text}`);
    const mergedFinalText = normalizeText(`${previous.finalText || previous.translatedText || previous.text} ${unit.finalText || unit.translatedText || unit.text}`);
    output[output.length - 1] = {
      ...previous,
      end: Number(Math.max(segmentEnd(previous), segmentEnd(unit)).toFixed(3)),
      duration: Number(Math.max(0.1, Math.max(segmentEnd(previous), segmentEnd(unit)) - segmentStart(previous)).toFixed(3)),
      text: mergedText,
      ttsText: mergedText,
      prosodyText: mergedText,
      finalText: mergedFinalText,
      translatedText: mergedFinalText,
      sourceIds: Array.from(new Set([...(previous.sourceIds || []), ...(unit.sourceIds || [])].map(String).filter(Boolean))),
      sourceRowIds: Array.from(new Set([...(previous.sourceRowIds || []), ...(unit.sourceRowIds || [])].map(String).filter(Boolean))),
      sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(unit.sourceSegmentCount) || 1),
    };
  }
  return output.map((unit, index) => ({
    ...unit,
    id: String(unit.id || `tts-${index + 1}`),
    index,
  }));
}

function buildTtsUnits(displayRows = [], translatedUnits = [], config = {}, options = {}) {
  const builder = typeof options.builder === 'function' ? options.builder : null;
  const ttsUnits = builder
    ? builder(displayRows, translatedUnits, config)
    : buildFallbackTtsUnits(displayRows, config);
  return {
    ttsUnits,
    qcReport: createTtsQcReport(ttsUnits, options.clips || [], config),
  };
}

function validateTimelineArtifacts(artifacts = {}, config = {}) {
  return {
    source: createTimelineQcReport('source', artifacts.sourceSegments || [], config),
    translationUnits: createTimelineQcReport('translation_units', artifacts.translationUnits || [], config),
    displayRows: createTranslationQcReport(artifacts.sourceSegments || [], artifacts.displayRows || [], config),
    ttsUnits: createTtsQcReport(artifacts.ttsUnits || [], artifacts.ttsClips || [], config),
  };
}

module.exports = {
  alignTranslatedUnitsById,
  assertSourceCoverage,
  buildSourceTimeline,
  buildTranslationUnits,
  buildTtsUnits,
  mapTranslatedUnitsToMergedDisplayRows,
  mapTranslatedUnitsToDisplayRows,
  validateSourceCoverage,
  validateTimelineArtifacts,
};
