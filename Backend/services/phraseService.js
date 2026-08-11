function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stableJitter(text) {
  const source = String(text || '');
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return ((Math.abs(hash) % 41) - 20) / 100;
}

function getPhraseProfile(config = {}) {
  const mode = String(config.phraseLengthMode || 'natural').toLowerCase();
  if (mode === 'short') {
    return { targetSeconds: 1.25, maxSeconds: 2.4, maxChars: 48 };
  }
  if (mode === 'detailed') {
    return { targetSeconds: 1.9, maxSeconds: 3.4, maxChars: 78 };
  }
  return {
    targetSeconds: Number(config.targetPhraseSeconds) || 1.6,
    maxSeconds: Number(config.maxPhraseSeconds) || 3.2,
    maxChars: 64,
  };
}

function getPauseProfile(config = {}) {
  const style = String(config.pauseStyle || 'natural').toLowerCase();
  if (style === 'tight') {
    return { continuation: 0, comma: 0.05, clause: 0.1, sentence: 0.18, emphasis: 0.28 };
  }
  if (style === 'dramatic') {
    return { continuation: 0, comma: 0.2, clause: 0.32, sentence: 0.52, emphasis: 0.72 };
  }
  return { continuation: 0, comma: 0.08, clause: 0.16, sentence: 0.32, emphasis: 0.5 };
}

function boundaryTypeForText(text, isLast) {
  if (isLast) return 'none';
  const cleaned = normalizeText(text);
  if (/[.!?。！？]$/.test(cleaned)) return 'sentence';
  if (/[;:；：]$/.test(cleaned)) return 'clause';
  if (/[,，]$/.test(cleaned)) return 'comma';
  return 'continuation';
}

function pauseForBoundary(boundaryType, config, text = '') {
  const profile = getPauseProfile(config);
  const base = profile[boundaryType] || 0;
  if (!base) return 0;
  const jitter = boundaryType === 'continuation' ? 0 : stableJitter(text);
  return Number(Math.max(0.03, base * (1 + jitter)).toFixed(3));
}

function protectNumericPunctuation(text) {
  return String(text || '')
    .replace(/(\d)\s*:\s*(\d)/g, '$1__TIME_COLON__$2')
    .replace(/(\d)\s*,\s*(\d{3}\b)/g, '$1__THOUSAND_COMMA__$2')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1__DECIMAL_DOT__$2')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1__FRACTION_SLASH__$2');
}

function restoreNumericPunctuation(text) {
  return String(text || '')
    .replace(/__TIME_COLON__/g, ':')
    .replace(/__THOUSAND_COMMA__/g, ',')
    .replace(/__DECIMAL_DOT__/g, '.')
    .replace(/__FRACTION_SLASH__/g, '/');
}

function splitByPunctuation(text) {
  const protectedText = protectNumericPunctuation(text);
  return protectedText
    .split(/([,.;:!?，。！？；：])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const combined = normalizeText(`${token}${next}`);
        if (combined) parts.push(restoreNumericPunctuation(combined));
      }
      return parts;
    }, []);
}

function splitLongClause(text, maxChars) {
  const cleaned = normalizeText(text);
  if (cleaned.length <= maxChars) return [cleaned];

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const chunks = [];
    for (let index = 0; index < cleaned.length; index += maxChars) {
      chunks.push(cleaned.slice(index, index + maxChars).trim());
    }
    return chunks.filter(Boolean);
  }

  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function mergeSmallPhraseParts(parts, maxChars) {
  const merged = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length < maxChars * 0.35 && `${previous} ${part}`.length <= maxChars) {
      merged[merged.length - 1] = `${previous} ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function splitPhraseInHalf(text) {
  const cleaned = normalizeText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const midpoint = Math.ceil(cleaned.length / 2);
    return [cleaned.slice(0, midpoint).trim(), cleaned.slice(midpoint).trim()].filter(Boolean);
  }
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')].filter(Boolean);
}

function ensureEnoughPhrasesForDuration(parts, duration, config = {}) {
  const profile = getPhraseProfile(config);
  const desiredCount = Math.max(1, Math.ceil(duration / profile.maxSeconds));
  const maxCount = Math.max(desiredCount, Math.ceil(duration / profile.targetSeconds));
  const output = [...parts];

  while (output.length < desiredCount && output.length < maxCount) {
    let longestIndex = 0;
    for (let index = 1; index < output.length; index += 1) {
      if (output[index].length > output[longestIndex].length) {
        longestIndex = index;
      }
    }

    const split = splitPhraseInHalf(output[longestIndex]);
    if (split.length <= 1) break;
    output.splice(longestIndex, 1, ...split);
  }

  return output;
}

function splitTextIntoPhrases(text, config = {}) {
  const profile = getPhraseProfile(config);
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  const punctuationParts = splitByPunctuation(cleaned);
  const hasSpokenBoundary = punctuationParts.length > 1;
  const allowUnpunctuatedSplit = config.allowUnpunctuatedPhraseSplit === true;
  const rawParts = hasSpokenBoundary ? punctuationParts : [cleaned];
  const parts = rawParts.flatMap((part) => {
    if (!hasSpokenBoundary && !allowUnpunctuatedSplit) return [part];
    return splitLongClause(part, profile.maxChars);
  });
  return mergeSmallPhraseParts(parts.filter(Boolean), profile.maxChars);
}

function allocatePhraseDurations(segment, phrases, config = {}) {
  const duration = Math.max(0.1, Number(segment.duration) || ((Number(segment.end) || 0) - (Number(segment.start) || 0)) || 0.1);
  const charWeights = phrases.map((phrase) => Math.max(1, normalizeText(phrase.text).length));
  const totalWeight = charWeights.reduce((sum, value) => sum + value, 0) || phrases.length;
  const basePauseTotal = phrases.reduce((sum, phrase, index) => (
    index < phrases.length - 1 ? sum + phrase.pauseAfterSeconds : sum
  ), 0);
  const maxPauseShare = String(config.pauseStyle || 'natural').toLowerCase() === 'dramatic' ? 0.28 : 0.23;
  const pauseScale = basePauseTotal > 0
    ? Math.min(1, (duration * maxPauseShare) / basePauseTotal)
    : 1;
  const pauseTotal = basePauseTotal * pauseScale;
  const speechBudget = Math.max(duration * 0.62, duration - pauseTotal);
  const minPhraseDuration = Math.min(0.75, duration / Math.max(phrases.length, 1));

  let cursor = Number(segment.start) || 0;
  const segmentEnd = cursor + duration;
  return phrases.map((phrase, index) => {
    const isLast = index === phrases.length - 1;
    const remainingPhrases = phrases.length - index;
    const remainingTime = Math.max(0.1, segmentEnd - cursor);
    const pauseAfterSeconds = isLast
      ? 0
      : Number((phrase.pauseAfterSeconds * pauseScale).toFixed(3));
    const proportional = speechBudget * (charWeights[index] / totalWeight);
    const maxAvailableForSpeech = Math.max(minPhraseDuration, remainingTime - pauseAfterSeconds - (remainingPhrases - 1) * minPhraseDuration);
    const phraseDuration = isLast
      ? Math.max(0.1, remainingTime)
      : clamp(proportional, minPhraseDuration, maxAvailableForSpeech);
    const start = cursor;
    const end = Math.min(segmentEnd, start + phraseDuration);
    cursor = end + pauseAfterSeconds;
    return {
      ...phrase,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number(Math.max(0.1, end - start).toFixed(3)),
      pauseAfterSeconds,
    };
  });
}

function buildPhraseSegments(segments, config = {}) {
  if (config.naturalPhraseSync === false) {
    return segments;
  }

  const output = [];
  for (const segment of segments || []) {
    const text = normalizeText(segment.text);
    const duration = Math.max(0.1, Number(segment.duration) || ((Number(segment.end) || 0) - (Number(segment.start) || 0)) || 0.1);
    const basePhraseTexts = splitTextIntoPhrases(text, config);
    const phraseTexts = config.allowDurationPhraseSplit === true
      ? ensureEnoughPhrasesForDuration(basePhraseTexts, duration, config)
      : basePhraseTexts;

    if (phraseTexts.length <= 1 || duration < 1.25) {
      output.push({ ...segment, naturalPhrase: false });
      continue;
    }

    const phraseDrafts = phraseTexts.map((phraseText, phraseIndex) => {
      const boundaryType = boundaryTypeForText(phraseText, phraseIndex === phraseTexts.length - 1);
      return {
        text: phraseText,
        boundaryType,
        pauseAfterSeconds: pauseForBoundary(boundaryType, config, phraseText),
      };
    });
    const planned = allocatePhraseDurations({ ...segment, duration }, phraseDrafts, config);

    planned.forEach((phrase, phraseIndex) => {
      output.push({
        ...segment,
        text: phrase.text,
        translatedText: phrase.text,
        start: phrase.start,
        end: phrase.end,
        duration: phrase.duration,
        gapAfter: phrase.pauseAfterSeconds,
        borrowableGap: phrase.pauseAfterSeconds,
        slotDuration: Number((phrase.duration + phrase.pauseAfterSeconds).toFixed(3)),
        allowedDuration: Number((phrase.duration + phrase.pauseAfterSeconds).toFixed(3)),
        naturalPhrase: true,
        parentIndex: segment.index,
        phraseIndex,
        phraseCount: planned.length,
        pauseAfterSeconds: phrase.pauseAfterSeconds,
        boundaryType: phrase.boundaryType,
      });
    });
  }

  return output;
}

function summarizePhrasePlan(segments = []) {
  const phraseSegments = segments.filter((segment) => segment.naturalPhrase);
  if (!phraseSegments.length) {
    return {
      enabled: false,
      phraseSegments: 0,
      medianPauseSeconds: 0,
      maxPhraseSeconds: 0,
    };
  }

  const pauses = phraseSegments
    .map((segment) => Number(segment.pauseAfterSeconds) || 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const durations = phraseSegments.map((segment) => Number(segment.duration) || 0);
  const medianPauseSeconds = pauses.length ? pauses[Math.floor(pauses.length / 2)] : 0;
  return {
    enabled: true,
    phraseSegments: phraseSegments.length,
    medianPauseSeconds: Number(medianPauseSeconds.toFixed(3)),
    maxPhraseSeconds: Number(Math.max(...durations).toFixed(3)),
  };
}

module.exports = {
  buildPhraseSegments,
  summarizePhrasePlan,
};
