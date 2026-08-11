const { translatedTextContainsSourceNumber } = require('../services/vietnameseNumberText');

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

function roundMetric(value) {
  return Number(Number(value || 0).toFixed(3));
}

function severityRank(status) {
  return status === 'error' ? 2 : status === 'warn' ? 1 : 0;
}

function worstStatus(items) {
  return items.reduce((status, item) => (
    severityRank(item.status) > severityRank(status) ? item.status : status
  ), 'ok');
}

function createIssue(status, code, message, segment = {}, extra = {}) {
  return {
    status,
    code,
    message,
    id: String(segment.id || segment.segmentId || extra.id || ''),
    index: Number(segment.index ?? extra.index ?? 0),
    start: roundMetric(segmentStart(segment)),
    end: roundMetric(segmentEnd(segment)),
    sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String) : [],
    sourceRowIds: Array.isArray(segment.sourceRowIds) ? segment.sourceRowIds.map(String) : [],
    ...extra,
  };
}

function extractNumbers(text = '') {
  return Array.from(new Set(String(text).match(/\d+(?:[.,:/-]\d+)*/g) || []));
}

function textDensity(segment = {}) {
  const text = normalizeText(segment.text || segment.finalText || segment.translatedText || segment.sourceText);
  const duration = Math.max(0.1, segmentEnd(segment) - segmentStart(segment));
  return {
    text,
    duration,
    charsPerSecond: text.length / duration,
  };
}

function readabilityProfile(config = {}) {
  const profileName = String(config.readabilityProfile || 'netflix_vi_adult').trim() || 'netflix_vi_adult';
  const kidsProfile = /kids|children|child/i.test(profileName);
  const maxCharsPerLine = Number(config.readabilityMaxCharsPerLine) || 42;
  const maxLines = Number(config.readabilityMaxLines) || 2;
  const adultCps = Number(config.readabilityAdultMaxCharsPerSecond) || 17;
  const kidsCps = Number(config.readabilityKidsMaxCharsPerSecond) || 13;
  const warnCps = Number(config.readabilityMaxCharsPerSecond) || (kidsProfile ? kidsCps : adultCps);
  return {
    profileName,
    maxCharsPerLine,
    maxLineErrorChars: Number(config.readabilityMaxLineErrorChars) || 52,
    maxLines,
    warnCps,
    errorCps: Number(config.readabilityErrorCharsPerSecond) || (kidsProfile ? 17 : 20),
    minDuration: Number(config.readabilityMinDurationSeconds) || (5 / 6),
    minErrorDuration: Number(config.readabilityMinErrorDurationSeconds) || 0.5,
    maxDuration: Number(config.readabilityMaxDurationSeconds) || 7,
  };
}

function textForReadability(segment = {}) {
  return String(segment.finalText || segment.translatedText || segment.text || '')
    .replace(/\r/g, '')
    .trim();
}

function normalizeReadabilityText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function wrapReadabilityLines(text = '', maxCharsPerLine = 42) {
  const normalized = normalizeReadabilityText(text);
  if (!normalized) return [];
  const max = Math.max(10, Number(maxCharsPerLine) || 42);
  const lines = [];
  let line = '';
  for (const word of normalized.split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
      continue;
    }
    const next = `${line} ${word}`;
    if (Array.from(next).length <= max) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function readabilityLines(text = '', maxCharsPerLine = 42) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  if (raw.includes('\n')) {
    return raw
      .split('\n')
      .map((line) => normalizeReadabilityText(line))
      .filter(Boolean);
  }
  return wrapReadabilityLines(raw, maxCharsPerLine);
}

function foldedVietnamese(value = '') {
  return normalizeReadabilityText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function hasBadLineBreak(lines = []) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  const dependentStart = /^(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi|da|dang|khien|nhung|ma|hoac|hay|nen|rang)\b/;
  const danglingEnd = /\b(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|nhung|ma|hoac|hay|rang)$/;
  for (let index = 1; index < lines.length; index += 1) {
    const previous = foldedVietnamese(lines[index - 1]);
    const current = foldedVietnamese(lines[index]);
    if (dependentStart.test(current) || danglingEnd.test(previous)) return true;
  }
  return false;
}

function createReadabilityQcReport(segments = [], config = {}) {
  const profile = readabilityProfile(config);
  const issues = [];
  const sorted = [...(segments || [])].sort((left, right) => segmentStart(left) - segmentStart(right));

  sorted.forEach((segment, index) => {
    const rawText = textForReadability(segment);
    const text = normalizeReadabilityText(rawText);
    if (!text) return;
    const start = segmentStart(segment);
    const end = segmentEnd(segment);
    const duration = Math.max(0.001, end - start);
    const chars = Array.from(text).length;
    const charsPerSecond = chars / Math.max(0.1, duration);
    const lines = readabilityLines(rawText, profile.maxCharsPerLine);
    const lineLengths = lines.map((line) => Array.from(line).length);
    const maxLineLength = Math.max(0, ...lineLengths);
    const baseMetrics = {
      index,
      duration: roundMetric(duration),
      textLength: chars,
      charsPerSecond: roundMetric(charsPerSecond),
      lineCount: lines.length,
      maxLineLength,
      maxCharsPerLine: profile.maxCharsPerLine,
      profile: profile.profileName,
    };

    if (charsPerSecond > profile.warnCps) {
      issues.push(createIssue(
        charsPerSecond > profile.errorCps ? 'error' : 'warn',
        'READING_SPEED_TOO_HIGH',
        'Subtitle reading speed is too high for the available duration.',
        segment,
        {
          ...baseMetrics,
          thresholdCharsPerSecond: charsPerSecond > profile.errorCps ? profile.errorCps : profile.warnCps,
        }
      ));
    }
    if (maxLineLength > profile.maxCharsPerLine) {
      issues.push(createIssue(
        maxLineLength > profile.maxLineErrorChars ? 'error' : 'warn',
        'LINE_TOO_LONG',
        'Subtitle line is longer than the readability target.',
        segment,
        {
          ...baseMetrics,
          thresholdChars: maxLineLength > profile.maxLineErrorChars ? profile.maxLineErrorChars : profile.maxCharsPerLine,
        }
      ));
    }
    if (lines.length > profile.maxLines) {
      issues.push(createIssue('error', 'TOO_MANY_LINES', 'Subtitle uses too many display lines.', segment, baseMetrics));
    }
    if (duration < profile.minDuration) {
      issues.push(createIssue(
        duration < profile.minErrorDuration ? 'error' : 'warn',
        'EVENT_TOO_SHORT_FOR_READING',
        'Subtitle event is too short for comfortable reading.',
        segment,
        {
          ...baseMetrics,
          thresholdSeconds: duration < profile.minErrorDuration ? profile.minErrorDuration : roundMetric(profile.minDuration),
        }
      ));
    }
    if (duration > profile.maxDuration) {
      issues.push(createIssue('warn', 'EVENT_TOO_LONG', 'Subtitle event is longer than the readability target.', segment, {
        ...baseMetrics,
        thresholdSeconds: profile.maxDuration,
      }));
    }
    if (hasBadLineBreak(lines)) {
      issues.push(createIssue('warn', 'BAD_LINE_BREAK', 'Subtitle line break may make the sentence harder to read.', segment, {
        ...baseMetrics,
        lines,
      }));
    }
  });

  return {
    name: 'readability',
    status: worstStatus(issues),
    checkedAt: new Date().toISOString(),
    profile: profile.profileName,
    segmentCount: sorted.length,
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.status === 'error').length,
    warningCount: issues.filter((issue) => issue.status === 'warn').length,
    thresholds: {
      maxCharsPerLine: profile.maxCharsPerLine,
      maxLineErrorChars: profile.maxLineErrorChars,
      maxLines: profile.maxLines,
      warnCharsPerSecond: profile.warnCps,
      errorCharsPerSecond: profile.errorCps,
      minDurationSeconds: roundMetric(profile.minDuration),
      minErrorDurationSeconds: profile.minErrorDuration,
      maxDurationSeconds: profile.maxDuration,
    },
    issues,
  };
}

function createTimelineQcReport(name, segments = [], config = {}) {
  const maxCharsPerSecond = Number(config.qcMaxCharsPerSecond) || 24;
  const minDuration = Number(config.qcMinCueDurationSeconds) || 0.12;
  const maxDuration = Number(config.qcMaxCueDurationSeconds) || 12;
  const issues = [];
  const sorted = [...(segments || [])].sort((left, right) => segmentStart(left) - segmentStart(right));

  sorted.forEach((segment, index) => {
    const start = segmentStart(segment);
    const end = segmentEnd(segment);
    const duration = end - start;
    const density = textDensity(segment);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      issues.push(createIssue('error', 'INVALID_TIMING', 'Segment timing is invalid.', segment, { index }));
      return;
    }
    if (!density.text) {
      issues.push(createIssue('warn', 'EMPTY_TEXT', 'Segment text is empty.', segment, { index }));
    }
    if (duration < minDuration) {
      issues.push(createIssue('warn', 'TOO_SHORT', 'Segment duration is very short.', segment, {
        index,
        duration: roundMetric(duration),
      }));
    }
    if (duration > maxDuration) {
      issues.push(createIssue('warn', 'TOO_LONG', 'Segment duration is long and may need review.', segment, {
        index,
        duration: roundMetric(duration),
      }));
    }
    if (density.text && density.charsPerSecond > maxCharsPerSecond) {
      issues.push(createIssue('warn', 'TEXT_TOO_DENSE', 'Text may be too dense for the available duration.', segment, {
        index,
        charsPerSecond: roundMetric(density.charsPerSecond),
        duration: roundMetric(density.duration),
        textLength: density.text.length,
      }));
    }

    const next = sorted[index + 1];
    if (next && end > segmentStart(next) + 0.001) {
      issues.push(createIssue('error', 'OVERLAP', 'Segment overlaps the next segment.', segment, {
        index,
        nextId: String(next.id || next.segmentId || ''),
        overlapSeconds: roundMetric(end - segmentStart(next)),
      }));
    }
  });

  const status = worstStatus(issues);
  return {
    name,
    status,
    checkedAt: new Date().toISOString(),
    segmentCount: sorted.length,
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.status === 'error').length,
    warningCount: issues.filter((issue) => issue.status === 'warn').length,
    issues,
  };
}

function createTranslationQcReport(sourceSegments = [], translatedSegments = [], config = {}) {
  const timeline = createTimelineQcReport('translation', translatedSegments, config);
  const issues = [...timeline.issues];
  const translatedText = normalizeText(translatedSegments.map((segment) => (
    segment.text || segment.finalText || segment.translatedText || ''
  )).join(' '));

  for (const source of sourceSegments || []) {
    for (const number of extractNumbers(source.text || source.sourceText || source.originalText)) {
      if (!translatedTextContainsSourceNumber(translatedText, number)) {
        issues.push(createIssue('warn', 'MISSING_NUMBER', 'A number from the source text may be missing after translation.', source, {
          number,
        }));
      }
    }
  }

  (translatedSegments || []).forEach((segment, index) => {
    const fit = segment?.ttsTimingFit && typeof segment.ttsTimingFit === 'object' ? segment.ttsTimingFit : null;
    if (!fit || !['too_long', 'too_short'].includes(String(fit.status || ''))) return;
    issues.push(createIssue('warn', 'TRANSLATION_TTS_TIMING', 'Translated text may not fit the target TTS timing budget.', segment, {
      index,
      fitStatus: fit.status,
      estimatedSeconds: roundMetric(fit.estimatedSeconds || 0),
      slotSeconds: roundMetric(fit.slotSeconds || segment.duration || 0),
      targetTtsRate: roundMetric(fit.targetTtsRate || segment.translationTargetTtsRate || 1),
      validation: fit.validation || 'estimate',
    }));
  });

  const status = worstStatus(issues);
  return {
    ...timeline,
    name: 'translation',
    status,
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.status === 'error').length,
    warningCount: issues.filter((issue) => issue.status === 'warn').length,
    sourceSegmentCount: sourceSegments.length,
    translatedSegmentCount: translatedSegments.length,
    issues,
  };
}

function createTtsQcReport(ttsUnits = [], clips = [], config = {}) {
  const timeline = createTimelineQcReport('tts', ttsUnits, config);
  const issues = [...timeline.issues];
  const fitPlan = config.ttsFitPlan && typeof config.ttsFitPlan === 'object' ? config.ttsFitPlan : null;
  const fitById = new Map((fitPlan?.units || []).map((unit) => [String(unit.id || ''), unit]));
  const clipById = new Map();
  clips.forEach((clip) => {
    const ids = [clip.id, clip.segmentId, clip.sourceId, clip.ttsUnitId].filter(Boolean).map(String);
    ids.forEach((id) => clipById.set(id, clip));
  });

  ttsUnits.forEach((unit, index) => {
    const duration = Math.max(0.1, segmentEnd(unit) - segmentStart(unit));
    const clip = clipById.get(String(unit.id || '')) || clips[index];
    if (clip?.ttsError === true || clip?.ttsFailed === true || clip?.status === 'error') {
      issues.push(createIssue('error', clip.errorCode || 'TTS_FAILED', clip.errorMessage || clip.error_reason || 'TTS generation failed.', unit, {
        index,
        provider: clip.provider || config.ttsProvider || '',
      }));
      return;
    }
    const clipDuration = Number(clip?.duration || clip?.durationSeconds || clip?.audioDurationSeconds || 0);
    if (clip && Number.isFinite(clipDuration) && clipDuration > duration + (Number(config.qcTtsOverflowToleranceSeconds) || 0.35)) {
      issues.push(createIssue('warn', 'TTS_OVERFLOW', 'TTS clip is longer than its target timing slot.', unit, {
        index,
        slotDuration: roundMetric(duration),
        audioDuration: roundMetric(clipDuration),
        overflowSeconds: roundMetric(clipDuration - duration),
      }));
    }
    const fit = fitById.get(String(unit.id || '')) || unit.ttsFit || null;
    if (fit?.action === 'manual_review') {
      issues.push(createIssue('warn', 'TTS_MANUAL_REVIEW', 'TTS fit planner recommends manual text review.', unit, {
        index,
        fitRatio: roundMetric(fit.fitRatio),
        overflowBefore: roundMetric(fit.overflowBefore),
      }));
    }
  });

  const status = worstStatus(issues);
  return {
    ...timeline,
    name: 'tts',
    status,
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.status === 'error').length,
    warningCount: issues.filter((issue) => issue.status === 'warn').length,
    ttsUnitCount: ttsUnits.length,
    clipCount: clips.length,
    fitPlan: fitPlan ? {
      status: fitPlan.status,
      enabled: fitPlan.enabled,
      mode: fitPlan.mode,
      summary: fitPlan.summary,
      units: fitPlan.units,
    } : null,
    issues,
  };
}

function createSyncQcReport(syncReport = {}, config = {}) {
  const issues = [];
  const maxDrift = Number(syncReport.maxStartDriftSeconds ?? syncReport.maxDriftSeconds ?? 0);
  const maxOverflow = Number(syncReport.maxEndOverflowSeconds ?? syncReport.maxOverflowSeconds ?? 0);
  const failedCount = Number(syncReport.failedSegmentCount || 0);
  const driftTolerance = Number(config.qcSyncDriftToleranceSeconds) || 0.35;
  const overflowTolerance = Number(config.qcSyncOverflowToleranceSeconds) || 0.12;

  if (failedCount > 0) {
    issues.push({
      status: 'error',
      code: 'SYNC_FAILED_SEGMENTS',
      message: 'Sync report contains failed segments.',
      failedCount,
    });
  }
  if (maxDrift > driftTolerance) {
    issues.push({
      status: 'warn',
      code: 'SYNC_DRIFT',
      message: 'Voice timing drift exceeds the review threshold.',
      maxDriftSeconds: roundMetric(maxDrift),
    });
  }
  if (maxOverflow > overflowTolerance) {
    issues.push({
      status: 'warn',
      code: 'SYNC_OVERFLOW',
      message: 'Voice timing overflows subtitle slots.',
      maxOverflowSeconds: roundMetric(maxOverflow),
    });
  }

  return {
    name: 'sync',
    status: worstStatus(issues),
    checkedAt: new Date().toISOString(),
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.status === 'error').length,
    warningCount: issues.filter((issue) => issue.status === 'warn').length,
    issues,
    metrics: {
      maxDriftSeconds: roundMetric(maxDrift),
      maxActualStartDriftSeconds: roundMetric(syncReport.maxActualStartDriftSeconds || 0),
      centeredClipCount: Number(syncReport.centeredClipCount || 0),
      maxVoiceAlignShiftSeconds: roundMetric(syncReport.maxVoiceAlignShiftSeconds || 0),
      avgVoiceAlignShiftSeconds: roundMetric(syncReport.avgVoiceAlignShiftSeconds || 0),
      maxOverflowSeconds: roundMetric(maxOverflow),
      failedSegmentCount: failedCount,
      quality: syncReport.quality || '',
      strictPass: syncReport.strictPass,
    },
  };
}

module.exports = {
  createReadabilityQcReport,
  createSyncQcReport,
  createTimelineQcReport,
  createTranslationQcReport,
  createTtsQcReport,
};
