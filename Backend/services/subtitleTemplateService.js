const path = require('path');
const { isCliTranslationProvider, runCliTranslation } = require('./cliTranslationService');
const { buildSkillTaskPrompt } = require('./skillPromptService');
const { cleanText, extractJsonObject } = require('../domain/storyTranslation');

const DEFAULT_BATCH_SIZE = 60;
const MAX_BATCH_SIZE = 120;

const GROUP_SYSTEM_PROMPT = `Use the provided subtitle-cue-grouping skill.
Return exactly one valid JSON object and no markdown.
Return grouping decisions only: source_ids, confidence, reason, and pending_ids.
Do not return source_text, translation, timestamps, corrected text, or rewritten source text.`;

function normalizeLanguage(value, fallback = 'auto') {
  const raw = String(value || '').trim();
  return raw || fallback;
}

function compactCue(segment = {}, index = 0) {
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || start + Math.max(0.1, Number(segment.duration) || 0.8);
  const id = String(segment.id || segment.sourceId || `cue-${index + 1}`).trim() || `cue-${index + 1}`;
  return {
    id,
    index,
    start,
    end,
    text: cleanText(segment.text || segment.sourceText || segment.originalText),
  };
}

function normalizeSourceCues(segments = []) {
  return (segments || [])
    .map(compactCue)
    .filter((cue) => cue.text && cue.end > cue.start)
    .map((cue, index) => ({ ...cue, index }));
}

function buildGroupPrompt(cues, config = {}, repair = null, isFinalBatch = false) {
  const language = normalizeLanguage(config.subtitleGroupLanguage || config.sourceLanguage || 'auto');
  const payload = {
    source_language: language,
    target_language_for_later_translation: config.targetLanguage || 'vi',
    final_batch: isFinalBatch,
    cues: cues.map((cue) => ({
      id: cue.id,
      text: cue.text,
    })),
  };

  return buildSkillTaskPrompt({
    skillName: 'subtitle-cue-grouping',
    task: 'Group raw STT cues into short subtitle template groups. Return grouping decisions only; the system will join original cue text and map timing.',
    input: payload,
    sourceLanguage: language,
    targetLanguage: config.targetLanguage || 'vi',
    retry: repair,
    outputContract: `Return JSON object only:
{"language":"${language}","groups":[{"group_id":1,"source_ids":["cue-id"],"confidence":0.9,"reason":"short reason"}],"pending_ids":[]}
Forbidden fields: source_text, translation, translation_merged, timestamps, edited source text, corrected source text.`,
  });
}

function parseGroupOutput(rawText) {
  const parsed = extractJsonObject(rawText);
  return {
    language: cleanText(parsed.language),
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    pending_ids: Array.isArray(parsed.pending_ids) ? parsed.pending_ids.map((id) => String(id || '').trim()).filter(Boolean) : [],
  };
}

function idsAreConsecutive(ids = [], cueOrder = new Map()) {
  if (!ids.length) return false;
  const positions = ids.map((id) => cueOrder.get(String(id))).filter(Number.isInteger);
  if (positions.length !== ids.length) return false;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] !== positions[index - 1] + 1) return false;
  }
  return true;
}

function pendingIsSuffix(pendingIds = [], batchCues = []) {
  if (!pendingIds.length) return true;
  const pendingSet = new Set(pendingIds.map(String));
  const suffix = [];
  for (let index = batchCues.length - 1; index >= 0; index -= 1) {
    const id = String(batchCues[index].id);
    if (!pendingSet.has(id)) break;
    suffix.unshift(id);
  }
  return suffix.length === pendingIds.length && suffix.every((id, index) => id === pendingIds[index]);
}

function normalizeGroupResult(raw, batchCues, groupOffset = 0, isFinalBatch = false) {
  const cueById = new Map(batchCues.map((cue) => [String(cue.id), cue]));
  const cueOrder = new Map(batchCues.map((cue, index) => [String(cue.id), index]));
  const pendingIds = (isFinalBatch ? [] : raw.pending_ids).map(String).filter((id) => cueById.has(id));
  const errors = [];

  if (!pendingIsSuffix(pendingIds, batchCues)) {
    errors.push('pending_ids must be a suffix at the end of the batch.');
  }

  const pendingSet = new Set(pendingIds);
  const seen = new Set();
  const groups = [];
  for (const [index, item] of raw.groups.entries()) {
    const sourceIds = (Array.isArray(item.source_ids) ? item.source_ids : item.sourceIds || [])
      .map((id) => String(id || '').trim())
      .filter((id) => cueById.has(id) && !pendingSet.has(id));
    if (!sourceIds.length) {
      errors.push(`group ${index + 1} has no valid source_ids.`);
      continue;
    }
    if (!idsAreConsecutive(sourceIds, cueOrder)) {
      errors.push(`group ${index + 1} source_ids are not consecutive.`);
      continue;
    }
    const duplicate = sourceIds.find((id) => seen.has(id));
    if (duplicate) {
      errors.push(`cue ${duplicate} appears more than once.`);
      continue;
    }
    sourceIds.forEach((id) => seen.add(id));
    const sourceText = cleanText(sourceIds.map((id) => cueById.get(id)?.text).join(' '));
    groups.push({
      group_id: groupOffset + groups.length + 1,
      source_ids: sourceIds,
      source_text: sourceText,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      reason: cleanText(item.reason),
    });
  }

  const expectedIds = batchCues.map((cue) => String(cue.id)).filter((id) => !pendingSet.has(id));
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length) {
    errors.push(`missing cue ids: ${missing.join(', ')}`);
  }

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    error.output = raw;
    throw error;
  }

  return { groups, pending_ids: pendingIds };
}

function groupToSegment(group, sourceById, index) {
  const cues = group.source_ids.map((id) => sourceById.get(String(id))).filter(Boolean);
  const start = cues[0]?.start ?? 0;
  const end = cues[cues.length - 1]?.end ?? Math.max(start + 0.1, start);
  return {
    id: `template-${String(index + 1).padStart(4, '0')}`,
    groupId: group.group_id,
    start,
    end,
    duration: Number(Math.max(0.1, end - start).toFixed(3)),
    text: group.source_text,
    originalText: cues.map((cue) => cue.text).join(' '),
    sourceIds: group.source_ids,
    sourceRowIds: group.source_ids,
    sourceSegmentCount: group.source_ids.length,
    templateGroupCreatedBy: 'ai_grouping',
    templateGroupConfidence: group.confidence,
    templateGroupReason: group.reason,
    originalCues: cues.map(({ id, start: cueStart, end: cueEnd, text }) => ({
      id,
      start: cueStart,
      end: cueEnd,
      text,
    })),
  };
}

function fallbackSingletonGroups(cues = [], groupOffset = 0) {
  return cues.map((cue, index) => ({
    group_id: groupOffset + index + 1,
    source_ids: [cue.id],
    source_text: cue.text,
    confidence: null,
    reason: 'fallback_single_cue',
  }));
}

function groupProvider(config = {}) {
  return String(config.subtitleGroupProvider || config.translationProvider || 'codex_cli').trim().toLowerCase();
}

function groupModel(config = {}) {
  return String(config.subtitleGroupModel || config.cliTranslationModel || '').trim();
}

function groupingConcurrency(config = {}, batchCount = 1) {
  const explicit = config.subtitleGroupConcurrency ?? process.env.DUBFLOW_SUBTITLE_GROUP_CONCURRENCY;
  if (explicit === undefined || explicit === null || String(explicit).trim() === '') {
    return 1;
  }
  return Math.max(1, Math.min(
    batchCount || 1,
    Math.round(Number(explicit) || 1),
    5
  ));
}

async function callGroupModel(cues, config, isFinalBatch, repair = null) {
  const provider = groupProvider(config);
  if (!isCliTranslationProvider(provider)) {
    throw new Error(`Unsupported AI grouping provider: ${config.subtitleGroupProvider || config.translationProvider || 'unknown'}`);
  }
  const rawText = await runCliTranslation(provider, {
    systemPrompt: GROUP_SYSTEM_PROMPT,
    userPrompt: buildGroupPrompt(cues, config, repair, isFinalBatch),
    timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
    model: groupModel(config),
  });
  return parseGroupOutput(rawText);
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

async function buildParallelBatchGroups(batches, config, sourceById) {
  const concurrency = groupingConcurrency(config, batches.length);

  const batchResults = await mapWithConcurrency(batches, concurrency, async (batch, batchIndex) => {
    let repair = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await callGroupModel(batch, config, true, repair);
        return {
          groups: normalizeGroupResult(raw, batch, 0, true).groups,
          warnings: [],
        };
      } catch (error) {
        repair = {
          errors: error.validationErrors || [error.message],
          output: error.output || null,
        };
        if (attempt >= 1) {
          return {
            groups: fallbackSingletonGroups(batch, 0),
            warnings: [`batch_${batchIndex + 1}_fallback:${error.message}`],
          };
        }
      }
    }
    return { groups: fallbackSingletonGroups(batch, 0), warnings: [`batch_${batchIndex + 1}_fallback:unknown`] };
  });

  const warnings = [];
  const groups = batchResults.flatMap((result) => {
    warnings.push(...(result.warnings || []));
    return result.groups || [];
  }).map((group, index) => ({
    ...group,
    group_id: index + 1,
    source_text: group.source_text || group.source_ids.map((id) => sourceById.get(String(id))?.text).filter(Boolean).join(' '),
  }));

  return { groups, warnings, concurrency };
}

async function buildSubtitleTemplateGroups(segments = [], config = {}) {
  const sourceCues = normalizeSourceCues(segments);
  if (!sourceCues.length) {
    return {
      schemaVersion: 'subtitle_template_groups_v1',
      provider: groupProvider(config),
      model: groupModel(config),
      language: normalizeLanguage(config.subtitleGroupLanguage || config.sourceLanguage || 'auto'),
      sourceCues: [],
      groups: [],
      segments: [],
      warnings: ['no_source_cues'],
    };
  }

  const batchSize = Math.max(8, Math.min(MAX_BATCH_SIZE, Math.round(Number(config.subtitleGroupBatchSize) || DEFAULT_BATCH_SIZE)));
  const sourceById = new Map(sourceCues.map((cue) => [String(cue.id), cue]));
  const batches = [];
  for (let cursor = 0; cursor < sourceCues.length; cursor += batchSize) {
    batches.push(sourceCues.slice(cursor, cursor + batchSize));
  }
  const requestedConcurrency = groupingConcurrency(config, batches.length);
  if (requestedConcurrency > 1 && batches.length > 1) {
    const parallel = await buildParallelBatchGroups(batches, config, sourceById);
    const segmentsOut = parallel.groups.map((group, index) => groupToSegment(group, sourceById, index));
    return {
      schemaVersion: 'subtitle_template_groups_v1',
      provider: groupProvider(config),
      model: groupModel(config),
      language: normalizeLanguage(config.subtitleGroupLanguage || config.sourceLanguage || 'auto'),
      sourceCues,
      groups: parallel.groups,
      segments: segmentsOut,
      warnings: parallel.warnings,
      concurrency: parallel.concurrency,
      createdAt: new Date().toISOString(),
    };
  }

  const groups = [];
  const warnings = [];
  let carry = [];

  for (let cursor = 0; cursor < sourceCues.length; cursor += batchSize) {
    const baseBatch = sourceCues.slice(cursor, cursor + batchSize);
    const batch = [...carry, ...baseBatch];
    const isFinalBatch = cursor + batchSize >= sourceCues.length;
    carry = [];

    let repair = null;
    let normalized = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await callGroupModel(batch, config, isFinalBatch, repair);
        normalized = normalizeGroupResult(raw, batch, groups.length, isFinalBatch);
        break;
      } catch (error) {
        repair = {
          errors: error.validationErrors || [error.message],
          output: error.output || null,
        };
        if (attempt >= 1) {
          warnings.push(`batch_${Math.floor(cursor / batchSize) + 1}_fallback:${error.message}`);
          normalized = {
            groups: fallbackSingletonGroups(batch, groups.length),
            pending_ids: [],
          };
        }
      }
    }

    groups.push(...normalized.groups);
    carry = normalized.pending_ids.map((id) => sourceById.get(String(id))).filter(Boolean);
  }

  if (carry.length) {
    groups.push(...fallbackSingletonGroups(carry, groups.length));
    warnings.push('final_pending_ids_fell_back_to_single_cue_groups');
  }

  const segmentsOut = groups.map((group, index) => groupToSegment(group, sourceById, index));
  return {
    schemaVersion: 'subtitle_template_groups_v1',
    provider: groupProvider(config),
    model: groupModel(config),
    language: normalizeLanguage(config.subtitleGroupLanguage || config.sourceLanguage || 'auto'),
    sourceCues,
    groups,
    segments: segmentsOut,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

function templateArtifactPaths(paths) {
  return {
    jsonPath: path.join(paths.transcripts, 'source_template_groups.json'),
    srtPath: path.join(paths.transcripts, 'source_template_groups.srt'),
  };
}

module.exports = {
  buildSubtitleTemplateGroups,
  templateArtifactPaths,
  _private: {
    groupingConcurrency,
  },
};
