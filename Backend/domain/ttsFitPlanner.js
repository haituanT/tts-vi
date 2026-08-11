function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
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

function foldVietnamese(text = '') {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function spokenTokens(text = '') {
  return normalizeText(text)
    .replace(/[.,;:!?\u3002\uff01\uff1f\uff1b\uff1a\uff0c]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function estimateSpeechSeconds(text = '', config = {}) {
  const tokens = spokenTokens(text);
  const punctuationPauses = (normalizeText(text).match(/[,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c]/g) || []).length;
  const wordsPerSecond = clamp(config.ttsFitWordsPerSecond || 3.15, 1.8, 5.6);
  return Number(((tokens.length / wordsPerSecond) + punctuationPauses * 0.08).toFixed(3));
}

function estimateSpeechSecondsAtRate(text = '', speakingRate = 1, config = {}) {
  const rate = clamp(speakingRate || config.speakingRate || 1, 0.75, 2);
  return Number((estimateSpeechSeconds(text, config) / rate).toFixed(3));
}

function getModeProfile(config = {}) {
  const mode = String(config.ttsFitMode || 'balanced').trim().toLowerCase();
  if (mode === 'natural') {
    return {
      mildRatio: 1.08,
      reviewRatio: 1.22,
      hardReviewRatio: 1.42,
      maxRate: Math.min(1.1, Number(config.ttsFitMaxRate) || 1.1),
    };
  }
  if (mode === 'strict') {
    return {
      mildRatio: 1.03,
      reviewRatio: 1.12,
      hardReviewRatio: 1.28,
      maxRate: Math.min(1.25, Number(config.ttsFitMaxRate) || 1.25),
    };
  }
  return {
    mildRatio: 1.05,
    reviewRatio: 1.18,
    hardReviewRatio: 1.35,
    maxRate: Math.min(1.2, Number(config.ttsFitMaxRate) || 1.2),
  };
}

function isClosingCue(text = '') {
  const folded = foldVietnamese(text);
  return /\b(cam on|hen gap|ket thuc|den day|het video|video nay|ky sau|tap sau|duoc roi)\b/.test(folded);
}

function removeFillerPhrases(text = '') {
  const replacements = [
    /\bc[oóòỏõọ] v[eẻẽẹéè]\b/gi,
    /\br[aấầẩẫậ]t\b(?=\s+(an to[aàáảãạ]n|nguy hi[eểễệếề]m|don gi[aảãạáà]n))/gi,
    /\bk[yỳýỷỹỵ]\s+n[aàáảãạ]y\b/gi,
    /\bđ[eếềểễệ]n\s+đ[aâầấẩẫậ]y\s+l[aàáảãạ]\b/gi,
    /\bnh[eẹéèẻẽ]\s+nh[aẹéèẻẽ]ng\b/gi,
    /\bth[uựứừửữ]c\s+s[uựứừửữ]\b/gi,
    /\bm[oộốồổỗ]t\s+c[aáàảãạ]ch\b/gi,
    /\bm[oộốồổỗ]i\s+ng[uư]?[oờớởỡợ]i\b/gi,
  ];
  let output = compactDubbingText(text);
  for (const pattern of replacements) {
    output = output.replace(pattern, '');
  }
  return normalizeText(output)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/^\s*[,.;:!?]+/, '')
    .trim();
}

function keepNumbersWhenShortening(original, candidate) {
  const normalizedOriginal = normalizeText(original);
  const numbers = normalizedOriginal.match(/\d+(?:[.,:/-]\d+)*/g) || [];
  let output = normalizeText(candidate);
  for (const number of numbers) {
    if (!output.includes(number)) {
      output = normalizeText(`${output} ${number}`);
    }
  }
  return output;
}

function disabledTextBudgetHelper(text = '', targetRatio = 0.85) {
  const original = normalizeText(text);
  const cleaned = removeFillerPhrases(original);
  const targetLength = Math.max(12, Math.floor(original.length * targetRatio));
  if (cleaned.length <= targetLength || cleaned.length <= original.length * 0.88) {
    return keepNumbersWhenShortening(original, cleaned || original);
  }

  const parts = cleaned
    .split(/([,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c])/)
    .reduce((items, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const value = normalizeText(`${token}${next}`);
        if (value) items.push(value);
      }
      return items;
    }, []);

  let output = '';
  for (const part of parts.length ? parts : cleaned.split(/\s+/)) {
    const candidate = normalizeText(output ? `${output} ${part}` : part);
    if (candidate.length > targetLength && output) break;
    if (candidate.length > targetLength && !output && parts.length) {
      output = '';
      break;
    }
    output = candidate;
  }

  if (!output || output.length < Math.min(10, targetLength * 0.4)) {
    const words = cleaned.split(/\s+/).filter(Boolean);
    output = '';
    for (const word of words) {
      const candidate = output ? `${output} ${word}` : word;
      if (candidate.length > targetLength && output) break;
      output = candidate;
    }
  }

  return keepNumbersWhenShortening(original, output || cleaned || original);
}

function unitText(unit = {}) {
  return normalizeText(unit.prosodyText || unit.ttsText || unit.text || unit.finalText || unit.translatedText || '');
}

function planUnit(unit = {}, config = {}) {
  const profile = getModeProfile(config);
  const baseRate = clamp(config.speakingRate || 1, 0.75, 2);
  const maxRate = clamp(config.ttsFitMaxRate || profile.maxRate, baseRate, 1.35);
  const text = unitText(unit);
  const timelineDuration = Math.max(0, segmentEnd(unit) - segmentStart(unit));
  const slotDuration = Math.max(
    0.1,
    Number(unit.allowedDuration) || 0,
    Number(unit.slotDuration) || 0,
    timelineDuration,
    Number(unit.duration) || 0
  );
  const estimated = estimateSpeechSecondsAtRate(text, baseRate, config);
  const fitRatio = Number((estimated / Math.max(0.1, slotDuration)).toFixed(3));
  const closingCue = isClosingCue(text);

  let action = 'ok';
  let suggestedRate = baseRate;
  let fittedText = text;
  let reason = 'Text fits the target slot.';

  const requiredRate = Number((baseRate * fitRatio).toFixed(3));
  const speedUpOnlyOverflowSeconds = Math.max(0.2, Math.min(1.2, Number(config.ttsFitSpeedUpOnlyOverflowSeconds) || 0.65));

  if (config.ttsFitMeasuredOverflowOnly === true) {
    // The actual provider audio is the source of truth in this mode.  Do not
    // speed up from an estimate: the renderer will first make the clip at the
    // user's target rate, then retry only clips whose measured overflow passes
    // the configured threshold.
    reason = 'Render at the target rate first; measure audio before applying anti-overflow speed.';
  } else if (
    fitRatio > profile.mildRatio
    && (requiredRate <= maxRate + 0.01 || estimated - slotDuration <= speedUpOnlyOverflowSeconds)
  ) {
    action = 'speed_up';
    suggestedRate = Number(Math.min(maxRate, Math.max(baseRate, requiredRate)).toFixed(2));
    reason = 'Text is slightly over budget; use a per-unit speaking rate.';
  } else if (fitRatio > profile.hardReviewRatio) {
    action = 'manual_review';
    suggestedRate = maxRate;
    fittedText = text;
    reason = 'Estimated speech is much longer than the slot; manual review is safer than forcing speed.';
  } else if (fitRatio > profile.reviewRatio || (closingCue && fitRatio > profile.mildRatio)) {
    action = 'manual_review';
    suggestedRate = Math.min(maxRate, Number(Math.max(baseRate, Math.min(maxRate, baseRate * Math.min(fitRatio, 1.12))).toFixed(2)));
    fittedText = text;
    reason = 'Text likely needs manual shortening before TTS.';
  }

  const fittedEstimated = estimateSpeechSecondsAtRate(fittedText, suggestedRate, config);
  return {
    id: String(unit.id || ''),
    index: Number(unit.index) || 0,
    slotDuration: Number(slotDuration.toFixed(3)),
    estimatedSpeechSeconds: estimated,
    fitRatio,
    action,
    suggestedRate,
    reason,
    originalText: text,
    fittedText,
    overflowBefore: Number(Math.max(0, estimated - slotDuration).toFixed(3)),
    overflowAfter: Number(Math.max(0, fittedEstimated - slotDuration).toFixed(3)),
    closingCue,
  };
}

function statusFromUnits(units = []) {
  if (units.some((unit) => unit.action === 'manual_review')) return 'error';
  if (units.some((unit) => unit.action !== 'ok')) return 'warn';
  return 'ok';
}

function applyPlanToUnits(ttsUnits = [], plan = {}, config = {}) {
  if (config.ttsFitEnabled === false) {
    return ttsUnits;
  }
  const byId = new Map((plan.units || []).map((unit) => [String(unit.id), unit]));
  return (ttsUnits || []).map((unit, index) => {
    const fit = byId.get(String(unit.id || '')) || plan.units?.[index];
    if (!fit) return unit;
    const text = unitText(unit);
    return {
      ...unit,
      text,
      ttsText: text,
      prosodyText: text,
      fittedText: text,
      originalTtsText: fit.originalText,
      suggestedRate: fit.action === 'speed_up' ? fit.suggestedRate : undefined,
      ttsFit: fit,
    };
  });
}

function summarizePlan(units = []) {
  return units.reduce((summary, unit) => {
    summary.total += 1;
    summary[unit.action] = (summary[unit.action] || 0) + 1;
    summary.maxFitRatio = Math.max(summary.maxFitRatio, Number(unit.fitRatio) || 0);
    summary.maxOverflowBefore = Math.max(summary.maxOverflowBefore, Number(unit.overflowBefore) || 0);
    return summary;
  }, {
    total: 0,
    ok: 0,
    speed_up: 0,
    manual_review: 0,
    maxFitRatio: 0,
    maxOverflowBefore: 0,
  });
}

function planTtsFit(ttsUnits = [], config = {}) {
  if (config.ttsFitEnabled === false) {
    const units = (ttsUnits || []).map((unit, index) => ({
      id: String(unit.id || ''),
      index,
      slotDuration: Math.max(0.1, segmentEnd(unit) - segmentStart(unit)),
      estimatedSpeechSeconds: estimateSpeechSeconds(unitText(unit), config),
      fitRatio: 1,
      action: 'ok',
      suggestedRate: clamp(config.speakingRate || 1, 0.75, 2),
      reason: 'TTS fit planner is disabled.',
      originalText: unitText(unit),
      fittedText: unitText(unit),
      overflowBefore: 0,
      overflowAfter: 0,
      closingCue: false,
    }));
    return {
      status: 'ok',
      enabled: false,
      mode: String(config.ttsFitMode || 'balanced'),
      units,
      summary: summarizePlan(units),
    };
  }

  const units = (ttsUnits || []).map((unit) => planUnit(unit, config));
  return {
    status: statusFromUnits(units),
    enabled: true,
    mode: String(config.ttsFitMode || 'balanced'),
    units,
    summary: summarizePlan(units),
  };
}

module.exports = {
  applyPlanToUnits,
  estimateSpeechSeconds,
  planTtsFit,
};
