const { verbalizeVietnameseDubbingText } = require('./vietnameseNumberText');

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTtsTextCleanupMode(mode = 'natural') {
  const value = String(mode || 'natural').trim().toLowerCase();
  return ['natural', 'fast', 'strict'].includes(value) ? value : 'natural';
}

function isDigit(char = '') {
  return /\d/.test(char);
}

function isProtectedNumericPunctuation(text, index) {
  const char = text[index];
  if (char !== '.' && char !== ':') return false;
  return isDigit(text[index - 1]) && isDigit(text[index + 1]);
}

function normalizeTtsPunctuation(text = '', mode = 'natural') {
  const cleanupMode = normalizeTtsTextCleanupMode(mode);
  const value = normalizeText(text)
    .replace(/\s+([,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a%])/g, '$1')
    .replace(/([,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a])(?=\S)/g, (match, mark, offset, source) => (
      isProtectedNumericPunctuation(source, offset)
      || /[,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a]/.test(source[offset - 1] || '')
      || /[,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a]/.test(source[offset + 1] || '')
        ? mark
        : `${mark} `
    ))
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!value || cleanupMode !== 'fast') return value;

  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (isProtectedNumericPunctuation(value, index)) {
      output += char;
      continue;
    }
    if (/[\u3002\uff01\uff1f\uff1b\uff1a.!?;:]/.test(char)) {
      output += ' ';
      continue;
    }
    if (/[\uff0c,]/.test(char)) {
      output += ' ';
      continue;
    }
    output += char;
  }

  return normalizeText(output)
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a\s]+/, '')
    .replace(/[,.;:!?\u3002\uff01\uff1f\uff0c\uff1b\uff1a\s]+$/, '')
    .trim();
}

function segmentStart(segment) {
  return Number(segment?.start) || 0;
}

function segmentEnd(segment) {
  const start = segmentStart(segment);
  return Number(segment?.end) || (start + Math.max(0.1, Number(segment?.duration) || 0.8));
}

function roundSeconds(value) {
  return Number(Number(value || 0).toFixed(3));
}

function isCjk(char = '') {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 0x3400 && code <= 0x9fff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af);
}

function endsHardSentence(text) {
  return /[.\u3002\uff01\uff1f!?]\s*$/.test(normalizeText(text));
}

function endsSoftClause(text) {
  return /[\uff0c,\uff1b;\uff1a:]\s*$/.test(normalizeText(text));
}

function weightedTextLength(text) {
  let total = 0;
  for (const char of normalizeText(text)) {
    if (isCjk(char)) total += 1.75;
    else total += char.trim() ? 1 : 0.45;
  }
  return total;
}

function startsWithDependentChinese(text) {
  return /^(\u7684|\u4e86|\u7740|\u904e|\u8fc7|\u5730|\u5f97|\u548c|\u4e0e|\u8207|\u53ca|\u4ee5\u53ca|\u6216|\u5728|\u4e8e|\u65bc|\u5411|\u628a|\u88ab|\u4f46\u662f|\u4f46|\u4e0d\u8fc7|\u4e0d\u904e|\u7136\u800c|\u53ef\u662f|\u56e0\u4e3a|\u56e0\u70ba|\u6240\u4ee5|\u5982\u679c|\u867d\u7136|\u96d6\u7136|\u5c3d\u7ba1|\u5118\u7ba1|\u5373\u4f7f|\u800c\u4e14|\u7136\u540e|\u7136\u5f8c|\u63a5\u7740|\u63a5\u8457|\u4e8e\u662f|\u65bc\u662f|\u4e0e\u6b64\u540c\u65f6|\u8207\u6b64\u540c\u6642|\u540e\u6765|\u5f8c\u4f86)/.test(normalizeText(text));
}

function endsWithDependentChinese(text) {
  return /(\u7684|\u5730|\u5f97|\u548c|\u4e0e|\u8207|\u53ca|\u6216|\u5728|\u4e8e|\u65bc|\u5411|\u628a|\u88ab|\u8ba9|\u8b93|\u4f46|\u800c|\u5e76|\u4e26|\u4e14|\u4f7f|\u4ee4|\u82e5|\u5982|\u56e0|\u4e3a|\u7232|\u4ee5)\s*$/.test(normalizeText(text));
}

function joinSourceText(parts) {
  let output = '';
  for (const raw of parts) {
    const text = normalizeText(raw);
    if (!text) continue;
    if (!output) {
      output = text;
      continue;
    }
    const previous = output[output.length - 1];
    const first = text[0];
    if (isCjk(previous) || isCjk(first) || /[\uff0c\u3002\uff01\uff1f\uff1b\uff1a,.!?;:]/.test(first)) {
      output += text;
    } else {
      output += ` ${text}`;
    }
  }
  return normalizeText(output);
}

function joinTranslatedText(parts) {
  return parts.map(normalizeText).filter(Boolean).join(' ');
}

function normalizeSegment(segment, index) {
  const start = segmentStart(segment);
  const end = Math.max(start + 0.05, segmentEnd(segment));
  return {
    ...segment,
    id: String(segment?.id || segment?.segmentId || `seg-${index + 1}`),
    index,
    start,
    end,
    duration: Math.max(0.05, end - start),
    text: normalizeText(segment?.text || segment?.sourceText || segment?.originalText),
  };
}

function cjkCharCount(text = '') {
  return ([...String(text || '').matchAll(/[\u3400-\u9fff]/g)] || []).length;
}

function repeatedOverlapMinChars(text = '') {
  return cjkCharCount(text) >= 8 ? 8 : 18;
}

function longestSuffixPrefixOverlap(leftText = '', rightText = '') {
  const left = normalizeText(leftText);
  const right = normalizeText(rightText);
  if (!left || !right) return 0;
  const minOverlap = Math.max(repeatedOverlapMinChars(left), repeatedOverlapMinChars(right));
  const maxOverlap = Math.min(left.length, right.length);
  for (let length = maxOverlap; length >= minOverlap; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function trimRepeatedLeadingSourceOverlap(segments = []) {
  const output = [];
  for (const segment of segments) {
    const previous = output[output.length - 1];
    const text = normalizeText(segment.text);
    if (!previous || !text) {
      output.push({ ...segment, text });
      continue;
    }

    const gap = Math.max(0, segmentStart(segment) - segmentEnd(previous));
    const overlapLength = gap <= 0.35
      ? longestSuffixPrefixOverlap(previous.text, text)
      : 0;
    if (!overlapLength) {
      output.push({ ...segment, text });
      continue;
    }

    const trimmed = normalizeText(text.slice(overlapLength));
    output.push({
      ...segment,
      text: trimmed,
      sourceText: trimmed,
      originalText: trimmed,
      repeatedSourcePrefixTrimmed: true,
      repeatedSourceFullyTrimmed: !trimmed,
      repeatedSourcePrefix: text.slice(0, overlapLength),
    });
  }
  return output;
}

function isFullyTrimmedRepeatedSegment(segment = {}) {
  return segment.repeatedSourceFullyTrimmed === true && !normalizeText(segment.text);
}

function appendRepeatedCoverageToMeaningUnit(unit = {}, segment = {}) {
  const rowId = sourceRowId(segment, `row-${(unit.sourceRowIds || []).length + 1}`);
  const end = Math.max(segmentEnd(unit), segmentEnd(segment));
  const displayRows = Array.isArray(unit.displayRows) ? unit.displayRows : [];
  return {
    ...unit,
    end: roundSeconds(end),
    duration: roundSeconds(Math.max(0.1, end - segmentStart(unit))),
    sourceIds: Array.from(new Set([...(unit.sourceIds || []), rowId].filter(Boolean))),
    sourceRowIds: Array.from(new Set([...(unit.sourceRowIds || []), rowId].filter(Boolean))),
    sourceSegmentCount: (Number(unit.sourceSegmentCount) || 1) + 1,
    displayRows: [
      ...displayRows,
      {
        id: rowId,
        start: roundSeconds(segmentStart(segment)),
        end: roundSeconds(segmentEnd(segment)),
        duration: roundSeconds(Math.max(0.1, segmentEnd(segment) - segmentStart(segment))),
        sourceText: '',
        repeatedSourceFullyTrimmed: true,
      },
    ],
  };
}

function appendRepeatedCoverageToTranslationPacket(packet = {}, segment = {}) {
  const rowId = sourceRowId(segment, `row-${(packet.sourceIds || []).length + 1}`);
  const end = Math.max(segmentEnd(packet), segmentEnd(segment));
  const childSegments = Array.isArray(packet.childSegments) ? packet.childSegments : [];
  return {
    ...packet,
    end: roundSeconds(end),
    duration: roundSeconds(Math.max(0.1, end - segmentStart(packet))),
    sourceIds: Array.from(new Set([...(packet.sourceIds || []), rowId].filter(Boolean))),
    sourceSegmentCount: (Number(packet.sourceSegmentCount) || 1) + 1,
    childSegments: [
      ...childSegments,
      {
        ...segment,
        id: rowId,
        text: '',
        sourceText: '',
        originalText: '',
        repeatedSourceFullyTrimmed: true,
      },
    ],
  };
}

function timelineConfig(config = {}) {
  const requestedMaxDuration = Number(config.timelineMaxUnitDuration ?? config.maxMeaningSegmentDuration ?? 2.8);
  const maxDuration = Math.max(1.6, Math.min(3.0, requestedMaxDuration));
  const requestedHardMaxDuration = Number(config.timelineHardMaxUnitDuration ?? 3.6);
  const hardMaxDuration = Math.max(maxDuration + 0.2, Math.min(3.8, requestedHardMaxDuration));
  const requestedMaxWeight = Number(config.timelineMaxUnitWeight ?? 30);
  const maxWeight = Math.max(18, Math.min(32, requestedMaxWeight));
  const requestedHardMaxWeight = Number(config.timelineHardMaxUnitWeight ?? 46);
  const hardMaxWeight = Math.max(maxWeight + 4, Math.min(50, requestedHardMaxWeight));

  return {
    mergeGap: Math.max(0, Math.min(0.45, Number(config.timelineMergeGapSeconds ?? config.shortSegmentMergeGap ?? 0.22))),
    breakGap: Math.max(0.1, Math.min(0.7, Number(config.timelineBreakGapSeconds ?? config.meaningSegmentBreakGap ?? 0.35))),
    maxDuration,
    hardMaxDuration,
    maxWeight,
    hardMaxWeight,
    maxTranslatedChars: Math.max(42, Math.min(58, Number(config.timelineMaxTranslatedChars ?? 56))),
    minDuration: Math.max(0.2, Math.min(2.5, Number(config.timelineMinUnitDuration ?? config.minDubbingSegmentDuration ?? 0.8))),
    guard: Math.max(0, Math.min(0.05, Number(config.timelineClampGuardSeconds ?? 0))),
  };
}

function shouldKeepMerging(buffer, nextSegment, options) {
  if (!buffer.length || !nextSegment) return false;
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const gap = segmentStart(nextSegment) - segmentEnd(last);
  const currentText = joinSourceText(buffer.map((segment) => segment.text));
  const nextText = normalizeText(nextSegment.text);
  const combinedText = joinSourceText([currentText, nextText]);
  const currentDuration = segmentEnd(last) - segmentStart(first);
  const combinedDuration = segmentEnd(nextSegment) - segmentStart(first);
  const lastDuration = segmentEnd(last) - segmentStart(last);
  const currentWeight = weightedTextLength(currentText);
  const nextWeight = weightedTextLength(nextText);
  const combinedWeight = weightedTextLength(combinedText);
  const nextIsDependent = startsWithDependentChinese(nextText);
  const currentIsShort = currentDuration < options.minDuration || currentWeight < 12;
  const nextIsTiny = (segmentEnd(nextSegment) - segmentStart(nextSegment)) < options.minDuration || nextWeight < 8;

  if (gap > options.breakGap) return false;
  if (combinedDuration > options.hardMaxDuration || combinedWeight > options.hardMaxWeight) return false;
  if (endsHardSentence(currentText) && lastDuration >= 0.35) return false;
  if (currentDuration >= options.maxDuration || currentWeight >= options.maxWeight) return false;
  if (combinedDuration > options.maxDuration && !(nextIsDependent && currentIsShort)) return false;
  if (combinedWeight > options.maxWeight && !(nextIsDependent && currentIsShort)) return false;
  if (gap <= options.mergeGap && (currentIsShort || nextIsTiny || endsSoftClause(currentText) || nextIsDependent)) return true;
  if (lastDuration < options.minDuration || nextIsDependent || endsSoftClause(currentText)) return true;
  return false;
}

function createUnit(buffer, index) {
  const start = Math.min(...buffer.map(segmentStart));
  const end = Math.max(...buffer.map(segmentEnd));
  const text = joinSourceText(buffer.map((segment) => segment.text));
  const sourceIds = buffer.map((segment) => segment.id).filter(Boolean);
  return {
    id: `unit-${index + 1}`,
    index,
    start: roundSeconds(start),
    end: roundSeconds(end),
    duration: roundSeconds(Math.max(0.1, end - start)),
    text,
    sourceText: text,
    originalText: text,
    sourceIds,
    sourceSegmentCount: buffer.length,
  };
}

function sourceCharLength(text) {
  return [...normalizeText(text)].length;
}

const SOURCE_NEW_THOUGHT_PREFIXES = [
  '\u8fd9\u4e00\u5e55',
  '\u597d',
  '\u4f46',
  '\u4f46\u662f',
  '\u7136\u800c',
  '\u4e0d\u8fc7',
  '\u53ef\u662f',
  '\u800c\u6d2a\u6c34',
  '\u5269\u4e0b\u7684\u4eba',
  '\u56e0\u6b64',
  '\u6240\u4ee5',
  '\u63a5\u4e0b\u6765',
  '\u4eca\u5929',
  '\u672c\u671f',
];

const SOURCE_INCOMPLETE_SUFFIXES = [
  '\u56e0\u4e3a',
  '\u7531\u4e8e',
  '\u5728',
  '\u6709',
  '\u5176\u4e2d',
  '\u5206\u5e03\u7740',
  '\u6570\u91cf\u5e9e\u5927',
  '\u8fc4\u4eca\u4e3a\u6b62',
  '\u987e\u540d\u601d\u4e49',
  '\u53d1\u751f\u5730',
  '\u51b3\u5b9a',
  '\u91c7\u7528',
  '\u5c31\u662f',
  '\u53eb',
  '\u9762\u79ef',
  '\u4e14',
  '\u9760\u8fd1',
  '\u867d\u7136',
  '\u4f46\u4ece\u5165\u53e3\u8fdb\u53bb\u540e',
  '\u53ef\u8ba9',
  '\u544a\u8bc9\u4f17\u4eba',
  '\u4ed6\u544a\u8bc9\u4f17\u4eba',
  '\u4f46\u4ed6\u53c8\u4e00\u60f3',
];

function startsNewThought(text) {
  const value = normalizeText(text);
  return SOURCE_NEW_THOUGHT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function endsIncompleteSource(text) {
  const value = normalizeText(text);
  return SOURCE_INCOMPLETE_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function isBridgeSourceCue(text) {
  const value = normalizeText(text);
  return sourceCharLength(value) <= 8 && (
    endsIncompleteSource(value)
    || /\u51b3\u5b9a|\u544a\u8bc9|\u53eb|\u5c31\u662f|\u6709|\u5728/.test(value)
  );
}

function createTranslationPacket(buffer, index) {
  const unit = createUnit(buffer, index);
  return {
    ...unit,
    id: `packet-${index + 1}`,
    translationPacket: true,
    childSegments: buffer.map((segment) => ({
      ...segment,
      text: normalizeText(segment.text),
      sourceText: normalizeText(segment.text),
      originalText: normalizeText(segment.text),
    })),
  };
}

function shouldMergeTranslationPacket(buffer, nextSegment, options) {
  if (!buffer.length || !nextSegment) return false;
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const lastTextSegment = [...buffer].reverse()
    .find((segment) => normalizeText(segment.text || segment.sourceText || segment.originalText || ''))
    || last;
  const gap = segmentStart(nextSegment) - segmentEnd(last);
  const currentText = joinSourceText(buffer.map((segment) => segment.text));
  const nextText = normalizeText(nextSegment.text);
  const combinedText = joinSourceText([currentText, nextText]);
  const combinedDuration = segmentEnd(nextSegment) - segmentStart(first);
  const combinedLength = sourceCharLength(combinedText);
  const currentIsComplete = !endsIncompleteSource(lastTextSegment.text);
  const nextIsNewThought = startsNewThought(nextText);
  const nextIsBridge = isBridgeSourceCue(nextText);
  const lastIsShort = sourceCharLength(lastTextSegment.text) <= 7
    || (segmentEnd(lastTextSegment) - segmentStart(lastTextSegment)) <= 1.15;
  const nextIsContinuation = startsWithDependentChinese(nextText) && !nextIsNewThought;

  if (gap > Math.min(options.breakGap, 0.32)) return false;
  if (buffer.length >= 4) return false;
  if (combinedDuration > 7.2 || combinedLength > 42) return false;
  if (nextIsNewThought && currentIsComplete && sourceCharLength(currentText) >= 10) return false;
  if (endsIncompleteSource(lastTextSegment.text)) return true;
  if (nextIsBridge) return true;
  if (lastIsShort && combinedLength <= 30 && combinedDuration <= 5.2) return true;
  if (nextIsContinuation && combinedLength <= 34 && combinedDuration <= 6.4) return true;
  if (sourceCharLength(currentText) < 16 && sourceCharLength(nextText) <= 12 && combinedLength <= 28 && combinedDuration <= 4.8) return true;
  return false;
}

function buildTranslationPackets(segments = [], config = {}) {
  const options = timelineConfig(config);
  const sorted = trimRepeatedLeadingSourceOverlap((segments || [])
    .map(normalizeSegment)
    .filter((segment) => segment.text && segmentEnd(segment) > segmentStart(segment))
    .sort((left, right) => segmentStart(left) - segmentStart(right)));
  const packets = [];
  let buffer = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index];
    if (isFullyTrimmedRepeatedSegment(segment)) {
      if (buffer.length) {
        buffer.push(segment);
      } else if (packets.length) {
        packets[packets.length - 1] = appendRepeatedCoverageToTranslationPacket(packets[packets.length - 1], segment);
      }
      continue;
    }
    buffer.push(segment);
    const next = sorted[index + 1];
    if (!shouldMergeTranslationPacket(buffer, next, options)) {
      packets.push(createTranslationPacket(buffer, packets.length));
      buffer = [];
    }
  }

  if (buffer.length) packets.push(createTranslationPacket(buffer, packets.length));
  return clampNonOverlapping(packets, options.guard).map((packet, index) => ({ ...packet, index }));
}

function meaningUnitConfig(config = {}) {
  const targetMinDuration = Math.max(1.2, Math.min(6, Number(config.naturalDubTargetMinSeconds ?? 3.0)));
  const targetMaxDuration = Math.max(targetMinDuration, Math.min(7.2, Number(config.naturalDubTargetMaxSeconds ?? 5.8)));
  const maxDuration = Math.max(targetMaxDuration, Math.min(7.8, Number(config.maxMeaningUnitDuration ?? config.maxMeaningSegmentDuration ?? 6.5)));
  const hardMaxDuration = Math.max(maxDuration, Math.min(8.5, Number(config.hardMaxMeaningUnitDuration ?? 7.2)));
  const maxChars = Math.max(70, Math.min(220, Number(config.maxMeaningUnitChars ?? config.maxMeaningSegmentChars ?? 150)));
  const hardMaxChars = Math.max(maxChars, Math.min(280, Number(config.hardMaxMeaningUnitChars ?? Math.max(maxChars + 40, 220))));
  const maxSourceRows = Math.max(1, Math.min(6, Math.round(Number(config.maxMeaningUnitSourceRows ?? 4))));
  const hardBreakGap = Math.max(0.2, Math.min(1.5, Number(config.meaningUnitHardBreakGapSeconds ?? config.meaningSegmentBreakGap ?? 0.6)));
  const softBreakGap = Math.max(0.05, Math.min(hardBreakGap, Number(config.meaningUnitSoftBreakGapSeconds ?? config.shortSegmentMergeGap ?? 0.25)));
  return {
    mergeGap: Math.max(0, Math.min(softBreakGap, Number(config.meaningUnitMergeGapSeconds ?? config.ttsMergeGapSeconds ?? 0.2))),
    targetMinDuration,
    targetMaxDuration,
    maxDuration,
    hardMaxDuration,
    maxChars,
    hardMaxChars,
    maxSourceRows,
    hardBreakGap,
    softBreakGap,
    minStandaloneDuration: Math.max(0.5, Math.min(4.0, Number(config.minNaturalTtsSegmentDuration ?? config.minDubbingSegmentDuration ?? 1.0))),
    minStandaloneChars: Math.max(6, Math.min(60, Number(config.minMeaningUnitStandaloneChars ?? 28))),
  };
}

function sourceRowId(segment = {}, fallback = '') {
  return String(segment.id || segment.segmentId || fallback || '').trim();
}

function createMeaningUnit(buffer, index) {
  const start = Math.min(...buffer.map(segmentStart));
  const end = Math.max(...buffer.map(segmentEnd));
  const sourceRowIds = buffer.map((segment, childIndex) => sourceRowId(segment, `row-${childIndex + 1}`)).filter(Boolean);
  const sourceText = joinSourceText(buffer.map((segment) => segment.text || segment.sourceText || segment.originalText || ''));
  return {
    id: `meaning-${String(index + 1).padStart(3, '0')}`,
    index,
    start: roundSeconds(start),
    end: roundSeconds(end),
    duration: roundSeconds(Math.max(0.1, end - start)),
    text: sourceText,
    sourceText,
    originalText: sourceText,
    translatedText: '',
    finalText: '',
    ttsText: '',
    sourceIds: sourceRowIds,
    sourceRowIds,
    sourceSegmentCount: buffer.length,
    displayRows: buffer.map((segment, childIndex) => ({
      id: sourceRowId(segment, `row-${childIndex + 1}`),
      start: roundSeconds(segmentStart(segment)),
      end: roundSeconds(segmentEnd(segment)),
      duration: roundSeconds(Math.max(0.1, segmentEnd(segment) - segmentStart(segment))),
      sourceText: normalizeText(segment.text || segment.sourceText || segment.originalText || ''),
    })),
  };
}

function startsWithVietnameseContinuation(text = '') {
  const folded = foldVietnameseForBoundary(text);
  return /^(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi|da|dang|khien|thuc chat|trong khi)\b/.test(folded);
}

function endsWithVietnameseContinuation(text = '') {
  const folded = foldVietnameseForBoundary(text);
  return /\b(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi)$/.test(folded);
}

function startsWithEnglishContinuation(text = '') {
  const cleaned = String(text || '').trim().toLowerCase().replace(/[.,!?;:]/g, '');
  return /^(and|but|or|because|so|then|to|for|with|in|on|at|of|that|which|who|whom|whose|as|if|when|while|although|though|since|unless|until|yet)\b/i.test(cleaned);
}

function endsWithEnglishContinuation(text = '') {
  const cleaned = String(text || '').trim().toLowerCase().replace(/[.,!?;:]/g, '');
  return /\b(and|but|or|because|so|then|to|for|with|in|on|at|of|that|which|who|whom|whose|as|if|when|while|although|though|since|unless|until|yet|the|a|an|my|your|his|her|its|our|their|this|that|these|those)$/i.test(cleaned);
}

function shouldMergeMeaningUnit(buffer, nextSegment, config = {}) {
  if (!buffer.length || !nextSegment) return false;
  const options = meaningUnitConfig(config);
  if (buffer.length + 1 > options.maxSourceRows) return false;

  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const lastTextSegment = [...buffer].reverse()
    .find((segment) => normalizeText(segment.text || segment.sourceText || segment.originalText || ''))
    || last;
  const currentText = joinSourceText(buffer.map((segment) => segment.text || segment.sourceText || segment.originalText || ''));
  const lastText = normalizeText(lastTextSegment.text || lastTextSegment.sourceText || lastTextSegment.originalText || '');
  const nextText = normalizeText(nextSegment.text || nextSegment.sourceText || nextSegment.originalText || '');
  const mergedText = joinSourceText([currentText, nextText]);
  const gap = Math.max(0, segmentStart(nextSegment) - segmentEnd(last));
  const lastDuration = Math.max(0.1, segmentEnd(lastTextSegment) - segmentStart(lastTextSegment));
  const nextDuration = Math.max(0.1, segmentEnd(nextSegment) - segmentStart(nextSegment));
  const mergedDuration = Math.max(0.1, segmentEnd(nextSegment) - segmentStart(first));
  const mergedLength = sourceCharLength(mergedText);
  const currentLength = sourceCharLength(currentText);
  const lastLength = sourceCharLength(lastText);
  const nextLength = sourceCharLength(nextText);
  const currentDuration = Math.max(0.1, segmentEnd(last) - segmentStart(first));
  const lastIsShort = lastDuration < options.minStandaloneDuration || lastLength < options.minStandaloneChars;
  const nextIsShort = nextDuration < options.minStandaloneDuration || nextLength < options.minStandaloneChars;

  const sourceLang = String(config.sourceLanguage || 'en').toLowerCase();
  const isVi = sourceLang.startsWith('vi');
  const isEn = sourceLang.startsWith('en') || (!isVi && !sourceLang.startsWith('zh') && !sourceLang.startsWith('ja') && !sourceLang.startsWith('ko'));

  const nextContinuation = (isVi ? startsWithVietnameseContinuation(nextText) : (isEn ? startsWithEnglishContinuation(nextText) : false))
    || startsWithDependentChinese(nextText)
    || isBridgeSourceCue(nextText);

  const previousIncomplete = (isVi ? endsWithVietnameseContinuation(lastText) : (isEn ? endsWithEnglishContinuation(lastText) : false))
    || endsWithDependentChinese(lastText)
    || endsIncompleteSource(lastText);

  const strongContinuation = nextContinuation || previousIncomplete;
  const currentEndsComplete = endsHardSentence(lastText) && lastDuration >= 1.2 && sourceCharLength(lastText) >= 8;
  const currentBelowTarget = currentDuration < options.targetMinDuration || currentLength < options.minStandaloneChars;

  if (gap >= options.hardBreakGap) return false;
  if (mergedDuration > options.hardMaxDuration || mergedLength > options.hardMaxChars) return false;
  if (gap >= options.softBreakGap && currentEndsComplete && !strongContinuation && !currentBelowTarget) return false;
  if (gap >= options.softBreakGap && !strongContinuation && !currentBelowTarget) return false;
  if (mergedDuration > options.maxDuration || mergedLength > options.maxChars) return strongContinuation && mergedDuration <= options.hardMaxDuration && mergedLength <= options.hardMaxChars;
  if (currentBelowTarget) return true;
  if (strongContinuation) return true;
  if (lastIsShort || nextIsShort) return mergedDuration <= options.targetMaxDuration && mergedLength <= options.maxChars;
  return gap <= options.mergeGap && mergedDuration <= options.targetMaxDuration;
}

function buildMeaningUnits(segments = [], config = {}) {
  const sorted = trimRepeatedLeadingSourceOverlap((segments || [])
    .map(normalizeSegment)
    .filter((segment) => segment.text && segmentEnd(segment) > segmentStart(segment))
    .sort((left, right) => segmentStart(left) - segmentStart(right)));
  const output = [];
  let buffer = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index];
    if (isFullyTrimmedRepeatedSegment(segment)) {
      if (buffer.length) {
        buffer.push(segment);
      } else if (output.length) {
        output[output.length - 1] = appendRepeatedCoverageToMeaningUnit(output[output.length - 1], segment);
      }
      continue;
    }
    buffer.push(segment);
    const next = sorted[index + 1];
    if (!shouldMergeMeaningUnit(buffer, next, config)) {
      output.push(createMeaningUnit(buffer, output.length));
      buffer = [];
    }
  }

  if (buffer.length) output.push(createMeaningUnit(buffer, output.length));
  return output.map((unit, index) => ({ ...unit, index }));
}

function ttsTextFromTranslation(text = '', config = {}) {
  const targetLanguage = String(config.targetLanguage || '').toLowerCase();
  if (targetLanguage.startsWith('vi') && config.verbalizeVietnameseNumbers !== false) {
    return normalizeTtsPunctuation(
      verbalizeVietnameseDubbingText(text),
      config.ttsTextCleanupMode || 'natural'
    );
  }
  return normalizeTtsPunctuation(text, config.ttsTextCleanupMode || 'natural');
}

function splitTextByDisplayRows(text, rows) {
  const value = normalizeText(text);
  if (!value || rows.length <= 1) return [value].filter(Boolean);
  const groups = rows.map((row) => [{
    start: row.start,
    end: row.end,
    text: row.sourceText || '',
  }]);
  let chunks = splitTranslatedTextForGroups(value, groups);
  if (chunks.length === rows.length) return chunks;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < rows.length) return rows.map((_, index) => index === 0 ? value : '').filter((_, index) => index < rows.length);
  const totalDuration = rows.reduce((sum, row) => sum + Math.max(0.1, Number(row.duration) || (Number(row.end) - Number(row.start)) || 0.1), 0);
  chunks = [];
  let cursor = 0;
  rows.forEach((row, index) => {
    if (index === rows.length - 1) {
      chunks.push(words.slice(cursor).join(' '));
      return;
    }
    const duration = Math.max(0.1, Number(row.duration) || (Number(row.end) - Number(row.start)) || 0.1);
    const take = Math.max(1, Math.round(words.length * (duration / Math.max(0.1, totalDuration))));
    chunks.push(words.slice(cursor, cursor + take).join(' '));
    cursor += take;
  });
  return chunks.map(normalizeText);
}

function mapMeaningUnitsToDisplayRows(meaningUnits = [], sourceRows = [], config = {}) {
  const sourceById = new Map((sourceRows || []).map((row, index) => [sourceRowId(row, `row-${index + 1}`), normalizeSegment(row, index)]));
  const output = [];

  for (const unit of meaningUnits || []) {
    const rowIds = Array.isArray(unit.sourceRowIds) && unit.sourceRowIds.length
      ? unit.sourceRowIds.map(String)
      : Array.isArray(unit.sourceIds) ? unit.sourceIds.map(String) : [];
    const rows = rowIds.map((id) => sourceById.get(id)).filter(Boolean);
    const displayRows = rows.length ? rows : [normalizeSegment({
      id: unit.id,
      start: unit.start,
      end: unit.end,
      text: unit.sourceText || unit.originalText || '',
    }, output.length)];
    const translatedText = normalizeText(unit.translatedText || unit.finalText || unit.text || '');
    const displayChunks = repairDanglingTranslatedChunks(
      splitTextByDisplayRows(translatedText, displayRows),
      translatedCueLimit(config)
    );

    displayRows.forEach((row, index) => {
      const start = segmentStart(row);
      const end = segmentEnd(row);
      const text = normalizeText(displayChunks[index] || translatedText);
      output.push({
        ...row,
        id: sourceRowId(row, `${unit.id}-row-${index + 1}`),
        index: output.length,
        start: roundSeconds(start),
        end: roundSeconds(end),
        duration: roundSeconds(Math.max(0.1, end - start)),
        text,
        translatedText: text,
        finalText: text,
        ttsText: text,
        originalText: normalizeText(row.text || row.sourceText || row.originalText || ''),
        sourceText: normalizeText(row.text || row.sourceText || row.originalText || ''),
        sourceIds: [sourceRowId(row, `${unit.id}-row-${index + 1}`)],
        sourceRowIds: [sourceRowId(row, `${unit.id}-row-${index + 1}`)],
        meaningUnitId: unit.id,
        meaningUnitSourceIds: rowIds,
      });
    });
  }

  return splitLongTranslatedDisplaySegments(output, config);
}

function translatedCueLimit(config = {}) {
  return Math.max(42, Math.min(64, Number(config.timelineOutputMaxChars ?? config.timelineMaxTranslatedChars ?? 56)));
}

function translatedCueTargetCps(config = {}) {
  return Math.max(11, Math.min(17, Number(config.timelineOutputMaxCps ?? config.translationCharsPerSecond ?? 13)));
}

function timelineBreathGap(config = {}) {
  return Math.max(0, Math.min(0.3, Number(config.timelineBreathGapSeconds ?? config.timelineGuardSeconds ?? 0.15)));
}

function readableCueDuration(start, end, config = {}) {
  const duration = Math.max(0.1, Number(end || 0) - Number(start || 0));
  const breath = Math.min(timelineBreathGap(config), duration * 0.22);
  return Math.max(0.1, duration - breath);
}

function isTranslatedChunkTooDense(text, group, config = {}) {
  const value = normalizeText(text);
  if (!value || !group?.length) return false;
  const duration = readableCueDuration(segmentStart(group[0]), segmentEnd(group[group.length - 1]), config);
  return sourceCharLength(value) / duration > translatedCueTargetCps(config);
}

function chooseOutputCueCount(text, children, config = {}) {
  const duration = Math.max(0.1, segmentEnd(children[children.length - 1]) - segmentStart(children[0]));
  const length = sourceCharLength(text);
  const byLength = Math.ceil(length / translatedCueLimit(config));
  const byReadSpeed = Math.ceil(length / Math.max(8, translatedCueTargetCps(config) * readableCueDuration(segmentStart(children[0]), segmentEnd(children[children.length - 1]), config)));
  const byDuration = duration > 5.2 && length > 58 ? Math.ceil(duration / 4.2) : 1;
  return Math.max(1, Math.min(children.length || 1, Math.max(byLength, byReadSpeed, byDuration)));
}

function allowedChildBoundary(leftChild) {
  return !endsIncompleteSource(leftChild?.text || leftChild?.sourceText || leftChild?.originalText || '');
}

function buildChildGroups(children, groupCount) {
  if (!children.length) return [];
  if (groupCount <= 1 || children.length <= 1) return [children];

  const totalDuration = segmentEnd(children[children.length - 1]) - segmentStart(children[0]);
  const boundaries = [];
  let previousBoundary = 0;

  for (let groupIndex = 1; groupIndex < groupCount; groupIndex += 1) {
    const targetTime = segmentStart(children[0]) + totalDuration * (groupIndex / groupCount);
    let best = -1;
    let bestScore = Infinity;
    const minBoundary = previousBoundary + 1;
    const maxBoundary = children.length - (groupCount - groupIndex);

    for (let boundary = minBoundary; boundary <= maxBoundary; boundary += 1) {
      const leftChild = children[boundary - 1];
      if (!allowedChildBoundary(leftChild)) continue;
      const score = Math.abs(segmentEnd(leftChild) - targetTime);
      if (score < bestScore) {
        best = boundary;
        bestScore = score;
      }
    }

    if (best < 0) best = minBoundary;
    boundaries.push(best);
    previousBoundary = best;
  }

  const groups = [];
  let start = 0;
  for (const boundary of boundaries) {
    groups.push(children.slice(start, boundary));
    start = boundary;
  }
  groups.push(children.slice(start));
  return groups.filter((group) => group.length);
}

const TRANSLATED_DANGLING_SUFFIXES = [
  'co nghia la',
  'nghia la',
  'the la',
  'vay la',
  'hoa ra',
  'nham de',
  'de',
  'va',
  'voi',
  'cua',
  'cho',
  'nen',
  'roi',
  'nhung',
  'ma',
  'khi',
  'neu',
  'vi',
  'do',
];

const TRANSLATED_CONTINUATION_PREFIXES = [
  'co nghia la',
  'nghia la',
  'the la',
  'vay la',
  'hoa ra',
  'vi vay',
  'tuy nhien',
  'nhung',
  'nen',
  'roi',
  'con',
  'cho phep',
  'khong co nghia',
];

function foldedBoundaryWords(text = '') {
  return foldVietnameseForBoundary(text)
    .replace(/[,.!?;:]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function matchTranslatedDanglingSuffix(text = '') {
  const value = normalizeText(text);
  if (!value) return null;
  const folded = foldedBoundaryWords(value).join(' ');
  const originalWords = value.split(/\s+/).filter(Boolean);

  for (const suffix of TRANSLATED_DANGLING_SUFFIXES) {
    if (folded !== suffix && !folded.endsWith(` ${suffix}`)) continue;
    const suffixWordCount = suffix.split(/\s+/).length;
    if (originalWords.length <= suffixWordCount + 1) return null;
    const prefix = normalizeText(originalWords.slice(0, -suffixWordCount).join(' '));
    const suffixText = normalizeText(originalWords.slice(-suffixWordCount).join(' ').replace(/[,.!?;:]+$/g, ''));
    if (!prefix || !suffixText || sourceCharLength(prefix) < 8) return null;
    return { prefix, suffix: suffixText };
  }

  return null;
}

function startsWithTranslatedContinuationPhrase(text = '') {
  const folded = foldedBoundaryWords(text).join(' ');
  return TRANSLATED_CONTINUATION_PREFIXES.some((prefix) => folded === prefix || folded.startsWith(`${prefix} `));
}

function repairDanglingTranslatedChunks(chunks = [], maxChars = 64) {
  const repaired = chunks.map(normalizeText).filter(Boolean);
  const softLimit = Math.max(24, Math.round((Number(maxChars) || 64) * 1.45));

  for (let index = 0; index < repaired.length - 1; index += 1) {
    const dangling = matchTranslatedDanglingSuffix(repaired[index]);
    if (!dangling) continue;
    const next = normalizeText(`${dangling.suffix} ${repaired[index + 1]}`);
    if (!next || sourceCharLength(next) > softLimit) continue;
    repaired[index] = dangling.prefix;
    repaired[index + 1] = next;
  }

  return repaired.filter(Boolean);
}

function safeTextBoundaryScore(text, index, target) {
  const left = text.slice(0, index);
  const right = text.slice(index);
  if (!left.trim() || !right.trim()) return -Infinity;
  const distance = Math.abs(index - target);
  let score = -distance;
  if (left.trim().length < target * 0.65) score -= 45;
  if (right.trim().length < target * 0.35) score -= 20;
  const foldedRight = right.trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
  const foldedLeft = left.trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
  if (/[,.!?;:]\s*$/.test(left)) score += distance <= 18 ? 45 : 8;
  if (/^(nhung|vi vay|tuy nhien|nen|roi|con|cho phep|khong co nghia)\b/.test(foldedRight)) score += distance <= 18 ? 35 : 8;
  if (startsWithTranslatedContinuationPhrase(right)) score += distance <= 18 ? 35 : 8;
  if (/\b(ve|toi|den|sang|vao|ra|o|tai|theo|cua|cho|voi|men)$/.test(foldedLeft)) score -= 45;
  if (matchTranslatedDanglingSuffix(left)) score -= 85;
  if (/^(ve phia|toi|den|sang|vao|ra|o|tai|theo)\b/.test(foldedRight)) score += 18;
  if (/\s$/.test(left) || /^\s/.test(right)) score += 20;
  return score;
}

function splitTranslatedTextForGroups(text, groups, config = {}) {
  const value = normalizeText(text);
  if (!value || groups.length <= 1) return [value].filter(Boolean);

  const chunks = [];
  let remaining = value;
  let remainingDuration = groups.reduce((sum, group) => sum + Math.max(0.1, segmentEnd(group[group.length - 1]) - segmentStart(group[0])), 0);

  for (let index = 0; index < groups.length - 1; index += 1) {
    const groupDuration = Math.max(0.1, segmentEnd(groups[index][groups[index].length - 1]) - segmentStart(groups[index][0]));
    const target = Math.max(8, Math.round(remaining.length * (groupDuration / remainingDuration)));
    const min = Math.max(6, target - 28);
    const max = Math.min(remaining.length - 6, target + 28);
    let best = -1;
    let bestScore = -Infinity;

    for (let cursor = min; cursor <= max; cursor += 1) {
      const previous = remaining[cursor - 1] || '';
      const current = remaining[cursor] || '';
      if (previous !== ' ' && current !== ' ' && !/[,.!?;:]/.test(previous)) continue;
      const score = safeTextBoundaryScore(remaining, cursor, target);
      if (score > bestScore) {
        best = cursor;
        bestScore = score;
      }
    }

    if (best < 0) best = remaining.lastIndexOf(' ', target);
    if (best < 0) break;
    chunks.push(normalizeText(remaining.slice(0, best)));
    remaining = normalizeText(remaining.slice(best));
    remainingDuration -= groupDuration;
  }

  if (remaining) chunks.push(remaining);
  return repairDanglingTranslatedChunks(chunks, translatedCueLimit(config));
}

function groupSourceText(group) {
  return joinSourceText(group.map((segment) => segment.text || segment.sourceText || segment.originalText || ''));
}

function packetTranslationText(packet, translatedPacket) {
  return normalizeText(translatedPacket?.text || translatedPacket?.finalText || translatedPacket?.translatedText || packet?.text || '');
}

function foldVietnameseForBoundary(text = '') {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function endsHardSpokenBoundary(text = '') {
  return /[.!?\u2026\u3002\uff01\uff1f]\s*$/.test(normalizeText(text));
}

function endsSoftSpokenBoundary(text = '') {
  return /[,;:\uff0c\uff1b\uff1a]\s*$/.test(normalizeText(text));
}

function continuesSpokenThought(currentText = '', nextText = '') {
  const current = foldVietnameseForBoundary(currentText);
  const next = foldVietnameseForBoundary(nextText);
  if (!current || !next) return false;
  if (/\b(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|men|la|bi|duoc|khi|neu|vi|do|nen|roi)$/.test(current)) return true;
  if (/^(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|men|la|bi|duoc|khi|neu|vi|do|nen|roi|thay|vao luc|trong khi)\b/.test(next)) return true;
  if (!endsHardSpokenBoundary(currentText) && !endsSoftSpokenBoundary(currentText)) return true;
  return false;
}

function breathGapForBoundary(segment, next, config = {}) {
  const breath = timelineBreathGap(config);
  if (breath <= 0 || !next) return 0;

  const text = segment.text || segment.finalText || segment.translatedText || '';
  const nextText = next.text || next.finalText || next.translatedText || '';
  if (continuesSpokenThought(text, nextText)) return 0;
  if (endsHardSpokenBoundary(text)) return breath;
  if (endsSoftSpokenBoundary(text)) return Math.min(0.07, breath * 0.45);

  const differentPacket = segment.translationPacketId && next.translationPacketId && segment.translationPacketId !== next.translationPacketId;
  return differentPacket ? Math.min(0.1, breath * 0.65) : 0;
}

function applyTimelineBreathGaps(segments = [], config = {}) {
  if (timelineBreathGap(config) <= 0) return segments;

  return segments.map((segment, index) => {
    const next = segments[index + 1];
    if (!next) return segment;
    const breath = breathGapForBoundary(segment, next, config);
    if (breath <= 0) return segment;

    const start = segmentStart(segment);
    const end = segmentEnd(segment);
    const duration = Math.max(0.05, end - start);
    const naturalGap = Math.max(0, segmentStart(next) - end);
    const missingGap = Math.max(0, breath - naturalGap);
    if (missingGap <= 0) return segment;

    const maxTrim = Math.min(missingGap, breath, duration * 0.22);
    const trimmedEnd = Math.max(start + 0.05, end - maxTrim);
    return {
      ...segment,
      end: roundSeconds(trimmedEnd),
      duration: roundSeconds(Math.max(0.05, trimmedEnd - start)),
      timelineBreathGapApplied: true,
    };
  });
}

function redistributeTranslatedPackets(packets = [], translatedPackets = [], config = {}) {
  const output = [];
  const maxChunkLength = translatedCueLimit(config);

  packets.forEach((packet, packetIndex) => {
    const children = Array.isArray(packet.childSegments) && packet.childSegments.length
      ? packet.childSegments
      : [packet];
    const translatedText = packetTranslationText(packet, translatedPackets[packetIndex]);
    let groupCount = chooseOutputCueCount(translatedText, children, config);
    let childGroups = buildChildGroups(children, groupCount);
    let textChunks = splitTranslatedTextForGroups(translatedText, childGroups, config);

    while (
      groupCount < children.length
      && textChunks.length === childGroups.length
      && textChunks.some((chunk) => sourceCharLength(chunk) > maxChunkLength)
    ) {
      groupCount += 1;
      childGroups = buildChildGroups(children, groupCount);
      textChunks = splitTranslatedTextForGroups(translatedText, childGroups, config);
    }

    const finalGroups = textChunks.length === childGroups.length ? childGroups : [children];
    const finalChunks = textChunks.length === childGroups.length ? textChunks : [translatedText];

    finalGroups.forEach((group, groupIndex) => {
      const start = segmentStart(group[0]);
      const end = segmentEnd(group[group.length - 1]);
      const text = normalizeText(finalChunks[groupIndex]);
      const sourceText = groupSourceText(group);
      output.push({
        id: `${packet.id || `packet-${packetIndex + 1}`}-out-${groupIndex + 1}`,
        index: output.length,
        start: roundSeconds(start),
        end: roundSeconds(end),
        duration: roundSeconds(Math.max(0.1, end - start)),
        text,
        translatedText: text,
        finalText: text,
        originalText: sourceText,
        sourceText,
        sourceIds: group.map((segment) => segment.id).filter(Boolean),
        sourceSegmentCount: group.length,
        translationPacketId: packet.id,
        timelineRedistributed: true,
      });
    });
  });

  const splitOutput = splitLongTranslatedDisplaySegments(output, config);
  const finalSegments = clampNonOverlapping(splitOutput, timelineConfig(config).guard)
    .map((segment, index) => ({ ...segment, index }));
  assertTimelineSafe(finalSegments);
  return finalSegments;
}

function sourceSegmentsFromTranslated(segments = []) {
  return segments.map((segment, index) => ({
    ...segment,
    id: `source-${index + 1}`,
    index,
    text: segment.sourceText || segment.originalText || '',
    translatedText: undefined,
    finalText: undefined,
  }));
}

function splitTextForCue(text, desiredChunks, maxChars, addCommas = false) {
  const cleaned = normalizeText(text);
  if (!cleaned || desiredChunks <= 1) return [cleaned].filter(Boolean);
  const protectedText = cleaned
    .replace(/(\d)\s*:\s*(\d)/g, '$1__TIME_COLON__$2')
    .replace(/(\d)\s*,\s*(\d{3}\b)/g, '$1__THOUSAND_COMMA__$2')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1__DECIMAL_DOT__$2');
  if ([...cleaned].some(isCjk) && !/\s/.test(cleaned)) {
    const chars = [...protectedText];
    const chunkSize = Math.max(1, Math.ceil(chars.length / desiredChunks));
    const chunks = [];
    for (let index = 0; index < chars.length; index += chunkSize) {
      chunks.push(chars.slice(index, index + chunkSize).join(''));
    }
    return chunks.map((chunk) => normalizeText(chunk)
      .replace(/__TIME_COLON__/g, ':')
      .replace(/__THOUSAND_COMMA__/g, ',')
      .replace(/__DECIMAL_DOT__/g, '.')).filter(Boolean);
  }
  const clauseParts = protectedText
    .split(/([,.;:!?，。！？；：])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const value = normalizeText(`${token}${next}`);
        if (value) parts.push(value);
      }
      return parts;
    }, []);
  let units = clauseParts.length > 1 ? clauseParts : protectedText.split(/\s+/).filter(Boolean);
  if (units.length <= 1) {
    const chunkSize = Math.max(1, Math.ceil(protectedText.length / desiredChunks));
    units = [];
    for (let index = 0; index < protectedText.length; index += chunkSize) {
      units.push(protectedText.slice(index, index + chunkSize));
    }
  }

  const chunks = [];
  let current = '';
  const targetChars = Math.max(16, Math.ceil(protectedText.length / desiredChunks));
  for (const unit of units) {
    const joiner = clauseParts.length > 1 ? ' ' : (isCjk((current || '').slice(-1)) || isCjk(unit[0]) ? '' : ' ');
    const candidate = current ? `${current}${joiner}${unit}` : unit;
    const shouldCut = chunks.length < desiredChunks - 1
      && current
      && candidate.length > Math.min(maxChars, targetChars * 1.1)
      && current.length >= Math.max(18, maxChars * 0.45);
    if (shouldCut) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  while (chunks.length < desiredChunks) {
    let longestIndex = 0;
    for (let index = 1; index < chunks.length; index += 1) {
      if (chunks[index].length > chunks[longestIndex].length) longestIndex = index;
    }
    const words = chunks[longestIndex].split(/\s+/).filter(Boolean);
    if (words.length < 2) break;
    const midpoint = Math.ceil(words.length / 2);
    chunks.splice(longestIndex, 1, words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' '));
  }

  const values = chunks
    .map((chunk) => {
      const value = normalizeText(chunk)
        .replace(/__TIME_COLON__/g, ':')
        .replace(/__THOUSAND_COMMA__/g, ',')
        .replace(/__DECIMAL_DOT__/g, '.');
      return value;
    })
    .filter(Boolean);

  return values
    .map((value, index) => {
      let output = normalizeText(value);
      if (addCommas && index < values.length - 1 && output.length >= 20 && !/[,.!?;:]$/.test(output)) {
        output += ',';
      }
      return output;
    })
    .filter(Boolean);
}

function splitTextIntoSentenceCues(text = '') {
  const value = normalizeText(text);
  if (!value) return [];
  const chunks = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!/[.!?\u2026\u3002\uff01\uff1f]/.test(char)) continue;
    if (char === '.' && isProtectedNumericPunctuation(value, index)) continue;

    let end = index + 1;
    while (end < value.length && /["')\]\u201d\u2019]/.test(value[end])) {
      end += 1;
    }

    const chunk = normalizeText(value.slice(start, end));
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < value.length && /\s/.test(value[start])) start += 1;
  }

  const tail = normalizeText(value.slice(start));
  if (tail) chunks.push(tail);
  return chunks;
}

function splitTranslatedTextForCue(text, desiredChunks, maxChars) {
  const sentenceChunks = splitTextIntoSentenceCues(text);
  if (sentenceChunks.length > 1) {
    return repairDanglingTranslatedChunks(sentenceChunks.flatMap((sentence) => {
      if (sourceCharLength(sentence) <= Math.max(86, Math.round(maxChars * 1.85))) {
        return [sentence];
      }
      const sentenceChunksWanted = Math.max(2, Math.min(3, Math.ceil(sourceCharLength(sentence) / Math.max(1, maxChars * 1.35))));
      return splitTextForCue(sentence, sentenceChunksWanted, maxChars, false);
    }).filter(Boolean), maxChars);
  }
  return repairDanglingTranslatedChunks(splitTextForCue(text, desiredChunks, maxChars, false), maxChars);
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function adaptiveCueCharLimit(text, duration, options, mode) {
  if (mode !== 'translated') {
    const hasCjkText = [...normalizeText(text)].some(isCjk);
    if (hasCjkText) {
      return Math.max(10, Math.min(18, Math.round(options.maxWeight / 1.75)));
    }
    return Math.max(28, Math.round(options.maxWeight * 1.25));
  }
  const normalized = normalizeText(text);
  const punctuationCount = (normalized.match(/[,.!?;:，。！？；：]/g) || []).length;
  const naturalBreakBonus = Math.min(6, punctuationCount * 2);
  const durationAllowance = Math.round(clampNumber(duration, 1.2, 5.0) * 4);
  const base = clampNumber(42 + durationAllowance + naturalBreakBonus, 46, options.maxTranslatedChars);
  return Math.round(base);
}

function desiredCueCount(segment, text, options, mode) {
  const duration = Math.max(0.1, segmentEnd(segment) - segmentStart(segment));
  const normalized = normalizeText(text);
  const limit = adaptiveCueCharLimit(normalized, duration, options, mode);
  const byText = Math.ceil(normalized.length / Math.max(1, limit * 0.9));
  const sourceWeight = weightedTextLength(normalized);
  const bySourceDuration = mode !== 'translated' && duration >= options.hardMaxDuration
    ? Math.ceil(duration / options.maxDuration)
    : 1;
  const bySourceWeight = mode !== 'translated' && sourceWeight > options.maxWeight
    ? Math.ceil(sourceWeight / options.maxWeight)
    : 1;
  const byTranslatedDuration = mode === 'translated' && duration > 4.2 && normalized.length > 48
    ? Math.ceil(duration / 3.4)
    : 1;
  const denseLongCue = duration >= 5.4 && normalized.length >= Math.round(limit * 0.85);
  const byDensity = denseLongCue
    ? Math.ceil(normalized.length / Math.max(48, Math.round(duration * 11)))
    : 1;
  const byDuration = duration >= 7.5 && normalized.length >= 56
    ? Math.ceil(duration / 4.8)
    : 1;
  const maxByMinDuration = Math.max(1, Math.floor(duration / 1.15));
  return Math.max(1, Math.min(4, maxByMinDuration, Math.max(byText, byDensity, byDuration, bySourceDuration, bySourceWeight, byTranslatedDuration)));
}

function splitOversizedSegment(segment, options, mode = 'source') {
  const duration = Math.max(0.1, segmentEnd(segment) - segmentStart(segment));
  const text = normalizeText(segment.text || segment.translatedText || segment.finalText || segment.sourceText);
  const maxChars = adaptiveCueCharLimit(text, duration, options, mode);
  const chunksWanted = desiredCueCount(segment, text, options, mode);
  const tooLong = chunksWanted > 1;
  if (!tooLong) return [segment];

  const desiredChunks = chunksWanted;
  const textChunks = mode === 'translated'
    ? splitTranslatedTextForCue(text, desiredChunks, maxChars)
    : splitTextForCue(text, desiredChunks, maxChars, false);
  if (textChunks.length <= 1) return [segment];

  const totalWeight = textChunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
  let cursor = segmentStart(segment);
  const sourceTextChunks = mode === 'translated'
    ? splitTextForCue(segment.sourceText || segment.originalText || '', textChunks.length, maxChars, false)
    : textChunks;

  return textChunks.map((chunk, index) => {
    const isLast = index === textChunks.length - 1;
    const remaining = segmentEnd(segment) - cursor;
    const proportional = duration * (Math.max(1, chunk.length) / totalWeight);
    const chunkDuration = isLast
      ? Math.max(0.1, remaining)
      : Math.max(0.1, Math.min(remaining - 0.1 * (textChunks.length - index - 1), proportional));
    const start = cursor;
    const end = isLast ? segmentEnd(segment) : cursor + chunkDuration;
    cursor = end;
    const sourceText = normalizeText(sourceTextChunks[index] || segment.sourceText || segment.originalText || '');
    return {
      ...segment,
      id: `${segment.id || 'unit'}-${index + 1}`,
      index,
      start: roundSeconds(start),
      end: roundSeconds(end),
      duration: roundSeconds(Math.max(0.1, end - start)),
      text: chunk,
      translatedText: mode === 'translated' ? chunk : segment.translatedText,
      finalText: mode === 'translated' ? chunk : segment.finalText,
      sourceText,
      originalText: sourceText || segment.originalText,
      splitFromOversizedTimeline: true,
    };
  });
}

function splitLongTranslatedDisplaySegments(segments = [], config = {}) {
  const options = timelineConfig(config);
  const splitSegments = (segments || [])
    .flatMap((segment) => {
      const sentenceSegments = splitTranslatedSegmentBySentence(segment);
      if (sentenceSegments.length > 1) return sentenceSegments;
      return splitOversizedSegment(sentenceSegments[0] || segment, options, 'translated');
    });
  return clampNonOverlapping(splitSegments, options.guard)
    .map((segment, index) => ({ ...segment, index }));
}

function splitTranslatedSegmentBySentence(segment = {}) {
  const text = normalizeText(segment.text || segment.finalText || segment.translatedText || '');
  const sentenceChunks = splitTextIntoSentenceCues(text);
  if (sentenceChunks.length <= 1) return [{ ...segment, text, translatedText: text, finalText: text }];

  const start = segmentStart(segment);
  const end = segmentEnd(segment);
  const duration = Math.max(0.1, end - start);
  const totalWeight = sentenceChunks.reduce((sum, chunk) => sum + Math.max(1, sourceCharLength(chunk)), 0);
  let cursor = start;

  return sentenceChunks.map((chunk, index) => {
    const isLast = index === sentenceChunks.length - 1;
    const remaining = Math.max(0.1, end - cursor);
    const proportional = duration * (Math.max(1, sourceCharLength(chunk)) / Math.max(1, totalWeight));
    const chunkDuration = isLast
      ? remaining
      : Math.max(0.25, Math.min(remaining - 0.1 * (sentenceChunks.length - index - 1), proportional));
    const chunkStart = cursor;
    const chunkEnd = isLast ? end : Math.min(end - 0.1 * (sentenceChunks.length - index - 1), cursor + chunkDuration);
    cursor = chunkEnd;
    return {
      ...segment,
      id: `${segment.id || 'translated'}-sent-${index + 1}`,
      start: roundSeconds(chunkStart),
      end: roundSeconds(chunkEnd),
      duration: roundSeconds(Math.max(0.1, chunkEnd - chunkStart)),
      text: chunk,
      translatedText: chunk,
      finalText: chunk,
      splitFromSentenceTimeline: true,
    };
  });
}

function clampNonOverlapping(segments, guard = 0) {
  const output = segments.map((segment) => ({ ...segment }));
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index];
    const next = output[index + 1];
    const start = segmentStart(current);
    let end = Math.max(start + 0.05, segmentEnd(current));
    if (next) {
      const maxEnd = Math.max(start + 0.05, segmentStart(next) - guard);
      end = Math.min(end, maxEnd);
    }
    current.start = roundSeconds(start);
    current.end = roundSeconds(end);
    current.duration = roundSeconds(Math.max(0.05, end - start));
  }
  return output;
}

function buildMergedUnits(segments = [], config = {}) {
  const options = timelineConfig(config);
  const sorted = (segments || [])
    .map(normalizeSegment)
    .filter((segment) => segment.text && segmentEnd(segment) > segmentStart(segment))
    .sort((left, right) => segmentStart(left) - segmentStart(right));
  const units = [];
  let buffer = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index];
    buffer.push(segment);
    const next = sorted[index + 1];
    if (!shouldKeepMerging(buffer, next, options)) {
      units.push(createUnit(buffer, units.length));
      buffer = [];
    }
  }

  if (buffer.length) units.push(createUnit(buffer, units.length));
  return clampNonOverlapping(units, options.guard).map((unit, index) => ({ ...unit, index }));
}

function buildTimelineUnits(segments = [], config = {}) {
  const options = timelineConfig(config);
  return buildMergedUnits(segments, config)
    .flatMap((unit) => splitOversizedSegment(unit, options, 'source'))
    .map((unit, index) => ({ ...unit, index }));
}

function overlapSeconds(left, right) {
  return Math.max(0, Math.min(segmentEnd(left), segmentEnd(right)) - Math.max(segmentStart(left), segmentStart(right)));
}

function translatedSegmentsForUnit(unit, translatedSegments = []) {
  const sourceIds = new Set((unit.sourceIds || []).map(String));
  const byId = translatedSegments.filter((segment) => {
    const ids = [
      segment.id,
      segment.segmentId,
      ...(Array.isArray(segment.sourceIds) ? segment.sourceIds : []),
    ].filter(Boolean).map(String);
    return ids.some((id) => sourceIds.has(id));
  });
  if (byId.length) return byId;

  const unitStart = segmentStart(unit);
  const unitEnd = segmentEnd(unit);
  const centerMatches = translatedSegments.filter((segment) => {
    const center = (segmentStart(segment) + segmentEnd(segment)) / 2;
    return center >= unitStart && center < unitEnd;
  });
  if (centerMatches.length) return centerMatches;

  let best = null;
  let bestOverlap = 0;
  for (const segment of translatedSegments) {
    const overlap = overlapSeconds(unit, segment);
    if (overlap > bestOverlap) {
      best = segment;
      bestOverlap = overlap;
    }
  }
  return best && bestOverlap > 0.001 ? [best] : [];
}

function normalizeTranslatedTimeline(sourceSegments = [], translatedSegments = [], config = {}) {
  const packets = buildTranslationPackets(sourceSegments, config);
  const normalizedTranslations = (translatedSegments || [])
    .map((segment, index) => ({
      ...segment,
      id: String(segment?.id || `translated-${index + 1}`),
      text: normalizeText(segment?.text || segment?.finalText || segment?.translatedText),
      translatedText: normalizeText(segment?.text || segment?.finalText || segment?.translatedText),
      start: segmentStart(segment),
      end: segmentEnd(segment),
    }))
    .filter((segment) => segment.text);

  const translatedPackets = packets.map((packet, index) => {
    const related = translatedSegmentsForUnit(packet, normalizedTranslations);
    const text = joinTranslatedText(related.map((segment) => segment.text));
    const finalText = text || joinTranslatedText(related.map((segment) => segment.translatedText)) || packet.text;
    return {
      ...packet,
      id: `merged-${index + 1}`,
      index,
      text: finalText,
      translatedText: finalText,
      finalText,
      originalText: packet.text,
      sourceText: packet.text,
      timelineNormalized: true,
    };
  }).filter((segment) => segment.text);

  const finalSegments = redistributeTranslatedPackets(packets, translatedPackets, config);

  return {
    sourceUnits: sourceSegmentsFromTranslated(finalSegments),
    segments: finalSegments,
  };
}

function assertTimelineSafe(segments = []) {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const start = segmentStart(segment);
    const end = segmentEnd(segment);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`Timeline normalizer produced an invalid cue at ${index + 1}.`);
    }
    const next = segments[index + 1];
    if (next && end > segmentStart(next) + 0.001) {
      throw new Error(`Timeline normalizer produced overlapping cues at ${index + 1}.`);
    }
  }
}

module.exports = {
  buildMeaningUnits,
  buildTranslationPackets,
  mapMeaningUnitsToDisplayRows,
  normalizeTtsPunctuation,
  redistributeTranslatedPackets,
  sourceSegmentsFromTranslated,
  splitLongTranslatedDisplaySegments,
  ttsTextFromTranslation,
};
