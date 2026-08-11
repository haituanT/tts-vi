const { isCliTranslationProvider, runCliTranslation } = require('./cliTranslationService');
const { buildSkillTaskPrompt } = require('./skillPromptService');
const { cleanText, extractJsonObject } = require('../domain/storyTranslation');
const {
  containsCjkUnifiedIdeograph,
  containsKnownCorruptTranslationArtifact,
  containsReplacementCharacter,
  repairCommonReplacementCharacters,
} = require('./textEncodingRepair');

const REPAIR_SYSTEM_PROMPT = `Use the provided subtitle-tts-overflow-repair skill.
Start from current_translation and preserve its meaning, facts, names, numbers, and structure.
Do not use overflow seconds, fit ratios, or any timing threshold to make the edit more aggressive.
First remove non-numeric commas and clearly redundant/filler words.
Then replace a word or short phrase only when a shorter natural synonym preserves exactly the same meaning.
It is fine for a repaired line to be only slightly shorter than the current translation; do not force a large cut.
If needed, retranslate only the smallest long phrase that causes overflow; do not rewrite the entire sentence merely because it is long.
Do not over-shorten into a dry summary: preserve the same complete narration beat, scene/detail, emphasis, and outcome.
Proper names are locked display text. Preserve every name exactly as written in current_translation/glossary/title/context; never remove, translate, Vietnamese-ize, phoneticize, respell, abbreviate, join, or split it.
Do not delete a separate source detail just to shorten the line.
Return exactly one valid JSON array and no markdown.`;

const DEFAULT_REPAIR_BATCH_SIZE = 4;
const DEFAULT_REPAIR_CONCURRENCY = 2;
const MAX_REPAIR_BATCH_SIZE = 200;
const TTS_OVERFLOW_REPAIR_PROMPT_VERSION = 'minimal-phrase-shortening-v7-name-lock';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function roundMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function stripJsonFence(value) {
  return String(value || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function extractJsonArray(value) {
  const text = stripJsonFence(value);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  const object = extractJsonObject(text);
  const items = object.repairs || object.results || object.items;
  if (Array.isArray(items)) return items;
  throw new Error('TTS overflow repair model did not return a JSON array.');
}

function isVietnameseTarget(config = {}) {
  const target = String(config.targetLanguage || 'vi').trim().toLowerCase();
  return target === 'vi' || target.startsWith('vi-') || target === 'vietnamese';
}

function repairEditHint() {
  return 'conservative_text_repair: ignore overflow amounts and thresholds; use the same minimal edit order for every selected line.';
}

function normalizeRepairPunctuation(text = '', config = {}) {
  let output = normalizeText(text)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:]){2,}/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!isVietnameseTarget(config)) return output;

  output = output
    .replace(/\b(doi nhien|dot nhien|bong nhien|sau do|luc nay|khi do|vi vay|do do|cuoi cung|ket qua la),\s+/gi, '$1 ')
    .replace(/\b(đột nhiên|bỗng nhiên|sau đó|lúc này|khi đó|vì vậy|do đó|cuối cùng|kết quả là),\s+/gi, '$1 ')
    .replace(/,\s+(va|và|roi|rồi|nen|nên|nhung|nhưng|thi|thì|ma|mà|de|để|khi)\b/gi, ' $1')
    .replace(/,\s+(phia|phía|dang|đằng|ben|bên|sau|truoc|trước)\b/gi, ' $1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const chars = Array.from(output);
  output = chars.map((char, index) => {
    if (char !== ',') return char;
    const prev = chars[index - 1] || '';
    const next = chars[index + 1] || '';
    if (/\d/.test(prev) && /\d/.test(next)) return char;
    return ' ';
  }).join('');

  return output
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeRepairInput(items = []) {
  return (items || [])
    .map((item, index) => {
      const rowId = normalizeText(item.row_id || item.rowId || item.id || `row-${index + 1}`);
      const currentTranslation = repairCommonReplacementCharacters(cleanText(item.current_translation || item.currentTranslation || item.currentText || item.text));
      const slotSeconds = roundMetric(item.slot_seconds ?? item.slotSeconds ?? item.duration);
      const audioSeconds = roundMetric(item.audio_seconds ?? item.audioSeconds ?? 0);
      const overflowSeconds = roundMetric(item.overflow_seconds ?? item.overflowSeconds ?? Math.max(0, audioSeconds - slotSeconds));
      const fitRatio = roundMetric(item.fit_ratio ?? item.fitRatio ?? (slotSeconds > 0 ? audioSeconds / slotSeconds : 0));
      return {
        row_id: rowId,
        source_text: repairCommonReplacementCharacters(cleanText(item.source_text || item.sourceText || item.originalText || '')),
        current_translation: currentTranslation,
        previous_translation: repairCommonReplacementCharacters(cleanText(item.previous_translation || item.previousTranslation || '')),
        next_translation: repairCommonReplacementCharacters(cleanText(item.next_translation || item.nextTranslation || '')),
        slot_seconds: slotSeconds,
        audio_seconds: audioSeconds,
        overflow_seconds: overflowSeconds,
        fit_ratio: fitRatio,
        target_tts_rate: roundMetric(item.target_tts_rate ?? item.targetTtsRate ?? 1) || 1,
        repair_hint: repairEditHint(),
        error_reason: normalizeText(item.error_reason || item.errorReason || ''),
      };
    })
    .filter((item) => item.row_id && item.current_translation);
}

function buildRepairPrompt(items = [], config = {}) {
  const sourceLanguage = String(config.sourceLanguage || 'auto').trim() || 'auto';
  const targetLanguage = String(config.targetLanguage || 'vi').trim() || 'vi';
  const repairInstructions = `Repair mode:
- Read source_text first as the meaning authority and current_translation as the wording/style reference.
- Start from current_translation and make the smallest useful edit; do not create a fresh summary.
- Ignore overflow seconds, fit ratio, and every timing threshold when deciding how much to edit.
- Do not use any hard character-count target.
- Repair order: first remove every non-numeric comma/pause, then delete clearly redundant filler/repeated words, then replace one long word/short phrase with a shorter equivalent.
- A small improvement is enough: shortening one word or one short phrase is valid when it makes the line easier for TTS. Do not force a large cut.
- If that is still not enough, retranslate only the smallest long phrase. Do not retranslate the whole line merely because it is long.
- Do not over-shorten into a dry summary. Preserve the same complete narration beat, scene/detail, emphasis, and outcome.
- Proper names are locked display text. Preserve every name exactly as written in current_translation/glossary/title/context; never remove, translate, Vietnamese-ize, phoneticize, respell, abbreviate, join, or split it.
- Treat commas as TTS pauses. Vietnamese repaired lines must contain no non-numeric commas.
- Do not add new commas.
- Do not delete a separate fact, action, result, negation, place, number, or vivid detail from source_text. If exact fit is impossible without losing meaning, keep a slightly longer but complete line.
- Before returning each row, verify that every source detail remains present or naturally implied and keep the repaired line close to current_translation.`;
  const context = [
    repairInstructions,
    config.autoContext,
    config.userContext,
    config.videoContext,
  ].filter(Boolean).join('\n\n');
  const promptItems = items.map((item) => ({
    row_id: item.row_id,
    source_text: item.source_text,
    current_translation: item.current_translation,
    previous_translation: item.previous_translation,
    next_translation: item.next_translation,
  }));
  return buildSkillTaskPrompt({
    skillName: 'subtitle-tts-overflow-repair',
    task: 'Conservatively repair subtitle/TTS rows: remove non-numeric commas and filler first, then use shorter synonyms or retranslate only a long phrase when needed. Keep a complete narration beat and preserve every locked proper name exactly. Do not rewrite the whole sentence.',
    input: promptItems,
    sourceLanguage,
    targetLanguage,
    context,
    glossary: config.customGlossary || '',
    outputContract: `Return JSON array only. Each item must be:
{"row_id":"same id","repaired_translation":"minimally edited subtitle/TTS line"}`,
  });
}

function parseRepairOutput(rawText, inputItems = [], provider = 'model', config = {}) {
  const parsed = extractJsonArray(rawText);
  if (!Array.isArray(parsed)) {
    throw new Error(`${provider} returned non-array TTS repair output.`);
  }

  const expectedIds = inputItems.map((item) => String(item.row_id));
  const expectedSet = new Set(expectedIds);
  const byId = new Map();
  const unexpected = [];
  const corrupt = [];
  const corruptArtifacts = [];
  const cjkRows = [];
  const rejectCjk = isVietnameseTarget(config);

  parsed.forEach((item) => {
    const rowId = String(item?.row_id ?? '').trim();
    const repaired = normalizeRepairPunctuation(
      repairCommonReplacementCharacters(cleanText(item?.repaired_translation || '')),
      config
    );
    if (!expectedSet.has(rowId)) {
      unexpected.push(rowId || '(missing row_id)');
      return;
    }
    if (!repaired) return;
    if (containsReplacementCharacter(repaired)) {
      corrupt.push(rowId);
      return;
    }
    if (containsKnownCorruptTranslationArtifact(repaired)) {
      corruptArtifacts.push(rowId);
      return;
    }
    if (rejectCjk && containsCjkUnifiedIdeograph(repaired)) {
      cjkRows.push(rowId);
      return;
    }
    byId.set(rowId, repaired);
  });

  if (unexpected.length) {
    throw new Error(`${provider} returned unexpected TTS repair row(s): ${unexpected.join(', ')}.`);
  }
  if (corrupt.length) {
    throw new Error(`${provider} returned corrupt replacement character(s) in TTS repair row(s): ${corrupt.join(', ')}.`);
  }
  if (corruptArtifacts.length) {
    throw new Error(`${provider} returned corrupt unit-replacement artifact(s) in TTS repair row(s): ${corruptArtifacts.join(', ')}.`);
  }
  if (cjkRows.length) {
    throw new Error(`${provider} returned Chinese Han/Hanzi/Kanji character(s) in Vietnamese TTS repair row(s): ${cjkRows.join(', ')}.`);
  }
  const missing = expectedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`${provider} missed TTS repair row(s): ${missing.join(', ')}.`);
  }

  return expectedIds.map((rowId) => ({
    row_id: rowId,
    repaired_translation: byId.get(rowId),
  }));
}

function chunkItems(items = [], size = 1) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(items = [], concurrency = 1, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function repairTtsOverflowTranslations(items = [], config = {}, deps = {}) {
  const input = normalizeRepairInput(items);
  if (!input.length) {
    throw new Error('No TTS overflow repair items are available.');
  }

  const provider = String(config.translationProvider || 'codex_cli').trim().toLowerCase();
  if (!isCliTranslationProvider(provider)) {
    throw new Error(`Unsupported TTS overflow repair provider: ${config.translationProvider || 'unknown'}`);
  }
  const runner = deps.runCliTranslation || runCliTranslation;
  const requestedSingleRequest = config.ttsOverflowRepairSingleRequest === true;
  const requestedBatchSize = requestedSingleRequest
    ? input.length
    : (Number(config.ttsOverflowRepairBatchSize || process.env.DUBFLOW_TTS_OVERFLOW_REPAIR_BATCH_SIZE || DEFAULT_REPAIR_BATCH_SIZE) || DEFAULT_REPAIR_BATCH_SIZE);
  const batchSize = Math.max(1, Math.min(
    MAX_REPAIR_BATCH_SIZE,
    input.length,
    requestedBatchSize
  ));
  const batches = chunkItems(input, batchSize);
  const concurrency = Math.max(1, Math.min(
    batches.length || 1,
    8,
    Number(
      config.ttsOverflowRepairConcurrency
      ?? config.cliTranslationConcurrency
      ?? config.subtitleGroupConcurrency
      ?? process.env.DUBFLOW_TTS_OVERFLOW_REPAIR_CONCURRENCY
      ?? DEFAULT_REPAIR_CONCURRENCY
    ) || DEFAULT_REPAIR_CONCURRENCY
  ));
  const batchRepairs = await mapWithConcurrency(batches, concurrency, async (batch) => {
    const raw = await runner(provider, {
      systemPrompt: REPAIR_SYSTEM_PROMPT,
      userPrompt: buildRepairPrompt(batch, config),
      timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
      model: config.cliTranslationModel,
    });
    return parseRepairOutput(raw, batch, provider, config);
  });
  const repairs = batchRepairs.flat();
  const byId = new Map(repairs.map((repair) => [repair.row_id, repair]));
  return input.map((item) => byId.get(item.row_id));
}

module.exports = {
  repairTtsOverflowTranslations,
  TTS_OVERFLOW_REPAIR_PROMPT_VERSION,
  _private: {
    buildRepairPrompt,
    extractJsonArray,
    chunkItems,
    mapWithConcurrency,
    normalizeRepairInput,
    normalizeRepairPunctuation,
    parseRepairOutput,
  },
};
