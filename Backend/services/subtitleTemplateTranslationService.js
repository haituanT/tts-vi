const { isCliTranslationProvider, runCliTranslation } = require('./cliTranslationService');
const { buildSkillTaskPrompt } = require('./skillPromptService');
const {
  containsReplacementCharacter,
  containsCjkUnifiedIdeograph,
  containsKnownCorruptTranslationArtifact,
  repairCommonReplacementCharacters,
} = require('./textEncodingRepair');
const { verbalizeVietnameseDubbingText } = require('./vietnameseNumberText');
const { cleanText, extractJsonObject } = require('../domain/storyTranslation');

const DEFAULT_CHUNK_SIZE = 24;
const MAX_CHUNK_SIZE = 40;
const DEFAULT_CONTEXT_GROUPS = 3;

const TEMPLATE_TRANSLATION_SYSTEM_PROMPT = `Use the provided subtitle-translation-prompt skill.
Return exactly one valid JSON array and no markdown.`;

function normalizeGroupId(segment = {}, index = 0) {
  return String(segment.groupId || segment.group_id || segment.id || index + 1).trim();
}

function normalizeTemplateInput(segments = []) {
  return (segments || [])
    .map((segment, index) => {
      const originalCueText = Array.isArray(segment.originalCues)
        ? segment.originalCues.map((cue) => cue?.text).filter(Boolean).join(' ')
        : '';
      const preferredText = repairCommonReplacementCharacters(cleanText(segment.text || segment.sourceText || segment.originalText));
      const fallbackText = repairCommonReplacementCharacters(cleanText(originalCueText || segment.originalText || segment.sourceText || segment.text));
      return {
        ...segment,
        group_id: normalizeGroupId(segment, index),
        text: containsReplacementCharacter(preferredText) && fallbackText
          ? fallbackText
          : preferredText,
      };
    })
    .filter((segment) => segment.group_id && segment.text);
}

function translationContextGroupCount(config = {}) {
  const requested = Number(config.translationChunkContextGroups ?? process.env.DUBFLOW_TRANSLATION_CHUNK_CONTEXT_GROUPS ?? DEFAULT_CONTEXT_GROUPS);
  if (!Number.isFinite(requested)) return DEFAULT_CONTEXT_GROUPS;
  return Math.max(0, Math.min(5, Math.round(requested)));
}

function promptGroupItem(segment = {}) {
  return {
    group_id: segment.group_id,
    text: segment.text,
  };
}

function buildChunkWindows(input = [], chunkSize = DEFAULT_CHUNK_SIZE, config = {}) {
  const windows = [];
  const contextSize = translationContextGroupCount(config);
  const normalizedChunkSize = Math.max(1, Math.round(Number(chunkSize) || DEFAULT_CHUNK_SIZE));
  for (let start = 0; start < input.length;) {
    let end = Math.min(input.length, start + normalizedChunkSize);
    const remainingAfterChunk = input.length - end;
    const minimumUsefulFinalChunk = Math.min(5, normalizedChunkSize);

    // Do not leave AGY (or any strict batch translator) with a tiny trailing
    // request. A 12+2 split is especially easy for a model to truncate or
    // mistake for context, so rebalance that tail into two useful batches.
    if (
      remainingAfterChunk > 0
      && remainingAfterChunk < minimumUsefulFinalChunk
      && input.length - start > normalizedChunkSize
    ) {
      end = start + Math.ceil((input.length - start) / 2);
    }

    windows.push({
      items: input.slice(start, end),
      contextBefore: input.slice(Math.max(0, start - contextSize), start),
      contextAfter: input.slice(end, Math.min(input.length, end + contextSize)),
    });
    start = end;
  }
  return windows;
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
  const items = object.results || object.translations || object.items;
  if (Array.isArray(items)) return items;
  throw new Error('Model did not return a JSON array.');
}

function isVietnameseTarget(config = {}) {
  const target = String(config.targetLanguage || 'vi').trim().toLowerCase();
  return target === 'vi' || target.startsWith('vi-') || target === 'vietnamese';
}

function buildTemplateTranslationPrompt(chunk, config = {}, repair = null, contextWindow = {}) {
  const payload = {
    context_before: (contextWindow.contextBefore || []).map(promptGroupItem),
    items_to_translate: chunk.map(promptGroupItem),
    context_after: (contextWindow.contextAfter || []).map(promptGroupItem),
  };
  const targetLanguage = String(config.targetLanguage || 'vi').trim() || 'vi';
  const sourceLanguage = String(config.sourceLanguage || 'auto').trim() || 'auto';

  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: `Translate only items_to_translate into ${targetLanguage} as continuous natural narration. Read context_before, items_to_translate, and context_after as one ordered passage before translating so the first and last translated items do not reset the story at chunk boundaries. Context groups are reference only: use them for pronouns, chronology, cause/effect, established names, tone, and transitions, but never output translations for context_before or context_after. Each translated item remains one subtitle line, but a line may continue naturally into the next item and is not required to be a complete sentence.`,
    input: payload,
    sourceLanguage,
    targetLanguage,
    context: [config.autoContext, config.userContext, config.videoContext].filter(Boolean).join('\n\n'),
    glossary: config.customGlossary || '',
    retry: repair,
    outputContract: `Return JSON array only for items_to_translate. Do not include context_before or context_after group IDs.
Return exactly ${chunk.length} objects: one and only one object for every items_to_translate group, including the final group.
Each item must be:
{"group_id":"same id","translation_merged":"translated subtitle line"}`,
  });
}

function parseTemplateTranslation(rawText, chunk, provider, config = {}) {
  const parsed = extractJsonArray(rawText);
  if (!Array.isArray(parsed)) {
    throw new Error(`${provider} returned non-array template translation output.`);
  }
  const expectedIds = new Set(chunk.map((segment) => String(segment.group_id)));
  const byId = new Map();
  const duplicateIds = [];
  const unexpectedIds = [];
  const corruptIds = [];
  const corruptArtifactIds = [];
  const cjkIds = [];
  const rejectCjk = isVietnameseTarget(config);
  parsed.forEach((item) => {
    const groupId = String(item?.group_id ?? item?.groupId ?? '').trim();
    const text = repairCommonReplacementCharacters(cleanText(item?.translation_merged || item?.translation || item?.text));
    if (!groupId) return;
    if (!expectedIds.has(groupId)) {
      unexpectedIds.push(groupId);
      return;
    }
    if (!text) return;
    if (byId.has(groupId)) {
      duplicateIds.push(groupId);
      return;
    }
    if (containsReplacementCharacter(text)) {
      corruptIds.push(groupId);
      return;
    }
    if (containsKnownCorruptTranslationArtifact(text)) {
      corruptArtifactIds.push(groupId);
      return;
    }
    if (rejectCjk && containsCjkUnifiedIdeograph(text)) {
      cjkIds.push(groupId);
      return;
    }
    byId.set(groupId, text);
  });
  if (unexpectedIds.length) {
    throw new Error(`${provider} returned unexpected template group(s): ${Array.from(new Set(unexpectedIds)).join(', ')}.`);
  }
  if (duplicateIds.length) {
    throw new Error(`${provider} returned duplicate template group(s): ${Array.from(new Set(duplicateIds)).join(', ')}.`);
  }
  if (corruptIds.length) {
    throw new Error(`${provider} returned corrupt replacement character(s) in template group(s): ${corruptIds.join(', ')}.`);
  }
  if (corruptArtifactIds.length) {
    throw new Error(`${provider} returned corrupt unit-replacement artifact(s) in template group(s): ${corruptArtifactIds.join(', ')}.`);
  }
  if (cjkIds.length) {
    throw new Error(`${provider} returned Chinese Han/Hanzi/Kanji character(s) in Vietnamese template group(s): ${cjkIds.join(', ')}.`);
  }
  const missing = chunk.map((segment) => String(segment.group_id)).filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`${provider} missed template group(s): ${missing.join(', ')}.`);
  }
  return chunk.map((segment) => ({
    group_id: segment.group_id,
    translation_merged: byId.get(String(segment.group_id)),
  }));
}

function normalizeVietnameseOutput(text = '', config = {}) {
  const cleaned = repairCommonReplacementCharacters(cleanText(text));
  if (!cleaned) return '';
  const output = isVietnameseTarget(config)
    ? verbalizeVietnameseDubbingText(cleaned)
    : cleaned;
  return repairCommonReplacementCharacters(output);
}

async function translateChunk(chunk, config, repair = null, contextWindow = {}) {
  const provider = String(config.translationProvider || 'codex_cli').trim().toLowerCase();
  if (!isCliTranslationProvider(provider)) {
    throw new Error(`Unsupported template translation provider: ${config.translationProvider || 'unknown'}`);
  }
  const raw = await runCliTranslation(provider, {
    systemPrompt: TEMPLATE_TRANSLATION_SYSTEM_PROMPT,
    userPrompt: buildTemplateTranslationPrompt(chunk, config, repair, contextWindow),
    timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
    model: config.cliTranslationModel,
  });
  return parseTemplateTranslation(raw, chunk, provider, config);
}

async function mapWithConcurrency(items = [], concurrency = 1, mapper = async () => {}) {
  const limit = Math.max(1, Math.min(items.length || 1, Math.round(Number(concurrency) || 1)));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function translateTemplateGroups(segments = [], config = {}) {
  const input = normalizeTemplateInput(segments);
  if (!input.length) {
    throw new Error('No template groups are available for translation.');
  }

  const requestedChunkSize = Number(config.cliTranslationChunkSize) || Number(process.env.DUBFLOW_CLI_TRANSLATION_CHUNK_SIZE) || DEFAULT_CHUNK_SIZE;
  const chunkSize = Math.max(5, Math.min(MAX_CHUNK_SIZE, Math.round(requestedChunkSize)));
  const chunks = buildChunkWindows(input, chunkSize, config);

  const progress = typeof config.translationProgress === 'function' ? config.translationProgress : async () => {};
  const requestedConcurrency = Math.max(1, Math.min(5, Math.round(Number(config.cliTranslationConcurrency) || Number(process.env.DUBFLOW_CLI_TRANSLATION_CONCURRENCY) || 3)));
  const provider = String(config.translationProvider || '').trim().toLowerCase();
  const concurrency = provider === 'antigravity_cli' ? Math.min(2, requestedConcurrency) : Math.min(3, requestedConcurrency);
  await progress({ type: 'start', totalLines: input.length, totalChunks: chunks.length, chunkSize, concurrency });

  const translatedChunks = await mapWithConcurrency(chunks, concurrency, async (chunkWindow, chunkIndex) => {
    const chunk = chunkWindow.items || [];
    await progress({ type: 'chunk_start', chunkIndex: chunkIndex + 1, totalChunks: chunks.length, lineCount: chunk.length });
    let repair = null;
    let chunkResult = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        chunkResult = await translateChunk(chunk, config, repair, chunkWindow);
        break;
      } catch (error) {
        repair = {
          errors: [error.message || String(error)],
          output: null,
        };
        if (attempt >= 1) throw error;
      }
    }
    await progress({ type: 'chunk_done', chunkIndex: chunkIndex + 1, totalChunks: chunks.length, lineCount: chunk.length });
    return chunkResult;
  });
  const translated = translatedChunks.flat();

  const byId = new Map(translated.map((item) => [String(item.group_id), item.translation_merged]));
  return input.map((segment) => {
    const translatedText = normalizeVietnameseOutput(byId.get(String(segment.group_id)), config);
    return {
      ...segment,
      originalText: segment.text,
      translatedText,
      finalText: translatedText,
      text: translatedText,
      ttsText: translatedText,
      translationMerged: translatedText,
      translationMode: 'template_group_merged',
    };
  });
}

function isTemplateGroupSegment(segment = {}) {
  return segment.templateGroupCreatedBy === 'ai_grouping'
    || Array.isArray(segment.originalCues)
    || String(segment.id || '').startsWith('template-');
}

function shouldUseTemplateGroupTranslation(segments = [], config = {}) {
  if (config.templateGroupTranslation === true) return true;
  if (!segments.length) return false;
  const templateCount = segments.filter(isTemplateGroupSegment).length;
  return templateCount > 0 && templateCount === segments.length;
}

module.exports = {
  translateTemplateGroups,
  shouldUseTemplateGroupTranslation,
  _private: {
    buildTemplateTranslationPrompt,
    buildChunkWindows,
    isVietnameseTarget,
    parseTemplateTranslation,
  },
};
