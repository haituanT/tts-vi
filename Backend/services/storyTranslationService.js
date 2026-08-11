const { isCliTranslationProvider, runCliTranslation } = require('./cliTranslationService');
const { buildSkillTaskPrompt, loadSkillText, loadRuntimeSkillText } = require('./skillPromptService');
const {
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
} = require('../domain/storyTranslation');

const ATOM_SYSTEM_PROMPT = `Use the provided subtitle-cue-grouping skill for source coverage/order and the subtitle-translation-prompt skill for Vietnamese meaning fidelity.
Return exactly one JSON object and no markdown.
Do not write the final narration. Build the meaningAtoms ledger only.
Keep every MAIN cue ID covered at least once, keep sourceRefs ordered and adjacent, and mark uncertain=true instead of guessing.

Skill: subtitle-cue-grouping

${loadSkillText('subtitle-cue-grouping')}

The complete subtitle-translation-prompt skill is included in the task prompt below; follow it for Vietnamese meaning fidelity, names, numbers, and TTS wording.`;

function translationSkillRules() {
  return `Skill: subtitle-translation-prompt

${loadRuntimeSkillText('subtitle-translation-prompt', 'vi')}`;
}

const STORY_SYSTEM_PROMPT = `Use the provided subtitle-translation-prompt skill for Vietnamese narration.
Return exactly one JSON object and no markdown.
Keep planId, sourceIds, atomIds, timing, and order locked.
Before writing any plan, silently read the complete contextBefore, sourceCues, contextAfter, meaningAtoms, and ordered segmentPlan. Use that context to resolve who/what pronouns refer to, causal links, chronology, established names, and narration tone. Context is reference only: never output, translate, or remap it unless it belongs to a locked plan.

The complete subtitle-translation-prompt skill is included in the task prompt below; follow it for Vietnamese meaning fidelity, names, numbers, and TTS wording. Reject Han/Hanzi/Kanji characters when the target is Vietnamese.`;

const VERIFY_SYSTEM_PROMPT = `Use the provided subtitle-translation-prompt skill to verify Vietnamese narration quality and meaning preservation.
Return exactly one JSON object: {"valid":boolean,"errors":[string]}.
Compare source cues, meaning atoms, story segments, sourceIds timeline mapping and omissions.
For every planId assigned to a story segment, verify that the segment text preserves the plan's meaningText naturally and does not add unsupported facts.
Reject non-consecutive sourceIds, missing or duplicated source cue coverage, timeline span mistakes, changed numbers or names, reversed chronology, lost negation, changed cause/effect, unsafe omissions, incomplete Vietnamese clauses, dangling connectors, and unnatural grouping that ignores clear semantic or pause boundaries.
Also reject discourse-continuity failures: adjacent story segments that read like isolated captions despite clear source continuity, repeated subjects or setup that make the narration reset unnecessarily, missing supported temporal/cause/result/contrast continuity, unsupported connector words, or abrupt starts/ends that break the spoken story while preserving the locked plan boundaries.
Accept explicit omissions with reason omitted_repetition, omitted_filler, or omitted_branding when the cited source really matches that reason. Do not report an allowed branding omission as missing content.
Do not rewrite the translation.

${translationSkillRules()}`;

function compactCue(cue) {
  return {
    id: cue.id,
    startMs: cue.startMs,
    endMs: cue.endMs,
    textZh: cue.textZh,
  };
}

function repairAttemptCount(config = {}) {
  const configured = Number(config.storyRepairMaxAttempts);
  const repairs = Number.isFinite(configured) ? configured : 2;
  return Math.max(0, Math.min(2, Math.round(repairs))) + 1;
}

function isCliTimeoutError(error) {
  return /CLI timed out after\s+\d+s|translation timed out/i.test(String(error?.message || error || ''));
}

function storyTranslationConcurrency(config = {}, total = 1) {
  const provider = String(config.translationProvider || '').trim().toLowerCase();
  const requested = Math.max(1, Math.min(5, Math.round(Number(config.cliTranslationConcurrency) || Number(process.env.DUBFLOW_CLI_TRANSLATION_CONCURRENCY) || 3)));
  const cap = provider === 'antigravity_cli' ? 2 : 3;
  return Math.max(1, Math.min(total || 1, cap, requested));
}

async function mapWithConcurrency(items = [], concurrency = 1, mapper = async () => {}) {
  const limit = Math.max(1, Math.min(items.length || 1, Math.round(Number(concurrency) || 1)));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function buildAtomPrompt(window, config = {}, repair = null) {
  const payload = {
    sourceLanguage: config.sourceLanguage || 'zh',
    targetLanguage: config.targetLanguage || 'vi',
    videoContext: cleanText([config.autoContext, config.userContext, config.videoContext].filter(Boolean).join('\n')),
    glossary: cleanText(config.customGlossary),
    contextBefore: window.contextBefore.map(compactCue),
    mainCues: window.cues.map(compactCue),
    contextAfter: window.contextAfter.map(compactCue),
    absoluteMaxSeconds: Number(config.storyAbsoluteMaxSegmentSeconds) || 10,
  };
  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'First read contextBefore, mainCues, and contextAfter as one passage. Then create a source-coverage meaning atom ledger only for mainCues. Use surrounding cues to resolve references and cause/effect, but never create an atom for context-only cues and do not write final narration.',
    input: payload,
    sourceLanguage: payload.sourceLanguage,
    targetLanguage: payload.targetLanguage,
    context: payload.videoContext,
    glossary: payload.glossary,
    retry: repair,
    outputContract: `Return this shape:
{"meaningAtoms":[{"sourceRefs":["C0001"],"meaningVi":"...","facts":["..."],"dependsOnPrevious":false,"dependsOnNext":false,"uncertain":false}]}`,
  });
}

function buildStoryPrompt(window, atoms, segmentPlan = [], config = {}, repair = null) {
  const payload = {
    targetMinSeconds: Number(config.storyTargetMinSeconds) || 4,
    targetMaxSeconds: Number(config.storyTargetMaxSeconds) || 8,
    absoluteMaxSeconds: Number(config.storyAbsoluteMaxSegmentSeconds) || 10,
    narrationGoal: 'Translate this whole ordered batch as one continuous, natural Vietnamese story before returning its individual timed plans. Each plan is a timed spoken beat, so use every nearby plan to resolve pronouns, cause/effect, tense, tone, and established names. Do not make every beat sound like a separate standalone caption. Remove only true spoken filler and exact repetition; never remove a fact, number, name, negation, or causal link. Use natural Vietnamese connectors only when they are supported by the source.',
    contextBefore: (window.contextBefore || []).map(compactCue),
    sourceCues: window.cues.map(compactCue),
    contextAfter: (window.contextAfter || []).map(compactCue),
    meaningAtoms: atoms,
    segmentPlan,
  };
  return buildSkillTaskPrompt({
    skillName: 'subtitle-translation-prompt',
    task: 'Mandatory silent process: read contextBefore, every sourceCue in this whole batch, contextAfter, meaningAtoms, and the complete ordered segmentPlan before translating. Then translate the locked plans as one continuous Vietnamese narration, using that context for references, chronology, cause/effect, established names, tone, and natural connectors. Context is reference only: write text only for the locked plans and preserve their structure.',
    input: payload,
    sourceLanguage: config.sourceLanguage || 'auto',
    targetLanguage: config.targetLanguage || 'vi',
    context: [config.autoContext, config.userContext, config.videoContext].filter(Boolean).join('\n\n'),
    glossary: config.customGlossary || '',
    retry: repair,
    outputContract: `Keep every planId exactly once and only write text for the locked plan.
Return this shape:
{"storySegments":[{"planId":"P00001","text":"Cau tieng Viet tu nhien, du nghia."}]}`,
  });
}

function buildVerifyPrompt(window, atoms, candidate) {
  return JSON.stringify({
    verificationGoal: 'Check both meaning fidelity and discourse continuity. A valid result should sound like one continuous Vietnamese narration across the ordered storySegments while keeping every locked plan/source mapping unchanged.',
    continuityChecklist: [
      'neighboring segments use context to resolve pronouns and references',
      'source-supported time, cause/result, contrast, and action/result relations are not lost',
      'subjects or setup are not repeated in a way that resets the story unnecessarily',
      'connectors are used only when supported by source meaning',
      'segment starts and endings do not sound abrupt, dangling, or like unrelated captions',
    ],
    sourceCues: window.cues.map(compactCue),
    meaningAtoms: atoms,
    segmentPlan: candidate.segmentPlan || [],
    storyText: candidate.storyText,
    storySegments: candidate.storySegments.map(({ segmentId, planId, atomIds, sourceIds, text, startMs, endMs }) => ({ segmentId, planId, atomIds, sourceIds, text, startMs, endMs })),
    omissions: candidate.omissions,
  }, null, 2);
}

function meaningTextForAtomIds(atomIds = [], atomsById = new Map()) {
  return cleanText((atomIds || []).map((id) => atomsById.get(id)?.meaningVi).filter(Boolean).join(' '));
}

function segmentPlanFromStorySegments(storySegments = [], atoms = []) {
  const atomsById = new Map(atoms.map((atom) => [atom.atomId, atom]));
  return (storySegments || []).map((segment, index) => ({
    planId: segment.planId || `P${String(index + 1).padStart(5, '0')}`,
    index,
    sourceIds: Array.isArray(segment.sourceIds) ? [...segment.sourceIds] : [],
    atomIds: Array.isArray(segment.atomIds) ? [...segment.atomIds] : [],
    meaningText: meaningTextForAtomIds(segment.atomIds || [], atomsById),
    boundaryReason: segment.boundaryReason || 'reused_verified_segment',
    start: segment.start,
    end: segment.end,
    startMs: segment.startMs,
    endMs: segment.endMs,
    duration: segment.duration,
  }));
}

async function callJson(systemPrompt, userPrompt, config, runner) {
  const provider = String(config.translationProvider || '').trim().toLowerCase();
  if (!isCliTranslationProvider(provider) && runner === runCliTranslation) {
    throw new Error(`Unsupported story translation provider: ${config.translationProvider || 'unknown'}`);
  }
  const raw = await runner(provider, {
    systemPrompt,
    userPrompt,
    timeoutMs: Math.max(60000, Number(process.env.DUBFLOW_CLI_TRANSLATION_TIMEOUT_MS) || 300000),
    model: config.cliTranslationModel,
  });
  return extractJsonObject(raw);
}

async function buildWindowAtoms(window, config, runner, atomOffset) {
  let repair = null;
  let lastOutput = null;
  let lastReport = { valid: false, errors: ['not_started'] };
  const maxAttempts = repairAttemptCount(config);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      lastOutput = await callJson(ATOM_SYSTEM_PROMPT, buildAtomPrompt(window, config, repair), config, runner);
      const atoms = normalizeAtoms(lastOutput.meaningAtoms, window.cues, atomOffset);
      lastReport = validateAtomLedger(window.cues, atoms, config);
      if (lastReport.valid) return { atoms, attempts: attempt };
    } catch (error) {
      lastReport = { valid: false, errors: [`atom_json:${error.message}`] };
      if (isCliTimeoutError(error)) break;
    }
    repair = { errors: lastReport.errors, output: lastOutput };
  }
  const error = new Error(`Meaning ledger for ${window.id} needs review: ${lastReport.errors.join(', ')}`);
  error.code = 'STORY_ATOM_VALIDATION_FAILED';
  error.validation = lastReport;
  throw error;
}

async function verifyCandidate(window, atoms, candidate, config, runner) {
  if (config.storyVerifierEnabled === false) return { valid: true, errors: [] };
  try {
    const raw = await callJson(VERIFY_SYSTEM_PROMPT, buildVerifyPrompt(window, atoms, candidate), config, runner);
    return {
      valid: raw.valid === true && (!Array.isArray(raw.errors) || raw.errors.length === 0),
      errors: Array.isArray(raw.errors) ? raw.errors.map(cleanText).filter(Boolean) : [],
    };
  } catch (error) {
    if (isCliTimeoutError(error)) {
      return {
        valid: true,
        errors: [],
        warnings: [`verifier_timeout:${error.message}`],
        bilingualVerified: false,
        timedOut: true,
      };
    }
    return { valid: false, errors: [`verifier_json:${error.message}`], warnings: [] };
  }
}

async function buildWindowStory(window, atoms, config, runner, segmentOffset) {
  const segmentPlan = buildStorySegmentPlan(window.cues, atoms, config);
  let repair = null;
  let lastRaw = null;
  let lastCandidate = null;
  let lastReport = { valid: false, status: 'needs_review', errors: ['not_started'], warnings: [] };

  const maxAttempts = repairAttemptCount(config);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      lastRaw = await callJson(STORY_SYSTEM_PROMPT, buildStoryPrompt(window, atoms, segmentPlan, config, repair), config, runner);
      const storySegments = clampStoryTimeline(
        normalizePlannedStorySegments(lastRaw.storySegments, segmentPlan, window.cues, segmentOffset),
        config
      );
      lastCandidate = {
        storyText: cleanText(storySegments.map((segment) => segment.text).join(' ')),
        storySegments,
        omissions: [],
        segmentPlan,
      };
      const deterministic = validateStoryResult({ sourceCues: window.cues, atoms, ...lastCandidate }, config);
      const bilingual = deterministic.valid
        ? await verifyCandidate(window, atoms, lastCandidate, config, runner)
        : { valid: false, errors: [] };
      const errors = [...deterministic.errors, ...bilingual.errors.map((item) => `bilingual:${item}`)];
      const warnings = [
        ...(deterministic.warnings || []),
        ...(bilingual.warnings || []).map((item) => `bilingual:${item}`),
      ];
      lastReport = {
        ...deterministic,
        valid: deterministic.valid && bilingual.valid,
        status: deterministic.valid && bilingual.valid
          ? (bilingual.timedOut ? 'verified_with_warnings' : 'verified')
          : 'needs_review',
        errors,
        warnings,
        bilingualVerified: bilingual.bilingualVerified ?? bilingual.valid,
        verifierTimedOut: Boolean(bilingual.timedOut),
        repairAttempts: attempt,
      };
      if (lastReport.valid) return { ...lastCandidate, validation: lastReport };
    } catch (error) {
      lastReport = {
        valid: false,
        status: 'needs_review',
        errors: [`story_json:${error.message}`],
        warnings: [],
        repairAttempts: attempt,
      };
      if (isCliTimeoutError(error)) break;
    }
    repair = { errors: lastReport.errors, output: lastRaw };
  }

  const fallbackSegments = (lastCandidate?.storySegments || []).map((segment) => ({ ...segment, status: 'needs_review' }));
  return {
    storyText: cleanText(lastCandidate?.storyText),
    storySegments: fallbackSegments,
    omissions: lastCandidate?.omissions || [],
    segmentPlan,
    validation: lastReport,
  };
}

function reusableWindowResult(window, artifact, atomOffset, segmentOffset, config = {}) {
  if (!artifact || artifact.schemaVersion !== 'story_translation_v2') return null;
  const previousReport = (artifact.validation?.windows || []).find((report) => report.windowId === window.id);
  if (!previousReport?.valid) return null;

  const sourceIds = new Set(window.cues.map((cue) => cue.id));
  const previousAtoms = (artifact.meaningAtoms || []).filter((atom) => (
    Array.isArray(atom.sourceRefs)
    && atom.sourceRefs.length > 0
    && atom.sourceRefs.every((id) => sourceIds.has(id))
  ));
  if (!previousAtoms.length) return null;

  const atoms = normalizeAtoms(previousAtoms, window.cues, atomOffset);
  if (atoms.length !== previousAtoms.length) return null;
  const atomIdMap = new Map(previousAtoms.map((atom, index) => [atom.atomId, atoms[index].atomId]));
  if (atomIdMap.size !== previousAtoms.length) return null;

  const previousSegments = (artifact.storySegments || []).filter((segment) => (
    Array.isArray(segment.sourceIds)
    && segment.sourceIds.length > 0
    && segment.sourceIds.every((id) => sourceIds.has(id))
  ));
  const rawSegments = previousSegments.map((segment) => ({
    atomIds: (segment.atomIds || []).map((id) => atomIdMap.get(id)).filter(Boolean),
    text: segment.text,
  }));
  const storySegments = clampStoryTimeline(
    normalizeStorySegments(rawSegments, atoms, window.cues, segmentOffset),
    config
  ).map((segment, index) => ({
    ...segment,
    planId: `P${String(index + 1).padStart(5, '0')}`,
  }));
  const segmentPlan = segmentPlanFromStorySegments(storySegments, atoms);

  const previousOmissions = (artifact.omissions || []).filter((omission) => (
    Array.isArray(omission.sourceIds)
    && omission.sourceIds.length > 0
    && omission.sourceIds.every((id) => sourceIds.has(id))
  ));
  const atomsById = new Map(atoms.map((atom) => [atom.atomId, atom]));
  const sourceById = new Map(window.cues.map((cue) => [cue.id, cue]));
  const omissions = normalizeOmissions(previousOmissions.map((omission) => ({
    atomIds: (omission.atomIds || []).map((id) => atomIdMap.get(id)).filter(Boolean),
    sourceIds: omission.sourceIds,
    reason: omission.reason,
    note: omission.note,
  })), atomsById, sourceById);
  const storyText = cleanText(storySegments.map((segment) => segment.text).join(' '));
  const ledgerValidation = validateAtomLedger(window.cues, atoms, config);
  const storyValidation = validateStoryResult({
    sourceCues: window.cues,
    atoms,
    storyText,
    storySegments,
    omissions,
    segmentPlan,
  }, config);
  if (!ledgerValidation.valid || !storyValidation.valid) return null;

  return {
    atoms,
    storyText,
    storySegments,
    omissions,
    segmentPlan,
    validation: {
      ...storyValidation,
      valid: true,
      status: 'verified',
      bilingualVerified: previousReport.bilingualVerified !== false,
      repairAttempts: 0,
      reused: true,
    },
  };
}

async function translateStorySegments(segments = [], config = {}, dependencies = {}) {
  const sourceCues = normalizeStorySourceCues(segments);
  if (!sourceCues.length) throw new Error('Cannot translate an empty source cue list.');
  const runner = dependencies.runCliTranslation || runCliTranslation;
  const progress = typeof config.translationProgress === 'function' ? config.translationProgress : async () => {};
  const windows = buildStoryWindows(sourceCues, config);
  const allAtoms = [];
  const allStorySegments = [];
  const allOmissions = [];
  const allSegmentPlan = [];
  const windowReports = [];
  // A window contains a complete 25–30 second story batch. Windows can still
  // run in parallel because each call receives its own source context and must
  // return the locked plans in that same batch.
  const concurrency = storyTranslationConcurrency(config, windows.length);

  await progress({ type: 'story_start', totalLines: sourceCues.length, totalChunks: windows.length, chunkSize: 0, concurrency });
  const windowResults = await mapWithConcurrency(windows, concurrency, async (window, index) => {
    await progress({ type: 'chunk_start', chunkIndex: index + 1, totalChunks: windows.length, lineCount: window.cues.length });
    const reused = reusableWindowResult(
      window,
      config.storyReuseArtifact,
      0,
      0,
      config
    );
    if (reused) {
      const report = {
        windowId: window.id,
        start: window.start,
        end: window.end,
        atomRepairAttempts: 0,
        ...reused.validation,
      };
      await progress({ type: 'chunk_done', chunkIndex: index + 1, totalChunks: windows.length, lineCount: window.cues.length, reused: true });
      return {
        index,
        atoms: reused.atoms,
        storySegments: reused.storySegments,
        omissions: reused.omissions,
        segmentPlan: reused.segmentPlan,
        report,
      };
    }
    let atomResult;
    try {
      atomResult = await buildWindowAtoms(window, config, runner, 0);
    } catch (error) {
      const placeholderAtoms = window.cues.map((cue, cueIndex) => ({
        atomId: `A${String(cueIndex + 1).padStart(5, '0')}`,
        sourceRefs: [cue.id],
        meaningVi: '',
        facts: [],
        dependsOnPrevious: false,
        dependsOnNext: false,
        uncertain: true,
      }));
      const errors = error.validation?.errors || [error.message || String(error)];
      const report = {
        windowId: window.id,
        start: window.start,
        end: window.end,
        valid: false,
        status: 'needs_review',
        errors,
        warnings: [],
        atomRepairAttempts: Number(config.storyRepairMaxAttempts) || 2,
        repairAttempts: Number(config.storyRepairMaxAttempts) || 2,
      };
      await progress({ type: 'chunk_error', chunkIndex: index + 1, totalChunks: windows.length, error: errors.join(', ') });
      return {
        index,
        atoms: placeholderAtoms,
        storySegments: [],
        omissions: [],
        segmentPlan: [],
        report,
      };
    }
    const storyResult = await buildWindowStory(window, atomResult.atoms, config, runner, 0);
    const report = {
      windowId: window.id,
      start: window.start,
      end: window.end,
      atomRepairAttempts: atomResult.attempts,
      ...storyResult.validation,
    };
    if (storyResult.validation.valid) {
      await progress({ type: 'chunk_done', chunkIndex: index + 1, totalChunks: windows.length, lineCount: window.cues.length });
    } else {
      await progress({
        type: 'chunk_error',
        chunkIndex: index + 1,
        totalChunks: windows.length,
        error: storyResult.validation.errors.join(', '),
      });
    }
    return {
      index,
      atoms: atomResult.atoms,
      storySegments: storyResult.storySegments,
      omissions: storyResult.omissions,
      segmentPlan: storyResult.segmentPlan,
      report,
    };
  });

  windowResults
    .sort((left, right) => left.index - right.index)
    .forEach((result) => {
      const atomIdMap = new Map();
      result.atoms.forEach((atom, atomIndex) => {
        atomIdMap.set(atom.atomId, `A${String(allAtoms.length + atomIndex + 1).padStart(5, '0')}`);
      });
      const segmentIdMap = new Map();
      result.storySegments.forEach((segment, segmentIndex) => {
        const id = `V${String(allStorySegments.length + segmentIndex + 1).padStart(5, '0')}`;
        segmentIdMap.set(segment.segmentId || segment.id, id);
      });
      const planIdMap = new Map();
      (result.segmentPlan || []).forEach((plan, planIndex) => {
        planIdMap.set(plan.planId, `P${String(allSegmentPlan.length + planIndex + 1).padStart(5, '0')}`);
      });
      allAtoms.push(...result.atoms.map((atom) => ({
        ...atom,
        atomId: atomIdMap.get(atom.atomId) || atom.atomId,
      })));
      const planStart = allSegmentPlan.length;
      allSegmentPlan.push(...(result.segmentPlan || []).map((plan, planIndex) => {
        const planId = planIdMap.get(plan.planId) || plan.planId;
        return {
          ...plan,
          planId,
          atomIds: (plan.atomIds || []).map((atomId) => atomIdMap.get(atomId) || atomId),
          index: planStart + planIndex,
        };
      }));
      allStorySegments.push(...result.storySegments.map((segment) => {
        const segmentId = segmentIdMap.get(segment.segmentId || segment.id) || segment.segmentId || segment.id;
        return {
          ...segment,
          segmentId,
          id: segmentId,
          planId: planIdMap.get(segment.planId) || segment.planId,
          atomIds: (segment.atomIds || []).map((atomId) => atomIdMap.get(atomId) || atomId),
        };
      }));
      allOmissions.push(...result.omissions.map((item) => ({
        ...item,
        atomIds: (item.atomIds || []).map((atomId) => atomIdMap.get(atomId) || atomId),
      })));
      windowReports.push(result.report);
    });

  const storyText = cleanText(allStorySegments.map((segment) => segment.text).join(' '));
  const globalValidation = validateStoryResult({
    sourceCues,
    atoms: allAtoms,
    storyText,
    storySegments: allStorySegments,
    omissions: allOmissions,
    segmentPlan: allSegmentPlan,
  }, config);
  const invalidWindows = windowReports.filter((report) => !report.valid);
  const windowWarnings = windowReports.flatMap((report) => (
    (report.warnings || []).map((warning) => `${report.windowId}:${warning}`)
  ));
  const validationErrors = [
    ...globalValidation.errors,
    ...invalidWindows.flatMap((report) => report.errors.map((error) => `${report.windowId}:${error}`)),
  ];
  const validationWarnings = [
    ...globalValidation.warnings,
    ...windowWarnings,
  ];
  const validation = {
    ...globalValidation,
    valid: globalValidation.valid && invalidWindows.length === 0,
    status: globalValidation.valid && invalidWindows.length === 0
      ? (windowReports.some((report) => report.verifierTimedOut) ? 'verified_with_warnings' : 'verified')
      : 'needs_review',
    errors: validationErrors,
    warnings: validationWarnings,
    repairAttempts: windowReports.reduce((sum, report) => sum + (Number(report.repairAttempts) || 0), 0),
    windows: windowReports,
  };
  const storySegments = allStorySegments.map((segment) => ({
    ...segment,
    status: validation.valid ? 'verified' : (segment.status === 'verified' ? 'needs_review' : segment.status),
  }));

  return {
    schemaVersion: 'story_translation_v2',
    translationMode: 'story_v2',
    sourceCues,
    meaningAtoms: allAtoms,
    storyText,
    segmentPlan: allSegmentPlan,
    storySegments,
    omissions: allOmissions,
    validation,
    segments: storySegmentsToLegacySegments(storySegments, sourceCues),
  };
}

async function retranslateStorySegment(artifact = {}, segmentId = '', config = {}, dependencies = {}) {
  const sourceCues = normalizeStorySourceCues((artifact.sourceCues || []).map((cue) => ({
    ...cue,
    id: cue.originalId || cue.id,
    text: cue.textZh || cue.text,
    start: cue.start ?? Number(cue.startMs) / 1000,
    end: cue.end ?? Number(cue.endMs) / 1000,
  })));
  const sourceIdRemap = new Map((artifact.sourceCues || []).map((cue, index) => [sourceCues[index]?.id, String(cue.id)]));
  sourceCues.forEach((cue) => {
    cue.id = sourceIdRemap.get(cue.id) || cue.id;
  });
  const allAtoms = Array.isArray(artifact.meaningAtoms) ? artifact.meaningAtoms : [];
  const existingSegments = Array.isArray(artifact.storySegments) ? artifact.storySegments : [];
  const selected = existingSegments.find((segment) => String(segment.segmentId || segment.id) === String(segmentId));
  if (!selected) throw new Error(`Story segment not found: ${segmentId}`);
  const selectedAtomIds = new Set(selected.atomIds || []);
  const atoms = allAtoms.filter((atom) => selectedAtomIds.has(atom.atomId));
  if (!atoms.length) throw new Error(`Story segment has no mapped atoms: ${segmentId}`);
  const sourceIds = Array.from(new Set(atoms.flatMap((atom) => atom.sourceRefs || [])));
  const cueIndexes = sourceIds.map((id) => sourceCues.findIndex((cue) => cue.id === id)).filter((index) => index >= 0);
  if (!cueIndexes.length) throw new Error(`Story segment has no mapped source cues: ${segmentId}`);
  const first = Math.min(...cueIndexes);
  const last = Math.max(...cueIndexes);
  const window = {
    id: `REPAIR-${segmentId}`,
    cues: sourceCues.slice(first, last + 1),
    contextBefore: sourceCues.slice(Math.max(0, first - 2), first),
    contextAfter: sourceCues.slice(last + 1, last + 3),
    start: sourceCues[first].start,
    end: sourceCues[last].end,
  };
  const runner = dependencies.runCliTranslation || runCliTranslation;
  const replacement = await buildWindowStory(window, atoms, config, runner, 0);
  if (!replacement.validation.valid) {
    return { ...artifact, validation: replacement.validation };
  }
  replacement.storySegments = replacement.storySegments.map((segment, index) => ({
    ...segment,
    segmentId: index === 0 ? String(segmentId) : `${segmentId}-${String.fromCharCode(97 + index)}`,
    id: index === 0 ? String(segmentId) : `${segmentId}-${String.fromCharCode(97 + index)}`,
  }));
  const otherSegments = existingSegments.filter((segment) => String(segment.segmentId || segment.id) !== String(segmentId));
  const atomOrder = new Map(allAtoms.map((atom, index) => [atom.atomId, index]));
  const storySegments = [...otherSegments, ...replacement.storySegments]
    .sort((left, right) => (atomOrder.get(left.atomIds?.[0]) ?? Infinity) - (atomOrder.get(right.atomIds?.[0]) ?? Infinity))
    .map((segment, index) => ({
      ...segment,
      planId: `P${String(index + 1).padStart(5, '0')}`,
    }));
  const omissions = [
    ...(artifact.omissions || []).filter((item) => !(item.atomIds || []).some((id) => selectedAtomIds.has(id))),
    ...replacement.omissions,
  ];
  const storyText = cleanText(storySegments.map((segment) => segment.text).join(' '));
  const segmentPlan = segmentPlanFromStorySegments(storySegments, allAtoms);
  const validation = validateStoryResult({ sourceCues, atoms: allAtoms, storyText, storySegments, omissions, segmentPlan }, config);
  const normalizedSegments = storySegmentsToLegacySegments(storySegments, sourceCues);
  return {
    ...artifact,
    schemaVersion: 'story_translation_v2',
    translationMode: 'story_v2',
    sourceCues,
    storyText,
    segmentPlan,
    storySegments,
    omissions,
    validation,
    segments: normalizedSegments,
  };
}

module.exports = {
  ATOM_SYSTEM_PROMPT,
  STORY_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  buildAtomPrompt,
  buildStoryPrompt,
  buildVerifyPrompt,
  translateStorySegments,
  retranslateStorySegment,
};
