const ALLOWED_OMISSION_REASONS = new Set([
  'omitted_repetition',
  'omitted_filler',
  'omitted_branding',
]);
const { translatedTextContainsSourceNumber } = require('../services/vietnameseNumberText');
const { containsCjkUnifiedIdeograph } = require('../services/textEncodingRepair');

const DANGLING_SOURCE_CONNECTOR = /^(?:\u4f46\u662f|\u4f46|\u800c|\u6240\u4ee5|\u56e0\u4e3a|\u5982\u679c|\u7531\u4e8e|\u4e8e\u662f|\u7136\u540e|\u5e76\u4e14|\u4ee5\u53ca|\u4e0d\u8fc7|\u5374|\u6216|\u6216\u8005|\u8981\u4e48|\u867d\u7136|\u5c3d\u7ba1|\u540c\u65f6|\u7ed3\u679c|\u56e0\u6b64|\u90a3\u4e48)[\s,，;；:：.!?\u3002\uff01\uff1f]*$/u;

const DANGLING_VIETNAMESE_END = /\b(và|nhưng|hoặc|vì|nên|rằng|khi|nếu|mà|để|của|với|do|bởi)\s*[,:;\-–—]?$/iu;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDanglingSourceConnector(cue) {
  return DANGLING_SOURCE_CONNECTOR.test(cleanText(cue && cue.textZh));
}

function cueId(index) {
  return `C${String(index + 1).padStart(4, '0')}`;
}

function normalizeStorySourceCues(segments = []) {
  const cues = (segments || []).flatMap((segment, index) => {
    const start = Math.max(0, Number(segment.start) || 0);
    const end = Math.max(start + 0.1, Number(segment.end) || (start + Number(segment.duration) || start + 0.8));
    const textZh = cleanText(segment.textZh || segment.sourceText || segment.originalText || segment.text);
    const base = {
      id: cueId(index),
      originalId: String(segment.id || segment.sourceId || cueId(index)),
      sourceIndex: index,
      start,
      end,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      duration: Number((end - start).toFixed(3)),
      textZh,
      words: Array.isArray(segment.words) ? segment.words : [],
      hardAnchorBefore: segment.hardAnchorBefore === true,
      hardAnchorAfter: segment.hardAnchorAfter === true,
    };
    const words = (Array.isArray(segment.words) ? segment.words : []).map((word) => ({
      text: cleanText(word.text || word.word),
      start: Number(word.start),
      end: Number(word.end),
    })).filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    const boundaries = words.reduce((items, word, wordIndex) => {
      if (wordIndex < words.length - 1 && /[。！？!?；;]$/u.test(word.text)) items.push(wordIndex + 1);
      return items;
    }, []);
    if (!boundaries.length) return [base];
    const ranges = [];
    let from = 0;
    for (const boundary of [...boundaries, words.length]) {
      const part = words.slice(from, boundary);
      if (part.length) ranges.push(part);
      from = boundary;
    }
    if (ranges.length < 2) return [base];
    return ranges.map((part, partIndex) => ({
      ...base,
      id: `${base.id}-${String.fromCharCode(65 + partIndex)}`,
      start: part[0].start,
      end: part[part.length - 1].end,
      startMs: Math.round(part[0].start * 1000),
      endMs: Math.round(part[part.length - 1].end * 1000),
      duration: Number((part[part.length - 1].end - part[0].start).toFixed(3)),
      textZh: cleanText(part.map((word) => word.text).join('')),
      words: part,
      subAnchor: true,
      hardAnchorBefore: partIndex === 0 ? base.hardAnchorBefore : false,
      hardAnchorAfter: partIndex === ranges.length - 1 ? base.hardAnchorAfter : false,
    }));
  }).filter((cue) => cue.textZh);
  return cues.map((cue, index) => ({ ...cue, index }));
}

function buildStoryWindows(sourceCues = [], config = {}) {
  const targetSeconds = Math.max(15, Math.min(25, Number(config.storyContextTargetSeconds) || 22));
  const maxSeconds = Math.max(targetSeconds, Math.min(30, Number(config.storyContextMaxSeconds) || 30));
  const hardGap = Math.max(0.6, Math.min(2, Number(config.storyHardBreakGapSeconds) || 1.2));
  const windows = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const firstIndex = current[0].index;
    const lastIndex = current[current.length - 1].index;
    windows.push({
      id: `W${String(windows.length + 1).padStart(3, '0')}`,
      cues: current,
      contextBefore: sourceCues.slice(Math.max(0, firstIndex - 2), firstIndex),
      contextAfter: sourceCues.slice(lastIndex + 1, lastIndex + 3),
      start: current[0].start,
      end: current[current.length - 1].end,
    });
    current = [];
  };

  for (const cue of sourceCues) {
    if (!current.length) {
      current.push(cue);
      continue;
    }
    const previous = current[current.length - 1];
    const gap = Math.max(0, cue.start - previous.end);
    const proposedDuration = cue.end - current[0].start;
    const hardBreak = cue.hardAnchorBefore || previous.hardAnchorAfter || gap >= hardGap;
    const reachedNaturalTarget = (previous.end - current[0].start) >= targetSeconds && /[。！？!?]$/u.test(previous.textZh);
    if (hardBreak) {
      flush();
    } else if ((proposedDuration > maxSeconds || reachedNaturalTarget) && current.length > 1 && isDanglingSourceConnector(previous)) {
      const dangling = current.pop();
      flush();
      current.push(dangling);
    } else if (proposedDuration > maxSeconds || reachedNaturalTarget) {
      flush();
    }
    current.push(cue);
  }
  flush();
  return windows;
}

function stripJsonFence(value) {
  return String(value || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function extractJsonObject(value) {
  const text = stripJsonFence(value);
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Model did not return a JSON object.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
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
    if (depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error('Model returned incomplete JSON.');
}

function sourceOrderMap(sourceCues = []) {
  return new Map(sourceCues.map((cue, index) => [String(cue.id), index]));
}

function normalizeStringList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function extractNumbers(text = '') {
  return Array.from(new Set(String(text || '').match(/\d+(?:[.,:/-]\d+)*/g) || []));
}

function normalizeAtoms(rawAtoms = [], sourceCues = [], atomOffset = 0) {
  const validSourceIds = new Set(sourceCues.map((cue) => cue.id));
  const normalized = (Array.isArray(rawAtoms) ? rawAtoms : []).map((atom) => ({
    sourceRefs: normalizeStringList(atom.sourceRefs || atom.sourceIds).filter((id) => validSourceIds.has(id)),
    meaningVi: cleanText(atom.meaningVi || atom.meaning || atom.text),
    facts: normalizeStringList(atom.facts).map(cleanText).filter(Boolean),
    dependsOnPrevious: atom.dependsOnPrevious === true,
    dependsOnNext: atom.dependsOnNext === true,
    uncertain: atom.uncertain === true,
  })).filter((atom) => atom.sourceRefs.length && atom.meaningVi);
  return normalized.map((atom, index) => ({
    atomId: `A${String(atomOffset + index + 1).padStart(5, '0')}`,
    ...atom,
  }));
}

function normalizeOmissions(rawOmissions = [], atomsById = new Map(), sourceCuesById = new Map()) {
  return (Array.isArray(rawOmissions) ? rawOmissions : []).map((item) => {
    const atomIds = normalizeStringList(item.atomIds).filter((id) => atomsById.has(id));
    const atomSourceIds = atomIds.flatMap((id) => atomsById.get(id)?.sourceRefs || []);
    const sourceIds = normalizeStringList([...(item.sourceIds || []), ...atomSourceIds]).filter((id) => sourceCuesById.has(id));
    return {
      atomIds,
      sourceIds,
      reason: String(item.reason || '').trim(),
      sourceText: cleanText(sourceIds.map((id) => sourceCuesById.get(id)?.textZh).filter(Boolean).join(' ')),
      note: cleanText(item.note),
    };
  }).filter((item) => item.atomIds.length || item.sourceIds.length);
}

function segmentTimeline(sourceIds, sourceCuesById) {
  const cues = sourceIds.map((id) => sourceCuesById.get(id)).filter(Boolean);
  if (!cues.length) return { start: 0, end: 0.1 };
  return {
    start: Math.min(...cues.map((cue) => cue.start)),
    end: Math.max(...cues.map((cue) => cue.end)),
  };
}

function atomIdsForSourceIds(sourceIds = [], atoms = []) {
  const sourceSet = new Set(sourceIds);
  return atoms
    .filter((atom) => (
      Array.isArray(atom.sourceRefs)
      && atom.sourceRefs.length > 0
      && atom.sourceRefs.every((id) => sourceSet.has(id))
    ))
    .map((atom) => atom.atomId);
}

function atomPlanText(atom = {}) {
  return cleanText(atom.meaningVi);
}

function sourceIndexesForAtom(atom = {}, sourceOrder = new Map()) {
  return (atom.sourceRefs || []).map((id) => sourceOrder.get(id)).filter(Number.isInteger);
}

function buildStorySegmentPlan(sourceCues = [], atoms = [], config = {}) {
  const sourceOrder = sourceOrderMap(sourceCues);
  const sourceCuesById = new Map(sourceCues.map((cue) => [cue.id, cue]));
  const validAtoms = (atoms || []).filter((atom) => Array.isArray(atom.sourceRefs) && atom.sourceRefs.length);
  // A story row is a spoken beat, not necessarily one STT cue. This prevents
  // individually correct but disconnected narration when STT is fragmented.
  const targetMinSeconds = Math.max(2, Math.min(8, Number(config.storyTargetMinSeconds) || 4));
  const targetMaxSeconds = Math.max(
    targetMinSeconds,
    Math.min(10, Number(config.storyTargetMaxSeconds) || 8)
  );
  const groupNarrativeBeats = config.storyNarrativeGrouping === true;
  const plans = [];
  let current = [];

  const flush = (reason = 'standalone_complete_unit') => {
    if (!current.length) return;
    const sourceIds = normalizeStringList(current.flatMap((atom) => atom.sourceRefs || []))
      .sort((left, right) => (sourceOrder.get(left) ?? Infinity) - (sourceOrder.get(right) ?? Infinity));
    const timeline = segmentTimeline(sourceIds, sourceCuesById);
    const planId = `P${String(plans.length + 1).padStart(5, '0')}`;
    plans.push({
      planId,
      sourceIds,
      atomIds: current.map((atom) => atom.atomId).filter(Boolean),
      meaningText: cleanText(current.map(atomPlanText).filter(Boolean).join(' ')),
      boundaryReason: reason,
      start: timeline.start,
      end: timeline.end,
      startMs: Math.round(timeline.start * 1000),
      endMs: Math.round(timeline.end * 1000),
      duration: Number(Math.max(0.1, timeline.end - timeline.start).toFixed(3)),
    });
    current = [];
  };

  validAtoms.forEach((atom, index) => {
    const currentSourceIds = normalizeStringList(current.flatMap((item) => item.sourceRefs || []));
    const currentTimeline = segmentTimeline(currentSourceIds, sourceCuesById);
    const candidateSourceIds = normalizeStringList([...currentSourceIds, ...(atom.sourceRefs || [])]);
    const candidateTimeline = segmentTimeline(candidateSourceIds, sourceCuesById);
    const wouldExceedTarget = current.length
      && candidateTimeline.end - candidateTimeline.start > targetMaxSeconds;

    // A fresh, unrelated beat starts a new slot once the current narration has
    // reached its minimum size. Dependent clauses always remain together.
    if (groupNarrativeBeats && wouldExceedTarget && currentTimeline.end - currentTimeline.start >= targetMinSeconds) {
      const previous = current[current.length - 1];
      if (!previous.dependsOnNext && !atom.dependsOnPrevious) flush('target_duration_boundary');
    }

    current.push(atom);
    const next = validAtoms[index + 1];
    if (!next) {
      flush(atom.dependsOnNext ? 'dependency_chain' : 'standalone_complete_unit');
      return;
    }

    const currentIndexes = sourceIndexesForAtom(atom, sourceOrder);
    const nextIndexes = sourceIndexesForAtom(next, sourceOrder);
    const currentLast = currentIndexes.length ? Math.max(...currentIndexes) : -Infinity;
    const nextFirst = nextIndexes.length ? Math.min(...nextIndexes) : Infinity;
    if (atom.dependsOnNext || next.dependsOnPrevious) return;
    if (nextFirst <= currentLast) return;
    if (groupNarrativeBeats) {
      const currentSourceIdsAfter = normalizeStringList(current.flatMap((item) => item.sourceRefs || []));
      const timeline = segmentTimeline(currentSourceIdsAfter, sourceCuesById);
      if (timeline.end - timeline.start >= targetMinSeconds) flush('narrative_beat');
    } else {
      flush('standalone_complete_unit');
    }
  });

  return plans.map((plan, index) => ({ ...plan, index }));
}

function normalizeStorySegments(rawSegments = [], atoms = [], sourceCues = [], segmentOffset = 0) {
  const atomsById = new Map(atoms.map((atom) => [atom.atomId, atom]));
  const sourceCuesById = new Map(sourceCues.map((cue) => [cue.id, cue]));
  const normalized = (Array.isArray(rawSegments) ? rawSegments : []).map((segment) => {
    const explicitSourceIds = normalizeStringList(segment.sourceIds || segment.sourceRefs).filter((id) => sourceCuesById.has(id));
    const explicitAtomIds = normalizeStringList(segment.atomIds).filter((id) => atomsById.has(id));
    const atomSourceIds = normalizeStringList(explicitAtomIds.flatMap((id) => atomsById.get(id)?.sourceRefs || []));
    const sourceIds = explicitSourceIds.length ? explicitSourceIds : atomSourceIds;
    const atomIds = explicitAtomIds.length ? explicitAtomIds : atomIdsForSourceIds(sourceIds, atoms);
    const timeline = segmentTimeline(sourceIds, sourceCuesById);
    const text = cleanText(segment.text);
    return {
      atomIds,
      sourceIds,
      sourceRowIds: sourceIds,
      text,
      translatedText: text,
      finalText: text,
      start: timeline.start,
      end: timeline.end,
      startMs: Math.round(timeline.start * 1000),
      endMs: Math.round(timeline.end * 1000),
      duration: Number(Math.max(0.1, timeline.end - timeline.start).toFixed(3)),
      status: 'verified',
    };
  }).filter((segment) => segment.sourceIds.length && segment.text);
  return normalized.map((segment, index) => {
    const segmentId = `V${String(segmentOffset + index + 1).padStart(5, '0')}`;
    return { segmentId, id: segmentId, ...segment };
  });
}

function normalizePlannedStorySegments(rawSegments = [], segmentPlan = [], sourceCues = [], segmentOffset = 0) {
  const planById = new Map((segmentPlan || []).map((plan) => [String(plan.planId), plan]));
  const sourceCuesById = new Map(sourceCues.map((cue) => [cue.id, cue]));
  const normalized = (Array.isArray(rawSegments) ? rawSegments : []).map((segment) => {
    const plan = planById.get(String(segment.planId || '').trim());
    const text = cleanText(segment.text);
    if (!plan || !text) return null;
    const timeline = segmentTimeline(plan.sourceIds, sourceCuesById);
    return {
      planId: plan.planId,
      atomIds: [...(plan.atomIds || [])],
      sourceIds: [...(plan.sourceIds || [])],
      sourceRowIds: [...(plan.sourceIds || [])],
      meaningText: plan.meaningText || '',
      boundaryReason: plan.boundaryReason,
      text,
      translatedText: text,
      finalText: text,
      start: timeline.start,
      end: timeline.end,
      startMs: Math.round(timeline.start * 1000),
      endMs: Math.round(timeline.end * 1000),
      duration: Number(Math.max(0.1, timeline.end - timeline.start).toFixed(3)),
      status: 'verified',
    };
  }).filter(Boolean);
  return normalized.map((segment, index) => {
    const segmentId = `V${String(segmentOffset + index + 1).padStart(5, '0')}`;
    return { segmentId, id: segmentId, ...segment };
  });
}

function validateAtomLedger(sourceCues = [], atoms = [], config = {}) {
  const errors = [];
  const order = sourceOrderMap(sourceCues);
  const seenAtoms = new Set();
  let lastSourceIndex = -1;
  atoms.forEach((atom) => {
    if (seenAtoms.has(atom.atomId)) errors.push(`duplicate_atom:${atom.atomId}`);
    seenAtoms.add(atom.atomId);
    if (!atom.meaningVi) errors.push(`empty_atom:${atom.atomId}`);
    if (atom.uncertain) errors.push(`uncertain_atom:${atom.atomId}`);
    const indexes = atom.sourceRefs.map((id) => order.get(id)).filter(Number.isInteger);
    if (indexes.length !== atom.sourceRefs.length) errors.push(`unknown_source_ref:${atom.atomId}`);
    if (indexes.some((value, index) => index > 0 && value !== indexes[index - 1] + 1)) errors.push(`non_contiguous_source_refs:${atom.atomId}`);
    if (indexes.length && indexes[0] < lastSourceIndex) errors.push(`atom_order:${atom.atomId}`);
    if (indexes.length) lastSourceIndex = indexes[indexes.length - 1];
  });
  const covered = new Set(atoms.flatMap((atom) => atom.sourceRefs));
  sourceCues.forEach((cue) => {
    if (!covered.has(cue.id)) errors.push(`missing_source:${cue.id}`);
  });
  return { valid: errors.length === 0, errors };
}

function sourceIdsFromOmissions(omissions = []) {
  return normalizeStringList((omissions || []).flatMap((item) => item.sourceIds || []));
}

function estimateTimelineChars(text = '') {
  return cleanText(text).replace(/\s+/g, '').length;
}

function validateStoryTimelineMapping(sourceCues = [], storySegments = [], omissions = [], config = {}) {
  const errors = [];
  const warnings = [];
  const sourceOrder = sourceOrderMap(sourceCues);
  const sourceById = new Map(sourceCues.map((cue) => [cue.id, cue]));
  const coveredBy = new Map();
  const omitted = new Set(sourceIdsFromOmissions(omissions));
  let lastSourceIndex = -1;
  let previousEnd = -Infinity;
  const baseCps = Number(config.translationCharsPerSecond) || 13;
  const maxCharsPerSecond = Math.max(8, Math.min(24, Number(config.storyTimelineMaxCharsPerSecond) || baseCps * 1.35));

  storySegments.forEach((segment) => {
    const segmentId = segment.segmentId || segment.id || 'unknown_segment';
    const sourceIds = normalizeStringList(segment.sourceIds);
    if (!sourceIds.length) {
      errors.push(`timeline_missing_sourceIds:${segmentId}`);
      return;
    }

    const indexes = sourceIds.map((id) => sourceOrder.get(id));
    const unknownIds = sourceIds.filter((id, index) => !Number.isInteger(indexes[index]));
    unknownIds.forEach((id) => errors.push(`timeline_unknown_source:${segmentId}:${id}`));
    if (unknownIds.length) return;

    const nonContiguous = indexes.some((value, index) => index > 0 && value !== indexes[index - 1] + 1);
    if (nonContiguous) errors.push(`timeline_non_contiguous_sources:${segmentId}:${sourceIds.join(',')}`);
    if (indexes[0] <= lastSourceIndex) errors.push(`timeline_source_order:${segmentId}:${sourceIds.join(',')}`);
    lastSourceIndex = indexes[indexes.length - 1];

    sourceIds.forEach((id) => {
      const owners = coveredBy.get(id) || [];
      owners.push(segmentId);
      coveredBy.set(id, owners);
    });

    const firstCue = sourceById.get(sourceIds[0]);
    const lastCue = sourceById.get(sourceIds[sourceIds.length - 1]);
    const expectedStart = Number(firstCue?.start) || 0;
    const expectedEnd = Number(lastCue?.end) || expectedStart + 0.1;
    if (Math.abs((Number(segment.start) || 0) - expectedStart) > 0.025) {
      errors.push(`timeline_start_mismatch:${segmentId}:${sourceIds[0]}`);
    }
    if (Math.abs((Number(segment.end) || 0) - expectedEnd) > 0.025) {
      errors.push(`timeline_end_mismatch:${segmentId}:${sourceIds[sourceIds.length - 1]}`);
    }
    if (expectedStart < previousEnd - 0.001) errors.push(`timeline_overlap:${segmentId}`);
    previousEnd = Math.max(previousEnd, expectedEnd);

    if (/[,;:]\s*$/u.test(cleanText(segment.text))) errors.push(`timeline_incomplete_sentence:${segmentId}`);
    const duration = Math.max(0.1, expectedEnd - expectedStart);
    const charsPerSecond = estimateTimelineChars(segment.text) / duration;
    if (charsPerSecond > maxCharsPerSecond) {
      warnings.push(`timeline_text_too_dense:${segmentId}:${charsPerSecond.toFixed(1)}cps>${maxCharsPerSecond.toFixed(1)}cps`);
    } else if (charsPerSecond > baseCps) {
      warnings.push(`timeline_text_dense:${segmentId}:${charsPerSecond.toFixed(1)}cps`);
    }
  });

  for (const cue of sourceCues) {
    const id = String(cue.id);
    const owners = coveredBy.get(id) || [];
    if (owners.length > 1) errors.push(`timeline_duplicate_source:${id}:${owners.join(',')}`);
    if (!owners.length && !omitted.has(id)) errors.push(`timeline_missing_source:${id}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateStoryResult({ sourceCues = [], atoms = [], storyText = '', storySegments = [], omissions = [], segmentPlan = [] }, config = {}) {
  const errors = [];
  const warnings = [];
  const atomOrder = new Map(atoms.map((atom, index) => [atom.atomId, index]));
  const sourceOrder = sourceOrderMap(sourceCues);
  const planById = new Map((segmentPlan || []).map((plan) => [String(plan.planId), plan]));
  const coveredPlans = new Set();
  const accounted = new Map();
  const registerAtom = (atomId, location) => {
    if (!atomOrder.has(atomId)) errors.push(`unknown_atom:${atomId}`);
    if (accounted.has(atomId)) errors.push(`duplicate_atom_coverage:${atomId}`);
    accounted.set(atomId, location);
  };

  let lastAtomIndex = -1;
  let lastSourceIndex = -1;
  let previousEnd = -Infinity;
  storySegments.forEach((segment) => {
    if (planById.size) {
      const planId = String(segment.planId || '').trim();
      const plan = planById.get(planId);
      if (!plan) {
        errors.push(`unknown_segment_plan:${segment.segmentId}:${planId || 'missing'}`);
      } else {
        if (coveredPlans.has(planId)) errors.push(`duplicate_segment_plan:${planId}`);
        coveredPlans.add(planId);
        if ((segment.atomIds || []).join('\u0000') !== (plan.atomIds || []).join('\u0000')) errors.push(`segment_plan_atom_mismatch:${segment.segmentId}:${planId}`);
        if ((segment.sourceIds || []).join('\u0000') !== (plan.sourceIds || []).join('\u0000')) errors.push(`segment_plan_source_mismatch:${segment.segmentId}:${planId}`);
      }
    }
    const atomIndexes = segment.atomIds.map((id) => atomOrder.get(id)).filter(Number.isInteger);
    segment.atomIds.forEach((id) => registerAtom(id, segment.segmentId));
    if (!segment.text) errors.push(`empty_story_segment:${segment.segmentId}`);
    const target = String(config.targetLanguage || 'vi').trim().toLowerCase();
    if ((target === 'vietnamese' || target.startsWith('vi')) && containsCjkUnifiedIdeograph(segment.text)) {
      errors.push(`cjk_in_vietnamese_segment:${segment.segmentId}`);
    }
    if (DANGLING_VIETNAMESE_END.test(segment.text)) errors.push(`dangling_connector:${segment.segmentId}`);
    if (atomIndexes.some((value, index) => index > 0 && value !== atomIndexes[index - 1] + 1)) errors.push(`non_contiguous_atoms:${segment.segmentId}`);
    if (atomIndexes.length && atomIndexes[0] <= lastAtomIndex) errors.push(`story_atom_order:${segment.segmentId}`);
    if (atomIndexes.length) lastAtomIndex = atomIndexes[atomIndexes.length - 1];
    const sourceIndexes = segment.sourceIds.map((id) => sourceOrder.get(id)).filter(Number.isInteger);
    if (sourceIndexes.some((value, index) => index > 0 && value !== sourceIndexes[index - 1] + 1)) errors.push(`non_contiguous_sources:${segment.segmentId}`);
    if (sourceIndexes.length && sourceIndexes[0] < lastSourceIndex) errors.push(`story_source_order:${segment.segmentId}`);
    if (sourceIndexes.length) lastSourceIndex = sourceIndexes[sourceIndexes.length - 1];
    if (segment.start < previousEnd - 0.001) errors.push(`timeline_overlap:${segment.segmentId}`);
    previousEnd = Math.max(previousEnd, segment.end);
    if (segment.duration < (Number(config.storyTargetMinSeconds) || 4)) warnings.push(`segment_short:${segment.segmentId}`);
  });

  omissions.forEach((item, index) => {
    if (!ALLOWED_OMISSION_REASONS.has(item.reason)) errors.push(`invalid_omission_reason:${index}`);
    item.atomIds.forEach((id) => registerAtom(id, `omission:${index}`));
  });
  atoms.forEach((atom) => {
    if (!accounted.has(atom.atomId)) errors.push(`missing_atom_coverage:${atom.atomId}`);
  });
  if (planById.size) {
    for (const plan of segmentPlan) {
      if (!coveredPlans.has(String(plan.planId))) errors.push(`missing_segment_plan:${plan.planId}`);
    }
  }
  const rebuiltStoryText = cleanText(storySegments.map((segment) => segment.text).join(' '));
  if (cleanText(storyText) !== rebuiltStoryText) errors.push('story_text_mismatch');
  const sourceNumbers = Array.from(new Set(sourceCues.flatMap((cue) => extractNumbers(cue.textZh))));
  sourceNumbers.forEach((number) => {
    if (!translatedTextContainsSourceNumber(rebuiltStoryText, number)) errors.push(`missing_number:${number}`);
  });
  const timelineValidation = validateStoryTimelineMapping(sourceCues, storySegments, omissions, config);
  errors.push(...timelineValidation.errors);
  warnings.push(...timelineValidation.warnings);

  return {
    valid: errors.length === 0,
    status: errors.length ? 'needs_review' : 'verified',
    errors,
    warnings,
  };
}

function clampStoryTimeline(storySegments = [], config = {}) {
  const maxShift = Math.max(0, Math.min(0.35, Number(config.storyBoundaryMaxShiftSeconds) || 0.35));
  return storySegments.map((segment, index) => {
    const previous = storySegments[index - 1];
    let start = segment.start;
    let end = segment.end;
    if (previous && start < previous.end) {
      const overlap = previous.end - start;
      const boundary = overlap <= maxShift * 2 ? (previous.end + start) / 2 : previous.end;
      start = Math.max(start, boundary);
    }
    const next = storySegments[index + 1];
    if (next && end > next.start) {
      const overlap = end - next.start;
      const boundary = overlap <= maxShift * 2 ? (end + next.start) / 2 : next.start;
      end = Math.min(end, boundary);
    }
    if (end <= start) end = start + 0.1;
    return {
      ...segment,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      duration: Number((end - start).toFixed(3)),
    };
  });
}

function storySegmentsToLegacySegments(storySegments = [], sourceCues = []) {
  const sourceById = new Map(sourceCues.map((cue) => [cue.id, cue]));
  return storySegments.map((segment, index) => ({
    ...segment,
    index,
    originalText: cleanText(segment.sourceIds.map((id) => sourceById.get(id)?.textZh).filter(Boolean).join(' ')),
    sourceText: cleanText(segment.sourceIds.map((id) => sourceById.get(id)?.textZh).filter(Boolean).join(' ')),
    ttsText: segment.text,
    validationStatus: segment.status || 'verified',
  }));
}

function adaptLegacyTranslationArtifact(payload = {}) {
  if (payload.schemaVersion === 'story_translation_v2') return payload;
  const sourceCues = normalizeStorySourceCues(payload.sourceSegments || payload.segments || []);
  const storySegments = (payload.segments || []).map((segment, index) => {
    const cue = sourceCues[index];
    const text = cleanText(segment.finalText || segment.translatedText || segment.text);
    return {
      segmentId: `V${String(index + 1).padStart(5, '0')}`,
      id: String(segment.id || `V${String(index + 1).padStart(5, '0')}`),
      atomIds: [`A${String(index + 1).padStart(5, '0')}`],
      sourceIds: cue ? [cue.id] : normalizeStringList(segment.sourceIds),
      sourceRowIds: cue ? [cue.id] : normalizeStringList(segment.sourceRowIds || segment.sourceIds),
      text,
      translatedText: text,
      finalText: text,
      start: Number(segment.start) || cue?.start || 0,
      end: Number(segment.end) || cue?.end || 0.1,
      duration: Number(segment.duration) || Math.max(0.1, (Number(segment.end) || 0.1) - (Number(segment.start) || 0)),
      status: 'legacy_unverified',
    };
  });
  return {
    ...payload,
    schemaVersion: 'story_translation_v2',
    translationMode: 'legacy',
    sourceCues,
    meaningAtoms: storySegments.map((segment, index) => ({
      atomId: segment.atomIds[0],
      sourceRefs: segment.sourceIds,
      meaningVi: segment.text,
      facts: [],
      dependsOnPrevious: false,
      uncertain: false,
      legacy: true,
      index,
    })),
    storyText: cleanText(storySegments.map((segment) => segment.text).join(' ')),
    storySegments,
    omissions: [],
    validation: { status: 'legacy_unverified', valid: false, errors: [], warnings: ['legacy_artifact'] },
  };
}

module.exports = {
  ALLOWED_OMISSION_REASONS,
  cleanText,
  normalizeStorySourceCues,
  buildStoryWindows,
  extractJsonObject,
  normalizeAtoms,
  normalizeOmissions,
  buildStorySegmentPlan,
  normalizeStorySegments,
  normalizePlannedStorySegments,
  validateAtomLedger,
  validateStoryResult,
  clampStoryTimeline,
  storySegmentsToLegacySegments,
  adaptLegacyTranslationArtifact,
};
