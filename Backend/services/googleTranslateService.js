const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isCliTranslationProvider, runCliTranslation } = require('./cliTranslationService');
const { buildSkillTaskPrompt } = require('./skillPromptService');
const { containsCjkUnifiedIdeograph, containsKnownCorruptTranslationArtifact } = require('./textEncodingRepair');
const { verbalizeVietnameseDubbingText } = require('./vietnameseNumberText');
const execFileAsync = promisify(execFile);

function targetTtsRateForTranslation(config = {}) {
  const configured = Number(config.translationTargetTtsRate);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(0.75, Math.min(1.5, configured));
  }
  return 1;
}

function isChineseSource(config = {}) {
  const value = String(config.sourceLanguage || '').trim().toLowerCase();
  return value === 'zh' || value.startsWith('zh-') || value.startsWith('cmn');
}

function isChineseToVietnamese(config = {}) {
  return isChineseSource(config) && isVietnameseTarget(config);
}

function charsPerSecondForLanguage(languageCode) {
  const code = String(languageCode || '').toLowerCase();
  if (code.startsWith('vi')) return 13;
  if (code.startsWith('en')) return 16;
  if (code.startsWith('zh')) return 8;
  if (code.startsWith('ja')) return 9;
  if (code.startsWith('ko')) return 10;
  return 14;
}

function splitIntoSpeechClauses(text) {
  return String(text || '')
    .split(/([,.;:!?\uff0c\u3002\uff01\uff1f\uff1b\uff1a])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const combined = `${token}${next}`.trim();
        if (combined) parts.push(combined);
      }
      return parts;
    }, []);
}

function estimateTranslationCharBudget(segment, config) {
  const target = String(config.targetLanguage || '').toLowerCase();
  const baseCps = Number(config.translationCharsPerSecond) || charsPerSecondForLanguage(target);
  const speakingRate = targetTtsRateForTranslation(config);
  const slotSeconds = getReadableSegmentSlotSeconds(segment, config);

  return Math.max(12, Math.round(slotSeconds * baseCps * speakingRate * 0.95));
}

function getSegmentSlotSeconds(segment) {
  return Math.max(
    0.35,
    Number(segment.allowedDuration)
      || Number(segment.slotDuration)
      || Number(segment.duration)
      || Math.max(0.35, (Number(segment.end) || 0) - (Number(segment.start) || 0))
      || 0.35
  );
}

function getReadableSegmentSlotSeconds(segment, config = {}) {
  const slotSeconds = getSegmentSlotSeconds(segment);
  if (config.useTimelineGuardForTtsBudget !== true) {
    return slotSeconds;
  }
  const breathGap = Math.max(0, Math.min(0.3, Number(config.timelineBreathGapSeconds ?? config.timelineGuardSeconds ?? 0.15)));
  return Math.max(0.35, slotSeconds - Math.min(breathGap, slotSeconds * 0.22));
}

function isVietnameseTarget(config = {}) {
  const target = String(config.targetLanguage || '').trim().toLowerCase();
  return target === 'vietnamese' || target.startsWith('vi');
}

function countSpokenWords(text = '') {
  const normalized = String(text || '')
    .replace(/[.,!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 0;
  return normalized.split(' ').filter(Boolean).length;
}

function vietnameseWordsPerSecond(config = {}) {
  const configured = Number(config.translationWordsPerSecond);
  const base = Number.isFinite(configured) && configured > 0
    ? Math.max(3.0, Math.min(5.2, configured))
    : 4.4;
  return Math.min(6.5, base * targetTtsRateForTranslation(config));
}

function getDubbingTimingBudget(segment, config = {}) {
  const target = String(config.targetLanguage || '').toLowerCase();
  const cps = Math.max(8, Number(config.translationCharsPerSecond) || charsPerSecondForLanguage(target));
  const speakingRate = targetTtsRateForTranslation(config);
  const slotSeconds = getReadableSegmentSlotSeconds(segment, config);

  if (isVietnameseTarget(config)) {
    const effectiveWordsPerSecond = vietnameseWordsPerSecond(config);
    const minWords = Math.max(2, Math.round(slotSeconds * 0.75 * effectiveWordsPerSecond));
    const maxWords = Math.max(3, Math.round(slotSeconds * 0.95 * effectiveWordsPerSecond));
    const acceptableMaxWords = Math.max(maxWords, Math.round(slotSeconds * 1.05 * effectiveWordsPerSecond));
    return {
      slotSeconds,
      targetMinSeconds: slotSeconds * 0.86,
      targetMaxSeconds: slotSeconds * 0.95,
      acceptableMinSeconds: slotSeconds * 0.75,
      acceptableMaxSeconds: slotSeconds * 1.02,
      minChars: Math.max(10, minWords * 4),
      maxChars: Math.max(16, maxWords * 5),
      acceptableMinChars: Math.max(8, minWords * 4),
      acceptableMaxChars: Math.max(18, acceptableMaxWords * 5),
      minWords,
      maxWords,
      acceptableMaxWords,
      effectiveWordsPerSecond,
      effectiveCps: cps * speakingRate,
      speakingRate,
      translationTargetTtsRate: speakingRate,
      targetTtsRate: speakingRate,
    };
  }

  const effectiveCps = cps * speakingRate;
  return {
    slotSeconds,
    targetMinSeconds: slotSeconds * 0.9,
    targetMaxSeconds: slotSeconds * 0.95,
    acceptableMinSeconds: slotSeconds * 0.85,
    acceptableMaxSeconds: slotSeconds * 1.05,
    minChars: Math.max(6, Math.round(slotSeconds * 0.9 * effectiveCps)),
    maxChars: Math.max(8, Math.round(slotSeconds * 0.95 * effectiveCps)),
    acceptableMinChars: Math.max(5, Math.round(slotSeconds * 0.85 * effectiveCps)),
    acceptableMaxChars: Math.max(9, Math.round(slotSeconds * 1.05 * effectiveCps)),
    effectiveCps,
    speakingRate,
    translationTargetTtsRate: speakingRate,
    targetTtsRate: speakingRate,
  };
}

function estimateSpeechSeconds(text, segment, config = {}) {
  const budget = getDubbingTimingBudget(segment, config);
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c?]/g, '')
    .trim();
  if (!normalized) return 0;
  if (isVietnameseTarget(config) && budget.effectiveWordsPerSecond) {
    return countSpokenWords(text) / Math.max(1, budget.effectiveWordsPerSecond);
  }
  return normalized.length / Math.max(1, budget.effectiveCps);
}

function foldDetailText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function extractCriticalNumbers(text = '') {
  const folded = foldDetailText(text).replace(/,/g, '.');
  return Array.from(new Set((folded.match(/\b\d+(?:[.:]\d+)?\b/g) || []).filter(Boolean)));
}

function extractCriticalNames(text = '') {
  const matches = String(text || '').match(/\b[A-Z][A-Za-z0-9'.-]{1,}(?:\s+[A-Z][A-Za-z0-9'.-]{1,}){0,3}/g) || [];
  const ignored = new Set(['The', 'A', 'An', 'This', 'That', 'It', 'He', 'She', 'They', 'We', 'I']);
  return Array.from(new Set(matches
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !ignored.has(value))));
}

function preservesCriticalDetails(referenceText = '', candidateText = '') {
  const candidateFolded = foldDetailText(candidateText).replace(/,/g, '.');
  for (const token of extractCriticalNumbers(referenceText)) {
    if (!candidateFolded.includes(token)) return false;
  }

  for (const name of extractCriticalNames(referenceText)) {
    const foldedName = foldDetailText(name);
    if (foldedName && !candidateFolded.includes(foldedName)) return false;
  }

  return true;
}

function keepCriticalDetails(candidateText = '', fallbackText = '') {
  return preservesCriticalDetails(fallbackText, candidateText) ? candidateText : fallbackText;
}

function sourceHasApproximation(text = '') {
  return /(\u8fd1|\u5c06\u8fd1|\u7ea6|\u5927\u7ea6|\u5de6\u53f3|about|around|nearly|almost|approximately)/i.test(String(text || ''));
}

function appendBeforeSentenceEnd(text = '', value = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return value;
  if (/[.!?]$/.test(cleaned)) return cleaned.replace(/([.!?])$/, ', ' + value + '$1');
  return cleaned + ', ' + value;
}

function restoreMissingSourceNumbers(candidateText = '', sourceText = '') {
  const sourceNumbers = extractCriticalNumbers(sourceText);
  if (!sourceNumbers.length) return candidateText;

  let output = String(candidateText || '').replace(/\s+/g, ' ').trim();
  for (const number of sourceNumbers) {
    const foldedOutput = foldDetailText(output).replace(/,/g, '.');
    if (foldedOutput.includes(number)) continue;

    const value = (sourceHasApproximation(sourceText) ? 'g\u1ea7n ' : '') + number;
    const vagueQuantity = /m\S*t con s\S* r\S*t l\S*n|con s\S* r\S*t l\S*n|s\S* l\S*ng l\S*n|r\S*t l\S*n/i;
    if (vagueQuantity.test(output)) {
      output = output.replace(vagueQuantity, value);
    } else {
      output = appendBeforeSentenceEnd(output, value);
    }
  }
  return output;
}

function keepSourceCriticalDetails(candidateText = '', segment = {}) {
  const sourceText = String(segment.originalText || segment.sourceText || '').trim();
  if (!sourceText) return candidateText;

  let output = restoreMissingSourceNumbers(candidateText, sourceText);
  for (const name of extractCriticalNames(sourceText)) {
    const foldedName = foldDetailText(name);
    if (foldedName && !foldDetailText(output).includes(foldedName)) {
      output = appendBeforeSentenceEnd(output, name);
    }
  }
  return output;
}

function getTimingFitStatus(text, segment, config = {}) {
  const budget = getDubbingTimingBudget(segment, config);
  const estimatedSeconds = estimateSpeechSeconds(text, segment, config);
  let status = 'ok';
  if (estimatedSeconds > budget.acceptableMaxSeconds) {
    status = 'too_long';
  } else if (estimatedSeconds < budget.acceptableMinSeconds) {
    status = 'too_short';
  } else if (estimatedSeconds >= budget.targetMinSeconds && estimatedSeconds <= budget.targetMaxSeconds) {
    status = 'ideal';
  }
  return {
    ...budget,
    estimatedSeconds,
    status,
    ratio: estimatedSeconds / Math.max(0.1, budget.slotSeconds),
  };
}

function compactVietnameseForDubbing(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\bquý vị\b/gi, 'bạn')
    .replace(/\bvui lòng\b/gi, 'hãy')
    .replace(/\bthực hiện các giao dịch\b/gi, 'giao dịch')
    .replace(/\bcác giao dịch mua hàng\b/gi, 'giao dịch')
    .replace(/\bhoạt động đáng ngờ\b/gi, 'giao dịch lạ')
    .replace(/\btrong vòng\b/gi, 'trong')
    .replace(/\btrong khoảng thời gian\b/gi, 'trong')
    .replace(/\bmột chiếc\b/gi, 'chiếc')
    .replace(/\bmột ly\b/gi, 'ly')
    .replace(/\bmột chai\b/gi, 'chai')
    .replace(/\bmột bằng\b/gi, 'bằng')
    .replace(/\bcủa mình\b/gi, '')
    .replace(/\bcủa bạn\b/gi, 'bạn')
    .replace(/\bvào lúc\b/gi, 'lúc')
    .replace(/\bngày hôm qua\b/gi, 'hôm qua')
    .replace(/\bngày hôm nay\b/gi, 'hôm nay')
    .replace(/\bđô la\b/gi, 'đô')
    .replace(/\bAn sinh Xã hội\b/gi, 'an sinh')
    .replace(/\bliên hệ với bạn qua tin nhắn\b/gi, 'nhắn tin cho bạn')
    .replace(/\bcó thể gian lận\b/gi, 'khả nghi')
    .replace(/\bkhông bao giờ\b/gi, 'chẳng bao giờ')
    .replace(/\bthực sự\b/gi, '')
    .replace(/\bmột cách\b/gi, '')
    .replace(/\srất\s+/gi, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function keepWithinCharBudget(text, maxChars) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length <= maxChars) return cleaned;

  const clauses = splitIntoSpeechClauses(cleaned);
  if (clauses.length > 1) {
    const kept = [];
    let length = 0;
    for (const clause of clauses) {
      const candidateLength = length + (kept.length ? 1 : 0) + clause.length;
      if (candidateLength > maxChars) break;
      kept.push(clause);
      length = candidateLength;
    }
    const joined = kept.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length >= Math.max(8, Math.floor(maxChars * 0.55))) {
      return joined;
    }
  }

  const words = cleaned.split(/\s+/);
  const kept = [];
  for (const word of words) {
    const candidate = [...kept, word].join(' ');
    if (candidate.length > maxChars) break;
    kept.push(word);
  }

  const result = kept.join(' ').trim();
  if (result.length >= Math.max(8, Math.floor(maxChars * 0.55))) {
    return result.replace(/[,;:]$/, '').trim();
  }

  return cleaned;
}

function applyDurationAwareConstraint(translatedText, segment, config) {
  const text = String(translatedText || '').trim();
  if (!text) return text;

  const cleanedRaw = keepSourceCriticalDetails(keepCriticalDetails(cleanDubbingTranslationText(text), text), segment);
  const cleaned = isVietnameseTarget(config) ? verbalizeVietnameseDubbingText(cleanedRaw) : cleanedRaw;
  if (config.allowTextShortening !== true) return cleaned;

  const fit = getTimingFitStatus(cleaned, segment, config);
  const threshold = Number(config.translationConstraintThreshold) || 1.05;
  const maxChars = Math.round(fit.maxChars * threshold);
  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  const compactRaw = keepSourceCriticalDetails(compactVietnameseForDubbing(cleaned), segment);
  const compact = isVietnameseTarget(config) ? verbalizeVietnameseDubbingText(compactRaw) : compactRaw;
  return keepCriticalDetails(compact, cleaned);
}

function assertNoCjkInVietnameseTranslation(text = '', config = {}, provider = 'model', label = 'translation') {
  if (!isVietnameseTarget(config)) return;
  if (containsCjkUnifiedIdeograph(text)) {
    throw new Error(`${provider} returned Chinese Han/Hanzi/Kanji character(s) in Vietnamese ${label}.`);
  }
  assertNoCorruptArtifactInVietnameseTranslation(text, config, provider, label);
}

function assertNoCorruptArtifactInVietnameseTranslation(text = '', config = {}, provider = 'model', label = 'translation') {
  if (!isVietnameseTarget(config) || !containsKnownCorruptTranslationArtifact(text)) return;
  throw new Error(`${provider} returned corrupt unit-replacement artifact(s) in Vietnamese ${label}.`);
}

function cleanDubbingTranslationText(text) {
  return compactVietnameseForDubbing(text)
    .replace(/\banh ta\b/gi, 'anh')
    .replace(/\bc� ta\b/gi, 'c�')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildDubbingTranslationPrompt(segment, config) {
  const videoContext = [config.autoContext, config.userContext].filter(Boolean).join('\n\n').trim() || '(none)';
  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'Translate one subtitle line using the skill. Return only the translated subtitle text.',
    input: String(segment.text || ''),
    sourceLanguage: config.sourceLanguage || 'auto',
    targetLanguage: config.targetLanguage || 'vi',
    context: videoContext,
    glossary: config.customGlossary || '',
    outputContract: [
      'Return only the translated subtitle text.',
      'Keep this as one subtitle line.',
      'No explanation, no markdown, no preamble.',
    ].join('\n'),
  });
}

function normalizeLlmContent(content) {
  return collapseRepeatedTranslationText(repairMojibake(String(content || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()));
}

function normalizeRepeatKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:，。！？；：、"“”'‘’()[\]{}\-–—\s]+/g, '')
    .trim();
}

function collapseRepeatedTranslationText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const parts = value.split(/\s*[,;，；]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return value;

  const counts = new Map();
  for (const part of parts) {
    const key = normalizeRepeatKey(part);
    if (key.length < 10) continue;
    const current = counts.get(key) || { count: 0, text: part };
    current.count += 1;
    counts.set(key, current);
  }

  let repeated = null;
  for (const item of counts.values()) {
    if (!repeated || item.count > repeated.count) repeated = item;
  }
  if (!repeated || repeated.count < 3 || repeated.count / parts.length < 0.6) return value;
  return repeated.text.replace(/[,.!?;:，。！？；：、]+$/g, '').trim();
}

function repairMojibake(text) {
  const value = String(text || '');
  if (!/[ÃƒÃ‚Ã„Ã…Ã¡ÂºÃ¡Â»]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    return /[\u00c0-\u1ef9]/.test(repaired) ? repaired : value;
  } catch {
    return value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTsvTranslations(text, config = {}, provider = 'model') {
  const lines = String(text || '')
    .replace(/^```(?:text|tsv)?/i, '')
    .replace(/```$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const map = new Map();

  for (const line of lines) {
    const match = line.match(/^(\d+)\s*\|\|\|\s*(.+)$/);
    if (match) {
      const translated = normalizeLlmContent(match[2]);
      assertNoCjkInVietnameseTranslation(translated, config, provider, `timing rewrite line ${match[1]}`);
      map.set(Number(match[1]), translated);
    }
  }

  return map;
}

function parseTimingRewriteTranslations(text, config = {}, provider = 'model') {
  const value = String(text || '').trim();
  if (!value) return new Map();
  try {
    const start = value.indexOf('[');
    const end = value.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(value.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const map = new Map();
        parsed.forEach((item) => {
          const rowId = Number(item?.row_id ?? item?.rowId ?? item?.id);
          const translated = normalizeLlmContent(item?.repaired_translation || item?.translation || item?.text || '');
          if (Number.isInteger(rowId) && translated) {
            assertNoCjkInVietnameseTranslation(translated, config, provider, `timing rewrite line ${rowId}`);
            map.set(rowId, translated);
          }
        });
        return map;
      }
    }
  } catch {
    // Older prompts asked for TSV; keep accepting that output for in-flight jobs.
  }
  return parseTsvTranslations(value, config, provider);
}

function shouldRewriteForTtsTiming(segment, config = {}, precomputedFit = null) {
  // TTS timing is review data, never an automatic instruction to rewrite translation text.
  return false;
}

function rankTimingRewriteCandidate(candidate) {
  const fit = candidate.fit || { status: 'ok', ratio: 1 };
  if (fit.status === 'too_long') return 2 + Math.max(0, fit.ratio - 1.05);
  if (fit.status === 'too_short') return Math.max(0, 0.85 - fit.ratio);
  return 0;
}

function buildTimingRewritePrompt(items, config = {}) {
  const repairInstructions = `Repair mode:
- Read source_text first. source_text is the meaning authority; current_translation is the Vietnamese style/reference.
- Do not repair from current_translation alone. If source_text and current_translation differ, preserve the source meaning and use current_translation only for tone.
- Start from current_translation and make the smallest useful edit.
- Treat this as meaning-faithful minimal timing repair, not a fresh summary.
- Do not use any hard character-count target.
- Repair order: first remove every non-numeric comma/pause, then delete only clearly redundant filler/repeated words, then replace a long word/short phrase with a shorter equivalent.
- If that is still not enough, retranslate only the smallest long phrase. Do not rewrite the whole line merely because it is long.
- Do not over-shorten into a dry summary. Preserve the same complete narration beat, scene/detail, emphasis, and outcome.
- Proper names are locked display text. Preserve every name exactly as written in the current translation, glossary, title, or context; never remove, translate, Vietnamese-ize, phoneticize, respell, abbreviate, join, or split it.
- Treat commas as TTS pauses. Vietnamese repaired lines must contain no non-numeric commas.
- Do not add new commas.
- Prefer shorter natural Vietnamese synonyms; never delete a separate fact just to make the line fit.
- Do not delete a separate fact, action, result, negation, place, number, or vivid detail from source_text. If exact fit is impossible without losing meaning, keep a slightly longer but complete line.
- Before returning each row, verify that every distinct detail in source_text/current_translation is present or naturally implied in repaired_translation.
- Bad repair example: replacing "the water was full of mud and he could not even see his hand" with only "the water was muddy" is invalid because it drops the visibility detail.
- Keep the repaired line natural, complete, and close to current_translation unless it truly needs a shorter retranslation.`;
  const context = [repairInstructions, config.autoContext, config.userContext].filter(Boolean).join('\n\n').trim();
  const glossary = String(config.customGlossary || '').trim();
  const rows = items.map(({ segment, fit }, index) => {
    const source = String(segment.originalText || segment.sourceText || segment.text || '').replace(/\s+/g, ' ').trim();
    const current = String(segment.translatedText || segment.text || '').replace(/\s+/g, ' ').trim();
    return {
      row_id: String(index),
      source_text: source,
      current_translation: current,
      slot_seconds: Number(fit.slotSeconds.toFixed(3)),
      audio_seconds: Number(fit.estimatedSeconds.toFixed(3)),
      overflow_seconds: Number(Math.max(0, fit.estimatedSeconds - fit.slotSeconds).toFixed(3)),
      fit_ratio: Number((fit.estimatedSeconds / Math.max(0.1, fit.slotSeconds)).toFixed(3)),
      target_tts_rate: targetTtsRateForTranslation(config),
      error_reason: fit.status,
    };
  });

  return {
    system: `Use the subtitle-tts-overflow-repair skill included in the task prompt.
Return exactly one valid JSON array and no markdown.`,
    user: buildSkillTaskPrompt({
      skillName: 'subtitle-tts-overflow-repair',
      task: 'Conservatively repair subtitle/TTS rows: remove non-numeric commas and filler first, then use shorter synonyms or retranslate only a long phrase when needed. Keep a complete narration beat and preserve every locked proper name exactly. Do not rewrite the whole sentence.',
      input: rows,
      sourceLanguage: config.sourceLanguage || 'auto',
      targetLanguage: config.targetLanguage || 'vi',
      context,
      glossary,
      outputContract: `Return JSON array only. Each item must be:
{"row_id":"same id","repaired_translation":"conservatively edited subtitle/TTS line"}`,
    }),
  };
}

async function callTimingRewriteModel(items, config) {
  if (!items.length) return new Map();
  const prompt = buildTimingRewritePrompt(items, config);
  if (!isCliTranslationProvider(config.translationProvider)) {
    return new Map();
  }
  const raw = await runCliTranslation(config.translationProvider, {
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
    model: config.cliTranslationModel,
  });
  return parseTimingRewriteTranslations(raw, config, config.translationProvider);
}

function timingFitMetadata(fit, extra = {}) {
  return {
    status: fit.status,
    slotSeconds: Number(fit.slotSeconds.toFixed(3)),
    estimatedSeconds: Number(fit.estimatedSeconds.toFixed(3)),
    targetMinSeconds: Number(fit.targetMinSeconds.toFixed(3)),
    targetMaxSeconds: Number(fit.targetMaxSeconds.toFixed(3)),
    acceptableMinSeconds: Number(fit.acceptableMinSeconds.toFixed(3)),
    acceptableMaxSeconds: Number(fit.acceptableMaxSeconds.toFixed(3)),
    targetTtsRate: Number(targetTtsRateForTranslation(extra.config || {}).toFixed(2)),
    ratio: Number(fit.ratio.toFixed(3)),
    validation: extra.validation || 'estimate',
    pass: Number(extra.pass) || 0,
    ...extra,
    config: undefined,
  };
}

function timingFitFromActualSeconds(actualSeconds, segment, config = {}, extra = {}) {
  const budget = getDubbingTimingBudget(segment, config);
  const seconds = Math.max(0, Number(actualSeconds) || 0);
  let status = 'ok';
  if (seconds > budget.acceptableMaxSeconds) {
    status = 'too_long';
  } else if (seconds < budget.acceptableMinSeconds) {
    status = 'too_short';
  } else if (seconds >= budget.targetMinSeconds && seconds <= budget.targetMaxSeconds) {
    status = 'ideal';
  }
  return timingFitMetadata({
    ...budget,
    estimatedSeconds: seconds,
    status,
    ratio: seconds / Math.max(0.1, budget.slotSeconds),
  }, { ...extra, config, validation: 'tts_probe' });
}

function isNearTimingBoundary(fit = {}) {
  const estimated = Number(fit.estimatedSeconds) || 0;
  const targetMax = Number(fit.targetMaxSeconds) || 0;
  const acceptableMax = Number(fit.acceptableMaxSeconds) || 0;
  const acceptableMin = Number(fit.acceptableMinSeconds) || 0;
  if (fit.status === 'too_long' || fit.status === 'too_short') return true;
  if (targetMax && estimated >= targetMax * 0.96) return true;
  if (acceptableMax && estimated >= acceptableMax * 0.92) return true;
  if (acceptableMin && estimated <= acceptableMin * 1.08) return true;
  return false;
}

function currentTimingFit(segment = {}, config = {}) {
  const existing = segment.ttsTimingFit;
  if (existing && typeof existing === 'object') {
    return {
      ...getTimingFitStatus(segment.text || segment.translatedText || '', segment, config),
      ...existing,
    };
  }
  return getTimingFitStatus(segment.text || segment.translatedText || '', segment, config);
}

async function probeRiskyTranslationTimings(output, config = {}, pass = 0) {
  if (String(config.translationTimingValidationMode || 'estimate_plus_probe') !== 'estimate_plus_probe') {
    return { probed: 0, failed: 0 };
  }
  const maxProbeLines = Math.max(0, Math.min(80, Number(config.translationTimingProbeMaxLines) || Number(config.ttsTimingRewriteMaxLines) || 40));
  const risky = output
    .map((segment, index) => ({ segment, index, fit: currentTimingFit(segment, config) }))
    .filter(({ fit }) => isNearTimingBoundary(fit))
    .sort((left, right) => rankTimingRewriteCandidate(right) - rankTimingRewriteCandidate(left))
    .slice(0, maxProbeLines);
  if (!risky.length) return { probed: 0, failed: 0 };

  const probeDir = path.join(os.tmpdir(), 'dubflow_translation_probe_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const probeSegments = risky.map(({ segment }, index) => ({
    ...segment,
    id: String(segment.id || 'translation-probe-' + index),
    index,
    text: String(segment.text || segment.translatedText || '').trim(),
    ttsText: String(segment.text || segment.translatedText || '').trim(),
    prosodyText: String(segment.text || segment.translatedText || '').trim(),
  }));

  try {
    const { synthesizeAllSegments } = require('./googleTtsService');
    const clips = await synthesizeAllSegments(probeSegments, {
      ...config,
      speakingRate: targetTtsRateForTranslation(config),
      minSpeakingRate: targetTtsRateForTranslation(config),
      maxSpeakingRate: targetTtsRateForTranslation(config),
      maxEffectiveSpeakingRate: targetTtsRateForTranslation(config),
      ttsDurationControl: false,
      preserveTtsAudio: true,
      allowTextShortening: false,
      ttsMaxAttempts: 1,
      ttsConcurrency: Math.min(3, Math.max(1, Number(config.ttsConcurrency) || 1)),
    }, probeDir);
    clips.forEach((clip, localIndex) => {
      const target = risky[localIndex];
      if (!target) return;
      const actualSeconds = Number(clip?.actualDuration || clip?.durationSeconds || clip?.audioDurationSeconds || 0);
      if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) return;
      output[target.index] = {
        ...output[target.index],
        ttsTimingProbe: {
          actualSeconds: Number(actualSeconds.toFixed(3)),
          targetTtsRate: Number(targetTtsRateForTranslation(config).toFixed(2)),
          pass,
        },
        ttsTimingFit: timingFitFromActualSeconds(actualSeconds, output[target.index], config, { pass }),
      };
    });
    return { probed: clips.filter(Boolean).length, failed: 0 };
  } catch (error) {
    risky.forEach(({ index }) => {
      output[index] = {
        ...output[index],
        ttsTimingProbe: {
          failed: true,
          message: String(error.message || error).slice(0, 240),
          pass,
        },
      };
    });
    return { probed: 0, failed: risky.length };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

function refreshEstimatedTimingFits(output, config = {}, pass = 0) {
  output.forEach((segment, index) => {
    const fit = getTimingFitStatus(segment.text || segment.translatedText || '', segment, config);
    output[index] = {
      ...segment,
      ttsTimingFit: timingFitMetadata(fit, { config, validation: 'estimate', pass }),
    };
  });
}

async function adaptTranslationsForTtsTiming(segments, config = {}) {
  const output = segments.map((segment) => {
    const constrained = applyDurationAwareConstraint(segment.text || segment.translatedText, segment, config);
    const fit = getTimingFitStatus(constrained, segment, config);
    return {
      ...segment,
      text: constrained,
      translatedText: constrained,
      translationTargetTtsRate: Number(targetTtsRateForTranslation(config).toFixed(2)),
      ttsTimingFit: timingFitMetadata(fit, { config, validation: 'estimate', pass: 0 }),
    };
  });

  if (config.ttsTimingRewrite === false) {
    await probeRiskyTranslationTimings(output, config, 0);
    return output;
  }

  const configuredMaxPasses = Number(config.translationTimingRewriteMaxPasses);
  const maxPasses = Math.max(0, Math.min(3, Number.isFinite(configuredMaxPasses) ? Math.round(configuredMaxPasses) : 2));
  const maxRewriteLines = Math.max(0, Math.min(200, Number(config.ttsTimingRewriteMaxLines) || 80));
  const batchSize = Math.max(10, Math.min(60, Number(config.ttsTimingRewriteBatchSize) || 40));
  let totalRewrites = 0;
  let totalProbes = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    refreshEstimatedTimingFits(output, config, pass);
    const probeStats = await probeRiskyTranslationTimings(output, config, pass);
    totalProbes += probeStats.probed || 0;

    const candidates = output
      .map((segment, index) => ({ segment, index, fit: currentTimingFit(segment, config) }))
      .filter(({ segment, fit }) => shouldRewriteForTtsTiming(segment, config, fit))
      .sort((left, right) => rankTimingRewriteCandidate(right) - rankTimingRewriteCandidate(left));
    if (!candidates.length) break;

    const selectedCandidates = candidates.slice(0, maxRewriteLines);
    if (!selectedCandidates.length) break;
    console.log('[translate] TTS timing rewrite pass ' + (pass + 1) + ': ' + selectedCandidates.length + '/' + output.length + ' lines, batch=' + batchSize + ', probes=' + totalProbes);

    let passRewrites = 0;
    for (let start = 0; start < selectedCandidates.length; start += batchSize) {
      const batch = selectedCandidates.slice(start, start + batchSize);
      try {
        const rewritten = await callTimingRewriteModel(batch, config);
        batch.forEach(({ segment, index }, localIndex) => {
          const revisedRaw = rewritten.get(localIndex);
          if (!revisedRaw) return;
          const currentText = output[index]?.text || segment.text || segment.translatedText || '';
          const revised = applyDurationAwareConstraint(revisedRaw, segment, config);
          if (revised.includes('\uFFFD')) return;
          if (!preservesCriticalDetails(currentText, revised)) return;
          const fit = getTimingFitStatus(revised, segment, config);
          output[index] = {
            ...output[index],
            text: revised,
            translatedText: revised,
            ttsTimingRewriteApplied: true,
            ttsTimingRewritePasses: (Number(output[index]?.ttsTimingRewritePasses) || 0) + 1,
            ttsTimingFit: timingFitMetadata(fit, { config, validation: 'estimate', pass: pass + 1 }),
          };
          passRewrites += 1;
        });
      } catch {
        // Keep the previous translation if timing rewrite fails.
      }
    }
    totalRewrites += passRewrites;
    if (!passRewrites) break;
  }

  refreshEstimatedTimingFits(output, config, maxPasses);
  const finalProbeStats = await probeRiskyTranslationTimings(output, config, maxPasses);
  totalProbes += finalProbeStats.probed || 0;
  const warningCount = output.filter((segment) => ['too_long', 'too_short'].includes(segment.ttsTimingFit?.status)).length;
  output.forEach((segment, index) => {
    output[index] = {
      ...segment,
      ttsTimingSummary: {
        validationMode: String(config.translationTimingValidationMode || 'estimate_plus_probe'),
        rewritePasses: Number(segment.ttsTimingRewritePasses) || 0,
        targetTtsRate: Number(targetTtsRateForTranslation(config).toFixed(2)),
      },
    };
  });
  if (totalRewrites || totalProbes || warningCount) {
    console.log('[translate] timing validation: rewrites=' + totalRewrites + ', probes=' + totalProbes + ', warnings=' + warningCount + '/' + output.length);
  }
  return output;
}
function parseSrtTimestamp(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return 0;
  const [, hours, minutes, seconds, millis] = match;
  return (Number(hours) * 3600)
    + (Number(minutes) * 60)
    + Number(seconds)
    + (Number(millis.padEnd(3, '0')) / 1000);
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + `,${String(millis).padStart(3, '0')}`;
}

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:srt|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function parseSrtEntries(content) {
  const normalized = stripCodeFence(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const entries = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (!lines.length) continue;

    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timing = lines[timingIndex].split('-->').map((part) => part.trim());
    if (timing.length < 2) continue;

    const text = lines.slice(timingIndex + 1).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    entries.push({
      index: entries.length + 1,
      start: parseSrtTimestamp(timing[0]),
      end: parseSrtTimestamp(timing[1].split(/\s+/)[0]),
      text,
    });
  }

  return entries;
}

function formatSrtEntries(entries) {
  return entries.map((entry, index) => [
    String(index + 1),
    `${formatSrtTimestamp(entry.start)} --> ${formatSrtTimestamp(entry.end)}`,
    String(entry.text || '').replace(/\s+/g, ' ').trim(),
  ].join('\n')).join('\n\n') + '\n';
}

function formatCliJsonEntries(entries, config = {}) {
  return JSON.stringify((entries || []).map((entry) => ({
    index: Number(entry.index),
    text: String(entry.text || '').replace(/\s+/g, ' ').trim(),
  })), null, 2);
}

function translationCompletenessRisk(sourceText = '', translatedText = '', config = {}) {
  const source = String(sourceText || '').replace(/\s+/g, ' ').trim();
  const translated = String(translatedText || '').replace(/\s+/g, ' ').trim();
  if (!source || !translated) return null;

  const cjkCount = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const sourceWords = source
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const translatedWords = translated
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const sourceUnits = cjkCount >= 8 ? cjkCount : sourceWords;
  if (sourceUnits < 10) return null;

  const minimumRatio = cjkCount >= 8 ? 0.32 : 0.45;
  const minimumWords = Math.max(4, Math.floor(sourceUnits * minimumRatio));
  if (translatedWords >= minimumWords) return null;

  return {
    sourceUnits,
    translatedWords,
    minimumWords,
    sourcePreview: source.slice(0, 90),
  };
}

function findClippedTranslationEntries(inputEntries = [], translatedEntries = [], config = {}) {
  const risks = [];
  inputEntries.forEach((entry, index) => {
    const translated = translatedEntries[index];
    const risk = translationCompletenessRisk(entry?.text, translated?.text, config);
    if (risk) risks.push({ index: entry?.index ?? index, ...risk });
  });
  return risks;
}

function formatCliLineEntries(entries) {
  return (entries || []).map((entry) => {
    const index = Number(entry.index);
    const value = String(entry.text || '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return index + '\t' + value;
  }).join('\n');
}

function stripJsonFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function parseCliJsonPayload(raw, provider) {
  const cleaned = stripJsonFence(raw);
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart < 0 || arrayEnd <= arrayStart) {
    throw new Error(provider + ' returned non-JSON translation output.');
  }
  try {
    const parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    if (Array.isArray(parsed)) return parsed;
  } catch (arrayError) {
    try {
      const envelope = JSON.parse(cleaned);
      const items = envelope.translations || envelope.items || envelope.results;
      if (Array.isArray(items)) return items;
    } catch {
      // Use the clearer array parse error below.
    }
    throw new Error(provider + ' returned invalid JSON: ' + arrayError.message);
  }
  throw new Error(provider + ' returned JSON that is not an array.');
}

function parseCliJsonTranslations(raw, inputEntries, provider, config = {}) {
  const parsed = parseCliJsonPayload(raw, provider);
  if (parsed.length !== inputEntries.length) {
    throw new Error(provider + ' returned ' + parsed.length + ' items for ' + inputEntries.length + ' input cues.');
  }

  const byIndex = new Map();
  parsed.forEach((item) => {
    const index = Number(item && item.index);
    const text = normalizeLlmContent(item && item.text || '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(index) || !text) return;
    assertNoCjkInVietnameseTranslation(text, config, provider, `cue index ${index}`);
    byIndex.set(index, text);
  });

  return inputEntries.map((entry) => {
    const translated = byIndex.get(Number(entry.index));
    if (!translated) {
      throw new Error(provider + ' missed cue index ' + entry.index + '.');
    }
    return {
      ...entry,
      text: translated,
    };
  });
}

function stripCliLinePrefix(line, expectedIndex) {
  const value = String(line || '').replace(/^[-*]+\s*/, '').trim();
  const index = Number(expectedIndex);
  const exact = new RegExp('^' + index + '\s*(?:\t+|\s{2,}|[|:?.?\-??])\s*(.+)$').exec(value);
  if (exact) return exact[1].trim();
  return value.replace(/^\d+\s*(?:\t+|\s{2,}|[|:?.?\-??])\s*/, '').trim();
}

function parseCliLineTranslations(raw, inputEntries, provider, config = {}) {
  const cleaned = stripJsonFence(raw).replace(/\r/g, '').trim();
  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  const expected = new Set((inputEntries || []).map((entry) => Number(entry.index)));
  const byIndex = new Map();

  lines.forEach((line) => {
    const match = /^(\d+)\s*(?:\t+|\s{2,}|[|:?.?\-??])\s*(.+)$/.exec(line);
    if (!match) return;
    const index = Number(match[1]);
    const translated = normalizeLlmContent(match[2] || '').replace(/\s+/g, ' ').trim();
    if (expected.has(index) && translated) {
      assertNoCjkInVietnameseTranslation(translated, config, provider, `cue index ${index}`);
      byIndex.set(index, translated);
    }
  });

  if (byIndex.size !== inputEntries.length && lines.length === inputEntries.length) {
    byIndex.clear();
    inputEntries.forEach((entry, index) => {
      const translated = normalizeLlmContent(stripCliLinePrefix(lines[index], entry.index)).replace(/\s+/g, ' ').trim();
      if (translated) {
        assertNoCjkInVietnameseTranslation(translated, config, provider, `cue index ${entry.index}`);
        byIndex.set(Number(entry.index), translated);
      }
    });
  }

  if (byIndex.size !== inputEntries.length) {
    throw new Error(provider + ' returned ' + byIndex.size + ' line(s) for ' + inputEntries.length + ' input cues.');
  }

  return inputEntries.map((entry) => ({
    ...entry,
    text: byIndex.get(Number(entry.index)),
  }));
}

function segmentsToSrt(segments) {
  return formatSrtEntries(
    (segments || []).map((segment, index) => ({
      index: index + 1,
      start: Number(segment.start) || 0,
      end: Number(segment.end) || ((Number(segment.start) || 0) + (Number(segment.duration) || 0.8)),
      text: normalizeLlmContent(segment.text),
    }))
  );
}

function srtEntriesToSegments(entries, template = {}) {
  const {
    text: _text,
    translatedText: _translatedText,
    originalText: _originalText,
    sourceText: _sourceText,
    id: _id,
    index: _index,
    start: _start,
    end: _end,
    duration: _duration,
    ...sharedMeta
  } = template || {};

  return (entries || []).map((entry, index) => ({
    ...sharedMeta,
    index,
    start: Number(entry.start) || 0,
    end: Number(entry.end) || ((Number(entry.start) || 0) + 0.8),
    duration: Number(Math.max(0.1, (Number(entry.end) || 0) - (Number(entry.start) || 0)).toFixed(3)),
    text: normalizeLlmContent(entry.text),
    translatedText: normalizeLlmContent(entry.text),
  }));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Math.min(items.length || 1, Math.round(Number(concurrency) || 1)));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function assertSameSrtShape(inputEntries, outputEntries, label) {
  if (inputEntries.length !== outputEntries.length) {
    throw new Error(`${label} returned ${outputEntries.length} cues for ${inputEntries.length} input cues.`);
  }

  inputEntries.forEach((entry, index) => {
    const translated = outputEntries[index];
    const sameStart = Math.abs((Number(entry.start) || 0) - (Number(translated.start) || 0)) < 0.001;
    const sameEnd = Math.abs((Number(entry.end) || 0) - (Number(translated.end) || 0)) < 0.001;
    if (!sameStart || !sameEnd) {
      throw new Error(`${label} changed timestamps at cue ${index + 1}.`);
    }
  });
}

async function translateSegmentsWithCli(segments, config) {
  const entries = parseSrtEntries(segmentsToSrt(segments));
  if (!entries.length) {
    throw new Error('Cannot translate an empty subtitle list with CLI.');
  }

  const provider = String(config.translationProvider || '').trim().toLowerCase();
  const isAntigravity = provider === 'antigravity_cli';
  const requestedChunkSize = Math.max(5, Math.min(40, Number(config.cliTranslationChunkSize) || Number(process.env.DUBFLOW_CLI_TRANSLATION_CHUNK_SIZE) || 12));
  const longJobChunkCap = entries.length >= 80 ? 12 : entries.length >= 40 ? 16 : 24;
  const chunkSize = isAntigravity
    ? Math.min(25, requestedChunkSize)
    : Math.min(requestedChunkSize, longJobChunkCap);
  const chunks = chunkArray(entries, chunkSize);
  const requestedConcurrency = Math.max(1, Math.min(5, Number(config.cliTranslationConcurrency) || Number(process.env.DUBFLOW_CLI_TRANSLATION_CONCURRENCY) || 3));
  const concurrency = isAntigravity ? Math.min(2, requestedConcurrency) : Math.min(3, requestedConcurrency);
  const systemPrompt = isAntigravity ? buildCliLineSystemPrompt() : buildCliJsonSystemPrompt();
  console.log('[translate] CLI translation:', entries.length + ' lines, chunks=' + chunks.length + ', chunk=' + chunkSize + ', concurrency=' + concurrency + ', mode=' + (isAntigravity ? 'lines' : 'json'));
  const progress = typeof config.translationProgress === 'function'
    ? config.translationProgress
    : async () => {};
  await progress({ type: 'start', totalLines: entries.length, totalChunks: chunks.length, chunkSize, concurrency });

  const translatedChunks = await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const previous = index > 0 ? chunks[index - 1].slice(-3) : [];
    await progress({ type: 'chunk_start', chunkIndex: index + 1, totalChunks: chunks.length, lineCount: chunk.length });
    try {
      const result = await translateCliEntryChunk({
        chunk,
        previous,
        config,
        systemPrompt,
      });
      await progress({ type: 'chunk_done', chunkIndex: index + 1, totalChunks: chunks.length, lineCount: chunk.length });
      return result;
    } catch (error) {
      await progress({ type: 'chunk_error', chunkIndex: index + 1, totalChunks: chunks.length, error: error.message || String(error) });
      throw error;
    }
  });
  const translatedEntries = translatedChunks.flat();

  assertSameSrtShape(entries, translatedEntries, config.translationProvider);
  const mappedEntries = translatedEntries.map((entry, index) => {
    const source = segments[index] || {};
    const translatedText = normalizeLlmContent(entry.text);
    return {
      ...source,
      originalText: source.text,
      translatedText,
      text: translatedText,
    };
  });
  return adaptTranslationsForTtsTiming(mappedEntries, config);
}

async function translateCliEntryChunk({
  chunk,
  previous,
  config,
  systemPrompt,
  depth = 0,
}) {
  const provider = String(config.translationProvider || '').trim().toLowerCase();
  const timeoutMs = Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000);
  const attempts = depth === 0 ? 2 : 1;
  const errors = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const isAntigravity = provider === 'antigravity_cli';
      const userPrompt = isAntigravity
        ? buildCliLineUserPrompt({
          chunkLines: formatCliLineEntries(chunk),
          overlapLines: previous.length ? formatCliLineEntries(previous) : '',
          sourceLanguage: config.sourceLanguage,
          targetLanguage: config.targetLanguage,
          videoContext: [config.autoContext, config.userContext].filter(Boolean).join('\n\n'),
          customGlossary: config.customGlossary,
          expectedCueCount: chunk.length,
          retryNote: errors.length ? errors[errors.length - 1] : '',
        })
        : buildCliJsonUserPrompt({
          chunkJson: formatCliJsonEntries(chunk, config),
          overlapJson: previous.length ? formatCliJsonEntries(previous, config) : '',
          sourceLanguage: config.sourceLanguage,
          targetLanguage: config.targetLanguage,
          videoContext: [config.autoContext, config.userContext].filter(Boolean).join('\n\n'),
          customGlossary: config.customGlossary,
          expectedCueCount: chunk.length,
          retryNote: errors.length ? errors[errors.length - 1] : '',
        });
      const raw = await runCliTranslation(provider, {
        systemPrompt,
        userPrompt,
        timeoutMs,
        model: config.cliTranslationModel,
      });
      const translated = isAntigravity
        ? parseCliLineTranslations(raw, chunk, provider, config)
        : parseCliJsonTranslations(raw, chunk, provider, config);
      const clipped = findClippedTranslationEntries(chunk, translated, config);
      if (clipped.length && attempt < attempts - 1) {
        const indexes = clipped.slice(0, 6).map((item) => item.index).join(', ');
        throw new Error('Possible clipped translation at index(es) ' + indexes + '. Translate every source clause completely; do not shorten for timing.');
      }
      return translated;
    } catch (error) {
      errors.push(error.message || String(error));
      if (attempt < attempts - 1) {
        await sleep(1200);
      }
    }
  }

  if (chunk.length > 5 && depth < 3) {
    const mid = Math.ceil(chunk.length / 2);
    const firstChunk = chunk.slice(0, mid);
    const secondChunk = chunk.slice(mid);
    const first = await translateCliEntryChunk({
      chunk: firstChunk,
      previous,
      config,
      systemPrompt,
      depth: depth + 1,
    });
    const second = await translateCliEntryChunk({
      chunk: secondChunk,
      previous: chunk.slice(Math.max(0, mid - 3), mid),
      config,
      systemPrompt,
      depth: depth + 1,
    });
    return [...first, ...second];
  }

  throw new Error(errors[errors.length - 1] || provider + ' failed to return valid translation lines.');
}

function describeCliTranslationProvider(provider) {
  switch (String(provider || '').trim().toLowerCase()) {
    case 'codex_cli':
      return 'Codex CLI';
    case 'antigravity_cli':
      return 'Antigravity CLI';
    default:
      return 'CLI';
  }
}

function buildCliJsonSystemPrompt() {
  return `Use the subtitle-translation-prompt skill included in the task prompt.
Return exactly one valid JSON array and no markdown.`;
}

function buildCliLineSystemPrompt() {
  return `Use the subtitle-translation-prompt skill included in the task prompt.
Return exactly the requested indexed text lines and no markdown.`;
}

function buildCliSrtSystemPrompt() {
  return `Use the subtitle-translation-prompt skill included in the task prompt.
Return valid SRT only and no markdown.`;
}

function parseJsonPromptPayload(value, fallback = []) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function buildCliJsonUserPrompt({
  chunkJson,
  overlapJson,
  sourceLanguage,
  targetLanguage,
  videoContext,
  customGlossary,
  expectedCueCount,
  retryNote,
}) {
  const overlapBlock = overlapJson
    ? 'Reference context from previous cues. Do not translate these again:\n' + overlapJson
    : '';

  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'Translate this CLI JSON subtitle chunk using the skill. Preserve row indexes and return only the parser-safe JSON shape.',
    input: {
      items: parseJsonPromptPayload(chunkJson, []),
      expectedCueCount: Number(expectedCueCount) || undefined,
      previousContext: overlapJson ? parseJsonPromptPayload(overlapJson, overlapJson) : undefined,
    },
    sourceLanguage: sourceLanguage || 'auto',
    targetLanguage: targetLanguage || 'vi',
    context: [videoContext, overlapBlock].filter(Boolean).join('\n\n'),
    glossary: customGlossary || '',
    retry: retryNote ? { errors: [retryNote], output: null } : null,
    outputContract: [
      `Return exactly ${Number(expectedCueCount) || 'the same number of'} JSON object(s).`,
      'Output JSON array only, no markdown, no explanation.',
      'Each object must be {"index": original index, "text": translated subtitle text}.',
      'Do not output duration, start, end, timestamp, source text, or extra fields.',
    ].join('\n'),
  });
}

function buildCliLineUserPrompt({
  chunkLines,
  overlapLines,
  sourceLanguage,
  targetLanguage,
  videoContext,
  customGlossary,
  expectedCueCount,
  retryNote,
}) {
  const overlapBlock = overlapLines
    ? 'Reference context from previous lines. Do not translate these again:\n' + overlapLines
    : '';

  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'Translate this CLI indexed-line subtitle chunk using the skill. Preserve row indexes and return only parser-safe indexed lines.',
    input: {
      lines: chunkLines,
      expectedCueCount: Number(expectedCueCount) || undefined,
      previousContextLines: overlapLines || undefined,
    },
    sourceLanguage: sourceLanguage || 'auto',
    targetLanguage: targetLanguage || 'vi',
    context: [videoContext, overlapBlock].filter(Boolean).join('\n\n'),
    glossary: customGlossary || '',
    retry: retryNote ? { errors: [retryNote], output: null } : null,
    outputContract: [
      `Return exactly ${Number(expectedCueCount) || 'the same number of'} line(s).`,
      'Each output line format must be: original_index<TAB>translated text.',
      'Keep the same indexes from the input.',
      'No JSON, no SRT, no markdown, no explanation.',
      'Do not add line breaks inside a translation.',
    ].join('\n'),
  });
}

function buildCliSrtUserPrompt({
  chunkSrt,
  overlapSrt,
  sourceLanguage,
  targetLanguage,
  videoContext,
  customGlossary,
  expectedCueCount,
  retryNote,
}) {
  const overlapBlock = overlapSrt
    ? `REFERENCE CONTEXT FROM PREVIOUS CUES - DO NOT TRANSLATE THESE AGAIN:\n${overlapSrt}\n\n`
    : '';

  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'Translate this SRT subtitle chunk using the skill. Preserve the SRT cue structure exactly.',
    input: {
      srt: chunkSrt,
      expectedCueCount: Number(expectedCueCount) || undefined,
      previousContextSrt: overlapSrt || undefined,
    },
    sourceLanguage: sourceLanguage || 'auto',
    targetLanguage: targetLanguage || 'vi',
    context: [videoContext, overlapBlock].filter(Boolean).join('\n\n'),
    glossary: customGlossary || '',
    retry: retryNote ? { errors: [retryNote], output: null } : null,
    outputContract: [
      `The input block contains exactly ${Number(expectedCueCount) || 'the same number of'} subtitle cue(s).`,
      `Your output must contain exactly ${Number(expectedCueCount) || 'the same number of'} subtitle cue(s).`,
      'Keep every cue number and timestamp line exactly as provided.',
      'Only replace the subtitle text inside each cue.',
      'One input cue must remain one output cue.',
      'Do not omit, merge, split, summarize, or reorder cues.',
      'Return SRT only.',
    ].join('\n'),
  });
}

function buildContextAnalysisPrompt({ sourceLanguage, targetLanguage, title, transcript }) {
  return {
    system: `Use the subtitle-translation-prompt skill included in the task prompt for subtitle translation context analysis.
Return exactly one JSON object and no markdown.
Extract only domain context, terminology, names, and translation warnings that will help the later subtitle translation step.`,
    user: buildSkillTaskPrompt({
      skillName: 'subtitle-translation-prompt',
      task: 'Analyze subtitle translation context using the skill. Do not translate the transcript; extract only context that helps later subtitle translation.',
      input: {
        title: title || '',
        transcript: transcript || '',
      },
      sourceLanguage: sourceLanguage || 'auto',
      targetLanguage: targetLanguage || 'vi',
      outputContract: `Return JSON object only:
{
  "detected_domain": "",
  "summary_context": "",
  "tone_style": "",
  "key_terms": [
    {
      "source": "",
      "suggested_translation": "",
      "note": ""
    }
  ],
  "do_not_translate": [],
  "names_entities": [],
  "translation_warnings": [],
  "recommended_context_prompt": ""
}`,
    }),
  };
}

function extractFirstJsonObject(text) {
  const value = String(text || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;

    if (depth === 0) {
      return value.slice(start, index + 1);
    }
  }

  return value;
}

function parseJsonObject(text) {
  const jsonText = extractFirstJsonObject(text);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Context analysis did not return valid JSON: ${error.message}`);
  }
}
async function analyzeTranslationContext(input, config) {
  const provider = String(config.translationProvider || '').trim().toLowerCase();
  if (!isCliTranslationProvider(provider)) {
    throw new Error(`Unsupported translation provider: ${config.translationProvider || 'unknown'}`);
  }
  const prompt = buildContextAnalysisPrompt(input);
  const rawText = await runCliTranslation(provider, {
    systemPrompt: `${prompt.system}\nReturn only one valid JSON object.`,
    userPrompt: prompt.user,
    timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
    model: config.cliTranslationModel,
  });
  return parseJsonObject(rawText);
}

async function translateSegments(segments, config) {
  const faithfulConfig = {
    ...config,
    allowTextShortening: false,
    ttsTimingRewrite: false,
    translationTimingRewriteMaxPasses: 0,
  };
  if (isCliTranslationProvider(faithfulConfig.translationProvider)) {
    try {
      return await translateSegmentsWithCli(segments, faithfulConfig);
    } catch (error) {
      throw new Error(`${describeCliTranslationProvider(faithfulConfig.translationProvider)} translation failed: ${error.message}`);
    }
  }

  throw new Error(`Unsupported translation provider: ${faithfulConfig.translationProvider || 'unknown'}`);
}

module.exports = {
  translateSegments,
  analyzeTranslationContext,
  parseSrtEntries,
  formatSrtEntries,
  segmentsToSrt,
  srtEntriesToSegments,
  getDubbingTimingBudget,
  getTimingFitStatus,
  targetTtsRateForTranslation,
  buildCliSrtSystemPrompt,
  buildCliSrtUserPrompt,
  buildCliJsonSystemPrompt,
  buildCliJsonUserPrompt,
  buildCliLineSystemPrompt,
  buildCliLineUserPrompt,
  formatCliJsonEntries,
  formatCliLineEntries,
  translationCompletenessRisk,
  findClippedTranslationEntries,
  parseCliJsonTranslations,
  parseCliLineTranslations,
  assertSameSrtShape,
};










