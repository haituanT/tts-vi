require('dotenv').config();
require('./helpers/modelCacheBootstrap').initModelCacheRoot();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fsNative = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');

const { fetchTranscript, validateTranscriptAvailability } = require('./transcript-fetcher');
const { resolveGoogleCloudConfig, getGoogleConfigStatus } = require('./services/configService');
const { createJob, updateJob, addLog, getJob, getJobPaths, listJobIds, readJson, writeJson } = require('./services/jobService');
const { extractVideoId, downloadVideo, extractAudio, createPreviewVideo } = require('./services/youtubeService');
const {
  pickAudioWithDialog,
  pickGoogleCredentialsWithDialog,
  pickLogoWithDialog,
  pickVideoWithTkinter,
  pickOutputFolderWithTkinter,
  validateLocalVideoPath,
  getFileInfo,
} = require('./services/localFileService');
const { checkFasterWhisper, checkFfmpeg, checkYtDlp, checkPython, checkTkinter, checkNodeDependencies } = require('./services/dependencyService');
const { checkGoogleCloudConfig } = require('./services/googlePreflightService');
const { resolvePythonExecutable } = require('./services/pythonRuntimeService');
const fasterWhisperService = require('./services/fasterWhisperService');
const groqSpeechService = require('./services/groqSpeechService');
const assemblyAiSpeechService = require('./services/assemblyAiSpeechService');
const {
  translateSegments,
  analyzeTranslationContext,
  parseSrtEntries,
  segmentsToSrt,
  srtEntriesToSegments,
} = require('./services/googleTranslateService');
const { translateStorySegments, retranslateStorySegment } = require('./services/storyTranslationService');
const { adaptLegacyTranslationArtifact } = require('./domain/storyTranslation');
const { getCliTranslationProviderStatus } = require('./services/cliTranslationService');
const { synthesizeAllSegments, listVoices, previewVoice } = require('./services/googleTtsService');
const standaloneTtsService = require('./services/standaloneTtsService');
const aimaxSrtBatchService = require('./services/aimaxSrtBatchService');
const { createAlignedAudio } = require('./services/syncService');
const { mergeVideoAndAudio, exportSrt, exportVtt } = require('./services/exportService');
const { resolveOutputConfig, saveExportCopy, publishJobArtifacts, sanitizePathSegment } = require('./services/outputService');
const {
  alignTranslatedUnitsById,
  assertSourceCoverage,
  buildTranslationUnits: buildPipelineTranslationUnits,
  buildTtsUnits: buildPipelineTtsUnits,
  mapTranslatedUnitsToMergedDisplayRows,
  mapTranslatedUnitsToDisplayRows,
} = require('./domain/timelinePipeline');
const { applyPlanToUnits, planTtsFit } = require('./domain/ttsFitPlanner');
const {
  createReadabilityQcReport,
  createSyncQcReport,
  createTimelineQcReport,
  createTranslationQcReport,
  createTtsQcReport,
} = require('./domain/qcReport');
const { createQcSummary } = require('./domain/qcSummary');
const {
  buildMeaningUnits,
  buildTranslationPackets,
  sourceSegmentsFromTranslated,
  splitLongTranslatedDisplaySegments,
  ttsTextFromTranslation,
} = require('./services/timelineService');
const { buildPhraseSegments, summarizePhrasePlan } = require('./services/phraseService');
const {
  buildSubtitleTemplateGroups,
  templateArtifactPaths,
} = require('./services/subtitleTemplateService');
const {
  shouldUseTemplateGroupTranslation,
  translateTemplateGroups,
} = require('./services/subtitleTemplateTranslationService');
const {
  repairTtsOverflowTranslations,
  TTS_OVERFLOW_REPAIR_PROMPT_VERSION,
} = require('./services/ttsOverflowRepairService');
const {
  MAX_REPAIR_PREVIEW_CUES,
  buildPreviewRepairResults,
  preparePreviewRepairItems,
  previewItemsToAimaxSegments,
} = require('./services/ttsRepairPreviewService');
const {
  containsReplacementCharacter,
  repairCommonReplacementCharacters,
} = require('./services/textEncodingRepair');
const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;
const LOCAL_FILE_PICKER_ENABLED = process.env.LOCAL_FILE_PICKER_ENABLED !== 'false';
const activeJobOperations = new Map();
let nextJobOperationSequence = 1;
const ACTIVE_OPERATION_STALE_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.DUBFLOW_ACTIVE_OPERATION_STALE_MS) || 6 * 60 * 60 * 1000
);
const ACTIVE_OPERATION_FORCE_RELEASE_MS = Math.max(
  1000,
  Number(process.env.DUBFLOW_ACTIVE_OPERATION_FORCE_RELEASE_MS) || 5000
);
const TTS_PROVIDER_TESTS = [
  { provider: 'edge_tts', label: 'Edge TTS' },
  { provider: 'aimax_tts', label: 'AIMAX Clone' },
  { provider: 'google_cloud_tts', label: 'Google Cloud TTS' },
];
const TTS_PROVIDER_TEST_SEGMENT_LIMIT = 2;
const TTS_PROVIDER_TEST_TEXT_LIMIT = 1200;
const TTS_TIMING_TRACE_OVERFLOW_SECONDS = 0.02;
const TTS_TIMING_MAJOR_OVERFLOW_SECONDS = 1.0;
const TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS = 1.0;
const TTS_TIMING_START_DRIFT_SECONDS = 0.04;
const AUTO_ANTI_OVERFLOW_MAX_SPEAKING_RATE = 1.6;
const AUTO_ANTI_OVERFLOW_TARGET_GUARD_SECONDS = 0.5;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
const staticMediaOptions = {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (/\.mp4$/i.test(filePath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline');
    }
    if (/\.wav$/i.test(filePath)) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', 'inline');
    }
    if (/\.mp3$/i.test(filePath)) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', 'inline');
    }
  },
};
app.use('/jobs', express.static(path.join(__dirname, 'jobs'), staticMediaOptions));
app.use('/downloads', express.static(path.join(__dirname, 'downloads'), staticMediaOptions));

function localFileContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
  }[ext] || 'application/octet-stream';
}

app.get('/api/local-file', async (req, res) => {
  try {
    const filePath = String(req.query.path || '').trim();
    if (!filePath) {
      return res.status(400).json({ success: false, message: 'Missing local file path.' });
    }
    const absolutePath = path.resolve(filePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return res.status(400).json({ success: false, message: 'Local path is not a file.' });
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', localFileContentType(absolutePath));
    res.setHeader('Content-Disposition', 'inline');
    fsNative.createReadStream(absolutePath).pipe(res);
  } catch (error) {
    res.status(404).json({ success: false, message: 'Local file is not available.', detail: error.message });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'DubFlow Backend API',
    message: 'Backend is running.',
    mode: 'desktop',
    note: 'Use the DubFlow desktop app. This port is for local API routes only.',
  });
});

const PROJECT_SKILL_NAMES = new Set([
  'subtitle-cue-grouping',
  'subtitle-translation-prompt',
  'subtitle-tts-overflow-repair',
]);

async function readProjectSkill(skillName) {
  if (!PROJECT_SKILL_NAMES.has(skillName)) {
    const error = new Error('Unknown skill.');
    error.statusCode = 404;
    throw error;
  }
  const candidates = [
    path.join(__dirname, '..', '.codex', 'skills', skillName, 'SKILL.md'),
    path.join(os.homedir(), '.codex', 'skills', skillName, 'SKILL.md'),
  ];
  let lastError = null;
  for (const skillPath of candidates) {
    try {
      return {
        path: skillPath,
        content: await fs.readFile(skillPath, 'utf8'),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Skill file is not available.');
}

app.get('/api/skills/:skillName', async (req, res) => {
  try {
    const skillName = String(req.params.skillName || '').trim();
    const skill = await readProjectSkill(skillName);
    res.json({
      success: true,
      name: skillName,
      path: skill.path,
      content: skill.content,
    });
  } catch (error) {
    res.status(error.statusCode || 404).json({
      success: false,
      message: 'Skill file is not available in this project.',
      detail: error.message,
    });
  }
});

const STAGES = {
  CREATED: { percent: 0, stage: 'job_created', message: 'Job created' },
  VALIDATING: { percent: 5, stage: 'validating_input', message: 'Validating input' },
  DEPENDENCIES: { percent: 10, stage: 'checking_dependencies', message: 'Checking dependencies' },
  PREPARING_SOURCE: { percent: 15, stage: 'preparing_source_video', message: 'Preparing source video' },
  EXTRACTING_AUDIO: { percent: 25, stage: 'extracting_audio', message: 'Extracting audio' },
  TRANSCRIBING: { percent: 40, stage: 'speech_to_text', message: 'Running speech-to-text' },
  TRANSLATING: { percent: 55, stage: 'translating_transcript', message: 'Translating transcript' },
  SYNTHESIZING: { percent: 70, stage: 'generating_tts_audio', message: 'Generating TTS audio' },
  SYNCING: { percent: 82, stage: 'syncing_audio', message: 'Syncing audio' },
  EXPORTING: { percent: 92, stage: 'exporting_video', message: 'Exporting video and artifacts' },
  COMPLETED: { percent: 100, stage: 'completed', message: 'Video processed successfully' },
};

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

function buildError(code, message, detail, suggestion) {
  return {
    error: true,
    code,
    message,
    detail,
    suggestion,
  };
}

function roundMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function ensurePathInsideJobRoot(paths, targetPath) {
  const relativePath = path.relative(paths.root, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to clear path outside job root: ${targetPath}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWindowsFileLock(error) {
  return ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code);
}

async function rmWithRetry(targetPath, options = {}) {
  const maxAttempts = Number(process.env.DUBFLOW_RM_RETRY_ATTEMPTS) || 24;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(targetPath, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFileLock(error) || attempt >= maxAttempts) {
        break;
      }
      await sleep(Math.min(2500, 150 * attempt));
    }
  }

  throw lastError;
}

function formatOperationAge(startedAt = Date.now()) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (ageSeconds < 90) return `${ageSeconds}s`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 90) return `${ageMinutes}m`;
  return `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`;
}

function clearOperationReleaseTimer(active) {
  if (active?.releaseTimer) {
    clearTimeout(active.releaseTimer);
    active.releaseTimer = null;
  }
}

function releaseActiveJobOperation(jobId, active, reason) {
  const current = activeJobOperations.get(jobId);
  if (!current || current.operationId !== active.operationId) return false;
  clearOperationReleaseTimer(active);
  activeJobOperations.delete(jobId);
  console.warn(`[job-lock] Released ${active.label} for ${jobId}: ${reason}`);
  return true;
}

function requestActiveJobOperationCancel(jobId, active, reason, forceReleaseMs = ACTIVE_OPERATION_FORCE_RELEASE_MS) {
  if (!active || active.finished) return;
  active.cancelRequestedAt = active.cancelRequestedAt || Date.now();
  active.cancelReason = active.cancelReason || reason;
  if (!active.controller?.signal?.aborted) {
    active.controller?.abort();
  }

  if (!active.releaseTimer) {
    active.releaseTimer = setTimeout(() => {
      releaseActiveJobOperation(jobId, active, `cancel did not settle after ${forceReleaseMs}ms`);
    }, forceReleaseMs);
    active.releaseTimer.unref?.();
  }
}

function activeJobOperationIsStale(active) {
  if (!active) return false;
  if (active.controller?.signal?.aborted && active.cancelRequestedAt) {
    return Date.now() - active.cancelRequestedAt >= ACTIVE_OPERATION_FORCE_RELEASE_MS;
  }
  return Date.now() - active.startedAt >= ACTIVE_OPERATION_STALE_MS;
}

function attachResponseAbort(jobId, active, response) {
  if (!response?.once) return () => {};
  const onClose = () => {
    if (active.finished || response.writableEnded) return;
    requestActiveJobOperationCancel(jobId, active, 'client disconnected');
  };
  response.once('close', onClose);
  return () => response.off?.('close', onClose);
}

async function runExclusiveJobOperation(jobId, label, task, options = {}) {
  const active = activeJobOperations.get(jobId);
  if (active) {
    if (activeJobOperationIsStale(active)) {
      requestActiveJobOperationCancel(jobId, active, 'stale lock replaced', 1);
      releaseActiveJobOperation(jobId, active, 'stale lock replaced');
    } else {
      const cancelText = active.cancelRequestedAt
        ? ` Cancel was requested ${formatOperationAge(active.cancelRequestedAt)} ago.`
        : '';
      throw new Error(`Job ${jobId} is already running ${active.label} for ${formatOperationAge(active.startedAt)}.${cancelText} Wait for it to finish before starting ${label}.`);
    }
  }

  const controller = new AbortController();
  const operationId = `${Date.now()}-${nextJobOperationSequence++}`;
  const activeOperation = {
    operationId,
    label,
    startedAt: Date.now(),
    cancelRequestedAt: 0,
    cancelReason: '',
    finished: false,
    releaseTimer: null,
    controller,
  };
  activeJobOperations.set(jobId, activeOperation);
  const detachResponseAbort = attachResponseAbort(jobId, activeOperation, options.response);

  try {
    return await task(controller.signal);
  } finally {
    activeOperation.finished = true;
    clearOperationReleaseTimer(activeOperation);
    detachResponseAbort();
    const current = activeJobOperations.get(jobId);
    if (current?.operationId === operationId) {
      activeJobOperations.delete(jobId);
    }
  }
}

function normalizeOcrProvider(value) {
  return 'rapidocr';
}

async function resetJobDirectory(paths, targetPath) {
  ensurePathInsideJobRoot(paths, targetPath);
  await rmWithRetry(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}

async function resetManualArtifacts(paths, keys = []) {
  const targets = keys.map((key) => paths[key]).filter(Boolean);
  for (const target of targets) {
    await resetJobDirectory(paths, target);
  }
}

async function resetManualTtsArtifacts(paths, options = {}) {
  const preserveAimaxSrtBatches = options.preserveAimaxSrtBatches === true;
  ensurePathInsideJobRoot(paths, paths.tts);
  await fs.mkdir(paths.tts, { recursive: true });
  const entries = await fs.readdir(paths.tts, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (preserveAimaxSrtBatches && entry.name === 'aimax_srt_batches') {
      continue;
    }
    const targetPath = path.join(paths.tts, entry.name);
    ensurePathInsideJobRoot(paths, targetPath);
    await rmWithRetry(targetPath, { recursive: true, force: true });
  }
}

async function removeJobFile(paths, targetPath) {
  ensurePathInsideJobRoot(paths, targetPath);
  await fs.rm(targetPath, { force: true }).catch(() => {});
}

async function clearManualVideoArtifacts(paths) {
  const entries = await fs.readdir(paths.exports).catch(() => []);
  await Promise.all(entries
    .filter((entry) => /\.(mp4|mkv|avi|mov|webm)$/i.test(entry))
    .map((entry) => removeJobFile(paths, path.join(paths.exports, entry))));
}

async function saveManualSourceTranscript(paths, sourceSegments, patch = {}) {
  if (!sourceSegments.length) return;
  await fs.mkdir(paths.transcripts, { recursive: true });

  const existing = await readJson(paths.transcriptJson, {});
  const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
  await exportSrt(sourceSegments, sourceSegmentedSrtPath);

  await writeJson(paths.transcriptJson, {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...patch,
    sourceSegmentedSrtPath,
    segmentedSegmentCount: sourceSegments.length,
    sourceSegments,
    segments: sourceSegments,
  });
}

function joinCleanCueTexts(cues = []) {
  return cues
    .map((cue) => String(cue?.text || '').replace(/\s+/g, ' ').trim())
    .filter((text) => text && !containsReplacementCharacter(text))
    .join(' ')
    .trim();
}

function segmentSourceIds(segment = {}) {
  const ids = Array.isArray(segment.sourceIds) && segment.sourceIds.length
    ? segment.sourceIds
    : (Array.isArray(segment.sourceRowIds) ? segment.sourceRowIds : []);
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

function hasCorruptSegmentText(segment = {}) {
  return [
    segment.text,
    segment.sourceText,
    segment.originalText,
    segment.translatedText,
    segment.finalText,
  ].some((value) => containsReplacementCharacter(value));
}

async function hydrateTemplateGroupSourceSegments(paths, segments = []) {
  const transcriptJson = await readJson(paths.transcriptJson, {});
  const artifactPath = transcriptJson?.sourceTemplateGroupJsonPath || templateArtifactPaths(paths).jsonPath;
  const artifact = await readJson(artifactPath, null);
  if (!artifact || !Array.isArray(artifact.sourceCues)) {
    return segments;
  }

  const sourceCueById = new Map(artifact.sourceCues.map((cue) => [String(cue.id), cue]));
  const artifactSegments = Array.isArray(artifact.segments) ? artifact.segments : [];
  const artifactGroups = Array.isArray(artifact.groups) ? artifact.groups : [];
  const artifactById = new Map();
  const artifactBySourceKey = new Map();

  function rememberArtifact(item = {}) {
    const sourceIds = segmentSourceIds(item).length
      ? segmentSourceIds(item)
      : (Array.isArray(item.source_ids) ? item.source_ids.map(String) : []);
    const key = sourceIds.join('\u0001');
    for (const id of [item.id, item.groupId, item.group_id].filter(Boolean)) {
      artifactById.set(String(id), { ...item, sourceIds });
    }
    if (key) artifactBySourceKey.set(key, { ...item, sourceIds });
  }

  artifactSegments.forEach(rememberArtifact);
  artifactGroups.forEach(rememberArtifact);

  return segments.map((segment) => {
    const ids = segmentSourceIds(segment);
    const artifactMatch = artifactById.get(String(segment.id || ''))
      || artifactById.get(String(segment.groupId || segment.group_id || ''))
      || artifactBySourceKey.get(ids.join('\u0001'));
    const sourceIds = ids.length ? ids : (artifactMatch?.sourceIds || []);
    const cueObjects = Array.isArray(artifactMatch?.originalCues) && artifactMatch.originalCues.length
      ? artifactMatch.originalCues
      : sourceIds.map((id) => sourceCueById.get(String(id))).filter(Boolean);
    const cueText = joinCleanCueTexts(cueObjects);
    const artifactOriginalText = repairCommonReplacementCharacters(String(artifactMatch?.originalText || '').replace(/\s+/g, ' ').trim());
    const artifactSourceText = repairCommonReplacementCharacters(String(artifactMatch?.source_text || artifactMatch?.sourceText || artifactMatch?.text || '').replace(/\s+/g, ' ').trim());
    const fallbackText = cueText
      || (!containsReplacementCharacter(artifactOriginalText) ? artifactOriginalText : '')
      || (!containsReplacementCharacter(artifactSourceText) ? artifactSourceText : '');

    if (!fallbackText || (!hasCorruptSegmentText(segment) && Array.isArray(segment.originalCues) && segment.originalCues.length)) {
      return segment;
    }

    return {
      ...segment,
      text: fallbackText,
      sourceText: fallbackText,
      originalText: fallbackText,
      sourceIds,
      sourceRowIds: sourceIds,
      originalCues: cueObjects.map((cue) => ({
        id: String(cue.id || ''),
        start: Number(cue.start) || 0,
        end: Number(cue.end) || Number(cue.start) || 0,
        text: String(cue.text || '').replace(/\s+/g, ' ').trim(),
      })).filter((cue) => cue.id && cue.text),
    };
  });
}

function normalizeDuplicateText(text) {
  return normalizeSegmentText(text)
    .toLowerCase()
    .replace(/[.,!?;:\u3002\uff01\uff1f\uff1b\uff1a，、\s]+/g, '');
}

function areAdjacentDuplicateTexts(leftText, rightText) {
  const left = normalizeDuplicateText(leftText);
  const right = normalizeDuplicateText(rightText);
  if (left.length < 10 || right.length < 10) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 10 && longer.includes(shorter);
}

function collapseAdjacentDuplicateSegments(segments = []) {
  const output = [];
  for (const segment of segments) {
    const previous = output[output.length - 1];
    const gap = previous ? Math.max(0, (Number(segment.start) || 0) - (Number(previous.end) || 0)) : Infinity;
    if (previous && gap <= 0.25 && areAdjacentDuplicateTexts(previous.text, segment.text)) {
      const start = Math.min(Number(previous.start) || 0, Number(segment.start) || 0);
      const end = Math.max(Number(previous.end) || 0, Number(segment.end) || 0);
      const previousText = normalizeSegmentText(previous.text);
      const currentText = normalizeSegmentText(segment.text);
      output[output.length - 1] = {
        ...previous,
        text: currentText.length > previousText.length ? currentText : previousText,
        end: Number(end.toFixed(3)),
        duration: Number(Math.max(0.1, end - start).toFixed(3)),
        sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(segment.sourceSegmentCount) || 1),
      };
      continue;
    }
    output.push(segment);
  }
  return output.map((segment, index) => ({ ...segment, index }));
}

async function failOrphanedJobsOnStartup() {
  const jobIds = await listJobIds();
  const now = new Date().toISOString();

  for (const jobId of jobIds) {
    let job;
    try {
      job = await getJob(jobId);
    } catch {
      continue;
    }

    if (!job || !['queued', 'running'].includes(job.status)) {
      continue;
    }

    const error = buildError(
      'BACKEND_RESTARTED',
      'The backend restarted while this job was running.',
      'Previous backend process stopped before the job could finish.',
      'Start the job again. If you are running nodemon, ignore Backend/jobs and Backend/downloads from watch mode.'
    );

    await updateJob(jobId, {
      status: 'failed',
      percent: 100,
      stage: 'failed',
      message: error.message,
      logs: [
        ...(job.logs || []),
        {
          time: now,
          level: 'error',
          message: error.detail,
        },
      ],
      error: {
        code: error.code,
        message: error.message,
        detail: error.detail,
        suggestion: error.suggestion,
      },
    });
  }
}

function classifyError(error) {
  const detail = error.message || String(error);
  const normalizedDetail = detail.toLowerCase();

  if (normalizedDetail.includes('operation canceled') || normalizedDetail.includes('operation aborted')) {
    return buildError(
      'OPERATION_CANCELED',
      'Operation was canceled.',
      detail,
      'Start the task again when you are ready.'
    );
  }

  if (detail.includes('LOCAL_FILE_PICKER_UNAVAILABLE')) {
    return buildError(
      'TKINTER_UNAVAILABLE',
      'Python tkinter is not available. Install Python with tkinter support or paste local path manually.',
      detail,
      'Install Python from python.org with tkinter support, then retry the local file picker.'
    );
  }

  if (detail.includes('LOCAL_FOLDER_PICKER_UNAVAILABLE') || detail.includes('LOCAL_FOLDER_PICKER_FAILED')) {
    return buildError(
      'FOLDER_PICKER_UNAVAILABLE',
      'Folder picker is unavailable.',
      detail,
      'Install Python with tkinter support, then retry choosing the output folder.'
    );
  }

  if (detail.includes('LOCAL_FOLDER_NOT_FOUND')) {
    return buildError(
      'LOCAL_FOLDER_NOT_FOUND',
      'The selected output folder does not exist.',
      detail,
      'Choose an existing output folder.'
    );
  }

  if (detail.includes('LOCAL_FILE_NOT_FOUND')) {
    return buildError(
      'LOCAL_FILE_NOT_FOUND',
      'The selected local video path does not exist.',
      detail,
      'Choose a valid local file with the picker or paste an existing absolute path.'
    );
  }

  if (detail.includes('LOCAL_FILE_UNSUPPORTED_FORMAT')) {
    return buildError(
      'LOCAL_FILE_UNSUPPORTED_FORMAT',
      'The selected local video format is not supported.',
      detail,
      'Use .mp4, .mkv, .mov, .avi, .webm, or .m4v.'
    );
  }

  if (detail.includes('yt-dlp')) {
    return buildError(
      'YT_DLP_MISSING',
      'yt-dlp was not found. Install yt-dlp or use Local File mode.',
      detail,
      'Install yt-dlp and make sure it is available in PATH.'
    );
  }

  if (detail.includes('FFmpeg')) {
    return buildError(
      'FFMPEG_MISSING',
      'FFmpeg was not found. Install FFmpeg and make sure it is available in PATH.',
      detail,
      'Install FFmpeg, add it to PATH, then restart the backend.'
    );
  }

  if (detail.includes('Missing Google Cloud credentials')) {
    return buildError(
      'GOOGLE_CREDENTIALS_MISSING',
      'Google Cloud credentials are missing.',
      detail,
      'Use backend .env, a service account path, or paste a valid API key for local testing.'
    );
  }

  if (detail.includes('No source SRT is available')) {
    return buildError(
      'SOURCE_SUBTITLE_MISSING',
      'Không có phụ đề gốc để dịch.',
      detail,
      'Hãy tạo phụ đề gốc hoặc thêm SRT gốc trước khi chạy dịch phụ đề.'
    );
  }

  if (detail.includes('No translated subtitles are available')) {
    return buildError(
      'TRANSLATED_SUBTITLE_MISSING',
      'Không có phụ đề đã dịch để xử lý tiếp.',
      detail,
      'Hãy chạy Dịch phụ đề trước, hoặc nạp SRT dịch rồi thử lại.'
    );
  }

  if (detail.includes('No final subtitles are available for TTS')) {
    return buildError(
      'TTS_SUBTITLE_MISSING',
      'Không có nội dung phụ đề để lồng tiếng.',
      detail,
      'Hãy chạy Dịch phụ đề hoặc nhập/nạp phụ đề final trước khi bấm Lồng tiếng.'
    );
  }

  if (detail.includes('TTS sync failed')) {
    return buildError(
      'TTS_SYNC_FAILED',
      'TTS timing produced a warning.',
      detail,
      'Review the TTS timing report if you want tighter sync, then regenerate audio.'
    );
  }

  if (detail.includes('already running TTS generation')) {
    return buildError(
      'TTS_ALREADY_RUNNING',
      'TTS is already running for this job.',
      detail,
      'Wait for the current TTS task to finish before starting TTS again.'
    );
  }

  if (detail.includes('already running')) {
    return buildError(
      'JOB_OPERATION_ALREADY_RUNNING',
      'This job already has an active operation.',
      detail,
      'Wait for the current operation to finish or press Cancel before starting another one.'
    );
  }

  if (detail.includes('Faster Whisper STT failed')) {
    return buildError(
      'FASTER_WHISPER_STT_FAILED',
      'Faster Whisper local STT failed. Check local Python, model, audio file, and dependencies.',
      detail,
      'Verify Faster Whisper dependencies are installed and the extracted audio file is valid.'
    );
  }

  if (detail.includes('Groq STT')) {
    return buildError(
      'GROQ_STT_FAILED',
      'Groq STT failed. Check Groq API keys, model, quota, rate limits, and extracted audio.',
      detail,
      'Verify GROQ_API_KEY/GROQ_API_KEYS, use whisper-large-v3-turbo or whisper-large-v3, then retry.'
    );
  }

  if (detail.includes('Unsupported STT provider')) {
    return buildError(
      'UNSUPPORTED_STT_PROVIDER',
      'STT provider is not supported in this build.',
      detail,
      'Use Faster Whisper Local or Groq Whisper STT.'
    );
  }

  if (
    detail.includes('Codex CLI')
    || detail.includes('Antigravity CLI')
    || normalizedDetail.includes('cli timed out')
    || normalizedDetail.includes('codex_cli')
    || normalizedDetail.includes('antigravity_cli')
  ) {
    const isTimeout = normalizedDetail.includes('cli timed out') || normalizedDetail.includes('timed out');
    return buildError(
      isTimeout ? 'CLI_TRANSLATION_TIMEOUT' : 'CLI_TRANSLATION_FAILED',
      isTimeout
        ? 'CLI translation timed out. The selected CLI did not return a subtitle translation in time.'
        : 'CLI translation failed. Check the selected CLI login and availability.',
      detail,
      isTimeout
        ? 'Retry once, use a lighter CLI model if configured, or reduce CLI chunk size with DUBFLOW_CLI_TRANSLATION_CHUNK_SIZE.'
        : 'Confirm the selected CLI is installed, logged in, and usable from this machine, then retry.'
    );
  }

  if (detail.includes('Unsupported translation provider')) {
    return buildError(
      'UNSUPPORTED_TRANSLATION_PROVIDER',
      'Translation provider is not supported in this build.',
      detail,
      'Use Codex CLI or Antigravity CLI.'
    );
  }

  if (detail.includes('Translation failed') || detail.includes('translation failed')) {
    return buildError(
      'TRANSLATION_FAILED',
      'Translation failed. Check the selected translation provider.',
      detail,
      'Verify the selected provider settings, model availability, and target language, then retry.'
    );
  }

  if (
    detail.includes('edge_tts_helper.py')
    || detail.includes('No audio was received')
    || detail.includes('edge_tts.exceptions.NoAudioReceived')
    || detail.includes('Edge TTS')
  ) {
    return buildError(
      'EDGE_TTS_FAILED',
      'Edge TTS failed. Check selected voice, language code, and Edge TTS availability.',
      detail,
      'Verify the Edge voice name and language code, then retry loading voices or previewing the voice.'
    );
  }

  if (detail.includes('RapidOCR is not available') || normalizedDetail.includes('rapidocr')) {
    return buildError(
      'OCR_RUNTIME_MISSING',
      'RapidOCR is not installed in the active Python environment.',
      detail,
      'OCR will not download anything automatically. Install or restore the local OCR Python dependencies only when you choose to run OCR.'
    );
  }

  if ((detail.includes('AIMAX TTS') || detail.includes('AIMAX API')) && (
    normalizedDetail.includes('bad gateway')
    || normalizedDetail.includes('cloudflare')
    || normalizedDetail.includes('temporary aimax')
    || normalizedDetail.includes('server returned 502')
    || normalizedDetail.includes('server returned 503')
    || normalizedDetail.includes('server returned 504')
  )) {
    return buildError(
      'AIMAX_PROVIDER_UNAVAILABLE',
      'AIMAX server is temporarily unavailable.',
      detail,
      'DubFlow retried the AIMAX request, but the provider still returned a temporary server error. Wait a moment, then retry the TTS step.'
    );
  }

  if (detail.includes('AIMAX TTS') || detail.includes('AIMAX API')) {
    return buildError(
      'AIMAX_TTS_FAILED',
      'AIMAX TTS failed. Check AIMAX API key, cloned voice, quota, and language.',
      detail,
      'Set AIMAX_API_KEY in Backend/.env, reload the voice list, choose a uv_* voice, then retry.'
    );
  }

  if (detail.includes('TTS failed')) {
    return buildError(
      'TTS_FAILED',
      'Text-to-speech failed. Check the selected TTS provider, voice, and language code.',
      detail,
      'Verify the selected TTS provider is available, reload the voice list, choose a matching voice, then retry.'
    );
  }

  if (detail.includes('EBUSY') || detail.includes('EPERM') || detail.includes('resource busy or locked')) {
    return buildError(
      'FILE_LOCKED',
      'A job file is temporarily locked by another process.',
      detail,
      'Wait a moment, close any preview that may be reading job files, then retry.'
    );
  }

  if (detail.includes('permission') || detail.includes('PERMISSION_DENIED') || detail.includes('API has not been used')) {
    return buildError(
      'GOOGLE_CLOUD_PERMISSION_ERROR',
      'Google Cloud access failed. Check API enablement, billing, and credentials.',
      detail,
      'Enable the required APIs, confirm billing, and verify the selected credentials.'
    );
  }

  if (detail.includes('Invalid YouTube URL')) {
    return buildError(
      'INVALID_YOUTUBE_URL',
      'The YouTube URL is invalid.',
      detail,
      'Paste a full YouTube watch URL and retry.'
    );
  }

  if (detail.includes('Dependency check timed out') || detail.includes('Input validation timed out')) {
    return buildError(
      'VALIDATION_TIMEOUT',
      'Input validation took too long and timed out.',
      detail,
      'Restart backend and run again. If it keeps happening, check Python/ffmpeg/yt-dlp accessibility in PATH.'
    );
  }

  return buildError(
    'DUBBING_FAILED',
    'Video processing failed.',
    detail,
    'Check the selected provider settings, local dependencies, input files, and logs.'
  );
}

async function updateStage(jobId, stageConfig, level = 'info', detailMessage = '') {
  await updateJob(jobId, {
    status: 'running',
    percent: stageConfig.percent,
    stage: stageConfig.stage,
    message: detailMessage || stageConfig.message,
  });
  await addLog(jobId, level, detailMessage || stageConfig.message);
}

async function getDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { windowsHide: true }
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function getFileStats(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function replaceTimelineVoiceRange(baseAudioPath, replacementAudioPath, outputPath, startSeconds, endSeconds, sampleRate = 32000) {
  const start = Math.max(0, Number(startSeconds) || 0);
  const end = Math.max(start + 0.05, Number(endSeconds) || start + 0.05);
  const tempPath = outputPath.replace(/\.wav$/i, '_row_rerun_tmp.wav');
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      baseAudioPath,
      '-i',
      replacementAudioPath,
      '-filter_complex',
      `[0:a]volume=enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':volume=0[base];[1:a]volume=enable='not(between(t,${start.toFixed(3)},${end.toFixed(3)}))':volume=0[repair];[base][repair]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,aresample=${sampleRate}[mix]`,
      '-map',
      '[mix]',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      tempPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  await fs.copyFile(tempPath, outputPath);
  await fs.rm(tempPath, { force: true }).catch(() => {});
  return outputPath;
}

function normalizeTimelineVoiceRanges(ranges = []) {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range) => {
      const start = Math.max(0, Number(range?.start ?? range?.startSeconds) || 0);
      const rawEnd = Number(range?.end ?? range?.endSeconds);
      const end = Number.isFinite(rawEnd) ? rawEnd : start + 0.05;
      return {
        start,
        end: Math.max(start + 0.05, end),
      };
    })
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start)
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end + 0.005) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

function timelineRangeExpression(ranges = []) {
  return normalizeTimelineVoiceRanges(ranges)
    .map((range) => `between(t,${range.start.toFixed(3)},${range.end.toFixed(3)})`)
    .join('+');
}

async function replaceTimelineVoiceRanges(baseAudioPath, replacementAudioPath, outputPath, ranges = [], sampleRate = 32000) {
  const normalizedRanges = normalizeTimelineVoiceRanges(ranges);
  if (!normalizedRanges.length) {
    return outputPath;
  }
  const rangeExpression = timelineRangeExpression(normalizedRanges);
  const tempPath = outputPath.replace(/\.wav$/i, `_repair_apply_tmp_${Date.now()}.wav`);
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      baseAudioPath,
      '-i',
      replacementAudioPath,
      '-filter_complex',
      `[0:a]volume=enable='${rangeExpression}':volume=0[base];[1:a]volume=enable='not(${rangeExpression})':volume=0[repair];[base][repair]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,aresample=${sampleRate}[mix]`,
      '-map',
      '[mix]',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      tempPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 30 }
  );
  await fs.copyFile(tempPath, outputPath);
  await fs.rm(tempPath, { force: true }).catch(() => {});
  return outputPath;
}

function createRepairPreviewId() {
  return `preview-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function normalizeRepairPreviewId(value = '') {
  const safe = sanitizePathSegment(value, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) {
    throw new Error('Missing TTS repair preview id. Run TTS preview for the repaired row before applying.');
  }
  return safe;
}

function repairPreviewArtifactPaths(paths, previewId) {
  const safePreviewId = normalizeRepairPreviewId(previewId);
  const previewDir = path.join(paths.tts, 'repair_preview', safePreviewId);
  ensurePathInsideJobRoot(paths, previewDir);
  return {
    previewId: safePreviewId,
    previewDir,
    batchWorkDir: path.join(previewDir, 'aimax_srt_batches'),
    audioPath: path.join(previewDir, 'repair_preview.wav'),
    srtPath: path.join(previewDir, 'repair_preview.srt'),
    reportPath: path.join(previewDir, 'repair_preview_report.json'),
  };
}

function normalizeRepairApplyText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRepairApplyItems(items = [], defaultPreviewId = '') {
  const normalized = [];
  const seen = new Set();
  for (const [inputIndex, item] of (Array.isArray(items) ? items : []).entries()) {
    const rowId = normalizeRepairApplyText(item?.row_id || item?.rowId || item?.id);
    if (!rowId || seen.has(rowId)) continue;
    const previewId = normalizeRepairApplyText(item?.preview_id || item?.previewId || defaultPreviewId);
    const repairedTranslation = normalizeRepairApplyText(
      item?.repaired_translation
      || item?.repairedTranslation
      || item?.repairText
      || item?.text
    );
    const start = Number(item?.start);
    const duration = Number(item?.duration);
    const end = Number(item?.end);
    const safeStart = Number.isFinite(start) ? start : 0;
    const safeEnd = Number.isFinite(end)
      ? end
      : safeStart + Math.max(0.1, Number.isFinite(duration) ? duration : 1);
    if (!previewId || !repairedTranslation || safeEnd <= safeStart) continue;
    seen.add(rowId);
    normalized.push({
      row_id: rowId,
      preview_id: previewId,
      input_index: inputIndex,
      index: Number(item?.index) || inputIndex + 1,
      start: roundMetric(safeStart),
      end: roundMetric(Math.max(safeStart + 0.05, safeEnd)),
      repaired_translation: repairedTranslation,
      tts_preview_status: normalizeRepairApplyText(item?.tts_preview_status || item?.ttsPreviewStatus),
    });
  }
  return normalized;
}

function ttsReportItemSourceIdsForApply(item = {}) {
  return Array.from(new Set([
    ...(Array.isArray(item.sourceRowIds) ? item.sourceRowIds : []),
    ...(Array.isArray(item.sourceIds) ? item.sourceIds : []),
    item.id,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function ttsReportItemTouchesApplyRows(item = {}, rowIds = new Set()) {
  return ttsReportItemSourceIdsForApply(item).some((id) => rowIds.has(String(id)));
}

function postSpeedMajorOverflowThreshold(item = {}, fallback = TTS_TIMING_MAJOR_OVERFLOW_SECONDS) {
  const postSpeed = Number(item.speedFactor) > 1.001;
  return postSpeed ? TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS : fallback;
}

function ttsReportApplyMetrics(item = {}) {
  const drift = Number(item.unplannedStartDriftSeconds ?? item.startDriftSeconds) || 0;
  const overflow = Math.max(
    Number(item.endOverflowSeconds) || 0,
    Number(item.overlapNextSeconds) || 0,
    Number(item.cueEndOverflowSeconds) || 0,
    Number(item.overflowAfterFitSeconds) || 0
  );
  const ttsError = item.ttsError === true || Boolean(item.errorCode);
  const timingWarning = ttsError
    || Math.abs(drift) > TTS_TIMING_START_DRIFT_SECONDS
    || overflow > TTS_TIMING_TRACE_OVERFLOW_SECONDS;
  return {
    timingWarning,
    overflowSeverity: overflow >= postSpeedMajorOverflowThreshold(item)
      ? 'major'
      : (overflow > TTS_TIMING_TRACE_OVERFLOW_SECONDS ? 'minor' : 'none'),
  };
}

function summarizeTtsApplyReport(report = {}) {
  const segments = Array.isArray(report?.segments) ? report.segments : [];
  const metrics = segments.map(ttsReportApplyMetrics);
  const failedSegmentCount = metrics.filter((item) => item.timingWarning).length;
  const minorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'minor').length;
  const majorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'major').length;
  return {
    ...report,
    segments,
    failedSegmentCount,
    overflowSegmentCount: minorOverflowSegmentCount + majorOverflowSegmentCount,
    minorOverflowSegmentCount,
    majorOverflowSegmentCount,
    strictPass: failedSegmentCount === 0,
  };
}

function mergeAppliedTtsRepairReport(previousReport = {}, appliedSegments = [], appliedRowIds = []) {
  const appliedIdSet = new Set(appliedRowIds.map(String));
  const previousSegments = Array.isArray(previousReport?.segments) ? previousReport.segments : [];
  const segments = [
    ...previousSegments.filter((item) => !ttsReportItemTouchesApplyRows(item, appliedIdSet)),
    ...appliedSegments,
  ].sort((left, right) => (
    (Number(left.expectedStartSeconds ?? left.actualStartSeconds) || 0)
    - (Number(right.expectedStartSeconds ?? right.actualStartSeconds) || 0)
  ));
  return summarizeTtsApplyReport({
    ...(previousReport && typeof previousReport === 'object' ? previousReport : {}),
    segments,
    message: 'Manual TTS audio updated with repaired cue preview audio.',
  });
}

function buildAppliedRepairReportSegment(item = {}, previewRow = {}) {
  const base = previewRow.report_segment && typeof previewRow.report_segment === 'object'
    ? previewRow.report_segment
    : {};
  const start = Number(item.start) || Number(previewRow.start) || 0;
  const end = Number(item.end) || Number(previewRow.end) || start + 0.1;
  const slotSeconds = Math.max(0.05, end - start);
  const audioSeconds = Math.max(
    0,
    Number(previewRow.audio_seconds)
    || Number(base.actualDurationSeconds)
    || Number(base.actualEndSeconds) - Number(base.actualStartSeconds)
    || slotSeconds
  );
  const actualStart = Number(base.actualStartSeconds ?? start);
  const actualEnd = Number(base.actualEndSeconds ?? (actualStart + audioSeconds));
  const endOverflow = Math.max(0, Number(previewRow.overflow_seconds) || Number(base.endOverflowSeconds) || Number(base.cueEndOverflowSeconds) || 0);
  return {
    ...base,
    id: item.row_id,
    sourceIds: [item.row_id],
    sourceRowIds: [item.row_id],
    index: Number(item.index || previewRow.cue_index || base.index) || 0,
    expectedStartSeconds: roundMetric(start),
    expectedEndSeconds: roundMetric(end),
    actualStartSeconds: roundMetric(actualStart),
    actualEndSeconds: roundMetric(actualEnd),
    startDriftSeconds: roundMetric(Number(base.startDriftSeconds) || 0),
    unplannedStartDriftSeconds: roundMetric(Number(base.unplannedStartDriftSeconds) || 0),
    expectedDurationSeconds: roundMetric(slotSeconds),
    availableSlotDurationSeconds: roundMetric(Number(previewRow.slot_seconds) || Number(base.availableSlotDurationSeconds) || slotSeconds),
    targetDurationSeconds: roundMetric(Number(base.targetDurationSeconds) || slotSeconds),
    actualDurationSeconds: roundMetric(audioSeconds),
    durationDeltaSeconds: roundMetric(Number(previewRow.delta_seconds) || (audioSeconds - slotSeconds)),
    cueEndOverflowSeconds: roundMetric(endOverflow),
    endOverflowSeconds: roundMetric(endOverflow),
    overlapNextSeconds: roundMetric(Number(base.overlapNextSeconds) || 0),
    overflowAfterFitSeconds: roundMetric(Number(base.overflowAfterFitSeconds) || endOverflow),
    ttsError: false,
    errorCode: '',
    errorMessage: '',
  };
}

function reportSegmentStartSeconds(segment = {}) {
  return roundMetric(Number(segment.expectedStartSeconds ?? segment.start ?? segment.actualStartSeconds) || 0);
}

function reportSegmentEndSeconds(segment = {}) {
  const start = reportSegmentStartSeconds(segment);
  const end = Number(segment.expectedEndSeconds ?? segment.end ?? segment.actualEndSeconds);
  return roundMetric(Number.isFinite(end) ? Math.max(start + 0.05, end) : start + 0.1);
}

function reportSegmentsInTimelineOrder(report = {}) {
  return (Array.isArray(report?.segments) ? report.segments : [])
    .map((segment) => ({ ...segment }))
    .sort((left, right) => (
      reportSegmentStartSeconds(left) - reportSegmentStartSeconds(right)
      || reportSegmentEndSeconds(left) - reportSegmentEndSeconds(right)
    ));
}

function findAimaxBatchForSegment(batchReport = {}, segment = {}) {
  const batchIndex = Number(segment.aimaxBatchIndex);
  if (!Number.isFinite(batchIndex)) return null;
  return (Array.isArray(batchReport?.batches) ? batchReport.batches : [])
    .find((batch) => Number(batch.index) === batchIndex) || null;
}

function aimaxClipPathForReportSegment(paths, batchReport = {}, segment = {}) {
  const batch = findAimaxBatchForSegment(batchReport, segment);
  const fileName = path.basename(String(segment.aimaxSegmentFileName || ''));
  const candidates = [];
  if (batch?.segmentsDir && fileName) {
    candidates.push(path.join(batch.segmentsDir, fileName));
  }
  if (batch?.segmentsDir && Number.isFinite(Number(segment.aimaxEntryIndex))) {
    const entryNumber = Number(segment.aimaxEntryIndex) + 1;
    candidates.push(path.join(batch.segmentsDir, `line_${String(entryNumber).padStart(3, '0')}.wav`));
    candidates.push(path.join(batch.segmentsDir, `line_${String(entryNumber).padStart(3, '0')}.mp3`));
    candidates.push(path.join(batch.segmentsDir, `line_${String(entryNumber).padStart(4, '0')}.wav`));
    candidates.push(path.join(batch.segmentsDir, `line_${String(entryNumber).padStart(4, '0')}.mp3`));
  }
  if (Array.isArray(batchReport?.batches) && Number.isFinite(Number(segment.index))) {
    const segmentIndex = Number(segment.index);
    for (const candidateBatch of batchReport.batches) {
      if (!candidateBatch?.segmentsDir) continue;
      const startCueIndex = Number(candidateBatch.startCueIndex) || 0;
      const endCueIndex = Number.isFinite(Number(candidateBatch.endCueIndex))
        ? Number(candidateBatch.endCueIndex)
        : startCueIndex + Math.max(0, Number(candidateBatch.cueCount) || 0) - 1;
      if (segmentIndex < startCueIndex || segmentIndex > endCueIndex) continue;
      const entryNumber = segmentIndex - startCueIndex + 1;
      candidates.push(path.join(candidateBatch.segmentsDir, `line_${String(entryNumber).padStart(3, '0')}.wav`));
      candidates.push(path.join(candidateBatch.segmentsDir, `line_${String(entryNumber).padStart(3, '0')}.mp3`));
      candidates.push(path.join(candidateBatch.segmentsDir, `line_${String(entryNumber).padStart(4, '0')}.wav`));
      candidates.push(path.join(candidateBatch.segmentsDir, `line_${String(entryNumber).padStart(4, '0')}.mp3`));
    }
  }
  if (batchReport?.cueClipDir && Number.isFinite(Number(segment.index))) {
    candidates.push(path.join(batchReport.cueClipDir, `cue_${String(Number(segment.index) + 1).padStart(5, '0')}.wav`));
  }

  for (const candidate of candidates) {
    try {
      ensurePathInsideJobRoot(paths, candidate);
      if (fsNative.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unsafe or stale paths and try the next candidate.
    }
  }
  return '';
}

function manualRowRerunClipOverrides(paths, rowReruns = []) {
  const overrides = new Map();
  for (const item of Array.isArray(rowReruns) ? rowReruns : []) {
    const rowId = String(item?.rowId || item?.row_id || '').trim();
    if (!rowId) continue;
    const candidates = [
      item?.clipPath,
      item?.replacementClipPath,
      item?.audioPath,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    for (const candidate of candidates) {
      try {
        ensurePathInsideJobRoot(paths, candidate);
        if (fsNative.existsSync(candidate)) {
          overrides.set(rowId, candidate);
          break;
        }
      } catch {
        // Ignore unsafe or stale rerun cache paths.
      }
    }
  }
  return overrides;
}

async function rebuildManualTtsFromAimaxClips({
  paths,
  outputPath,
  previousReport,
  previousBatchReport,
  previewReportsById,
  appliedRows,
  overrideClipByRowId = new Map(),
}) {
  const previousSegments = reportSegmentsInTimelineOrder(previousReport);
  if (!previousSegments.length || !previousBatchReport?.batches?.length) return null;

  const appliedIdSet = new Set((appliedRows || []).map((row) => String(row.rowId || row.row_id)));
  // A grouped AIMAX clip represents several display rows as one narration
  // unit.  A single-row preview cannot safely replace that whole clip.
  if (previousSegments.some((segment) => {
    const sourceIds = ttsReportItemSourceIdsForApply(segment);
    return sourceIds.length > 1 && sourceIds.some((id) => appliedIdSet.has(id));
  })) {
    return null;
  }
  const previewClipByRowId = new Map();
  for (const row of appliedRows || []) {
    const rowId = String(row.rowId || row.row_id || '');
    const overrideClipPath = String(overrideClipByRowId.get(rowId) || '').trim();
    const previewId = String(row.previewId || row.preview_id || '').trim();
    if (!previewId && overrideClipPath) {
      try {
        ensurePathInsideJobRoot(paths, overrideClipPath);
        if (fsNative.existsSync(overrideClipPath)) {
          previewClipByRowId.set(rowId, overrideClipPath);
          continue;
        }
      } catch {
        return null;
      }
      return null;
    }
    const previewReport = previewReportsById.get(previewId);
    const previewRow = (Array.isArray(previewReport?.rows) ? previewReport.rows : [])
      .find((candidate) => String(candidate.row_id) === rowId);
    const reportSegment = previewRow?.report_segment || {};
    const clipPath = aimaxClipPathForReportSegment(paths, previewReport, reportSegment);
    if (!clipPath) return null;
    previewClipByRowId.set(rowId, clipPath);
  }
  if (previewClipByRowId.size !== appliedIdSet.size) return null;

  const ttsSegments = [];
  const clips = [];
  for (let index = 0; index < previousSegments.length; index += 1) {
    const segment = previousSegments[index];
    const sourceIds = ttsReportItemSourceIdsForApply(segment);
    const repairRowId = sourceIds.find((id) => appliedIdSet.has(String(id)));
    const cachedRerunRowId = sourceIds.find((id) => overrideClipByRowId.has(String(id)));
    const clipPath = repairRowId
      ? previewClipByRowId.get(String(repairRowId))
      : (cachedRerunRowId ? overrideClipByRowId.get(String(cachedRerunRowId)) : '')
        || aimaxClipPathForReportSegment(paths, previousBatchReport, segment);
    if (!clipPath) return null;
    const start = reportSegmentStartSeconds(segment);
    const end = reportSegmentEndSeconds(segment);
    const id = String(segment.id || sourceIds[0] || `tts-${index + 1}`);
    ttsSegments.push({
      id,
      index,
      start,
      end,
      duration: roundMetric(Math.max(0.05, end - start)),
      text: String(segment.text || segment.finalText || segment.translatedText || id),
      sourceIds: sourceIds.length ? sourceIds : [id],
      sourceRowIds: sourceIds.length ? sourceIds : [id],
    });
    clips.push({
      id,
      index,
      path: clipPath,
      provider: 'aimax_tts',
      speakingRate: 1,
      ttsSpeakingRate: 1,
      ttsSpeedAppliedByProvider: true,
      allowPostTtsSpeedProcessing: false,
    });
  }

  const tempOutputPath = outputPath.replace(/\.wav$/i, `_repair_rebuild_tmp_${Date.now()}.wav`);
  const sourceDurationSeconds = await getDurationSeconds(outputPath);
  const aligned = await createAlignedAudio(ttsSegments, clips, tempOutputPath, {
    ttsProvider: 'aimax_tts',
    preserveTtsAudio: true,
    syncMode: 'strict',
    addSilenceGaps: true,
    voiceAlignShortClips: false,
    speedUpLongSegments: false,
    stretchShortClips: false,
    failOnStrictSync: false,
    normalizeLoudness: false,
    outputSampleRate: 32000,
    timelineDurationSeconds: sourceDurationSeconds,
  });
  if (!aligned?.outputPath || !await getFileStats(tempOutputPath)) {
    await fs.rm(tempOutputPath, { force: true }).catch(() => {});
    return null;
  }
  await fs.copyFile(tempOutputPath, outputPath);
  await fs.rm(tempOutputPath, { force: true }).catch(() => {});
  return aligned;
}

function toPublicJobUrl(jobId, absolutePath) {
  if (!jobId || !absolutePath) return null;
  const paths = getJobPaths(jobId);
  const root = `${path.join(__dirname, 'jobs')}${path.sep}`;
  if (!String(absolutePath).startsWith(root) && !String(absolutePath).startsWith(paths.root)) {
    return null;
  }
  const relativePath = path.relative(path.join(__dirname, 'jobs'), absolutePath).split(path.sep).join('/');
  return `/jobs/${relativePath}`;
}

async function updateManualTtsJobResult(jobId, paths, ttsResult = {}) {
  const current = await getJob(jobId).catch(() => null);
  const previousResult = current?.result && typeof current.result === 'object'
    ? current.result
    : {};
  const manifestPath = path.join(paths.tts, 'manual_tts_manifest.json');
  const audioPath = String(ttsResult.audioPath || '').trim();
  const srtPath = String(ttsResult.srtPath || '').trim();
  const reportPath = String(ttsResult.aimaxSrtBatchReportPath || ttsResult.ttsQcReportPath || '').trim();
  const audioReady = Boolean(audioPath) && Boolean(await getFileStats(audioPath));

  if (!audioReady) {
    await updateJob(jobId, {
      status: 'failed',
      percent: 70,
      stage: 'tts_failed',
      message: 'Manual TTS did not create playable audio.',
      error: 'Missing manual dubbed audio.',
      result: {
        ...previousResult,
        manualDubbedAudioPath: '',
        manualDubbedAudioUrl: '',
        manualTtsManifestPath: await fileExists(manifestPath) ? manifestPath : '',
        manualTtsManifestUrl: await fileExists(manifestPath) ? toPublicJobUrl(jobId, manifestPath) : '',
        ttsReportPath: reportPath,
        ttsReportUrl: reportPath ? toPublicJobUrl(jobId, reportPath) : '',
      },
    });
    return;
  }

  await updateJob(jobId, {
    status: 'completed',
    percent: 100,
    stage: 'voice',
    message: 'Manual TTS audio ready.',
    error: null,
    result: {
      ...previousResult,
      sourceVideoPath: previousResult.sourceVideoPath || (await fileExists(paths.sourceVideo) ? paths.sourceVideo : ''),
      transcriptJsonPath: previousResult.transcriptJsonPath || (await fileExists(paths.transcriptJson) ? paths.transcriptJson : ''),
      translatedJsonPath: previousResult.translatedJsonPath || (await fileExists(paths.translatedJson) ? paths.translatedJson : ''),
      manualDubbedAudioPath: audioPath,
      manualDubbedAudioUrl: toPublicJobUrl(jobId, audioPath),
      manualTtsManifestPath: await fileExists(manifestPath) ? manifestPath : '',
      manualTtsManifestUrl: await fileExists(manifestPath) ? toPublicJobUrl(jobId, manifestPath) : '',
      ttsSrtPath: srtPath,
      ttsSrtUrl: srtPath ? toPublicJobUrl(jobId, srtPath) : '',
      ttsReportPath: reportPath,
      ttsReportUrl: reportPath ? toPublicJobUrl(jobId, reportPath) : '',
    },
  });
}

function manualReportPaths(paths) {
  return {
    source: path.join(paths.transcripts, 'source_qc_report.json'),
    translation: path.join(paths.translations, 'translation_qc_report.json'),
    readability: path.join(paths.translations, 'readability_qc_report.json'),
    tts: path.join(paths.tts, 'tts_qc_report.json'),
    sync: path.join(paths.tts, 'sync_qc_report.json'),
    autoRepair: path.join(paths.tts, 'auto_tts_repair_report.json'),
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readQcReportEntry(jobId, key, reportPath) {
  const exists = Boolean(reportPath) && await fileExists(reportPath);
  const report = exists ? await readJson(reportPath, null) : null;
  return {
    key,
    exists,
    path: exists ? reportPath : '',
    url: exists ? toPublicJobUrl(jobId, reportPath) : '',
    report,
  };
}

async function buildManualQcSummary(jobId) {
  const paths = getJobPaths(jobId);
  const reportPaths = manualReportPaths(paths);
  const exportSyncReportPath = path.join(paths.exports, 'sync_qc_report.json');
  if (!await fileExists(reportPaths.sync) && await fileExists(exportSyncReportPath)) {
    reportPaths.sync = exportSyncReportPath;
  }
  const entries = {};
  for (const [key, reportPath] of Object.entries(reportPaths)) {
    entries[key] = await readQcReportEntry(jobId, key, reportPath);
  }
  return createQcSummary(jobId, entries);
}

async function writeReadabilityQcReport(paths, segments = [], config = {}) {
  await fs.mkdir(paths.translations, { recursive: true });
  const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
  await writeJson(readabilityQcReportPath, createReadabilityQcReport(segments, config));
  return readabilityQcReportPath;
}

function getVideoMimeType(filePath) {
  const extension = path.extname(filePath || '').toLowerCase();
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.mkv') return 'video/x-matroska';
  if (extension === '.avi') return 'video/x-msvideo';
  return 'video/mp4';
}

async function streamVideoFile(req, res, filePath) {
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;
  const mimeType = getVideoMimeType(filePath);
  const range = req.headers.range;

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    fsNative.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = String(range).replace(/bytes=/, '').split('-');
  const start = Number.parseInt(parts[0], 10);
  const end = parts[1] ? Number.parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, fileSize - 1);

  if (!Number.isFinite(start) || start >= fileSize || start < 0) {
    res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  const safeEnd = Math.min(Number.isFinite(end) ? end : fileSize - 1, fileSize - 1);
  const chunkSize = safeEnd - start + 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
    'Content-Length': chunkSize,
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
  });
  fsNative.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
}

function mapSegmentForClient(segment, index) {
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || (start + Math.max(0.1, Number(segment.duration) || 0.8));
  const mapped = {
    id: String(segment.id || segment.segmentId || `seg-${index + 1}`),
    index: index + 1,
    start,
    end,
    duration: Number(Math.max(0.1, end - start).toFixed(3)),
    text: String(segment.text || '').replace(/\s+/g, ' ').trim(),
    ttsText: String(segment.ttsText || '').replace(/\s+/g, ' ').trim(),
    originalText: String(segment.originalText || '').replace(/\s+/g, ' ').trim(),
    translatedText: String(segment.translatedText || segment.text || '').replace(/\s+/g, ' ').trim(),
    finalText: String(segment.finalText || segment.translatedText || segment.text || '').replace(/\s+/g, ' ').trim(),
  };
  if (Array.isArray(segment.sourceIds)) {
    mapped.sourceIds = segment.sourceIds.map(String).filter(Boolean);
  }
  if (Array.isArray(segment.sourceRowIds)) {
    mapped.sourceRowIds = segment.sourceRowIds.map(String).filter(Boolean);
  }
  if (segment.meaningUnitId) {
    mapped.meaningUnitId = String(segment.meaningUnitId);
  }
  if (segment.groupId) {
    mapped.groupId = String(segment.groupId);
  }
  if (segment.templateGroupCreatedBy) {
    mapped.templateGroupCreatedBy = String(segment.templateGroupCreatedBy);
  }
  if (segment.templateGroupReason) {
    mapped.templateGroupReason = String(segment.templateGroupReason);
  }
  if (Number.isFinite(Number(segment.templateGroupConfidence))) {
    mapped.templateGroupConfidence = Number(segment.templateGroupConfidence);
  }
  if (Array.isArray(segment.originalCues)) {
    mapped.originalCues = segment.originalCues.map((cue) => ({
      id: String(cue?.id || '').trim(),
      start: Number(cue?.start),
      end: Number(cue?.end),
      text: normalizeSegmentText(cue?.text),
    })).filter((cue) => cue.id && cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start);
  }
  if (Array.isArray(segment.words)) {
    const words = segment.words
      .map((word) => ({
        text: normalizeSegmentText(word?.text || word?.word),
        start: Number(word?.start),
        end: Number(word?.end),
      }))
      .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (words.length) {
      mapped.words = words;
    }
  }
  return mapped;
}

function normalizeClientSegments(rawSegments = []) {
  return (rawSegments || [])
    .map((segment, index) => mapSegmentForClient(segment, index))
    .filter((segment) => segment.text);
}

function prepareAimaxSrtBatchSubtitleRows(segments = [], config = {}) {
  const splitRows = splitLongTranslatedDisplaySegments(segments, {
    ...config,
    timelineOutputMaxChars: Math.min(52, Number(config.timelineOutputMaxChars || config.timelineMaxTranslatedChars || 52) || 52),
    timelineMaxTranslatedChars: Math.min(52, Number(config.timelineMaxTranslatedChars || config.timelineOutputMaxChars || 52) || 52),
    timelineOutputMaxCps: Math.min(13, Number(config.timelineOutputMaxCps || config.translationCharsPerSecond || 13) || 13),
  });
  return addTimingBudget(normalizeClientSegments(splitRows.map((segment, index) => ({
    ...segment,
    id: String(segment.id || `aimax-row-${index + 1}`),
    text: normalizeSegmentText(segment.finalText || segment.translatedText || segment.text || ''),
    translatedText: normalizeSegmentText(segment.translatedText || segment.finalText || segment.text || ''),
    finalText: normalizeSegmentText(segment.finalText || segment.translatedText || segment.text || ''),
    ttsText: normalizeSegmentText(segment.finalText || segment.translatedText || segment.text || segment.ttsText || ''),
  }))), {
    ...config,
    borrowGapSeconds: 0,
  }).map((segment, index) => ({ ...segment, index: index + 1 }));
}

function normalizeStoryDisplaySegments(storyArtifact = {}, config = {}) {
  const sourceById = new Map((storyArtifact.sourceCues || []).map((cue) => [String(cue.id), cue]));
  const segments = (storyArtifact.storySegments || []).map((segment, index) => {
    const mapped = mapSegmentForClient({
      ...segment,
      ttsText: segment.text,
      originalText: (segment.sourceIds || []).map((id) => sourceById.get(String(id))?.textZh).filter(Boolean).join(' '),
    }, index);
    return {
      ...mapped,
      segmentId: segment.segmentId || mapped.id,
      atomIds: Array.isArray(segment.atomIds) ? segment.atomIds.map(String) : [],
      sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String) : [],
      sourceRowIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String) : [],
      status: segment.status || storyArtifact.validation?.status || 'needs_review',
      validationStatus: segment.status || storyArtifact.validation?.status || 'needs_review',
    };
  });
  return addTimingBudget(segments, { ...config, borrowGapSeconds: 0 });
}

function storyTtsUnits(storyArtifact = {}, displaySegments = [], config = {}) {
  if (storyArtifact.validation?.valid !== true) return [];
  return addTimingBudget(displaySegments.map((segment, index) => ({
    ...segment,
    id: segment.id || `story-tts-${index + 1}`,
    index,
    text: segment.ttsText || segment.finalText || segment.text,
    ttsText: segment.ttsText || segment.finalText || segment.text,
    prosodyText: segment.ttsText || segment.finalText || segment.text,
    sourceSegmentCount: Array.isArray(segment.sourceIds) ? segment.sourceIds.length : 1,
  })), { ...config, borrowGapSeconds: 0 });
}

function storySourceCoverageReport(storyArtifact = {}) {
  const sourceIds = (storyArtifact.sourceCues || []).map((cue) => String(cue.id));
  const coveredIds = Array.from(new Set([
    ...(storyArtifact.meaningAtoms || []).flatMap((atom) => atom.sourceRefs || []),
    ...(storyArtifact.omissions || []).flatMap((item) => item.sourceIds || []),
  ].map(String)));
  const covered = new Set(coveredIds);
  const missingIds = sourceIds.filter((id) => !covered.has(id));
  return {
    sourceCount: sourceIds.length,
    uniqueCoveredCount: coveredIds.length,
    missingIds,
    duplicateIds: [],
    unknownIds: coveredIds.filter((id) => !sourceIds.includes(id)),
    orderValid: true,
    valid: missingIds.length === 0 && storyArtifact.validation?.valid === true,
  };
}

function shouldUseStoryTranslation(config = {}) {
  const source = String(config.sourceLanguage || '').trim().toLowerCase();
  const target = String(config.targetLanguage || '').trim().toLowerCase();
  const chineseSource = source === 'zh' || source.startsWith('zh-') || source.startsWith('cmn');
  return config.translationMode === 'story_v2' && chineseSource && target.startsWith('vi');
}

function extractWordTimestampSegments(rawSegments = []) {
  const segments = [];
  let wordCount = 0;

  for (const [index, segment] of (rawSegments || []).entries()) {
    const words = Array.isArray(segment?.words)
      ? segment.words
          .map((word) => ({
            text: normalizeSegmentText(word?.text || word?.word),
            start: Number(word?.start),
            end: Number(word?.end),
          }))
          .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
      : [];
    if (!words.length) continue;

    wordCount += words.length;
    const start = Number(segment.start) || words[0].start || 0;
    const end = Number(segment.end) || words[words.length - 1].end || start;
    segments.push({
      id: String(segment.id || segment.segmentId || `seg-${index + 1}`),
      index: index + 1,
      start,
      end,
      duration: Number(Math.max(0.1, end - start).toFixed(3)),
      text: normalizeSegmentText(segment.text || words.map((word) => word.text).join(' ')),
      words,
    });
  }

  return {
    segmentCount: segments.length,
    wordCount,
    segments,
  };
}

function cleanWordLevelText(text) {
  return normalizeSegmentText(text)
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1')
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+(\d)/gu, '$1$2')
    .replace(/(\d)\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1$2')
    .replace(/\s*([，。！？；：、])\s*/g, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function makeWordLevelSegment(words, index) {
  const validWords = (words || [])
    .map((word) => ({
      text: normalizeSegmentText(word?.text || word?.word),
      start: Number(word?.start),
      end: Number(word?.end),
    }))
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!validWords.length) return null;

  const start = validWords[0].start;
  const end = validWords[validWords.length - 1].end;
  const text = cleanWordLevelText(validWords.map((word) => word.text).join(' '));
  if (!text || end <= start) return null;
  return {
    id: `word-${index}`,
    index,
    text,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    duration: Number(Math.max(0.1, end - start).toFixed(3)),
    words: validWords,
  };
}

function buildWordLevelSegments(wordTimestampData = {}) {
  return (wordTimestampData.segments || [])
    .map((segment, index) => {
      const rebuilt = makeWordLevelSegment(segment.words || [], index + 1);
      if (!rebuilt) return null;
      return {
        ...rebuilt,
        id: String(segment.id || rebuilt.id || `word-${index + 1}`),
        index: index + 1,
      };
    })
    .filter(Boolean);
}

async function buildVideoLingoLikeSourceSegments(rawSegments, paths, config, jobId) {
  const inputPath = path.join(paths.transcripts, 'source_resegment_input.json');
  const outputPath = path.join(paths.transcripts, 'source_resegmented_nlp.srt');
  const reportPath = path.join(paths.transcripts, 'source_resegmented_nlp_report.json');
  const scriptPath = path.join(__dirname, 'scripts', 'videolingo_like_source_srt.py');
  await writeJson(inputPath, rawSegments);

  const python = resolvePythonExecutable();
  const lang = String(config.sourceLanguage || 'zh').split('-')[0] || 'zh';
  await execFileAsync(
    python,
    [
      scriptPath,
      '--strategy',
      'hybrid',
      '--lang',
      lang,
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--report',
      reportPath,
    ],
    {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 20,
    }
  );

  const srtContent = await fs.readFile(outputPath, 'utf8');
  const entries = parseSrtEntries(srtContent);
  const segments = normalizeClientSegments(srtEntriesToSegments(entries));
  if (!segments.length) {
    throw new Error('NLP re-segmentation produced no subtitle cues.');
  }
  if (jobId) {
    await addLog(jobId, 'success', `NLP re-segmented word timestamps into ${segments.length} subtitle cues.`);
  }
  return { segments, outputPath, reportPath };
}

async function buildBurnedSubtitleOcrSegments(videoPath, paths, config, jobId, abortSignal = undefined) {
  const outputPath = path.join(paths.transcripts, 'source_ocr.srt');
  const reportPath = path.join(paths.transcripts, 'source_ocr_report.json');
  const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
  const scriptPath = path.join(__dirname, 'scripts', 'ocr_burned_subtitles.py');
  const python = resolvePythonExecutable();
  const crop = config.ocrCrop && typeof config.ocrCrop === 'object' ? config.ocrCrop : {};
  const provider = normalizeOcrProvider(config.ocrProvider || config.provider);
  const fps = Math.max(0.1, Math.min(10, Number(config.ocrFps) || 2));
  const languageHints = Array.isArray(config.ocrLanguageHints)
    ? config.ocrLanguageHints.join(',')
    : String(config.ocrLanguageHints || config.sourceLanguage || 'zh,zh-Hans');


  await fs.mkdir(paths.transcripts, { recursive: true });
  const scriptArgs = [
      scriptPath,
      '--video',
      videoPath,
      '--output',
      outputPath,
      '--report',
      reportPath,
      '--provider',
      provider,
      '--fps',
      String(fps),
      '--crop-x',
      String(Number(crop.x ?? config.ocrCropX ?? 0) || 0),
      '--crop-y',
      String(Number(crop.y ?? config.ocrCropY ?? 0.72) || 0.72),
      '--crop-w',
      String(Number(crop.w ?? config.ocrCropW ?? 1) || 1),
      '--crop-h',
      String(Number(crop.h ?? config.ocrCropH ?? 0.24) || 0.24),
      '--language-hints',
      languageHints,
      '--similarity',
      String(Number(config.ocrMergeSimilarity ?? 0.86) || 0.86),
      '--max-empty-gap',
      String(Number(config.ocrMaxEmptyGap ?? 0.45) || 0.45),
      '--min-duration',
      String(Number(config.ocrMinDuration ?? 0.25) || 0.25),
    ];
  if (config.ocrSkipUnchanged !== false) {
    scriptArgs.push('--skip-unchanged');
  }
  if (config.ocrRequireCjk !== false) {
    scriptArgs.push('--require-cjk');
  }
  scriptArgs.push(
    '--change-threshold',
    String(Number(config.ocrChangeThreshold ?? 0.025) || 0.025),
    '--ocr-concurrency',
    String(Math.max(1, Math.min(32, Number(config.ocrConcurrency) || 8))),
    '--max-keyframe-gap',
    String(Math.max(0, Number(config.ocrMaxKeyframeGap ?? 1.5) || 0))
  );
  await execFileAsync(
    python,
    scriptArgs,
    {
      windowsHide: true,
      timeout: Math.max(120000, Number(config.ocrTimeoutMs) || 1800000),
      maxBuffer: 1024 * 1024 * 50,
      signal: abortSignal,
      env: {
        ...process.env,
      },
    }
  );

  const srtContent = await fs.readFile(outputPath, 'utf8');
  const entries = parseSrtEntries(srtContent);
  const segments = normalizeClientSegments(srtEntriesToSegments(entries));
  if (!segments.length) {
    throw new Error('OCR produced no subtitle cues. Check crop area/FPS or use Test OCR on another frame.');
  }
  await exportSrt(segments, sourceSegmentedSrtPath);

  let report = {};
  try {
    report = await readJson(reportPath, {});
  } catch {
    report = {};
  }

  if (jobId) {
    await addLog(jobId, 'success', `RapidOCR created ${segments.length} burned-subtitle cues. Scanned ${report.framesScanned || report.framesRequested || 0} frames, sent ${report.ocrRequests || report.framesProcessed || 0} OCR requests.`);
  }

  return {
    segments,
    outputPath,
    sourceSegmentedSrtPath,
    reportPath,
    report,
    srtContent: segmentsToSrt(segments),
  };
}

async function buildBurnedSubtitleKeyframeOcrSegments(videoPath, paths, config, jobId, abortSignal = undefined) {
  const outputPath = path.join(paths.transcripts, 'source_ocr_keyframe.srt');
  const reportPath = path.join(paths.transcripts, 'source_ocr_keyframe_report.json');
  const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
  const scriptPath = path.join(__dirname, 'scripts', 'ocr_burned_subtitles_keyframe.py');
  const python = resolvePythonExecutable();
  const crop = config.ocrCrop && typeof config.ocrCrop === 'object' ? config.ocrCrop : {};
  const provider = normalizeOcrProvider(config.ocrKeyframeProvider || config.ocrProvider || config.provider);
  const timelineFps = Math.max(1, Math.min(30, Number(config.ocrKeyframeTimelineFps ?? config.timelineFps ?? 15) || 15));
  const languageHints = Array.isArray(config.ocrLanguageHints)
    ? config.ocrLanguageHints.join(',')
    : String(config.ocrLanguageHints || config.sourceLanguage || 'zh,zh-Hans');

  const changeThresholdDefault = provider === 'rapidocr' ? 0.12 : 0.34;
  const suspiciousChangeDefault = provider === 'rapidocr' ? 0.32 : 0.26;
  const minTextDensityDefault = provider === 'rapidocr' ? 0.002 : 0.006;
  const verifyLongSecondsDefault = provider === 'rapidocr' ? 999 : 3.5;
  const sampleEverySecondsDefault = 0;
  const requestedOcrConcurrency = Math.max(1, Math.min(32, Number(config.ocrConcurrency) || 8));
  const ocrConcurrency = provider === 'rapidocr' ? 1 : requestedOcrConcurrency;
  const rapidocrUseDml = String(process.env.RAPIDOCR_USE_DML || (provider === 'rapidocr' ? '1' : '')).trim();

  await fs.mkdir(paths.transcripts, { recursive: true });
  const scriptArgs = [
    scriptPath,
    '--video',
    videoPath,
    '--output',
    outputPath,
    '--report',
    reportPath,
    '--provider',
    provider,
    '--timeline-fps',
    String(timelineFps),
    '--crop-x',
    String(Number(crop.x ?? config.ocrCropX ?? 0) || 0),
    '--crop-y',
    String(Number(crop.y ?? config.ocrCropY ?? 0.72) || 0.72),
    '--crop-w',
    String(Number(crop.w ?? config.ocrCropW ?? 1) || 1),
    '--crop-h',
    String(Number(crop.h ?? config.ocrCropH ?? 0.24) || 0.24),
    '--language-hints',
    languageHints,
    '--similarity',
    String(Number(config.ocrMergeSimilarity ?? 0.86) || 0.86),
    '--max-empty-gap',
    String(Number(config.ocrMaxEmptyGap ?? 0.35) || 0.35),
    '--min-duration',
    String(Number(config.ocrMinDuration ?? 0.12) || 0.12),
    '--change-threshold',
    String(Number(config.ocrKeyframeChangeThreshold ?? changeThresholdDefault) || changeThresholdDefault),
    '--suspicious-change',
    String(Number(config.ocrKeyframeSuspiciousChange ?? suspiciousChangeDefault) || suspiciousChangeDefault),
    '--min-text-density',
    String(Number(config.ocrKeyframeMinTextDensity ?? minTextDensityDefault) || minTextDensityDefault),
    '--verify-long-seconds',
    String(Number(config.ocrKeyframeVerifyLongSeconds ?? verifyLongSecondsDefault) || verifyLongSecondsDefault),
    '--sample-every-seconds',
    String(Math.max(0, Number(config.ocrKeyframeSampleEverySeconds ?? sampleEverySecondsDefault) || 0)),
    '--boundary-refine-window',
    String(Math.max(0, Math.min(1, Number(config.ocrKeyframeBoundaryRefineWindow ?? 0.16) || 0))),
    '--empty-confirm-frames',
    String(Math.max(1, Math.min(10, Number(config.ocrKeyframeEmptyConfirmFrames) || 2))),
    '--ocr-concurrency',
    String(ocrConcurrency),
  ];
  if (config.ocrRequireCjk !== false) {
    scriptArgs.push('--require-cjk');
  }

  const runKeyframeOcr = async (args, envOverrides = {}) => execFileAsync(
    python,
    args,
    {
      windowsHide: true,
      timeout: Math.max(120000, Number(config.ocrTimeoutMs) || 1800000),
      maxBuffer: 1024 * 1024 * 80,
      signal: abortSignal,
      env: {
        ...process.env,
        RAPIDOCR_USE_DML: provider === 'rapidocr' ? rapidocrUseDml : '',
        ...envOverrides,
      },
    }
  );

  try {
    await runKeyframeOcr(scriptArgs);
  } catch (error) {
    if (provider !== 'rapidocr' || abortSignal?.aborted) {
      throw error;
    }
    const retryArgs = [...scriptArgs];
    const concurrencyIndex = retryArgs.indexOf('--ocr-concurrency');
    if (concurrencyIndex >= 0 && concurrencyIndex + 1 < retryArgs.length) {
      retryArgs[concurrencyIndex + 1] = '1';
    }
    if (jobId) {
      await addLog(jobId, 'warn', 'RapidOCR keyframe OCR failed with the current runtime. Retrying on CPU with 1 worker...');
    }
    await runKeyframeOcr(retryArgs, {
      RAPIDOCR_USE_DML: '',
      RAPIDOCR_USE_CUDA: '',
    });
  }

  const srtContent = await fs.readFile(outputPath, 'utf8');
  const entries = parseSrtEntries(srtContent);
  const segments = normalizeClientSegments(srtEntriesToSegments(entries));
  if (!segments.length) {
    throw new Error('Keyframe OCR produced no subtitle cues. Check crop area or use Test OCR on another frame.');
  }
  await exportSrt(segments, sourceSegmentedSrtPath);

  let report = {};
  try {
    report = await readJson(reportPath, {});
  } catch {
    report = {};
  }

  if (jobId) {
    const providerLabel = 'RapidOCR';
    const timing = report.scanSeconds || report.ocrSeconds
      ? ` Scan ${report.scanSeconds || 0}s, OCR ${report.ocrSeconds || 0}s (${report.ocrWorkers || 1} workers).`
      : '';
    await addLog(jobId, 'success', `${providerLabel} keyframe OCR created ${segments.length} cues. Local scanned ${report.localFramesScanned || 0} frames, sent ${report.ocrRequests || 0} OCR requests.${timing}`);
  }

  return {
    segments,
    outputPath,
    sourceSegmentedSrtPath,
    reportPath,
    report,
    srtContent: segmentsToSrt(segments),
  };
}

async function testBurnedSubtitleOcrFrame(videoPath, paths, config, abortSignal = undefined) {
  const outputPath = path.join(paths.transcripts, 'ocr_crop_test.srt');
  const reportPath = path.join(paths.transcripts, 'ocr_crop_test_report.json');
  const previewImagePath = path.join(paths.transcripts, 'ocr_crop_test.jpg');
  const scriptPath = path.join(__dirname, 'scripts', 'ocr_burned_subtitles.py');
  const python = resolvePythonExecutable();
  const crop = config.ocrCrop && typeof config.ocrCrop === 'object' ? config.ocrCrop : {};
  const provider = normalizeOcrProvider(config.ocrProvider || config.provider);
  const timestamp = Math.max(0, Number(config.ocrTestTime ?? config.currentTime ?? 0) || 0);
  const languageHints = Array.isArray(config.ocrLanguageHints)
    ? config.ocrLanguageHints.join(',')
    : String(config.ocrLanguageHints || config.sourceLanguage || 'zh,zh-Hans');


  await fs.mkdir(paths.transcripts, { recursive: true });
  const scriptArgs = [
    scriptPath,
    '--video',
    videoPath,
    '--output',
    outputPath,
    '--report',
    reportPath,
    '--provider',
    provider,
    '--fps',
    '1',
    '--start',
    String(timestamp),
    '--end',
    String(timestamp + 0.001),
    '--crop-x',
    String(Number(crop.x ?? config.ocrCropX ?? 0) || 0),
    '--crop-y',
    String(Number(crop.y ?? config.ocrCropY ?? 0.72) || 0.72),
    '--crop-w',
    String(Number(crop.w ?? config.ocrCropW ?? 1) || 1),
    '--crop-h',
    String(Number(crop.h ?? config.ocrCropH ?? 0.24) || 0.24),
    '--language-hints',
    languageHints,
    '--preview-image',
    previewImagePath,
    '--progress-every',
    '0',
  ];

  await execFileAsync(
    python,
    scriptArgs,
    {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 20,
      signal: abortSignal,
      env: {
        ...process.env,
      },
    }
  );

  const report = await readJson(reportPath, {});
  const frame = Array.isArray(report.frames) ? report.frames.find((item) => item && item.time !== undefined) : null;
  return {
    report,
    reportPath,
    previewImagePath,
    text: String(frame?.text || ''),
    textOneLine: String(frame?.textOneLine || ''),
    confidence: Number(frame?.confidence || 0),
    time: timestamp,
  };
}

async function extractManualFramePreview(videoPath, paths, timeSeconds) {
  const outputPath = path.join(paths.transcripts, 'ocr_frame_picker.jpg');
  const reportPath = path.join(paths.transcripts, 'ocr_frame_picker_report.json');
  const scriptPath = path.join(__dirname, 'scripts', 'extract_video_frame.py');
  const python = resolvePythonExecutable();
  await fs.mkdir(paths.transcripts, { recursive: true });
  await execFileAsync(
    python,
    [
      scriptPath,
      '--video',
      videoPath,
      '--time',
      String(Math.max(0, Number(timeSeconds) || 0)),
      '--output',
      outputPath,
      '--report',
      reportPath,
    ],
    {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    }
  );
  const report = await readJson(reportPath, {});
  return {
    outputPath,
    reportPath,
    time: Number(report.time) || Math.max(0, Number(timeSeconds) || 0),
    width: Number(report.width) || 0,
    height: Number(report.height) || 0,
  };
}

function normalizeCaptionSegments(transcript) {
  return transcript.map((item) => {
    const start = Number(item.start) || 0;
    const duration = Number(item.duration) || Math.max(0.1, (Number(item.end) || start + 1) - start);
    return {
      text: item.text,
      start,
      end: Number(item.end) || start + duration,
      duration,
    };
  });
}

function normalizeSegmentText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeCjkJoinedText(text) {
  return normalizeSegmentText(text)
    .replace(/([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+(?=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g, '$1')
    .replace(/\s+([,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001])/g, '$1')
    .replace(/([,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001])\s+(?=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g, '$1');
}

function hasSentenceEnding(text) {
  return /[.!?\u3002\uff01\uff1f]\s*$/.test(normalizeSegmentText(text));
}

function hasStrongBoundary(text) {
  return /[.!?;:\u3002\uff01\uff1f\uff1b\uff1a]\s*$/.test(normalizeSegmentText(text));
}

function countWordsOrCjkUnits(text) {
  const cleaned = normalizeSegmentText(text);
  if (!cleaned) return 0;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.length;
  const cjkCount = (cleaned.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjkCount ? Math.ceil(cjkCount / 2) : words.length;
}

function createMeaningSegment(buffer, index) {
  const start = Math.min(...buffer.map((segment) => Number(segment.start) || 0));
  const end = Math.max(...buffer.map((segment) => Number(segment.end) || Number(segment.start) || 0));
  const text = normalizeSegmentText(buffer.map((segment) => segment.text).filter(Boolean).join(' '));
  return {
    index,
    text,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    duration: Number(Math.max(0.1, end - start).toFixed(3)),
    sourceSegmentCount: buffer.length,
  };
}

function addTimingBudget(segments, config) {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) || (start + Math.max(0.1, Number(segment.duration) || 0.1));
    const timelineDuration = end > start ? end - start : 0;
    const baseDuration = Math.max(0.1, Number(segment.duration) || 0, timelineDuration);
    const gapAfter = next ? Math.max(0, (Number(next.start) || 0) - end) : 0;
    const slotDuration = next
      ? Math.max(baseDuration, (Number(next.start) || 0) - start)
      : baseDuration;
    const borrowableGap = Math.min(gapAfter, Number(config.borrowGapSeconds) || 0);
    const allowedDuration = Math.max(0.1, baseDuration + borrowableGap);

    return {
      ...segment,
      duration: Number(baseDuration.toFixed(3)),
      gapAfter: Number(gapAfter.toFixed(3)),
      borrowableGap: Number(borrowableGap.toFixed(3)),
      slotDuration: Number(slotDuration.toFixed(3)),
      allowedDuration: Number(allowedDuration.toFixed(3)),
    };
  });
}

function splitTextByUnits(text = '', desiredParts = 1) {
  const clean = normalizeSegmentText(text);
  if (!clean || desiredParts <= 1) return [clean].filter(Boolean);

  const hasSpaces = /\s/.test(clean);
  const units = hasSpaces
    ? clean.split(/\s+/).filter(Boolean)
    : Array.from(clean);
  if (units.length <= desiredParts) return [clean];

  const parts = [];
  let cursor = 0;
  for (let index = 0; index < desiredParts; index += 1) {
    const remainingUnits = units.length - cursor;
    const remainingParts = desiredParts - index;
    const take = Math.max(1, Math.ceil(remainingUnits / remainingParts));
    const chunk = units.slice(cursor, cursor + take);
    cursor += take;
    parts.push(hasSpaces ? chunk.join(' ') : chunk.join(''));
  }
  return parts.map(normalizeSegmentText).filter(Boolean);
}

function splitLongSourceSegmentByWords(segment = {}, index = 0, config = {}) {
  const words = Array.isArray(segment.words)
    ? segment.words
        .map((word) => ({
          text: normalizeSegmentText(word.text || word.word || ''),
          start: Number(word.start),
          end: Number(word.end),
          confidence: word.confidence,
        }))
        .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
        .sort((left, right) => left.start - right.start || left.end - right.end)
    : [];
  if (words.length < 2) return null;

  const maxDuration = Math.max(2.2, Math.min(6, Number(config.sourceMaxCueSeconds) || 4.2));
  const maxChars = Math.max(12, Math.min(60, Number(config.sourceMaxCueChars) || 24));
  const output = [];
  let buffer = [];

  function pushBuffer() {
    if (!buffer.length) return;
    const start = buffer[0].start;
    const end = buffer[buffer.length - 1].end;
    const text = normalizeCjkJoinedText(buffer.map((word) => word.text).join(' '));
    if (!text || end <= start) {
      buffer = [];
      return;
    }
    output.push({
      ...segment,
      id: `${String(segment.id || `source-${index + 1}`)}-w${output.length + 1}`,
      index: index + output.length,
      text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number(Math.max(0.1, end - start).toFixed(3)),
      words: buffer.map((word) => ({ ...word })),
      sourceIds: [String(segment.id || `source-${index + 1}`)],
      sourceRowIds: [String(segment.id || `source-${index + 1}`)],
      sourceSegmentCount: Number(segment.sourceSegmentCount) || 1,
      splitFromLongSource: true,
      splitUsingWordTimestamps: true,
    });
    buffer = [];
  }

  for (const word of words) {
    buffer.push(word);
    const text = normalizeCjkJoinedText(buffer.map((item) => item.text).join(' '));
    const duration = buffer[buffer.length - 1].end - buffer[0].start;
    const units = countWordsOrCjkUnits(text);
    const isBoundary = hasStrongBoundary(text) || /[,\u3001\uff0c]\s*$/.test(text);
    const isTooLong = duration >= maxDuration || units >= maxChars;
    if (buffer.length > 1 && (isTooLong || (isBoundary && duration >= 1.1 && units >= 6))) {
      pushBuffer();
    }
  }
  pushBuffer();

  return output.length > 1 ? output : null;
}

function splitLongSourceSegment(segment = {}, index = 0, config = {}) {
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || (start + Math.max(0.1, Number(segment.duration) || 0.1));
  const duration = Math.max(0.1, end - start);
  const text = normalizeSegmentText(segment.text || segment.sourceText || segment.originalText || '');
  const maxDuration = Math.max(2.5, Math.min(8, Number(config.sourceMaxCueSeconds) || 6));
  const maxChars = Math.max(18, Math.min(80, Number(config.sourceMaxCueChars) || 42));
  const textUnits = countWordsOrCjkUnits(text);
  const desiredParts = Math.max(
    1,
    Math.ceil(duration / maxDuration),
    Math.ceil(textUnits / maxChars)
  );

  if (desiredParts <= 1) {
    return [{
      ...segment,
      id: String(segment.id || `source-${index + 1}`),
      index,
      text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number(duration.toFixed(3)),
    }];
  }

  const wordSplit = splitLongSourceSegmentByWords(segment, index, config);
  if (wordSplit?.length) return wordSplit;

  const textParts = splitTextByUnits(text, desiredParts);
  const partCount = Math.max(1, textParts.length);
  const step = duration / partCount;
  return textParts.map((part, partIndex) => {
    const partStart = start + (step * partIndex);
    const partEnd = partIndex === partCount - 1 ? end : start + (step * (partIndex + 1));
    return {
      ...segment,
      id: `${String(segment.id || `source-${index + 1}`)}-${partIndex + 1}`,
      index: index + partIndex,
      text: part,
      start: Number(partStart.toFixed(3)),
      end: Number(partEnd.toFixed(3)),
      duration: Number(Math.max(0.1, partEnd - partStart).toFixed(3)),
      sourceIds: [String(segment.id || `source-${index + 1}`)],
      sourceRowIds: [String(segment.id || `source-${index + 1}`)],
      sourceSegmentCount: Number(segment.sourceSegmentCount) || 1,
      splitFromLongSource: true,
    };
  });
}

function splitLongSourceSegments(segments = [], config = {}) {
  const output = [];
  for (const [index, segment] of (segments || []).entries()) {
    output.push(...splitLongSourceSegment(segment, index, config));
  }
  return output
    .filter((segment) => segment.text && segment.end > segment.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((segment, index) => ({ ...segment, index }));
}

function isAssemblyAiSentenceMode(config = {}) {
  return config.sttProvider === 'assemblyai_speech_to_text'
    && ['segment_timestamps', 'sentence_timestamps', 'assemblyai_sentences'].includes(String(config.sttTimestampMode || '').trim());
}

function shouldSafetySplitSourceSegments(config = {}) {
  return config.sttSourceSafetySplit !== false;
}

function sourceSafetySplitConfig(config = {}) {
  if (!isAssemblyAiSentenceMode(config)) {
    return {
      ...config,
      sourceMaxCueSeconds: Number(config.sourceMaxCueSeconds) || 4.2,
      sourceMaxCueChars: Number(config.sourceMaxCueChars) || 42,
    };
  }
  return {
    ...config,
    sourceMaxCueSeconds: Number(config.sourceMaxCueSeconds) || 4.2,
    sourceMaxCueChars: Number(config.sourceMaxCueChars) || 24,
  };
}

function naturalMaxSpeakingRate(config = {}, provider = '') {
  const base = Math.max(0.75, Math.min(2, Number(config.speakingRate) || 1));
  const configuredMax = Number(config.maxEffectiveSpeakingRate);
  if (Number.isFinite(configuredMax) && configuredMax > 0) {
    return Number(Math.max(base, Math.min(2, configuredMax)).toFixed(2));
  }
  const legacyMax = Number(config.maxSpeakingRate);
  if (Number.isFinite(legacyMax) && legacyMax > 0) {
    return Number(Math.max(base, Math.min(2, legacyMax)).toFixed(2));
  }
  return Number(Math.min(2, Math.max(base, base * 1.18)).toFixed(2));
}

async function resolveManualSourceVideoPath(jobId) {
  const job = await getJob(jobId).catch(() => null);
  if (job?.result?.videoPath) {
    return job.result.videoPath;
  }

  const paths = getJobPaths(jobId);
  const entries = await fs.readdir(paths.source).catch(() => []);
  const candidate = entries.find((entry) => /\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(entry));
  if (candidate) {
    return path.join(paths.source, candidate);
  }

  throw new Error('No source video is available for this job. Run extract audio first.');
}

async function resolveManualPreviewVideoPath(jobId) {
  const paths = getJobPaths(jobId);
  const previewVideoPath = path.join(paths.source, 'preview_source.mp4');
  if (await getFileStats(previewVideoPath)) {
    return previewVideoPath;
  }

  const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
  await createPreviewVideo(sourceVideoPath, previewVideoPath);
  return previewVideoPath;
}

app.get('/api/manual/video/:jobId', async (req, res) => {
  try {
    const sourceVideoPath = await resolveManualSourceVideoPath(req.params.jobId);
    return streamVideoFile(req, res, sourceVideoPath);
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: 'Source video is not available for this job.',
      detail: error.message,
    });
  }
});

app.get('/api/manual/preview-video/:jobId', async (req, res) => {
  try {
    const previewVideoPath = await resolveManualPreviewVideoPath(req.params.jobId);
    return streamVideoFile(req, res, previewVideoPath);
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: 'Preview video is not available for this job.',
      detail: error.message,
    });
  }
});

async function prepareManualSource(reqBody = {}, existingJobId = '') {
  const sourceType = reqBody?.sourceType === 'youtube' ? 'youtube' : 'local';
  const prepared = existingJobId
    ? { jobId: existingJobId, paths: getJobPaths(existingJobId) }
    : await createJob({
        status: 'running',
        stage: 'manual_prepare_source',
        message: 'Preparing source video for manual workflow.',
      });
  const { jobId, paths } = prepared;

  let sourceVideoPath = '';
  let sourceVideoId = null;

  if (existingJobId) {
    sourceVideoPath = await resolveManualSourceVideoPath(existingJobId);
  } else if (sourceType === 'youtube') {
    sourceVideoId = extractVideoId(reqBody?.videoUrl);
    if (!sourceVideoId) {
      throw new Error('Invalid YouTube URL');
    }
    sourceVideoPath = paths.sourceVideo;
    await downloadVideo(reqBody.videoUrl, sourceVideoPath);
  } else {
    const localVideoPath = await validateLocalVideoPath(reqBody?.videoPath);
    const extension = path.extname(localVideoPath || '').toLowerCase() || '.mp4';
    sourceVideoPath = path.join(paths.source, `source_video${extension}`);
    try {
      await fs.link(localVideoPath, sourceVideoPath);
    } catch {
      await fs.copyFile(localVideoPath, sourceVideoPath);
    }
  }

  const [videoStats, durationSeconds] = await Promise.all([
    getFileStats(sourceVideoPath),
    getDurationSeconds(sourceVideoPath),
  ]);

  const previewVideoPath = path.join(paths.source, 'preview_source.mp4');
  try {
    await createPreviewVideo(sourceVideoPath, previewVideoPath);
  } catch (error) {
    await addLog(jobId, 'warning', `Browser preview transcode failed, falling back to source video: ${error.message}`);
  }
  const hasPreviewVideo = Boolean(await getFileStats(previewVideoPath));

  const result = {
    jobId,
    sourceType,
    sourceVideoId,
    sourceVideoPath,
    sourceVideoUrl: `/api/manual/video/${jobId}`,
    previewVideoPath: hasPreviewVideo ? previewVideoPath : '',
    previewVideoUrl: hasPreviewVideo ? toPublicJobUrl(jobId, previewVideoPath) : `/api/manual/video/${jobId}`,
    videoPath: sourceVideoPath,
    videoUrl: hasPreviewVideo ? toPublicJobUrl(jobId, previewVideoPath) : `/api/manual/video/${jobId}`,
    audioPath: '',
    audioUrl: '',
    durationSeconds,
    videoFileSizeBytes: videoStats?.size || 0,
  };

  await updateJob(jobId, {
    status: 'completed',
    stage: 'manual_prepare_source_done',
    percent: 100,
    message: 'Source video is ready.',
    result,
    error: null,
  });

  return { jobId, paths, result };
}

function shouldMergeSourceCue(current, next, config = {}) {
  if (!current || !next) return false;
  const gap = Math.max(0, (Number(next.start) || 0) - (Number(current.end) || 0));
  const combinedDuration = Math.max(0.1, (Number(next.end) || 0) - (Number(current.start) || 0));
  const maxDuration = Number(config.maxSourceCleanMergeDuration) || Number(config.maxMeaningSegmentDuration) || 6.5;
  const minDuration = Number(config.minSourceCleanDuration) || 0.9;
  const currentText = normalizeSegmentText(current.text);
  const nextText = normalizeSegmentText(next.text);
  const minSentenceDuration = Number(config.minSourceSentenceDuration) || 0.35;
  if (gap > (Number(config.sourceCleanMergeGap) || 0.25) || combinedDuration > maxDuration) return false;
  if (hasSentenceEnding(currentText) && segmentDurationSeconds(current) >= minSentenceDuration) return false;
  if (segmentDurationSeconds(current) < minDuration || segmentDurationSeconds(next) < minDuration) return true;
  if (!hasSentenceEnding(currentText) && countWordsOrCjkUnits(currentText) <= 6) return true;
  if (/[,;:\u3001\uff0c\uff1b\uff1a]\s*$/.test(currentText)) return true;
  if (/^(và|nhưng|vì|nên|rồi|sau đó|để|khi)\b/i.test(nextText)) return true;
  return false;
}

function isHardSentenceEnd(text) {
  return /[.!?\u3002\uff01\uff1f]\s*$/.test(normalizeSegmentText(text));
}

function ttsTextTokens(text = '') {
  return normalizeSegmentText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function ttsTextSimilarity(left = '', right = '') {
  const leftTokens = new Set(ttsTextTokens(left));
  const rightTokens = new Set(ttsTextTokens(right));
  const smallerSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallerSize < 4) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / smallerSize;
}

function areTtsTextsRepeated(left = '', right = '') {
  const normalizedLeft = normalizeSegmentText(left).toLowerCase();
  const normalizedRight = normalizeSegmentText(right).toLowerCase();
  if (!normalizedLeft || !normalizedRight) return false;
  const compactLeft = normalizedLeft.replace(/[^\p{L}\p{N}]+/gu, '');
  const compactRight = normalizedRight.replace(/[^\p{L}\p{N}]+/gu, '');
  const shorter = compactLeft.length <= compactRight.length ? compactLeft : compactRight;
  const longer = compactLeft.length > compactRight.length ? compactLeft : compactRight;
  if (shorter.length >= 36 && longer.includes(shorter)) return true;
  return ttsTextSimilarity(normalizedLeft, normalizedRight) >= 0.82;
}

function splitTtsSentences(text = '') {
  const normalized = normalizeSegmentText(text);
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]*/gu) || [normalized];
  return parts.map((part) => normalizeSegmentText(part)).filter(Boolean);
}

function removeRepeatedTtsText(text = '', recentTexts = []) {
  const kept = [];
  for (const sentence of splitTtsSentences(text)) {
    const repeated = kept.some((item) => areTtsTextsRepeated(sentence, item))
      || recentTexts.some((item) => areTtsTextsRepeated(sentence, item));
    if (!repeated) kept.push(sentence);
  }
  return normalizeSegmentText(kept.join(' '));
}

function fitTtsTextToDuration(text = '', durationSeconds = 0, config = {}) {
  return normalizeSegmentText(text);
}

function sourceIdsForTtsSegment(segment = {}) {
  const ids = [
    ...(Array.isArray(segment.sourceIds) ? segment.sourceIds : []),
    ...(Array.isArray(segment.sourceRowIds) ? segment.sourceRowIds : []),
    segment.id,
    segment.segmentId,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(String);
  return Array.from(new Set(ids));
}

function textForTtsClipReuse(segment = {}) {
  return normalizeSegmentText(segment.prosodyText || segment.ttsText || segment.text || segment.finalText || segment.translatedText || '');
}

function ttsSegmentTouchesRows(segment = {}, rowIds = []) {
  const wanted = new Set((rowIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  if (!wanted.size) return false;
  return sourceIdsForTtsSegment(segment).some((id) => wanted.has(id));
}

function updatePreviousTtsSegmentsForRerun(previousSegments = [], rows = [], rowIds = []) {
  const requested = new Set((rowIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  if (!requested.size || !Array.isArray(previousSegments) || !previousSegments.length) return [];
  const rowsById = new Map((rows || []).map((row) => [String(row.id || ''), row]));
  return previousSegments.map((segment) => {
    if (!ttsSegmentTouchesRows(segment, rowIds)) return segment;
    const segmentRows = sourceIdsForTtsSegment(segment).map((id) => rowsById.get(id)).filter(Boolean);
    const text = normalizeSegmentText(
      segmentRows.length
        ? segmentRows.map((row) => row.text || row.finalText || row.translatedText || '').filter(Boolean).join(' ')
        : segment.text || segment.finalText || segment.translatedText || segment.ttsText || ''
    );
    if (!text) return segment;
    return {
      ...segment,
      text,
      translatedText: text,
      finalText: text,
      ttsText: text,
      prosodyText: text,
    };
  });
}

function ttsSegmentCanReuseClip(previous = {}, next = {}) {
  if (!previous || !next) return false;
  if (String(previous.id || '') !== String(next.id || '')) return false;
  if (textForTtsClipReuse(previous) !== textForTtsClipReuse(next)) return false;
  const previousStart = Number(previous.start) || 0;
  const nextStart = Number(next.start) || 0;
  const previousEnd = Number(previous.end) || 0;
  const nextEnd = Number(next.end) || 0;
  return Math.abs(previousStart - nextStart) <= 0.001 && Math.abs(previousEnd - nextEnd) <= 0.001;
}

function planPartialTtsReuse(previousManifest = {}, nextSegments = [], rowIds = []) {
  const requestedRowIds = (rowIds || []).map((value) => String(value || '').trim()).filter(Boolean);
  if (!requestedRowIds.length || !Array.isArray(previousManifest?.clips) || !Array.isArray(previousManifest?.ttsSegments)) {
    return { enabled: false, indices: [], existingClips: [], rerunCount: nextSegments.length, reusedCount: 0 };
  }

  const previousSegments = previousManifest.ttsSegments || [];
  const previousClips = previousManifest.clips || [];
  const indices = [];
  const existingClips = [];

  for (let index = 0; index < nextSegments.length; index += 1) {
    const segment = nextSegments[index];
    const previousSegment = previousSegments[index];
    const previousClip = previousClips[index];
    const touchesRequestedRows = ttsSegmentTouchesRows(segment, requestedRowIds);
    const reusable = !touchesRequestedRows
      && previousClip?.path
      && ttsSegmentCanReuseClip(previousSegment, segment);
    if (reusable) {
      existingClips[index] = previousClip;
    } else {
      indices.push(index);
    }
  }

  const reusedCount = existingClips.filter(Boolean).length;
  if (!reusedCount || reusedCount + indices.length !== nextSegments.length) {
    return { enabled: false, indices: [], existingClips: [], rerunCount: nextSegments.length, reusedCount: 0 };
  }

  return {
    enabled: true,
    indices,
    existingClips,
    rerunCount: indices.length,
    reusedCount,
  };
}

function ttsManifestVoiceKey(manifest = {}) {
  return [
    String(manifest.provider || '').trim(),
    String(manifest.languageCode || '').trim(),
    String(manifest.voiceName || '').trim(),
    String(manifest.aimaxProvider || '').trim(),
    String(manifest.aimaxModel || '').trim(),
    String(Number(manifest.speakingRate) || 1),
    String(manifest.ttsUnitMode || '').trim(),
  ].join('|');
}

function ttsConfigVoiceKey(config = {}, ttsUnitMode = '') {
  return [
    String(config.ttsProvider || '').trim(),
    String(config.ttsLanguageCode || '').trim(),
    String(config.ttsVoiceName || '').trim(),
    String(config.aimaxProvider || '').trim(),
    String(config.aimaxModel || '').trim(),
    String(Number(config.speakingRate) || 1),
    String(ttsUnitMode || '').trim(),
  ].join('|');
}

function planFullTtsReuse(previousManifest = {}, nextSegments = [], config = {}, ttsUnitMode = '') {
  if (!Array.isArray(previousManifest?.clips) || !Array.isArray(previousManifest?.ttsSegments)) {
    return { enabled: false, indices: [], existingClips: [], rerunCount: nextSegments.length, reusedCount: 0 };
  }
  if (ttsManifestVoiceKey(previousManifest) !== ttsConfigVoiceKey(config, ttsUnitMode)) {
    return { enabled: false, indices: [], existingClips: [], rerunCount: nextSegments.length, reusedCount: 0 };
  }

  const previousSegments = previousManifest.ttsSegments || [];
  const previousClips = previousManifest.clips || [];
  const indices = [];
  const existingClips = [];

  for (let index = 0; index < nextSegments.length; index += 1) {
    const previousSegment = previousSegments[index];
    const previousClip = previousClips[index];
    if (previousClip?.path && ttsSegmentCanReuseClip(previousSegment, nextSegments[index])) {
      existingClips[index] = previousClip;
    } else {
      indices.push(index);
    }
  }

  const reusedCount = existingClips.filter(Boolean).length;
  if (!reusedCount) {
    return { enabled: false, indices: [], existingClips: [], rerunCount: nextSegments.length, reusedCount: 0 };
  }

  return {
    enabled: true,
    indices,
    existingClips,
    rerunCount: indices.length,
    reusedCount,
  };
}

function mergeTtsSourceIds(left = {}, right = {}) {
  return Array.from(new Set([
    ...sourceIdsForTtsSegment(left),
    ...sourceIdsForTtsSegment(right),
  ]));
}

function normalizeTtsUnitMode(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'story_segments') return 'story_segments';
  return normalized === 'meaning_units' ? 'meaning_units' : 'post_translation';
}

function isTemplateGroupTtsSegment(segment = {}) {
  return String(segment.id || '').startsWith('template-')
    || segment.templateGroupCreatedBy === 'ai_grouping'
    || (Array.isArray(segment.originalCues) && segment.originalCues.length > 0);
}

function effectiveTtsUnitModeForSegments(mode, segments = []) {
  const normalized = normalizeTtsUnitMode(mode);
  if (normalized === 'story_segments' && Array.isArray(segments) && segments.length && (
    segments.every(isTemplateGroupTtsSegment) || segments.some(isTemplateGroupTtsSegment)
  )) {
    return 'post_translation';
  }
  return normalized;
}

function foldVietnameseBoundaryText(text = '') {
  return normalizeSegmentText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function spokenWordCount(text = '') {
  const cleaned = normalizeSegmentText(text)
    .replace(/[.,;:!?\u3002\uff01\uff1f\uff1b\uff1a\uff0c]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;
}

function startsWithStrongTtsTransition(text = '') {
  const folded = foldVietnameseBoundaryText(text);
  return /^(ket qua|vi vay|do do|sau do|luc nay|tuy nhien|nhung|thuc chat|dieu nay khien|nguyen nhan la)\b/.test(folded);
}

function startsWithDependentTtsCue(text = '') {
  const folded = foldVietnameseBoundaryText(text);
  return /^(va|vi|nen|de|khi|da|dang|bi|duoc|roi|cho|la|ma|neu|trong khi|khien)\b/.test(folded);
}

function endsWithDependentTtsCue(text = '') {
  const folded = foldVietnameseBoundaryText(text);
  return /\b(va|vi|nen|de|khi|da|dang|cho|la|ma|neu|roi|cua|voi|tai|o|trong)$/.test(folded);
}

function hasInternalHardTtsBoundary(text = '') {
  return /[.!?\u3002\uff01\uff1f]\s+\S/u.test(normalizeSegmentText(text));
}

function ttsUnitOptions(config = {}) {
  const speakingRate = Math.max(0.75, Math.min(2, Number(config.speakingRate) || 1));
  const baseWps = Number(config.ttsUnitMaxWordsPerSecond) || 4.6;
  return {
    mergeGap: Math.max(0, Math.min(0.8, Number(config.ttsMergeGapSeconds) || 0.35)),
    softDuration: Math.max(3.5, Math.min(8, Number(config.ttsUnitSoftMaxDuration) || 6.2)),
    hardDuration: Math.max(4, Math.min(9, Number(config.ttsUnitHardMaxDuration) || 7.0)),
    softWords: Math.max(12, Math.min(40, Number(config.ttsUnitSoftMaxWords) || 26)),
    hardWords: Math.max(16, Math.min(48, Number(config.ttsUnitHardMaxWords) || 32)),
    maxWordsPerSecond: Math.max(3.4, Math.min(6, baseWps * Math.max(0.9, Math.min(1.12, speakingRate / 1.1)))),
    minCompleteDuration: Math.max(0.8, Math.min(2.4, Number(config.minNaturalTtsSegmentDuration) || 1.4)),
  };
}

function ttsUnitStats(unit = {}) {
  const text = normalizeSegmentText(unit.prosodyText || unit.ttsText || unit.text || unit.finalText || unit.translatedText || '');
  const duration = Math.max(0.1, (Number(unit.end) || 0) - (Number(unit.start) || 0));
  const wordCount = spokenWordCount(text);
  return {
    text,
    duration,
    wordCount,
    estimatedWordsPerSecond: Number((wordCount / Math.max(0.1, duration)).toFixed(2)),
  };
}

function withTtsUnitStats(unit = {}) {
  const stats = ttsUnitStats(unit);
  return {
    ...unit,
    text: stats.text,
    ttsText: stats.text,
    prosodyText: stats.text,
    duration: Number(stats.duration.toFixed(3)),
    wordCount: stats.wordCount,
    estimatedWordsPerSecond: stats.estimatedWordsPerSecond,
  };
}

function isCompleteEnoughForTtsBoundary(unit = {}, options = ttsUnitOptions()) {
  const stats = ttsUnitStats(unit);
  return isHardSentenceEnd(stats.text)
    || stats.duration >= options.minCompleteDuration
    || stats.wordCount >= 7;
}

function shouldMergePostTranslationTtsUnit(previous, current, timing = {}, config = {}) {
  if (!previous || !current) return false;
  const options = ttsUnitOptions(config);
  const previousStats = ttsUnitStats(previous);
  const currentStats = ttsUnitStats(current);
  if (!previousStats.text || !currentStats.text) return false;

  const gap = Math.max(0, Number(timing.gap) || 0);
  if (gap > options.mergeGap) return false;

  const mergedDuration = Math.max(0.1, Number(timing.mergedDuration) || 0.1);
  const mergedText = normalizeSegmentText(`${previousStats.text} ${currentStats.text}`);
  const mergedWords = spokenWordCount(mergedText);
  const mergedWps = mergedWords / mergedDuration;
  const currentStartsStrong = startsWithStrongTtsTransition(currentStats.text);
  const currentStartsDependent = startsWithDependentTtsCue(currentStats.text);
  const previousEndsDependent = endsWithDependentTtsCue(previousStats.text);
  const continuationCandidate = !isHardSentenceEnd(previousStats.text) || previousEndsDependent || currentStartsDependent;
  const continuationHardDuration = Math.max(
    options.hardDuration,
    Math.min(12, Number(config.maxContinuationTtsMergeDuration ?? config.ttsContinuationHardMaxDuration ?? 10.5))
  );
  const continuationHardWords = Math.max(
    options.hardWords,
    Math.min(58, Number(config.maxContinuationTtsMergeWords ?? 44))
  );
  const previousComplete = isCompleteEnoughForTtsBoundary(previous, options);

  if (mergedDuration > (continuationCandidate ? continuationHardDuration : options.hardDuration)
    || mergedWords > (continuationCandidate ? continuationHardWords : options.hardWords)) return false;
  if (hasInternalHardTtsBoundary(previousStats.text) && !previousEndsDependent) return currentStartsDependent;
  if (currentStartsStrong && previousComplete && previousStats.wordCount >= 5) return false;
  if (isHardSentenceEnd(previousStats.text) && previousComplete && !currentStartsDependent) return false;
  if (previousEndsDependent || currentStartsDependent) return true;
  if (mergedWps > options.maxWordsPerSecond) return false;
  if (mergedDuration > options.softDuration && !previousEndsDependent && !currentStartsDependent) return false;
  if (mergedWords > options.softWords && !previousEndsDependent && !currentStartsDependent) return false;

  if (!isHardSentenceEnd(previousStats.text)) return true;
  if (previousStats.duration < options.minCompleteDuration || currentStats.duration < options.minCompleteDuration) return true;
  return false;
}

function buildTtsUnitsFromTranslatedRows(translatedSegments = [], config = {}) {
  const sorted = normalizeClientSegments(translatedSegments)
    .map((segment, index) => {
      const finalText = normalizeSegmentText(segment.finalText || segment.translatedText || segment.text || '');
      const rowTtsText = normalizeSegmentText(segment.ttsText || finalText);
      const sourceIds = sourceIdsForTtsSegment(segment).filter((id) => !String(id).startsWith('meaning-'));
      const start = Number(segment.start) || 0;
      const end = Number(segment.end) || (start + Math.max(0.1, Number(segment.duration) || 0.8));
      return withTtsUnitStats({
        id: String(segment.id || `display-${index + 1}`),
        index,
        start,
        end,
        translatedText: finalText,
        finalText,
        text: rowTtsText,
        ttsText: rowTtsText,
        prosodyText: rowTtsText,
        originalText: normalizeSegmentText(segment.originalText || segment.sourceText || ''),
        sourceText: normalizeSegmentText(segment.sourceText || segment.originalText || ''),
        sourceIds: sourceIds.length ? sourceIds : [String(segment.id || `display-${index + 1}`)],
        sourceRowIds: sourceIds.length ? sourceIds : [String(segment.id || `display-${index + 1}`)],
        sourceSegmentCount: 1,
      });
    })
    .filter((segment) => segment.text)
    .sort((a, b) => a.start - b.start);

  const output = [];
  for (const segment of sorted) {
    const previous = output[output.length - 1];
    if (!previous) {
      output.push(segment);
      continue;
    }
    const gap = Math.max(0, (Number(segment.start) || 0) - (Number(previous.end) || 0));
    const mergedDuration = Math.max(Number(previous.end) || 0, Number(segment.end) || 0) - (Number(previous.start) || 0);
    const shouldMerge = shouldMergePostTranslationTtsUnit(previous, segment, { gap, mergedDuration }, config);
    if (!shouldMerge) {
      output.push(segment);
      continue;
    }
    output[output.length - 1] = withTtsUnitStats({
      ...previous,
      end: Number(Math.max(Number(previous.end) || 0, Number(segment.end) || 0).toFixed(3)),
      text: normalizeSegmentText(`${previous.text} ${segment.text}`),
      ttsText: normalizeSegmentText(`${previous.ttsText || previous.text} ${segment.ttsText || segment.text}`),
      prosodyText: normalizeSegmentText(`${previous.prosodyText || previous.text} ${segment.prosodyText || segment.text}`),
      translatedText: normalizeSegmentText(`${previous.translatedText || previous.text} ${segment.translatedText || segment.text}`),
      finalText: normalizeSegmentText(`${previous.finalText || previous.text} ${segment.finalText || segment.text}`),
      sourceIds: mergeTtsSourceIds(previous, segment).filter((id) => !String(id).startsWith('meaning-')),
      sourceRowIds: mergeTtsSourceIds(previous, segment).filter((id) => !String(id).startsWith('meaning-')),
      sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(segment.sourceSegmentCount) || 1),
    });
  }

  return addTimingBudget(output.map((unit, index) => {
    const ttsText = ttsTextFromTranslation(unit.ttsText || unit.finalText || unit.translatedText || unit.text, config)
      || normalizeSegmentText(unit.ttsText || unit.finalText || unit.translatedText || unit.text);
    return {
      ...unit,
      id: `tts-${String(index + 1).padStart(3, '0')}`,
      index,
      text: ttsText,
      ttsText,
      prosodyText: ttsText,
      ttsCleanupMode: config.ttsTextCleanupMode || 'natural',
    };
  }), {
    ...config,
    borrowGapSeconds: 0,
  }).map(withTtsUnitStats);
}

function normalizeMeaningUnitsForTts(rawUnits = [], fallbackSegments = [], config = {}) {
  const units = Array.isArray(rawUnits) && rawUnits.length
    ? rawUnits
    : buildMeaningUnits(fallbackSegments, config);
  const normalizedUnits = units
    .map((unit, index) => {
      const start = Number(unit.start) || 0;
      const end = Number(unit.end) || (start + Math.max(0.1, Number(unit.duration) || 0.8));
      const translatedText = normalizeSegmentText(unit.translatedText || unit.finalText || unit.text || unit.sourceText);
      const ttsText = normalizeSegmentText(
        ttsTextFromTranslation(unit.ttsText || translatedText, config) || unit.ttsText || translatedText
      );
      const prosodyText = normalizeSegmentText(unit.prosodyText || ttsText || translatedText);
      const sourceIds = Array.from(new Set([
        ...(Array.isArray(unit.sourceRowIds) ? unit.sourceRowIds : []),
        ...(Array.isArray(unit.sourceIds) ? unit.sourceIds : []),
        unit.id,
      ].filter(Boolean).map(String)));
      return {
        ...unit,
        id: String(unit.id || `meaning-${index + 1}`),
        index,
        start,
        end,
        duration: Number(Math.max(0.1, end - start).toFixed(3)),
        text: prosodyText || ttsText || translatedText,
        translatedText,
        finalText: translatedText,
        ttsText: prosodyText || ttsText || translatedText,
        prosodyText: prosodyText || ttsText || translatedText,
        originalText: normalizeSegmentText(unit.sourceText || unit.originalText || ''),
        sourceText: normalizeSegmentText(unit.sourceText || unit.originalText || ''),
        sourceIds,
        sourceRowIds: sourceIds,
        sourceSegmentCount: Number(unit.sourceSegmentCount) || sourceIds.length || 1,
      };
    })
    .filter((unit) => unit.text);
  return mergeMeaningTtsContinuations(normalizedUnits, config);
}

function shouldMergeTtsUnit(previous, segment, timing = {}, config = {}) {
  const previousText = normalizeSegmentText(previous?.text);
  const currentText = normalizeSegmentText(segment?.text);
  if (!previousText || !currentText) return false;

  const gap = Math.max(0, Number(timing.gap) || 0);
  const mergeGap = Number(config.ttsMergeGapSeconds) || 0.35;
  if (gap > mergeGap) return false;

  const mergedDuration = Math.max(0.1, Number(timing.mergedDuration) || 0.1);
  const mergedText = normalizeSegmentText(`${previousText} ${currentText}`);
  const previousEndsDependent = endsWithDependentTtsCue(previousText);
  const currentStartsDependent = startsWithDependentTtsCue(currentText);
  const continuationCandidate = !isHardSentenceEnd(previousText) || previousEndsDependent || currentStartsDependent;
  const maxDuration = Number(config.maxTtsMergeDuration) || 7.5;
  const maxChars = Number(config.maxTtsMergeChars) || 260;
  const continuationMaxDuration = Math.max(
    maxDuration,
    Math.min(12, Number(config.maxContinuationTtsMergeDuration ?? config.ttsContinuationHardMaxDuration ?? 10.5))
  );
  const continuationMaxChars = Math.max(
    maxChars,
    Math.min(420, Number(config.maxContinuationTtsMergeChars ?? 340))
  );
  const activeMaxDuration = continuationCandidate ? continuationMaxDuration : maxDuration;
  const activeMaxChars = continuationCandidate ? continuationMaxChars : maxChars;
  if (mergedDuration > activeMaxDuration || mergedText.length > activeMaxChars) return false;

  const previousDuration = Math.max(0.1, Number(timing.previousDuration) || 0.1);
  const currentDuration = Math.max(0.1, Number(timing.currentDuration) || 0.1);
  const minSingleDuration = Number(config.minNaturalTtsSegmentDuration) || 1.6;
  const foldedPrevious = previousText
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
  const foldedCurrent = currentText
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();

  if (hasInternalHardTtsBoundary(previousText) && !previousEndsDependent) return currentStartsDependent;
  if (!isHardSentenceEnd(previousText)) return true;
  if (previousDuration < minSingleDuration || currentDuration < minSingleDuration) return true;
  if (/\b(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi)$/.test(foldedPrevious)) return true;
  if (/^(va|voi|cua|cho|de|ve|toi|den|sang|vao|ra|o|tai|theo|la|bi|duoc|khi|neu|vi|do|nen|roi|da|dang|khien|thuc chat)\b/.test(foldedCurrent)) return true;
  return false;
}

function mergeMeaningTtsContinuations(units = [], config = {}) {
  const output = [];
  for (const unit of units) {
    const previous = output[output.length - 1];
    if (!previous) {
      output.push(unit);
      continue;
    }

    const previousDuration = Math.max(0.1, (Number(previous.end) || 0) - (Number(previous.start) || 0));
    const currentDuration = Math.max(0.1, (Number(unit.end) || 0) - (Number(unit.start) || 0));
    const gap = Math.max(0, (Number(unit.start) || 0) - (Number(previous.end) || 0));
    const mergedDuration = Math.max(Number(previous.end) || 0, Number(unit.end) || 0) - (Number(previous.start) || 0);

    if (!shouldMergeTtsUnit(previous, unit, { gap, previousDuration, currentDuration, mergedDuration }, config)) {
      output.push(unit);
      continue;
    }

    const mergedText = normalizeSegmentText(`${previous.text || previous.ttsText} ${unit.text || unit.ttsText}`);
    const mergedFinalText = normalizeSegmentText(`${previous.finalText || previous.translatedText || previous.text} ${unit.finalText || unit.translatedText || unit.text}`);
    output[output.length - 1] = withTtsUnitStats({
      ...previous,
      end: Number(Math.max(Number(previous.end) || 0, Number(unit.end) || 0).toFixed(3)),
      text: mergedText,
      translatedText: mergedFinalText,
      finalText: mergedFinalText,
      ttsText: mergedText,
      prosodyText: mergedText,
      sourceIds: mergeTtsSourceIds(previous, unit),
      sourceRowIds: mergeTtsSourceIds(previous, unit),
      sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(unit.sourceSegmentCount) || 1),
    });
  }

  return output.map((unit, index) => ({ ...unit, index }));
}

function mergeAdjacentTtsSegments(segments, config = {}) {
  const mergeGap = Number(config.ttsMergeGapSeconds) || 0.35;
  const output = [];

  const sorted = [...(segments || [])]
    .map((segment) => ({
      ...segment,
      text: normalizeSegmentText(segment.finalText || segment.translatedText || segment.text || segment.ttsText),
      start: Number(segment.start) || 0,
      end: Number(segment.end) || ((Number(segment.start) || 0) + (Number(segment.duration) || 0.1)),
      sourceIds: sourceIdsForTtsSegment(segment),
    }))
    .filter((segment) => segment.text)
    .sort((a, b) => a.start - b.start);

  if (config.ttsProvider === 'aimax_tts' && config.aimaxMergeSegments !== true) {
    return addTimingBudget(sorted.map((segment, index) => ({ ...segment, index })), {
      ...config,
      borrowGapSeconds: 0,
    });
  }

  for (const rawSegment of sorted) {
    const recentTexts = output.slice(-2).map((item) => item.text);
    const baseDuration = Math.max(0.1, (Number(rawSegment.end) || 0) - (Number(rawSegment.start) || 0));
    const displayText = normalizeSegmentText(rawSegment.finalText || rawSegment.translatedText || rawSegment.text);
    const cleanedText = fitTtsTextToDuration(
      removeRepeatedTtsText(displayText, recentTexts),
      baseDuration,
      config
    );
    const segment = {
      ...rawSegment,
      text: cleanedText,
      translatedText: displayText,
      finalText: displayText,
      ttsText: cleanedText,
      sourceIds: sourceIdsForTtsSegment(rawSegment),
    };
    const previous = output[output.length - 1];
    if (!segment.text) {
      if (previous) {
        const extendedEnd = Math.max(Number(previous.end) || 0, Number(rawSegment.end) || 0);
        previous.end = Number(extendedEnd.toFixed(3));
        previous.duration = Number(Math.max(0.1, extendedEnd - (Number(previous.start) || 0)).toFixed(3));
      }
      continue;
    }
    if (!previous) {
      output.push(segment);
      continue;
    }

    const previousDuration = Math.max(0.1, (Number(previous.end) || 0) - (Number(previous.start) || 0));
    const currentDuration = Math.max(0.1, (Number(segment.end) || 0) - (Number(segment.start) || 0));
    const gap = Math.max(0, (Number(segment.start) || 0) - (Number(previous.end) || 0));
    const mergedDuration = Math.max(Number(previous.end) || 0, Number(segment.end) || 0) - (Number(previous.start) || 0);
    if (gap <= Math.max(mergeGap, 0.8) && areTtsTextsRepeated(previous.text, segment.text)) {
      output[output.length - 1] = {
        ...previous,
        end: Number(Math.max(Number(previous.end) || 0, Number(segment.end) || 0).toFixed(3)),
        duration: Number(Math.max(0.1, mergedDuration).toFixed(3)),
        sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(segment.sourceSegmentCount) || 1),
        sourceIds: mergeTtsSourceIds(previous, segment),
      };
      continue;
    }
    const mergedText = normalizeSegmentText(`${previous.text} ${segment.text}`);
    const mergedFinalText = normalizeSegmentText(`${previous.finalText || previous.text} ${segment.finalText || segment.text}`);
    const shouldMerge = shouldMergeTtsUnit(previous, segment, {
      gap,
      previousDuration,
      currentDuration,
      mergedDuration,
    }, config);

    if (shouldMerge) {
      output[output.length - 1] = {
        ...previous,
        text: mergedText,
        translatedText: mergedFinalText,
        finalText: mergedFinalText,
        ttsText: mergedText,
        end: Number(Math.max(Number(previous.end) || 0, Number(segment.end) || 0).toFixed(3)),
        duration: Number(Math.max(0.1, mergedDuration).toFixed(3)),
        sourceSegmentCount: (Number(previous.sourceSegmentCount) || 1) + (Number(segment.sourceSegmentCount) || 1),
        sourceIds: mergeTtsSourceIds(previous, segment),
      };
    } else {
      output.push(segment);
    }
  }

  return addTimingBudget(output.map((segment, index) => ({ ...segment, index })), {
    ...config,
    borrowGapSeconds: 0,
  }).map((segment) => {
    const ttsText = ttsTextFromTranslation(segment.ttsText || segment.finalText || segment.translatedText || segment.text, config)
      || normalizeSegmentText(segment.ttsText || segment.finalText || segment.translatedText || segment.text);
    return withTtsUnitStats({
      ...segment,
      text: ttsText,
      ttsText,
      prosodyText: ttsText,
      ttsCleanupMode: config.ttsTextCleanupMode || 'natural',
    });
  });
}

function assertStrictTtsSync(report) {
  if (!report || report.strictPass !== false) return;
  const failedCount = Number(report.failedSegmentCount) || 0;
  const maxOverflow = Number(report.maxEndOverflowSeconds) || 0;
  throw new Error(
    `TTS sync failed: ${failedCount} segment(s) overflow or overlap, max overflow ${maxOverflow.toFixed(3)}s. Shorten highlighted subtitles, increase speaking rate, or split/adjust the timeline before exporting.`
  );
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
function splitTextIntoChunks(text, desiredChunks) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (desiredChunks <= 1) return [cleaned];

  const protectedText = protectNumericPunctuation(cleaned);
  const clauseParts = protectedText
    .split(/([,.;:!?\uff0c\u3002\uff01\uff1f\uff1b\uff1a])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const combined = `${token}${next}`.trim();
        if (combined) parts.push(combined);
      }
      return parts;
    }, []);

  let units = clauseParts.length ? clauseParts : protectedText.split(/\s+/);
  if (units.length === 1 && protectedText.length > desiredChunks * 12) {
    const chunkSize = Math.ceil(protectedText.length / desiredChunks);
    units = [];
    for (let index = 0; index < protectedText.length; index += chunkSize) {
      units.push(protectedText.slice(index, index + chunkSize));
    }
  }

  const chunks = Array.from({ length: Math.min(desiredChunks, units.length) }, () => []);
  const targetCount = chunks.length;
  const totalChars = units.reduce((sum, unit) => sum + unit.length, 0) || 1;
  let currentBucket = 0;
  let currentChars = 0;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const remainingUnits = units.length - index;
    const remainingBuckets = targetCount - currentBucket;
    const expectedChars = totalChars / targetCount;

    chunks[currentBucket].push(unit);
    currentChars += unit.length;

    const shouldAdvance = currentBucket < targetCount - 1
      && remainingUnits > remainingBuckets - 1
      && currentChars >= expectedChars * 0.8;

    if (shouldAdvance) {
      currentBucket += 1;
      currentChars = 0;
    }
  }

  return chunks
    .map((items) => restoreNumericPunctuation(items.join(clauseParts.length ? ' ' : ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
}

function splitTranslatedSegmentsForTts(segments, config = {}) {
  const splitSegments = [];
  const maxDuration = Number(config.maxTtsSegmentDuration) || 10.0;
  const maxChars = Number(config.maxTtsSegmentChars) || 260;
  const targetChunkDuration = Number(config.targetTtsChunkDuration) || 5.5;
  const maxChunks = Number(config.maxTtsChunksPerSegment) || 3;

  for (const segment of segments) {
    const duration = Math.max(0.1, Number(segment.duration) || (Number(segment.end) || 0) - (Number(segment.start) || 0) || 0.1);
    const text = String(segment.text || '').trim();
    const shouldSplit = duration > maxDuration || text.length > maxChars;

    if (!shouldSplit) {
      splitSegments.push({
        ...segment,
        duration,
      });
      continue;
    }

    const desiredChunks = Math.max(
      2,
      Math.min(
        maxChunks,
        Math.max(
          Math.ceil(duration / targetChunkDuration),
          Math.ceil(text.length / Math.max(120, maxChars * 0.65))
        )
      )
    );

    const textChunks = splitTextIntoChunks(text, desiredChunks);
    if (textChunks.length <= 1) {
      splitSegments.push({
        ...segment,
        duration,
      });
      continue;
    }

    const totalWeight = textChunks.reduce((sum, chunk) => sum + Math.max(chunk.length, 1), 0) || textChunks.length;
    let currentStart = Number(segment.start) || 0;

    textChunks.forEach((chunk, index) => {
      const remainingDuration = (Number(segment.start) || 0) + duration - currentStart;
      const isLast = index === textChunks.length - 1;
      const proportionalDuration = duration * (Math.max(chunk.length, 1) / totalWeight);
      const chunkDuration = isLast
        ? Math.max(0.12, remainingDuration)
        : Math.max(0.12, Math.min(remainingDuration - 0.12 * (textChunks.length - index - 1), proportionalDuration));
      const end = currentStart + chunkDuration;

      splitSegments.push({
        ...segment,
        text: chunk,
        translatedText: chunk,
        start: Number(currentStart.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(chunkDuration.toFixed(3)),
        gapAfter: 0,
        borrowableGap: 0,
        slotDuration: Number(chunkDuration.toFixed(3)),
        allowedDuration: Number(chunkDuration.toFixed(3)),
      });

      currentStart = end;
    });
  }

  return addTimingBudget(splitSegments, config);
}

function summarizeTtsFit(clips = []) {
  const valid = clips.filter((clip) => Number.isFinite(clip.ttsRatio));
  if (!valid.length) {
    return {
      avgRatio: 1,
      overLimitCount: 0,
      total: clips.length,
    };
  }

  const avgRatio = valid.reduce((sum, clip) => sum + clip.ttsRatio, 0) / valid.length;
  const overLimitCount = valid.filter((clip) => clip.ttsRatio > 1.05).length;
  return {
    avgRatio: Number(avgRatio.toFixed(3)),
    overLimitCount,
    total: valid.length,
  };
}

function resolveAutoTtsRepairOptions(body = {}, rerunRowIds = []) {
  const googleConfig = body.googleCloudConfig || {};
  const enabled = !rerunRowIds.length && (
    body.autoTtsRepairEnabled === true
    || googleConfig.autoTtsRepairEnabled === true
  );
  return {
    enabled,
    maxPasses: Math.max(1, Math.min(3, Number(
      body.autoTtsRepairMaxPasses
      ?? googleConfig.autoTtsRepairMaxPasses
      ?? 2
    ) || 2)),
    minOverflowSeconds: Math.max(0, Number(
      body.autoTtsRepairMinOverflowSeconds
      ?? googleConfig.autoTtsRepairMinOverflowSeconds
      ?? 0.08
    ) || 0.08),
    maxRowsPerPass: Math.max(1, Math.min(50, Number(
      body.autoTtsRepairMaxRowsPerPass
      ?? googleConfig.autoTtsRepairMaxRowsPerPass
      ?? 20
    ) || 20)),
  };
}

function createAutoTtsRepairReport(options = {}) {
  return {
    enabled: options.enabled === true,
    maxPasses: Number(options.maxPasses) || 0,
    passes: [],
    finalStatus: options.enabled === true ? 'skipped' : 'skipped',
    changedRows: [],
  };
}

function autoRepairText(value = '') {
  return normalizeSegmentText(value);
}

function rowTextForAutoRepair(row = {}) {
  return autoRepairText(row.finalText || row.translatedText || row.text || row.ttsText || '');
}

function sourceTextForAutoRepair(row = {}, unit = {}) {
  return autoRepairText(row.sourceText || row.originalText || unit.sourceText || unit.originalText || '');
}

function rowForRepairableUnit(unit = {}, rows = []) {
  const rowById = new Map((rows || []).map((row) => [String(row.id || ''), row]));
  const direct = rowById.get(String(unit.id || '')) || rowById.get(String(unit.segmentId || ''));
  if (direct) return direct;
  const sourceIds = sourceIdsForTtsSegment(unit).filter((id) => rowById.has(id));
  return sourceIds.length === 1 ? rowById.get(sourceIds[0]) : null;
}

function repairContextForRow(row = {}, rows = []) {
  const index = rows.findIndex((item) => String(item.id || '') === String(row.id || ''));
  return {
    previous: index > 0 ? rowTextForAutoRepair(rows[index - 1]) : '',
    next: index >= 0 && index + 1 < rows.length ? rowTextForAutoRepair(rows[index + 1]) : '',
  };
}

function repairItemForRow(row = {}, unit = {}, timing = {}, rows = []) {
  const currentTranslation = rowTextForAutoRepair(row);
  if (!currentTranslation) return null;
  const slotSeconds = Math.max(0.1, Number(timing.slotSeconds || timing.slotDuration || unit.allowedDuration || unit.duration || ((Number(unit.end) || 0) - (Number(unit.start) || 0))) || 0.1);
  const audioSeconds = Math.max(0, Number(timing.audioSeconds || timing.estimatedSpeechSeconds || timing.actualDurationSeconds || timing.audioDuration || 0));
  const overflowSeconds = Math.max(0, Number(timing.overflowSeconds || timing.overflowBefore || timing.endOverflowSeconds || timing.overlapNextSeconds || Math.max(0, audioSeconds - slotSeconds)) || 0);
  const fitRatio = Math.max(1, Number(timing.fitRatio || (audioSeconds > 0 ? audioSeconds / slotSeconds : 1)) || 1);
  const context = repairContextForRow(row, rows);
  return {
    row_id: String(row.id || unit.id || ''),
    source_text: sourceTextForAutoRepair(row, unit),
    current_translation: currentTranslation,
    previous_translation: context.previous,
    next_translation: context.next,
    slot_seconds: Number(slotSeconds.toFixed(3)),
    audio_seconds: Number((audioSeconds || slotSeconds + overflowSeconds).toFixed(3)),
    overflow_seconds: Number(overflowSeconds.toFixed(3)),
    fit_ratio: Number(fitRatio.toFixed(3)),
    target_tts_rate: Number(timing.targetTtsRate || timing.suggestedRate || 1) || 1,
    error_reason: autoRepairText(timing.errorReason || timing.reason || 'TTS timing review'),
  };
}

function collectFitRepairItems(ttsUnits = [], ttsFitPlan = {}, rows = [], options = {}) {
  const unitById = new Map((ttsUnits || []).map((unit) => [String(unit.id || ''), unit]));
  const items = [];
  for (const fit of ttsFitPlan.units || []) {
    if (fit.action !== 'manual_review') continue;
    if (Number(fit.overflowBefore) < Number(options.minOverflowSeconds || 0)) continue;
    const unit = unitById.get(String(fit.id || '')) || ttsUnits[Number(fit.index) || 0];
    if (!unit) continue;
    const row = rowForRepairableUnit(unit, rows);
    if (!row) continue;
    const item = repairItemForRow(row, unit, {
      ...fit,
      slotSeconds: fit.slotDuration,
      audioSeconds: fit.estimatedSpeechSeconds,
      overflowSeconds: fit.overflowBefore,
      errorReason: fit.reason || 'TTS fit planner manual review',
    }, rows);
    if (item) items.push(item);
    if (items.length >= Number(options.maxRowsPerPass || 20)) break;
  }
  return items;
}

function collectPostTtsRepairItems(ttsSegments = [], clips = [], syncReport = {}, rows = [], options = {}) {
  const segmentById = new Map((ttsSegments || []).map((segment) => [String(segment.id || ''), segment]));
  const byRowId = new Map();
  const reportItems = Array.isArray(syncReport?.segments) ? syncReport.segments : [];

  for (const reportItem of reportItems) {
    const ttsError = reportItem.ttsError === true || reportItem.status === 'error' || reportItem.errorCode === 'TTS_FAILED';
    if (ttsError) continue;
    const overflowSeconds = Math.max(
      0,
      Number(reportItem.endOverflowSeconds) || 0,
      Number(reportItem.overlapNextSeconds) || 0,
      Number(reportItem.cueEndOverflowSeconds) || 0,
      Number(reportItem.overflowAfterFitSeconds) || 0
    );
    if (overflowSeconds < Number(options.minOverflowSeconds || 0)) continue;
    const segment = segmentById.get(String(reportItem.id || '')) || ttsSegments[Number(reportItem.index) || 0] || reportItem;
    const row = rowForRepairableUnit(segment, rows);
    if (!row || byRowId.has(String(row.id))) continue;
    const slotSeconds = Number(reportItem.availableSlotDurationSeconds || reportItem.targetDurationSeconds || reportItem.expectedDurationSeconds || segment.duration || 0);
    const audioSeconds = Number(reportItem.actualDurationSeconds || ((Number(reportItem.actualEndSeconds) || 0) - (Number(reportItem.actualStartSeconds) || 0)) || 0);
    const item = repairItemForRow(row, segment, {
      slotSeconds,
      audioSeconds,
      overflowSeconds,
      fitRatio: slotSeconds > 0 && audioSeconds > 0 ? audioSeconds / slotSeconds : 1,
      targetTtsRate: Number(reportItem.effectiveSpeedFactor || reportItem.speedFactor || 1) || 1,
      errorReason: `TTS overflow ${overflowSeconds.toFixed(3)}s`,
    }, rows);
    if (item) byRowId.set(String(row.id), item);
    if (byRowId.size >= Number(options.maxRowsPerPass || 20)) break;
  }

  for (const clip of clips || []) {
    if (byRowId.size >= Number(options.maxRowsPerPass || 20)) break;
    if (clip?.ttsError === true || clip?.ttsFailed === true || clip?.status === 'error') continue;
    const segment = ttsSegments[Number(clip?.index) || 0] || segmentById.get(String(clip?.id || ''));
    if (!segment) continue;
    const slotSeconds = Math.max(0.1, Number(segment.duration || ((Number(segment.end) || 0) - (Number(segment.start) || 0))) || 0.1);
    const audioSeconds = Number(clip.duration || clip.durationSeconds || clip.audioDurationSeconds || 0);
    const overflowSeconds = Math.max(0, audioSeconds - slotSeconds);
    if (overflowSeconds < Number(options.minOverflowSeconds || 0)) continue;
    const row = rowForRepairableUnit(segment, rows);
    if (!row || byRowId.has(String(row.id))) continue;
    const item = repairItemForRow(row, segment, {
      slotSeconds,
      audioSeconds,
      overflowSeconds,
      fitRatio: slotSeconds > 0 && audioSeconds > 0 ? audioSeconds / slotSeconds : 1,
      errorReason: `TTS clip overflow ${overflowSeconds.toFixed(3)}s`,
    }, rows);
    if (item) byRowId.set(String(row.id), item);
  }

  return Array.from(byRowId.values()).slice(0, Number(options.maxRowsPerPass || 20));
}

function timelineOverflowSeconds(reportItem = {}) {
  return Math.max(
    0,
    Number(reportItem.endOverflowSeconds) || 0,
    Number(reportItem.overlapNextSeconds) || 0,
    Number(reportItem.cueEndOverflowSeconds) || 0,
    Number(reportItem.overflowAfterFitSeconds) || 0
  );
}

function reportItemActualDurationSeconds(reportItem = {}) {
  const explicit = Number(reportItem.actualDurationSeconds);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const start = Number(reportItem.actualStartSeconds);
  const end = Number(reportItem.actualEndSeconds);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
  const slot = Number(reportItem.expectedDurationSeconds || reportItem.availableSlotDurationSeconds || reportItem.targetDurationSeconds);
  const overflow = timelineOverflowSeconds(reportItem);
  return Number.isFinite(slot) && slot > 0 ? slot + overflow : 0;
}

function autoAntiOverflowMaxSpeakingRate(baseSpeakingRate = 1) {
  const base = clampNumber(baseSpeakingRate, 0.5, 2.0);
  return Number(Math.min(2.0, Math.max(AUTO_ANTI_OVERFLOW_MAX_SPEAKING_RATE, base * 1.25, base + 0.05)).toFixed(2));
}

function antiOverflowSpeedFactorForReportItem(reportItem = {}, options = {}) {
  const parsedTriggerOverflowSeconds = Number(options.triggerOverflowSeconds);
  const triggerOverflowSeconds = Number.isFinite(parsedTriggerOverflowSeconds)
    ? Math.max(0, parsedTriggerOverflowSeconds)
    : TTS_TIMING_TRACE_OVERFLOW_SECONDS;
  const overflowSeconds = timelineOverflowSeconds(reportItem);
  if (overflowSeconds <= triggerOverflowSeconds) return 1;

  const actualDuration = reportItemActualDurationSeconds(reportItem);
  if (!actualDuration) return 1;

  const parsedTargetOverflowSeconds = Number(options.targetOverflowSeconds);
  const targetOverflowSeconds = Math.max(
    0,
    (Number.isFinite(parsedTargetOverflowSeconds) ? parsedTargetOverflowSeconds : TTS_TIMING_TRACE_OVERFLOW_SECONDS)
      - AUTO_ANTI_OVERFLOW_TARGET_GUARD_SECONDS
  );
  const targetDuration = Math.max(0.08, actualDuration - Math.max(0, overflowSeconds - targetOverflowSeconds));
  const requiredFactor = actualDuration / targetDuration;
  const baseSpeakingRate = clampNumber(options.baseSpeakingRate, 0.5, 2.0);
  const maxSpeakingRate = autoAntiOverflowMaxSpeakingRate(baseSpeakingRate);
  const maxFactor = Math.max(1, maxSpeakingRate / Math.max(0.1, baseSpeakingRate));
  return Number(Math.min(maxFactor, Math.max(1.02, requiredFactor)).toFixed(3));
}

function findTimelineOverflowIndices(syncReport = {}, thresholdSeconds = 1) {
  const parsedThreshold = Number(thresholdSeconds);
  const threshold = Number.isFinite(parsedThreshold) ? Math.max(0, parsedThreshold) : 1;
  return Array.from(new Set((syncReport?.segments || [])
    .filter((item) => timelineOverflowSeconds(item) > threshold)
    .map((item) => Number(item.index))
    .filter((index) => Number.isInteger(index) && index >= 0)));
}

function applyAutoRepairToCollection(collection = [], repairs = [], config = {}) {
  if (!Array.isArray(collection) || !collection.length || !Array.isArray(repairs) || !repairs.length) return collection;
  const repairById = new Map(repairs.map((repair) => [String(repair.row_id || repair.rowId || ''), autoRepairText(repair.repaired_translation || repair.repairedTranslation || '')]));
  return collection.map((item) => {
    const directText = repairById.get(String(item.id || '')) || repairById.get(String(item.segmentId || ''));
    const sourceRowIds = Array.from(new Set([
      ...(Array.isArray(item.sourceRowIds) ? item.sourceRowIds : []),
      ...(Array.isArray(item.sourceIds) ? item.sourceIds : []),
    ].map((id) => String(id || '').trim()).filter(Boolean)));
    const sourceMatches = sourceRowIds.filter((id) => repairById.has(id));
    const repairText = directText || (sourceRowIds.length === 1 && sourceMatches.length === 1 ? repairById.get(sourceMatches[0]) : '');
    if (!repairText) return item;
    const ttsText = ttsTextFromTranslation(repairText, config) || repairText;
    return {
      ...item,
      text: repairText,
      translatedText: repairText,
      finalText: repairText,
      ttsText,
      prosodyText: ttsText,
      dirty: true,
      status: Array.isArray(item.atomIds) && item.atomIds.length ? 'needs_review' : (item.status || 'translated'),
      validationStatus: Array.isArray(item.atomIds) && item.atomIds.length ? 'needs_review' : item.validationStatus,
      ttsSync: null,
      ttsTimingFit: null,
    };
  });
}

function collectChangedAutoRepairRows(beforeRows = [], afterRows = [], inputItems = [], repairs = [], reason = '') {
  const beforeById = new Map((beforeRows || []).map((row) => [String(row.id || ''), row]));
  const itemById = new Map((inputItems || []).map((item) => [String(item.row_id || ''), item]));
  return (repairs || [])
    .map((repair) => {
      const rowId = String(repair.row_id || repair.rowId || '');
      const before = rowTextForAutoRepair(beforeById.get(rowId) || {});
      const after = autoRepairText(repair.repaired_translation || repair.repairedTranslation || '');
      if (!rowId || !after || after === before) return null;
      const item = itemById.get(rowId) || {};
      return {
        rowId,
        before,
        after,
        reason: reason || item.error_reason || '',
        slotSeconds: item.slot_seconds || 0,
        audioSeconds: item.audio_seconds || 0,
        overflowSeconds: item.overflow_seconds || 0,
      };
    })
    .filter(Boolean);
}

async function runAutoTtsRepairPass({
  jobId,
  phase,
  passNumber,
  inputItems,
  rows,
  rawMeaningUnits,
  rawTtsUnits,
  config,
  report,
}) {
  const repairs = await repairTtsOverflowTranslations(inputItems, config);
  const changedRows = collectChangedAutoRepairRows(rows, applyAutoRepairToCollection(rows, repairs, config), inputItems, repairs, phase);
  const repairedRowIds = changedRows.map((row) => row.rowId);
  const failedRowIds = inputItems
    .map((item) => String(item.row_id || ''))
    .filter((rowId) => rowId && !repairedRowIds.includes(rowId));
  report.passes.push({
    pass: passNumber,
    phase,
    inputIssueCount: inputItems.length,
    repairedRowIds,
    failedRowIds,
    remainingIssueCount: failedRowIds.length,
  });
  report.changedRows.push(...changedRows);
  if (repairedRowIds.length) {
    await addLog(jobId, 'info', `Auto TTS repair ${phase}: repaired ${repairedRowIds.length}/${inputItems.length} row(s).`);
  }
  return {
    rows: applyAutoRepairToCollection(rows, repairs, config),
    rawMeaningUnits: applyAutoRepairToCollection(rawMeaningUnits, repairs, config),
    rawTtsUnits: applyAutoRepairToCollection(rawTtsUnits, repairs, config),
    repairedRowIds,
  };
}

async function persistAutoTtsRepairTranslation(jobId, paths, rows = [], rawMeaningUnits = [], rawTtsUnits = [], config = {}, extra = {}) {
  const translatedJson = await readJson(paths.translatedJson, {});
  const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
  const finalSrtPath = path.join(paths.exports, 'translated.srt');
  const finalSourceSegments = sourceSegmentsFromTranslated(rows);
  const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
  const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
  await fs.mkdir(paths.translations, { recursive: true });
  await fs.mkdir(paths.exports, { recursive: true });
  await exportSrt(rows, translatedSrtPath);
  await exportSrt(rows, finalSrtPath);
  await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, rows, config));
  await writeJson(readabilityQcReportPath, createReadabilityQcReport(rows, config));
  await writeJson(paths.translatedJson, {
    ...(translatedJson && typeof translatedJson === 'object' ? translatedJson : {}),
    autoTtsRepairAppliedAt: new Date().toISOString(),
    segments: rows,
    rawSegments: rows,
    storySegments: Array.isArray(translatedJson.storySegments) ? rows : translatedJson.storySegments,
    meaningUnits: Array.isArray(rawMeaningUnits) && rawMeaningUnits.length ? rawMeaningUnits : translatedJson.meaningUnits,
    ttsUnits: Array.isArray(rawTtsUnits) && rawTtsUnits.length ? rawTtsUnits : translatedJson.ttsUnits,
    translationQcReportPath,
    readabilityQcReportPath,
    ...(extra || {}),
  });
  return {
    translatedSrtPath,
    finalSrtPath,
    translationQcReportPath,
    readabilityQcReportPath,
  };
}

async function persistAimaxSubtitleSafetySplit(paths, rows = [], config = {}) {
  const translatedJson = await readJson(paths.translatedJson, {});
  const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
  const finalSrtPath = path.join(paths.exports, 'translated.srt');
  const finalSourceSegments = sourceSegmentsFromTranslated(rows);
  const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
  const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
  await fs.mkdir(paths.translations, { recursive: true });
  await fs.mkdir(paths.exports, { recursive: true });
  await exportSrt(rows, translatedSrtPath);
  await exportSrt(rows, finalSrtPath);
  await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, rows, config));
  await writeJson(readabilityQcReportPath, createReadabilityQcReport(rows, config));
  await writeJson(paths.translatedJson, {
    ...(translatedJson && typeof translatedJson === 'object' ? translatedJson : {}),
    aimaxSubtitleSafetySplitAppliedAt: new Date().toISOString(),
    segments: rows,
    rawSegments: rows,
    ttsSegments: rows,
    translationQcReportPath,
    readabilityQcReportPath,
  });
  return {
    translatedSrtPath,
    finalSrtPath,
    translationQcReportPath,
    readabilityQcReportPath,
  };
}

async function getDependencySnapshot() {
  const [ffmpeg, ytDlp, python, tkinter, fasterWhisper, nodeDependencies] = await Promise.all([
    checkFfmpeg(),
    checkYtDlp(),
    checkPython(),
    checkTkinter(),
    checkFasterWhisper(),
    checkNodeDependencies(),
  ]);

  return {
    ffmpeg,
    ytDlp,
    python,
    tkinter,
    fasterWhisper,
    fasterWhisperRuntime: fasterWhisperService.getRuntimeOptions(),
    nodeDependencies,
  };
}

async function getTranscriptSegments(videoId, audioPath, config, jobId) {
  if (videoId) {
    try {
      const captions = await fetchTranscript(videoId);
      if (captions && captions.length) {
        if (jobId) await addLog(jobId, 'success', 'Using YouTube captions as transcript source.');
        return {
          provider: 'youtube_captions',
          segments: normalizeCaptionSegments(captions),
        };
      }
    } catch (error) {
      if (jobId) await addLog(jobId, 'warning', `YouTube subtitles were not available, falling back to Speech-to-Text. ${error.message}`);
    }
  }

  if (config.sttProvider === 'faster_whisper_local') {
    if (jobId) {
      const runtime = fasterWhisperService.getRuntimeOptions(config);
      await addLog(jobId, 'info', `Using Faster Whisper local as transcript source (${config.sttModel || 'small'}, ${runtime.device}/${runtime.computeType}).`);
    }
    return {
      provider: 'faster_whisper_local',
      segments: await fasterWhisperService.transcribeAudio(audioPath, config),
    };
  }
  if (config.sttProvider === 'groq_speech_to_text') {
    if (jobId) {
      const runtime = groqSpeechService.getRuntimeOptions(config);
      await addLog(jobId, 'info', `Using Groq Whisper STT as transcript source (${runtime.model}, ${runtime.chunkSeconds}s chunks, ${runtime.overlapSeconds}s overlap, concurrency ${runtime.concurrency}).`);
    }
    return {
      provider: 'groq_speech_to_text',
      segments: await groqSpeechService.transcribeAudio(audioPath, config),
    };
  }
  if (config.sttProvider === 'assemblyai_speech_to_text') {
    if (jobId) {
      const runtime = assemblyAiSpeechService.getRuntimeOptions(config);
      await addLog(jobId, 'info', `Using AssemblyAI STT as transcript source (${runtime.model}, fallback ${runtime.speechModels.join(' -> ')}, mode ${runtime.processingMode}, ${runtime.chunkSeconds}s chunks, ${runtime.overlapSeconds}s overlap, concurrency ${runtime.concurrency}).`);
    }
    return {
      provider: 'assemblyai_speech_to_text',
      segments: await assemblyAiSpeechService.transcribeAudio(audioPath, config),
    };
  }
  throw new Error(`Unsupported STT provider: ${config.sttProvider}`);
}

async function validateStartRequest(body, dependencies) {
  const sourceType = body.sourceType || (body.videoPath ? 'local' : 'youtube');

  if (sourceType === 'youtube') {
    const videoId = extractVideoId(body.videoUrl);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }
    if (!dependencies.ytDlp) {
      throw new Error('yt-dlp is missing or not available in PATH. Install yt-dlp and restart the backend.');
    }
    return { sourceType, videoId };
  }

  if (sourceType === 'local') {
    const resolvedVideoPath = await validateLocalVideoPath(body.videoPath);
    return { sourceType, videoInfo: getFileInfo(resolvedVideoPath), resolvedVideoPath };
  }

  throw new Error('Unsupported source type.');
}

function validateConfiguredExportAssets(config = {}) {
  if (config.logoEnabled === true && !String(config.logoPath || config.randomLogoPaths || '').trim()) {
    throw new Error('Logo is enabled but no logo file was provided. Choose a logo file or turn off logo export.');
  }
  if (config.musicEnabled === true && !String(config.musicPath || '').trim()) {
    throw new Error('Background music is enabled but no audio file was provided. Choose a music file or turn off background music.');
  }
  if (config.overlayEnabled === true && !String(config.overlayText || '').trim()) {
    throw new Error('Text overlay is enabled but the overlay text is empty. Enter overlay text or turn off text overlay.');
  }
}

async function processJob(jobId, body) {
  const startedAt = Date.now();
  const paths = getJobPaths(jobId);
  const config = resolveGoogleCloudConfig(body);
  const outputConfig = resolveOutputConfig(body, jobId);
  validateConfiguredExportAssets(config);

  await updateStage(jobId, STAGES.VALIDATING);
  await addLog(jobId, 'info', 'Collecting dependency snapshot.');
  const dependencies = await withTimeout(
    getDependencySnapshot(),
    30000,
    'Dependency check timed out after 30 seconds.'
  );
  await addLog(jobId, 'success', 'Dependency snapshot collected.');

  await addLog(jobId, 'info', 'Validating source input.');
  const validation = await withTimeout(
    validateStartRequest(body, dependencies),
    30000,
    'Input validation timed out after 30 seconds.'
  );
  await addLog(jobId, 'success', 'Source input validated.');

  await updateStage(jobId, STAGES.DEPENDENCIES);
  if (!dependencies.ffmpeg) {
    throw new Error('FFmpeg is missing or not available in PATH. Install FFmpeg and restart the backend.');
  }
  if (!dependencies.python) {
    throw new Error('Python is missing. Install Python and restart the backend.');
  }
  if (config.sttProvider === 'faster_whisper_local' && !dependencies.fasterWhisper) {
    throw new Error('faster-whisper is missing in the active Python environment. Install it with: python -m pip install faster-whisper');
  }

  let sourceVideoPath = '';
  let sourceType = validation.sourceType;
  let sourceVideoId = validation.videoId || null;

  await updateStage(jobId, STAGES.PREPARING_SOURCE, 'info', sourceType === 'youtube' ? 'Downloading YouTube source video.' : 'Preparing local source video.');
  if (sourceType === 'youtube') {
    sourceVideoPath = paths.sourceVideo;
    await downloadVideo(body.videoUrl, sourceVideoPath);
    await addLog(jobId, 'success', `YouTube source prepared for video ${sourceVideoId}.`);
  } else {
    sourceVideoPath = paths.sourceVideo;
    await fs.rm(sourceVideoPath, { force: true }).catch(() => {});
    const localVideoPath = validation.resolvedVideoPath || body.videoPath;
    try {
      await fs.link(localVideoPath, sourceVideoPath);
    } catch {
      await fs.copyFile(localVideoPath, sourceVideoPath);
    }
    await addLog(jobId, 'success', `Using local source video: ${localVideoPath}`);
  }

  await updateStage(jobId, STAGES.EXTRACTING_AUDIO);
  await extractAudio(sourceVideoPath, paths.speechAudio);
  const previewVideoPath = path.join(paths.source, 'preview_source.mp4');
  await createPreviewVideo(sourceVideoPath, previewVideoPath);
  const sourceDurationSeconds = await getDurationSeconds(sourceVideoPath);
  await addLog(jobId, 'success', 'Speech audio and browser preview extracted successfully.');

  await updateStage(jobId, STAGES.TRANSCRIBING);
  const transcript = await getTranscriptSegments(sourceVideoId, paths.speechAudio, config, jobId);
  const wordTimestampData = extractWordTimestampSegments(transcript.segments);
  const wordTimestampsPath = path.join(paths.transcripts, 'word_timestamps.json');
  if (wordTimestampData.wordCount) {
    await writeJson(wordTimestampsPath, {
      provider: transcript.provider,
      sourceLanguage: config.sourceLanguage,
      createdAt: new Date().toISOString(),
      ...wordTimestampData,
    });
  }
  const rawSegments = normalizeClientSegments(transcript.segments);
  const wordLevelSegments = buildWordLevelSegments(wordTimestampData);
  const selectedSourceSegments = config.sttTimestampMode === 'word_level' && wordLevelSegments.length
    ? wordLevelSegments
    : rawSegments;
  let meaningSegments = addTimingBudget(selectedSourceSegments, config);
  let nlpResegment = null;
  if (config.nlpSourceResegment !== false && wordTimestampData.wordCount) {
    try {
      nlpResegment = await buildVideoLingoLikeSourceSegments(rawSegments, paths, config, jobId);
      meaningSegments = addTimingBudget(normalizeClientSegments(nlpResegment.segments), config);
    } catch (error) {
      await addLog(jobId, 'warning', `NLP re-segmentation failed; using original STT segments. ${error.message}`);
    }
  }
  if (shouldSafetySplitSourceSegments(config)) {
    const beforeSafetySplitCount = meaningSegments.length;
    meaningSegments = addTimingBudget(splitLongSourceSegments(meaningSegments, sourceSafetySplitConfig(config)), config);
    if (meaningSegments.length > beforeSafetySplitCount) {
      await addLog(jobId, 'info', `Source subtitle safety split: ${beforeSafetySplitCount} cue(s) -> ${meaningSegments.length} cue(s) to avoid overly long subtitles.`);
    }
  }
  const isStoryTranslation = shouldUseStoryTranslation(config);
  const shouldNormalizeTimelineBeforeTranslate = !isStoryTranslation && config.normalizeTimelineBeforeTranslate !== false;
  const sourceLanguageForTranslate = String(config.sourceLanguage || '').toLowerCase();
  const targetLanguageForTranslate = String(config.targetLanguage || '').toLowerCase();
  const translationTimelineMode = (
    (sourceLanguageForTranslate === 'zh' || sourceLanguageForTranslate.startsWith('zh-') || sourceLanguageForTranslate.startsWith('cmn'))
    && targetLanguageForTranslate.startsWith('vi')
  ) ? 'meaning_units' : 'translation_packets';
  const translationInputSegments = isStoryTranslation
    ? meaningSegments
    : shouldNormalizeTimelineBeforeTranslate
    ? addTimingBudget(buildPipelineTranslationUnits(meaningSegments, {
      ...config,
      timelinePipelineMode: translationTimelineMode,
    }, { mode: translationTimelineMode }).translationUnits, config)
    : meaningSegments;
  if (!isStoryTranslation && shouldNormalizeTimelineBeforeTranslate && translationInputSegments.length !== meaningSegments.length) {
    await addLog(jobId, 'info', `Timeline normalizer built ${translationInputSegments.length} ${translationTimelineMode === 'meaning_units' ? 'meaning unit(s)' : 'translation packet(s)'} from ${meaningSegments.length} source cues before translation.`);
  }
  const rawSrtPath = path.join(paths.transcripts, 'raw_source.srt');
  const wordLevelSrtPath = path.join(paths.transcripts, 'word_level_source.srt');
  const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
  const sourceQcReportPath = path.join(paths.transcripts, 'source_qc_report.json');
  const sourceCoverageReportPath = path.join(paths.transcripts, 'source_coverage_report.json');
  const sourceCoverageReport = assertSourceCoverage(meaningSegments, translationInputSegments);
  await writeJson(sourceQcReportPath, createTimelineQcReport('source', translationInputSegments, config));
  await writeJson(sourceCoverageReportPath, sourceCoverageReport);
  await exportSrt(rawSegments, rawSrtPath);
  if (wordLevelSegments.length) {
    await exportSrt(wordLevelSegments, wordLevelSrtPath);
  }
  await exportSrt(translationInputSegments, sourceSegmentedSrtPath);
  await writeJson(paths.transcriptJson, {
    provider: transcript.provider,
    sourceLanguage: config.sourceLanguage,
    sttTimestampMode: config.sttTimestampMode,
    rawSegmentCount: rawSegments.length,
    wordLevelSegmentCount: wordLevelSegments.length,
    segmentedSegmentCount: translationInputSegments.length,
    wordTimestampPath: wordTimestampData.wordCount ? wordTimestampsPath : '',
    wordTimestampSegmentCount: wordTimestampData.segmentCount,
    wordTimestampCount: wordTimestampData.wordCount,
    nlpSourceResegment: config.nlpSourceResegment !== false,
    nlpResegmentPath: nlpResegment?.outputPath || '',
    nlpResegmentReportPath: nlpResegment?.reportPath || '',
    sourceQcReportPath,
    sourceCoverageReportPath,
    rawSrtPath,
    wordLevelSrtPath: wordLevelSegments.length ? wordLevelSrtPath : '',
    sourceSegmentedSrtPath,
    rawSegments,
    wordLevelSegments,
    meaningSegments,
    sourceSegments: translationInputSegments,
    translationMode: config.translationMode,
    translationPackets: shouldNormalizeTimelineBeforeTranslate ? translationInputSegments : [],
    segments: translationInputSegments,
  });
  await addLog(
    jobId,
    'success',
    `Transcription completed with ${rawSegments.length} source segments. Translation input has ${translationInputSegments.length} ${isStoryTranslation ? 'source cue(s) for story v2' : (translationTimelineMode === 'meaning_units' ? 'meaning unit(s)' : 'packet(s)')}. Coverage ${sourceCoverageReport.uniqueCoveredCount}/${sourceCoverageReport.sourceCount}, missing 0, duplicate 0.`
  );

  await updateStage(jobId, STAGES.TRANSLATING);
  let storyArtifact = null;
  let translatedPackets = [];
  let finalTranslatedSegments = [];
  let useMeaningTimelineDisplay = false;
  if (isStoryTranslation) {
    storyArtifact = await translateStorySegments(translationInputSegments, config);
    translatedPackets = normalizeStoryDisplaySegments(storyArtifact, config);
    finalTranslatedSegments = translatedPackets;
  } else {
    translatedPackets = alignTranslatedUnitsById(
      translationInputSegments,
      await translateSegments(translationInputSegments, config)
    );
    useMeaningTimelineDisplay = config.translationDisplayMode === 'meaning_timeline';
    const translatedDisplayMapping = shouldNormalizeTimelineBeforeTranslate
      ? (
        useMeaningTimelineDisplay
          ? mapTranslatedUnitsToMergedDisplayRows(translatedPackets, meaningSegments, {
            ...config,
            timelinePipelineMode: 'meaning_units',
          })
          : mapTranslatedUnitsToDisplayRows(translatedPackets, translationInputSegments, {
            ...config,
            timelinePipelineMode: translationTimelineMode,
          }, {
            mode: translationTimelineMode,
            translationUnits: translationInputSegments,
          })
      )
      : null;
    finalTranslatedSegments = addTimingBudget(
      shouldNormalizeTimelineBeforeTranslate
        ? normalizeClientSegments(translatedDisplayMapping.displayRows)
        : translatedPackets,
      config
    );
  }
  const finalSourceSegments = sourceSegmentsFromTranslated(finalTranslatedSegments);
  const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
  const readabilityQcReportPath = await writeReadabilityQcReport(paths, finalTranslatedSegments, config);
  await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, finalTranslatedSegments, config));
  if (shouldNormalizeTimelineBeforeTranslate) {
    await exportSrt(finalSourceSegments, sourceSegmentedSrtPath);
  }
  await writeJson(paths.translatedJson, {
    ...(storyArtifact || {}),
    provider: config.translationProvider,
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    translationMode: config.translationMode,
    translationDisplayMode: isStoryTranslation ? 'story_timeline' : config.translationDisplayMode,
    translationPackets: shouldNormalizeTimelineBeforeTranslate ? translationInputSegments : [],
    rawSegments: translatedPackets,
    segments: finalTranslatedSegments,
    ttsSegments: isStoryTranslation ? storyTtsUnits(storyArtifact, finalTranslatedSegments, config) : finalTranslatedSegments,
    translationQcReportPath,
    readabilityQcReportPath,
    sourceCoverageReportPath,
    sourceCoverageReport,
  });
  await addLog(
    jobId,
    storyArtifact && !storyArtifact.validation.valid ? 'warning' : 'success',
    isStoryTranslation
      ? `Story translation v2 completed with ${storyArtifact.meaningAtoms.length} atom(s), ${finalTranslatedSegments.length} Vietnamese sentence(s), status ${storyArtifact.validation.status}.`
      : `Translation completed with ${translatedPackets.length} packet(s), ${useMeaningTimelineDisplay ? 'kept as meaning timeline' : 'redistributed to source timeline'} with ${finalTranslatedSegments.length} cue(s).`
  );

  if (isStoryTranslation && storyArtifact.validation.valid !== true) {
    throw new Error(`Story translation needs review; TTS was blocked. ${storyArtifact.validation.errors.join('; ')}`);
  }

  await updateStage(jobId, STAGES.SYNTHESIZING);
  const maxNaturalSpeakingRate = naturalMaxSpeakingRate(config, config.ttsProvider);
  const autoTtsFitEnabled = config.ttsFitEnabled !== false;
  const requestedTtsFitMaxRate = Number(config.ttsFitMaxRate);
  const autoTtsFitMaxRate = Number(Math.min(isStoryTranslation ? 1.2 : 1.35, Math.max(
    Number(config.speakingRate) || 1,
    Number.isFinite(requestedTtsFitMaxRate) && requestedTtsFitMaxRate > 0 ? requestedTtsFitMaxRate : maxNaturalSpeakingRate
  )).toFixed(2));
  const strictTtsConfig = {
    ...config,
    preserveTtsAudio: !autoTtsFitEnabled,
    ttsDurationControl: autoTtsFitEnabled,
    ttsFitEnabled: autoTtsFitEnabled,
    ttsFitMode: config.ttsFitMode || 'balanced',
    ttsFitMaxRate: autoTtsFitMaxRate,
    allowTextShortening: false,
    maxSpeakingRate: autoTtsFitMaxRate,
    maxEffectiveSpeakingRate: autoTtsFitMaxRate,
    continueOnTtsError: true,
  };
  const mergedTtsSegments = isStoryTranslation
    ? storyTtsUnits(storyArtifact, finalTranslatedSegments, strictTtsConfig)
    : buildPipelineTtsUnits(finalTranslatedSegments, translatedPackets, strictTtsConfig, {
      builder: (displayRows) => mergeAdjacentTtsSegments(displayRows, strictTtsConfig),
    }).ttsUnits;
  const ttsFitPlan = planTtsFit(mergedTtsSegments, strictTtsConfig);
  if (isStoryTranslation) {
    const blockedUnits = (ttsFitPlan.units || []).filter((unit) => unit.action === 'manual_review');
    if (blockedUnits.length) {
      throw new Error(`Story TTS overflow requires review for: ${blockedUnits.map((unit) => unit.id || unit.index + 1).join(', ')}. Text was not shortened or clipped.`);
    }
  }
  const fittedTtsUnits = applyPlanToUnits(mergedTtsSegments, ttsFitPlan, strictTtsConfig);
  const ttsSegments = buildPhraseSegments(fittedTtsUnits, strictTtsConfig)
    .map((segment, index) => ({ ...segment, index }));
  const phrasePlan = summarizePhrasePlan(ttsSegments);
  const clips = await synthesizeAllSegments(ttsSegments, strictTtsConfig, paths.tts);
  const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');
  await writeJson(ttsQcReportPath, createTtsQcReport(ttsSegments, clips, {
    ...strictTtsConfig,
    ttsFitPlan,
  }));
  const ttsFit = summarizeTtsFit(clips);
  await addLog(
    jobId,
    ttsFit.overLimitCount > 0 ? 'warning' : 'success',
    `Generated ${clips.length} TTS segments from ${finalTranslatedSegments.length} subtitle cues. Phrase sync ${phrasePlan.enabled ? `${phrasePlan.phraseSegments} phrase clips` : 'off'}. Duration-fit avg ratio ${ttsFit.avgRatio}, overflow clips ${ttsFit.overLimitCount}/${ttsFit.total}.`
  );

  await updateStage(jobId, STAGES.SYNCING);
  const syncResult = await createAlignedAudio(ttsSegments, clips, paths.finalDubbedAudio, {
    ...strictTtsConfig,
    syncMode: 'strict',
    addSilenceGaps: true,
    audioSampleRate: config.audioSampleRate || 32000,
    preserveTtsAudio: !autoTtsFitEnabled,
    speedUpLongSegments: config.speedUpLongSegments,
    acceptOverflowSeconds: 0.03,
    retryOverflowSeconds: 0,
    strictEndGuardSeconds: 0.03,
    normalizeLoudness: config.normalizeLoudness,
    timelineDurationSeconds: sourceDurationSeconds,
    maxVoiceGapSeconds: 0,
    hardTrimOverflow: false,
    failOnStrictSync: isStoryTranslation,
    maxEffectiveSpeakingRate: autoTtsFitMaxRate,
  });
  await writeJson(paths.syncReportJson, syncResult.report);
  const syncQcReportPath = path.join(paths.exports, 'sync_qc_report.json');
  await writeJson(syncQcReportPath, createSyncQcReport(syncResult.report, strictTtsConfig));
  await addLog(
    jobId,
    syncResult.report.quality === 'warning' ? 'warning' : 'success',
    `Audio synchronization completed. Avg drift ${syncResult.report.avgStartDriftSeconds}s, max drift ${syncResult.report.maxStartDriftSeconds}s, ${syncResult.report.within150msPercent}% within 150ms.`
  );

  await updateStage(jobId, STAGES.EXPORTING);
  const burnSubtitles = config.exportOptions.includes('burn_subtitles');
  const softSubtitles = config.exportOptions.includes('soft_subtitles') || config.exportOptions.includes('srt');
  const displaySubtitlePath = path.join(path.dirname(paths.translatedSrt), 'display_translated.srt');
  if (softSubtitles || burnSubtitles) {
    await exportSrt(finalTranslatedSegments, paths.translatedSrt);
  }
  if (burnSubtitles) {
    await exportSrt(finalTranslatedSegments, displaySubtitlePath, {
      displayOptimized: true,
      maxChars: config.subtitleDisplayMode === 'detailed' ? 80 : 64,
      maxLineLength: config.subtitleDisplayMode === 'detailed' ? 40 : 32,
    });
  }
  if (config.exportOptions.includes('vtt')) {
    await exportVtt(finalTranslatedSegments, paths.translatedVtt);
  }
  await mergeVideoAndAudio(sourceVideoPath, paths.finalDubbedAudio, paths.dubbedVideo, {
    keepBackgroundMusic: config.keepBackgroundMusic,
    originalAudioVolume: config.originalAudioVolume,
    burnSubtitles,
    subtitlePath: burnSubtitles ? displaySubtitlePath : paths.translatedSrt,
    embedSoftSubtitles: softSubtitles,
    softSubtitlePath: softSubtitles ? paths.translatedSrt : '',
    softSubtitleLanguage: config.targetLanguage || 'und',
    softSubtitleTitle: 'DubFlow subtitles',
    textOverlay: config.overlayEnabled === true ? {
      text: config.overlayText,
      x: config.overlayX,
      y: config.overlayY,
      start: config.overlayStart,
      end: config.overlayEnd,
    } : null,
    musicEnabled: config.musicEnabled,
    musicPath: config.musicPath,
    musicVolume: config.musicVolume,
    musicFade: config.musicFade,
    logoEnabled: config.logoEnabled,
    logoPath: config.logoPath,
    logoPosition: config.logoPosition,
    logoX: config.logoX,
    logoY: config.logoY,
    logoSize: config.logoSize,
    logoOpacity: config.logoOpacity,
    randomLogoText: config.randomLogoText,
    randomLogoPaths: config.randomLogoPaths,
    randomIntervalSeconds: config.randomIntervalSeconds,
    outputQuality: config.outputQuality,
    outputAspectRatio: config.outputAspectRatio,
  });
  const localExportPath = await saveExportCopy(paths.dubbedVideo, outputConfig);
  const published = await publishJobArtifacts(jobId, {
    dubbedVideo: config.exportOptions.includes('mp4') ? paths.dubbedVideo : undefined,
    audioPath: config.exportOptions.includes('audio') ? paths.finalDubbedAudio : undefined,
    transcriptPath: config.exportOptions.includes('transcript') ? paths.transcriptJson : undefined,
    translatedPath: config.exportOptions.includes('transcript') ? paths.translatedJson : undefined,
    srtPath: softSubtitles ? paths.translatedSrt : undefined,
    vttPath: config.exportOptions.includes('vtt') ? paths.translatedVtt : undefined,
  });

  const durationSeconds = sourceDurationSeconds || await getDurationSeconds(sourceVideoPath);
  const processingTimeSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));

  const result = {
    downloadUrl: published.dubbedVideo?.downloadUrl || null,
    outputPath: paths.dubbedVideo,
    sourceVideoPath,
    sourceVideoUrl: toPublicJobUrl(jobId, sourceVideoPath),
    previewVideoPath,
    previewVideoUrl: toPublicJobUrl(jobId, previewVideoPath),
    transcriptPath: paths.transcriptJson,
    sttTimestampMode: config.sttTimestampMode,
    rawSrtPath,
    wordTimestampPath: wordTimestampData.wordCount ? wordTimestampsPath : '',
    wordLevelSrtPath: wordLevelSegments.length ? wordLevelSrtPath : '',
    sourceSegmentedSrtPath,
    sourceQcReportPath,
    translatedPath: paths.translatedJson,
    translationQcReportPath,
    readabilityQcReportPath,
    audioPath: paths.finalDubbedAudio,
    ttsQcReportPath,
    srtPath: paths.translatedSrt,
    softSubtitlePath: softSubtitles ? paths.translatedSrt : '',
    softSubtitleUrl: published.srtPath?.downloadUrl || '',
    vttPath: paths.translatedVtt,
    syncReportPath: paths.syncReportJson,
    syncQcReportPath,
    localExportPath,
    artifactDownloads: {
      dubbedVideo: published.dubbedVideo?.downloadUrl,
      audio: published.audioPath?.downloadUrl,
      transcript: published.transcriptPath?.downloadUrl,
      translated: published.translatedPath?.downloadUrl,
      srt: published.srtPath?.downloadUrl,
      softSubtitle: published.srtPath?.downloadUrl,
      vtt: published.vttPath?.downloadUrl,
    },
  };

  const stats = {
    transcriptSegments: transcript.segments.length,
    translatedSegments: finalTranslatedSegments.length,
    ttsSegments: clips.length,
    durationSeconds,
    processingTimeSeconds,
    sync: syncResult.report,
  };

  await updateJob(jobId, {
    status: 'completed',
    percent: 100,
    stage: STAGES.COMPLETED.stage,
    message: STAGES.COMPLETED.message,
    result,
    stats,
    error: null,
  });
  await addLog(jobId, 'success', 'Video processed successfully.');

  return { success: true, jobId, status: 'completed', percent: 100, message: STAGES.COMPLETED.message, result, stats };
}

app.get('/api/health', async (req, res) => {
  const dependencies = await getDependencySnapshot();
  const googleCloud = getGoogleConfigStatus();
  const hasWindowsFilePicker = process.platform === 'win32';

  res.json({
    status: 'OK',
    backend: true,
    localMode: LOCAL_FILE_PICKER_ENABLED && (hasWindowsFilePicker || (dependencies.python && dependencies.tkinter)),
    dependencies: {
      ffmpeg: dependencies.ffmpeg,
      ytDlp: dependencies.ytDlp,
      python: dependencies.python,
      tkinter: dependencies.tkinter,
      fasterWhisper: dependencies.fasterWhisper,
    },
    fasterWhisperRuntime: dependencies.fasterWhisperRuntime,
    googleCloud,
  });
});

app.post('/api/cli-translation/verify', async (req, res) => {
  try {
    const provider = req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider;
    const status = await getCliTranslationProviderStatus(provider);
    if (!status.available) {
      return res.status(400).json({
        success: false,
        ...status,
        message: `${status.provider || 'CLI'} is not available on this machine.`,
      });
    }
    res.json({ success: true, ...status });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/pick-video', async (req, res) => {
  if (!LOCAL_FILE_PICKER_ENABLED) {
    return res.status(400).json(buildError(
      'LOCAL_FILE_PICKER_DISABLED',
      'Local file picker is disabled.',
      'LOCAL_FILE_PICKER_ENABLED is false.',
      'Enable LOCAL_FILE_PICKER_ENABLED=true in Backend/.env or paste a local file path manually.'
    ));
  }

  const result = await pickVideoWithTkinter();
  if (!result.success) {
    if (result.cancelled) {
      return res.json(result);
    }

    const error = classifyError(new Error(result.error || result.message));
    return res.status(400).json({
      success: false,
      ...error,
    });
  }

  return res.json(result);
});

app.post('/api/pick-output-folder', async (req, res) => {
  if (!LOCAL_FILE_PICKER_ENABLED) {
    return res.status(400).json(buildError(
      'LOCAL_FOLDER_PICKER_DISABLED',
      'Local folder picker is disabled.',
      'LOCAL_FILE_PICKER_ENABLED is false.',
      'Enable LOCAL_FILE_PICKER_ENABLED=true in Backend/.env.'
    ));
  }

  const result = await pickOutputFolderWithTkinter();
  if (!result.success) {
    if (result.cancelled) {
      return res.json(result);
    }

    const error = classifyError(new Error(result.error || result.message));
    return res.status(400).json({
      success: false,
      ...error,
    });
  }

  return res.json(result);
});

app.post('/api/pick-audio', async (req, res) => {
  if (!LOCAL_FILE_PICKER_ENABLED) {
    return res.status(400).json(buildError(
      'LOCAL_AUDIO_PICKER_DISABLED',
      'Audio file picker is disabled.',
      'LOCAL_FILE_PICKER_ENABLED is false.',
      'Enable LOCAL_FILE_PICKER_ENABLED=true in Backend/.env or paste the audio path manually.'
    ));
  }

  const result = await pickAudioWithDialog();
  if (!result.success) {
    if (result.cancelled) return res.json(result);
    return res.status(400).json({ success: false, ...result });
  }
  return res.json(result);
});

app.post('/api/pick-logo', async (req, res) => {
  if (!LOCAL_FILE_PICKER_ENABLED) {
    return res.status(400).json(buildError(
      'LOCAL_LOGO_PICKER_DISABLED',
      'Logo file picker is disabled.',
      'LOCAL_FILE_PICKER_ENABLED is false.',
      'Enable LOCAL_FILE_PICKER_ENABLED=true in Backend/.env or paste the logo path manually.'
    ));
  }

  const result = await pickLogoWithDialog();
  if (!result.success) {
    if (result.cancelled) return res.json(result);
    return res.status(400).json({ success: false, ...result });
  }
  return res.json(result);
});

app.post('/api/pick-google-credentials', async (req, res) => {
  if (!LOCAL_FILE_PICKER_ENABLED) {
    return res.status(400).json(buildError(
      'GOOGLE_CREDENTIALS_PICKER_DISABLED',
      'Google credentials file picker is disabled.',
      'LOCAL_FILE_PICKER_ENABLED is false.',
      'Enable LOCAL_FILE_PICKER_ENABLED=true in Backend/.env or paste the service account JSON path manually.'
    ));
  }

  const result = await pickGoogleCredentialsWithDialog();
  if (!result.success) {
    if (result.cancelled) return res.json(result);
    return res.status(400).json({ success: false, ...result });
  }
  return res.json(result);
});

app.post('/api/check-google-cloud', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig(req.body);
    const result = await checkGoogleCloudConfig(config);
    res.json(result);
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({
      success: false,
      checks: {
        credentials: { ok: false, message: mapped.message },
        speechToText: { ok: false, message: 'unknown' },
        translation: { ok: false, message: 'unknown' },
        textToSpeech: { ok: false, message: 'unknown' },
        voices: { ok: false, message: 'unknown', count: 0 },
      },
      warnings: [],
      errors: [{ service: 'credentials', message: mapped.detail }],
    });
  }
});

app.get('/api/google-voices', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig({
      googleCloudConfig: {
        credentialsMode: req.get('x-goog-api-key') ? 'api_key' : 'backend_env',
        apiKey: req.get('x-goog-api-key'),
        serviceAccountPath: req.query.serviceAccountPath,
        ttsProvider: req.query.provider,
        ttsLanguageCode: req.query.languageCode,
        ttsVoiceName: req.query.voiceName,
      },
      targetLanguage: req.query.languageCode,
    });
    const voices = await listVoices(req.query.languageCode || 'vi-VN', config);
    res.json({ voices });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ ...mapped, voices: [] });
  }
});

function normalizeTtsProviderTestProviders(providers = []) {
  const requested = Array.isArray(providers) && providers.length ? providers : TTS_PROVIDER_TESTS.map((item) => item.provider);
  const allowed = new Map(TTS_PROVIDER_TESTS.map((item) => [item.provider, item]));
  const seen = new Set();
  return requested
    .map((provider) => allowed.get(String(provider || '').trim()))
    .filter((item) => {
      if (!item || seen.has(item.provider)) return false;
      seen.add(item.provider);
      return true;
    });
}

function normalizeTtsProviderTestSegments(rawSegments = []) {
  return normalizeClientSegments((Array.isArray(rawSegments) ? rawSegments : []).map((segment, index) => {
    const text = normalizeSegmentText(segment?.ttsText || segment?.prosodyText || segment?.finalText || segment?.translatedText || segment?.text);
    return {
      ...segment,
      id: String(segment?.id || `test-segment-${index + 1}`),
      text,
      ttsText: text,
      finalText: text,
      translatedText: text,
    };
  }))
    .filter((segment) => String(segment.text || '').trim())
    .slice(0, TTS_PROVIDER_TEST_SEGMENT_LIMIT);
}

function buildTtsProviderTestConfig(config = {}, provider) {
  const keepSelectedVoice = provider === config.ttsProvider;
  return {
    ...config,
    ttsProvider: provider,
    ttsVoiceName: keepSelectedVoice ? config.ttsVoiceName : '',
    ttsConcurrency: 1,
    ttsMaxAttempts: 1,
    ttsDurationControl: false,
    preserveTtsAudio: true,
  };
}

function ttsProviderTestText(segment = {}, config = {}) {
  const text = normalizeSegmentText(
    ttsTextFromTranslation(segment.ttsText || segment.prosodyText || segment.finalText || segment.translatedText || segment.text, config)
      || segment.text
  );
  return text.length > TTS_PROVIDER_TEST_TEXT_LIMIT
    ? text.slice(0, TTS_PROVIDER_TEST_TEXT_LIMIT).trim()
    : text;
}

app.post('/api/preview-voice', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig(req.body);
    const buffer = await previewVoice(req.body.text || 'This is a voice preview.', config);
    res.json({
      success: true,
      audioContent: buffer.toString('base64'),
      mimeType: 'audio/mpeg',
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json(mapped);
  }
});

app.post('/api/manual/test-tts-providers', async (req, res) => {
  const jobId = String(req.body?.jobId || '').trim();
  const abortController = new AbortController();
  const abortProviderTest = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  res.once('close', abortProviderTest);
  try {
    const segments = normalizeTtsProviderTestSegments(req.body?.segments || []);
    if (!segments.length) {
      throw new Error('No subtitle segments are available for TTS provider testing.');
    }

    const providers = normalizeTtsProviderTestProviders(req.body?.providers);
    if (!providers.length) {
      throw new Error('No supported TTS provider was selected for testing.');
    }

    const baseConfig = resolveGoogleCloudConfig({
      ...req.body,
      targetLanguage: req.body?.targetLanguage || 'vi',
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        ttsProvider: req.body?.ttsProvider || req.body?.googleCloudConfig?.ttsProvider,
        ttsLanguageCode: req.body?.ttsLanguageCode || req.body?.googleCloudConfig?.ttsLanguageCode,
        ttsVoiceName: req.body?.ttsVoiceName || req.body?.googleCloudConfig?.ttsVoiceName,
        voiceGenderFilter: req.body?.voiceGenderFilter || req.body?.googleCloudConfig?.voiceGenderFilter,
        ssmlGender: req.body?.ssmlGender || req.body?.googleCloudConfig?.ssmlGender,
        aimaxApiKey: req.body?.aimaxApiKey || req.body?.googleCloudConfig?.aimaxApiKey,
        aimaxBaseUrl: req.body?.aimaxBaseUrl || req.body?.googleCloudConfig?.aimaxBaseUrl,
        aimaxProvider: req.body?.aimaxProvider || req.body?.googleCloudConfig?.aimaxProvider,
        aimaxModel: req.body?.aimaxModel || req.body?.googleCloudConfig?.aimaxModel,
        speakingRate: req.body?.speakingRate ?? req.body?.googleCloudConfig?.speakingRate,
        pitch: req.body?.pitch ?? req.body?.googleCloudConfig?.pitch,
        ttsTextCleanupMode: req.body?.ttsTextCleanupMode || req.body?.googleCloudConfig?.ttsTextCleanupMode,
      },
    });
    baseConfig.abortSignal = abortController.signal;

    if (jobId) {
      await addLog(jobId, 'info', `TTS provider test started: ${providers.length} provider(s), ${segments.length} segment(s).`);
    }

    const results = [];
    for (const item of providers) {
      const providerStartedAt = Date.now();
      const providerConfig = buildTtsProviderTestConfig(baseConfig, item.provider);
      const testedSegments = [];

      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const startedAt = Date.now();
        const text = ttsProviderTestText(segment, providerConfig);
        try {
          const buffer = await previewVoice(text, { ...providerConfig });
          testedSegments.push({
            result: {
              id: segment.id,
              index: segment.index,
              ok: true,
              elapsedMs: Date.now() - startedAt,
              byteLength: buffer.length,
              textLength: text.length,
              textPreview: text.slice(0, 120),
            },
            sampleAudio: {
              segmentId: segment.id,
              mimeType: 'audio/mpeg',
              audioContent: buffer.toString('base64'),
            },
          });
        } catch (error) {
          const mapped = classifyError(error);
          const timeout = /timed out/i.test(mapped.detail || mapped.message || '');
          const detail = timeout
            ? `${item.label} chưa trả kết quả trong thời gian chờ cấu hình. Job đã gửi có thể vẫn chạy trên AIMAX.`
            : mapped.detail;
          const suggestion = timeout
            ? 'Để DubFlow chờ tới khi AIMAX trả kết quả, bỏ AIMAX_TTS_POLL_TIMEOUT_MS hoặc đặt về 0.'
            : mapped.suggestion;
          testedSegments.push({
            result: {
              id: segment.id,
              index: segment.index,
              ok: false,
              elapsedMs: Date.now() - startedAt,
              code: mapped.code,
              message: mapped.message,
              detail,
              suggestion,
              textLength: text.length,
              textPreview: text.slice(0, 120),
            },
            sampleAudio: null,
          });
          for (const skipped of segments.slice(segmentIndex + 1)) {
            testedSegments.push({
              result: {
                id: skipped.id,
                index: skipped.index,
                ok: false,
                skipped: true,
                elapsedMs: 0,
                code: 'TTS_PROVIDER_TEST_SKIPPED',
                message: 'Đã bỏ qua sau khi đoạn test trước lỗi.',
                detail: 'Đã dừng để không tạo thêm job provider sau lỗi hoặc timeout.',
                suggestion: 'Sửa cấu hình provider hoặc thử lại sau.',
                textLength: ttsProviderTestText(skipped, providerConfig).length,
                textPreview: ttsProviderTestText(skipped, providerConfig).slice(0, 120),
              },
              sampleAudio: null,
            });
          }
          break;
        }
      }
      const segmentResults = testedSegments.map((segment) => segment.result);
      const sampleAudio = testedSegments.find((segment) => segment.sampleAudio)?.sampleAudio || null;

      const failedCount = segmentResults.filter((segment) => !segment.ok && segment.skipped !== true).length;
      const skippedCount = segmentResults.filter((segment) => segment.skipped === true).length;
      const passedCount = segmentResults.filter((segment) => segment.ok).length;
      results.push({
        provider: item.provider,
        label: item.label,
        ok: failedCount === 0 && skippedCount === 0,
        elapsedMs: Date.now() - providerStartedAt,
        segmentCount: segmentResults.length,
        passedCount,
        failedCount,
        skippedCount,
        segments: segmentResults,
        sampleAudio,
      });
    }

    const failedProviders = results.filter((item) => !item.ok);
    if (jobId) {
      const summary = failedProviders.length
        ? `TTS provider test finished: ${results.length - failedProviders.length}/${results.length} provider(s) passed. Failed: ${failedProviders.map((item) => item.label).join(', ')}.`
        : `TTS provider test finished: all ${results.length} provider(s) passed.`;
      await addLog(jobId, failedProviders.length ? 'warning' : 'success', summary);
    }

    res.json({
      success: true,
      jobId,
      testedAt: new Date().toISOString(),
      segmentCount: segments.length,
      segments: segments.map((segment) => ({
        id: segment.id,
        index: segment.index,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
        text: segment.text,
      })),
      providers: results,
    });
  } catch (error) {
    const mapped = classifyError(error);
    if (jobId) {
      await addLog(jobId, 'error', mapped.detail || mapped.message || error.message || String(error)).catch(() => {});
    }
    if (abortController.signal.aborted || res.headersSent || res.writableEnded || res.destroyed) {
      return;
    }
    res.status(400).json({ success: false, ...mapped });
  } finally {
    res.off('close', abortProviderTest);
  }
});


app.post('/api/analyze-context', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig({
      ...req.body,
      googleCloudConfig: {
        ...(req.body.googleCloudConfig || {}),
        credentialsMode: 'backend_env',
      },
    });
    const jobId = req.body.jobId;
    let transcript = String(req.body.transcript || '').trim();

    if (!transcript && jobId) {
      const paths = getJobPaths(jobId);
      const transcriptJson = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf8'));
      transcript = (transcriptJson.segments || []).map((segment) => segment.text).filter(Boolean).join('\n');
    }

    if (!transcript) {
      throw new Error('No transcript is available for context analysis yet. Run SRT/STT first or provide transcript text.');
    }

    const analysis = await analyzeTranslationContext({
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      title: req.body.title || '',
      transcript: transcript.slice(0, 60000),
    }, config);

    res.json({ success: true, analysis });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json(mapped);
  }
});

app.post('/api/tts-voices', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig(req.body);
    const voices = await listVoices(req.body.languageCode || config.ttsLanguageCode || 'vi-VN', config);
    res.json({ voices });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ ...mapped, voices: [] });
  }
});

app.post('/api/manual/prepare-source', async (req, res) => {
  try {
    const prepared = await prepareManualSource(req.body || '');
    res.json({ success: true, ...prepared.result });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/extract-audio', async (req, res) => {
  try {
    const existingJobId = String(req.body?.jobId || '').trim();
    const prepared = await prepareManualSource(req.body || {}, existingJobId);
    const { jobId, paths } = prepared;
    const sourceType = prepared.result.sourceType;
    const sourceVideoId = prepared.result.sourceVideoId;
    const sourceVideoPath = prepared.result.sourceVideoPath;

    await updateJob(jobId, {
      status: 'running',
      stage: 'manual_extract_audio',
      percent: 10,
      message: 'Extracting audio for manual workflow.',
      error: null,
    });
    await extractAudio(sourceVideoPath, paths.speechAudio);
    const [videoStats, audioStats] = await Promise.all([
      getFileStats(sourceVideoPath),
      getFileStats(paths.speechAudio),
    ]);
    const durationSeconds = await getDurationSeconds(paths.speechAudio);

    const result = {
      jobId,
      sourceType,
      sourceVideoId,
      sourceVideoPath,
      sourceVideoUrl: `/api/manual/video/${jobId}`,
      previewVideoPath: '',
      previewVideoUrl: `/api/manual/video/${jobId}`,
      videoPath: sourceVideoPath,
      videoUrl: `/api/manual/video/${jobId}`,
      audioPath: paths.speechAudio,
      audioUrl: toPublicJobUrl(jobId, paths.speechAudio),
      durationSeconds,
      videoFileSizeBytes: videoStats?.size || 0,
      audioFileSizeBytes: audioStats?.size || 0,
      sampleRate: 16000,
      channels: 1,
      format: 'wav',
    };

    await updateJob(jobId, {
      status: 'completed',
      stage: 'manual_extract_audio_done',
      percent: 100,
      message: 'Audio extracted successfully.',
      result,
      error: null,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/stt', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        sttProvider: req.body?.sttProvider,
        sttModel: req.body?.sttModel,
        sttTimestampMode: req.body?.sttTimestampMode,
        nlpSourceResegment: req.body?.nlpSourceResegment ?? req.body?.googleCloudConfig?.nlpSourceResegment,
        sourceLanguage: req.body?.sourceLanguage,
        sttHint: req.body?.sttHint || req.body?.userHint || '',
      },
    });

    await resetManualArtifacts(paths, ['transcripts', 'translations', 'tts', 'exports']);

    const transcript = await getTranscriptSegments(null, paths.speechAudio, config, jobId);
    const wordTimestampData = extractWordTimestampSegments(transcript.segments);
    const wordTimestampsPath = path.join(paths.transcripts, 'word_timestamps.json');
    if (wordTimestampData.wordCount) {
      await writeJson(wordTimestampsPath, {
        provider: transcript.provider,
        sourceLanguage: config.sourceLanguage,
        createdAt: new Date().toISOString(),
        ...wordTimestampData,
      });
    }
    const rawSegments = normalizeClientSegments(transcript.segments);
    const wordLevelSegments = buildWordLevelSegments(wordTimestampData);
    const selectedSourceSegments = config.sttTimestampMode === 'word_level' && wordLevelSegments.length
      ? wordLevelSegments
      : rawSegments;
    let sourceSegments = normalizeClientSegments(addTimingBudget(selectedSourceSegments, config));
    let nlpResegment = null;
    if (config.nlpSourceResegment !== false && wordTimestampData.wordCount) {
      try {
        nlpResegment = await buildVideoLingoLikeSourceSegments(rawSegments, paths, config, jobId);
        sourceSegments = normalizeClientSegments(addTimingBudget(nlpResegment.segments, config));
      } catch (error) {
        await addLog(jobId, 'warning', `NLP re-segmentation failed; using original STT segments. ${error.message}`);
      }
    }
    if (shouldSafetySplitSourceSegments(config)) {
      const beforeSafetySplitCount = sourceSegments.length;
      sourceSegments = normalizeClientSegments(addTimingBudget(splitLongSourceSegments(sourceSegments, sourceSafetySplitConfig(config)), config));
      if (sourceSegments.length > beforeSafetySplitCount) {
        await addLog(jobId, 'info', `Source subtitle safety split: ${beforeSafetySplitCount} cue(s) -> ${sourceSegments.length} cue(s) to avoid overly long subtitles.`);
      }
    }
    const rawSrtPath = path.join(paths.transcripts, 'raw_source.srt');
    const wordLevelSrtPath = path.join(paths.transcripts, 'word_level_source.srt');
    const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
    const sourceQcReportPath = path.join(paths.transcripts, 'source_qc_report.json');
    const rawSrtContent = segmentsToSrt(rawSegments);
    const wordLevelSrtContent = wordLevelSegments.length ? segmentsToSrt(wordLevelSegments) : '';
    const sourceSegmentedSrtContent = segmentsToSrt(sourceSegments);
    await writeJson(sourceQcReportPath, createTimelineQcReport('source', sourceSegments, config));
    await exportSrt(rawSegments, rawSrtPath);
    if (wordLevelSegments.length) {
      await exportSrt(wordLevelSegments, wordLevelSrtPath);
    }
    await exportSrt(sourceSegments, sourceSegmentedSrtPath);
    await writeJson(paths.transcriptJson, {
      provider: transcript.provider,
      sourceLanguage: config.sourceLanguage,
      sttTimestampMode: config.sttTimestampMode,
      rawSegmentCount: rawSegments.length,
      wordLevelSegmentCount: wordLevelSegments.length,
      segmentedSegmentCount: sourceSegments.length,
      wordTimestampPath: wordTimestampData.wordCount ? wordTimestampsPath : '',
      wordTimestampSegmentCount: wordTimestampData.segmentCount,
      wordTimestampCount: wordTimestampData.wordCount,
      nlpSourceResegment: config.nlpSourceResegment !== false,
      nlpResegmentPath: nlpResegment?.outputPath || '',
      nlpResegmentReportPath: nlpResegment?.reportPath || '',
      sourceQcReportPath,
      rawSrtPath,
      wordLevelSrtPath: wordLevelSegments.length ? wordLevelSrtPath : '',
      sourceSegmentedSrtPath,
      rawSegments,
      wordLevelSegments,
      sourceSegments,
      segments: sourceSegments,
    });

    res.json({
      success: true,
      jobId,
      provider: transcript.provider,
      sttTimestampMode: config.sttTimestampMode,
      rawCount: rawSegments.length,
      wordLevelCount: wordLevelSegments.length,
      count: sourceSegments.length,
      wordTimestampPath: wordTimestampData.wordCount ? wordTimestampsPath : '',
      wordTimestampSegmentCount: wordTimestampData.segmentCount,
      wordTimestampCount: wordTimestampData.wordCount,
      nlpSourceResegment: config.nlpSourceResegment !== false,
      nlpResegmentPath: nlpResegment?.outputPath || '',
      nlpResegmentReportPath: nlpResegment?.reportPath || '',
      sourceQcReportPath,
      sourceQcReportUrl: toPublicJobUrl(jobId, sourceQcReportPath),
      rawSegments,
      wordLevelSegments,
      sourceSegments,
      segments: sourceSegments,
      rawSrtPath,
      rawSrtUrl: toPublicJobUrl(jobId, rawSrtPath),
      rawSrtContent,
      wordLevelSrtPath: wordLevelSegments.length ? wordLevelSrtPath : '',
      wordLevelSrtUrl: wordLevelSegments.length ? toPublicJobUrl(jobId, wordLevelSrtPath) : '',
      wordLevelSrtContent,
      sourceSegmentedSrtPath,
      sourceSegmentedSrtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
      sourceSegmentedSrtContent,
      srtPath: sourceSegmentedSrtPath,
      srtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
      srtContent: sourceSegmentedSrtContent,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/subtitle-template-groups', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const existingTranscript = await readJson(paths.transcriptJson, {});
    const inputSegments = Array.isArray(req.body?.segments) && req.body.segments.length
      ? req.body.segments
      : (existingTranscript.sourceSegments || existingTranscript.rawSegments || existingTranscript.segments || []);
    if (!Array.isArray(inputSegments) || !inputSegments.length) {
      throw new Error('No source segments available for AI grouping. Run STT first.');
    }

    const config = {
      ...resolveGoogleCloudConfig({
        ...req.body,
        googleCloudConfig: {
          ...(req.body?.googleCloudConfig || {}),
          sourceLanguage: req.body?.sourceLanguage || req.body?.googleCloudConfig?.sourceLanguage,
          targetLanguage: req.body?.targetLanguage || req.body?.googleCloudConfig?.targetLanguage,
          translationProvider: req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider,
          cliTranslationModel: req.body?.cliTranslationModel || req.body?.googleCloudConfig?.cliTranslationModel,
          subtitleGroupProvider: req.body?.subtitleGroupProvider || req.body?.googleCloudConfig?.subtitleGroupProvider,
          subtitleGroupModel: req.body?.subtitleGroupModel || req.body?.googleCloudConfig?.subtitleGroupModel,
        },
      }),
      subtitleGroupLanguage: req.body?.subtitleGroupLanguage || req.body?.sourceLanguage || req.body?.googleCloudConfig?.sourceLanguage,
      subtitleGroupBatchSize: req.body?.subtitleGroupBatchSize,
      subtitleGroupConcurrency: req.body?.subtitleGroupConcurrency ?? req.body?.googleCloudConfig?.subtitleGroupConcurrency,
      subtitleGroupProvider: req.body?.subtitleGroupProvider || req.body?.googleCloudConfig?.subtitleGroupProvider,
      subtitleGroupModel: req.body?.subtitleGroupModel || req.body?.googleCloudConfig?.subtitleGroupModel,
      cliTranslationConcurrency: req.body?.cliTranslationConcurrency ?? req.body?.googleCloudConfig?.cliTranslationConcurrency,
    };

    await addLog(jobId, 'info', `AI subtitle grouping started (${config.subtitleGroupProvider || config.translationProvider || 'codex_cli'}${config.subtitleGroupModel ? `/${config.subtitleGroupModel}` : ''}, ${config.subtitleGroupLanguage || config.sourceLanguage || 'auto'}, batch ${config.subtitleGroupBatchSize || 60}, concurrency ${config.subtitleGroupConcurrency || config.cliTranslationConcurrency || 1}).`);
    const artifact = await buildSubtitleTemplateGroups(inputSegments, config);
    const groupedSegments = addTimingBudget(normalizeClientSegments(artifact.segments), config);
    const { jsonPath, srtPath } = templateArtifactPaths(paths);
    const srtContent = segmentsToSrt(groupedSegments);

    await writeJson(jsonPath, {
      ...artifact,
      segments: groupedSegments,
    });
    await exportSrt(groupedSegments, srtPath);
    await writeJson(paths.transcriptJson, {
      ...(existingTranscript && typeof existingTranscript === 'object' ? existingTranscript : {}),
      templateGroupLanguage: artifact.language,
      templateGroupProvider: artifact.provider,
      templateGroupCount: groupedSegments.length,
      templateGroupWarnings: artifact.warnings,
      sourceTemplateGroupJsonPath: jsonPath,
      sourceTemplateGroupSrtPath: srtPath,
      sourceTemplateGroupSegments: groupedSegments,
    });

    await addLog(
      jobId,
      artifact.warnings?.length ? 'warning' : 'success',
      `AI subtitle grouping completed: ${inputSegments.length} source cue(s) -> ${groupedSegments.length} group(s).${artifact.warnings?.length ? ` Warnings: ${artifact.warnings.join('; ')}` : ''}`
    );

    res.json({
      success: true,
      jobId,
      language: artifact.language,
      provider: artifact.provider,
      count: groupedSegments.length,
      sourceCount: inputSegments.length,
      warnings: artifact.warnings || [],
      groups: artifact.groups,
      segments: groupedSegments,
      sourceTemplateGroupJsonPath: jsonPath,
      sourceTemplateGroupJsonUrl: toPublicJobUrl(jobId, jsonPath),
      sourceTemplateGroupSrtPath: srtPath,
      sourceTemplateGroupSrtUrl: toPublicJobUrl(jobId, srtPath),
      srtPath,
      srtUrl: toPublicJobUrl(jobId, srtPath),
      srtContent,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/standalone-tts/plan', async (req, res) => {
  try {
    const segments = standaloneTtsService.planSegments(req.body?.text || '');
    res.json({ success: true, segments });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/standalone-tts/jobs', async (req, res) => {
  try {
    const config = resolveGoogleCloudConfig({
      ...req.body,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        apiKey: req.body?.googleApiKey || req.body?.apiKey || req.body?.googleCloudConfig?.apiKey,
        ttsProvider: req.body?.ttsProvider || req.body?.googleCloudConfig?.ttsProvider,
        ttsLanguageCode: req.body?.ttsLanguageCode || req.body?.googleCloudConfig?.ttsLanguageCode,
        ttsVoiceName: req.body?.ttsVoiceName || req.body?.googleCloudConfig?.ttsVoiceName,
        voiceGenderFilter: req.body?.voiceGenderFilter || req.body?.googleCloudConfig?.voiceGenderFilter,
        ssmlGender: req.body?.ssmlGender || req.body?.googleCloudConfig?.ssmlGender,
        aimaxApiKey: req.body?.aimaxApiKey || req.body?.googleCloudConfig?.aimaxApiKey,
        aimaxBaseUrl: req.body?.aimaxBaseUrl || req.body?.googleCloudConfig?.aimaxBaseUrl,
        aimaxProvider: req.body?.aimaxProvider || req.body?.googleCloudConfig?.aimaxProvider,
        aimaxModel: req.body?.aimaxModel || req.body?.googleCloudConfig?.aimaxModel,
        ttsConcurrency: req.body?.ttsConcurrency ?? req.body?.googleCloudConfig?.ttsConcurrency,
        ttsMaxAttempts: req.body?.ttsMaxAttempts ?? req.body?.googleCloudConfig?.ttsMaxAttempts,
        speakingRate: req.body?.speakingRate ?? req.body?.googleCloudConfig?.speakingRate,
        pitch: req.body?.pitch ?? req.body?.googleCloudConfig?.pitch,
      },
    });
    const operation = await standaloneTtsService.startOperation(req.body, config);
    res.json({ success: true, ...operation });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.get('/api/standalone-tts/jobs/:operationId', async (req, res) => {
  const operation = await standaloneTtsService.getOperation(req.params.operationId);
  if (!operation) {
    return res.status(404).json({ success: false, message: 'Standalone TTS operation was not found.' });
  }
  return res.json({ success: true, ...operation });
});

app.post('/api/standalone-tts/jobs/:operationId/cancel', async (req, res) => {
  const result = standaloneTtsService.cancelOperation(req.params.operationId);
  return res.json({ success: true, ...result });
});

app.get('/api/standalone-tts/history', async (req, res) => {
  try {
    const history = await standaloneTtsService.historyWithAvailability();
    res.json({
      success: true,
      history,
      defaultOutputDirectory: standaloneTtsService.defaultOutputDirectory(),
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.delete('/api/standalone-tts/history', async (req, res) => {
  try {
    await standaloneTtsService.clearHistory();
    res.json({ success: true, history: [] });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.get('/api/standalone-tts/files/:operationId', async (req, res) => {
  try {
    const filePath = await standaloneTtsService.resolveResultFile(req.params.operationId);
    if (!filePath) {
      return res.status(404).json({ success: false, message: 'Standalone TTS output file is not available.' });
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', localFileContentType(filePath));
    res.setHeader(
      'Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename="${path.basename(filePath).replace(/"/g, '')}"`
    );
    return fsNative.createReadStream(filePath).pipe(res);
  } catch (error) {
    return res.status(404).json({ success: false, message: 'Standalone TTS output file is not available.', detail: error.message });
  }
});

app.post('/api/standalone-tts/open-folder', async (req, res) => {
  try {
    const folderPath = path.resolve(String(req.body?.folderPath || '').trim());
    const stats = await fs.stat(folderPath);
    if (!stats.isDirectory()) throw new Error('Output folder does not exist.');
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    await execFileAsync(command, [folderPath], { windowsHide: true });
    res.json({ success: true, folderPath });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/ocr-burned-subtitles', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        sourceLanguage: req.body?.sourceLanguage,
      },
    });
    config.ocrProvider = normalizeOcrProvider(req.body?.ocrProvider || req.body?.provider || config.ocrProvider);
    config.ocrFps = req.body?.ocrFps ?? req.body?.fps ?? 2;
    config.ocrCrop = req.body?.ocrCrop || req.body?.crop || null;
    config.ocrCropX = req.body?.ocrCropX;
    config.ocrCropY = req.body?.ocrCropY;
    config.ocrCropW = req.body?.ocrCropW;
    config.ocrCropH = req.body?.ocrCropH;
    config.ocrLanguageHints = req.body?.ocrLanguageHints || req.body?.languageHints || ['zh', 'zh-Hans'];
    config.ocrMergeSimilarity = req.body?.ocrMergeSimilarity ?? 0.86;
    config.ocrMaxEmptyGap = req.body?.ocrMaxEmptyGap ?? 0.45;
    config.ocrMinDuration = req.body?.ocrMinDuration ?? 0.25;
    config.ocrRequireCjk = req.body?.ocrRequireCjk !== false;
    config.ocrSkipUnchanged = req.body?.ocrSkipUnchanged !== false;
    config.ocrChangeThreshold = req.body?.ocrChangeThreshold ?? 0.025;
    config.ocrConcurrency = req.body?.ocrConcurrency ?? 8;
    config.ocrMaxKeyframeGap = req.body?.ocrMaxKeyframeGap ?? 1.5;

    const responsePayload = await runExclusiveJobOperation(jobId, 'burned subtitle OCR', async (operationSignal) => {
      await resetManualArtifacts(paths, ['transcripts', 'translations', 'tts', 'exports']);
      const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
      await updateJob(jobId, {
        status: 'running',
        stage: 'manual_ocr_burned_subtitles',
        percent: 10,
        message: 'Running burned subtitle OCR with RapidOCR.',
        error: null,
      });

      const ocrResult = await buildBurnedSubtitleOcrSegments(sourceVideoPath, paths, config, jobId, operationSignal);
      const sourceSegments = normalizeClientSegments(addTimingBudget(ocrResult.segments, config));
      const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
      const sourceQcReportPath = path.join(paths.transcripts, 'source_qc_report.json');
      const sourceSegmentedSrtContent = segmentsToSrt(sourceSegments);
      await writeJson(sourceQcReportPath, createTimelineQcReport('source', sourceSegments, config));
      await exportSrt(sourceSegments, sourceSegmentedSrtPath);
      await writeJson(paths.transcriptJson, {
        provider: `${config.ocrProvider}_ocr`,
        sourceLanguage: config.sourceLanguage,
        ocrProvider: config.ocrProvider,
        ocrFps: Number(config.ocrFps) || 2,
        ocrCrop: config.ocrCrop || {
          x: Number(config.ocrCropX ?? 0) || 0,
          y: Number(config.ocrCropY ?? 0.72) || 0.72,
          w: Number(config.ocrCropW ?? 1) || 1,
          h: Number(config.ocrCropH ?? 0.24) || 0.24,
        },
        ocrPreserveFrameText: true,
        ocrRequireCjk: config.ocrRequireCjk !== false,
        ocrSkipUnchanged: config.ocrSkipUnchanged !== false,
        ocrChangeThreshold: Number(config.ocrChangeThreshold) || 0.025,
        ocrConcurrency: Number(config.ocrConcurrency) || 8,
        ocrMaxKeyframeGap: Number(config.ocrMaxKeyframeGap) || 1.5,
        ocrReportPath: ocrResult.reportPath,
        rawSegmentCount: sourceSegments.length,
        segmentedSegmentCount: sourceSegments.length,
        sourceQcReportPath,
        sourceSegmentedSrtPath,
        sourceSegments,
        segments: sourceSegments,
      });

      const payload = {
        success: true,
        jobId,
        provider: `${config.ocrProvider}_ocr`,
        ocrProvider: config.ocrProvider,
        ocrPreserveFrameText: true,
        count: sourceSegments.length,
        rawCount: sourceSegments.length,
        framesProcessed: ocrResult.report?.framesProcessed || 0,
        framesScanned: ocrResult.report?.framesScanned || ocrResult.report?.framesRequested || 0,
        framesSkipped: ocrResult.report?.framesSkipped || 0,
        ocrRequests: ocrResult.report?.ocrRequests || ocrResult.report?.framesProcessed || 0,
        skipRatio: ocrResult.report?.skipRatio || 0,
        framesWithText: ocrResult.report?.framesWithText || 0,
        framesFilteredOut: ocrResult.report?.framesFilteredOut || 0,
        sourceSegments,
        segments: sourceSegments,
        ocrSrtPath: ocrResult.outputPath,
        ocrSrtUrl: toPublicJobUrl(jobId, ocrResult.outputPath),
        ocrReportPath: ocrResult.reportPath,
        ocrReportUrl: toPublicJobUrl(jobId, ocrResult.reportPath),
        sourceQcReportPath,
        sourceQcReportUrl: toPublicJobUrl(jobId, sourceQcReportPath),
        sourceSegmentedSrtPath,
        sourceSegmentedSrtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
        sourceSegmentedSrtContent,
        srtPath: sourceSegmentedSrtPath,
        srtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
        srtContent: sourceSegmentedSrtContent,
      };

      await updateJob(jobId, {
        status: 'completed',
        stage: 'manual_ocr_burned_subtitles_done',
        percent: 100,
        message: `OCR created ${sourceSegments.length} burned subtitle cues.`,
        result: payload,
        error: null,
      });

      return payload;
    }, { response: res });

    res.json(responsePayload);
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/ocr-burned-subtitles-keyframe', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        sourceLanguage: req.body?.sourceLanguage,
      },
    });
    config.ocrKeyframeProvider = normalizeOcrProvider(req.body?.ocrKeyframeProvider || req.body?.provider || req.body?.ocrProvider || 'rapidocr');
    config.ocrProvider = config.ocrKeyframeProvider;
    config.ocrKeyframeTimelineFps = req.body?.ocrKeyframeTimelineFps ?? req.body?.timelineFps;
    config.ocrCrop = req.body?.ocrCrop || req.body?.crop || null;
    config.ocrCropX = req.body?.ocrCropX;
    config.ocrCropY = req.body?.ocrCropY;
    config.ocrCropW = req.body?.ocrCropW;
    config.ocrCropH = req.body?.ocrCropH;
    config.ocrLanguageHints = req.body?.ocrLanguageHints || req.body?.languageHints || ['zh', 'zh-Hans'];
    config.ocrMergeSimilarity = req.body?.ocrMergeSimilarity ?? 0.86;
    config.ocrMaxEmptyGap = req.body?.ocrMaxEmptyGap ?? 0.35;
    config.ocrMinDuration = req.body?.ocrMinDuration ?? 0.12;
    config.ocrRequireCjk = req.body?.ocrRequireCjk !== false;
    config.ocrConcurrency = req.body?.ocrConcurrency ?? 8;
    config.ocrKeyframeChangeThreshold = req.body?.ocrKeyframeChangeThreshold;
    config.ocrKeyframeSuspiciousChange = req.body?.ocrKeyframeSuspiciousChange;
    config.ocrKeyframeMinTextDensity = req.body?.ocrKeyframeMinTextDensity;
    config.ocrKeyframeVerifyLongSeconds = req.body?.ocrKeyframeVerifyLongSeconds ?? 3.5;
    config.ocrKeyframeSampleEverySeconds = req.body?.ocrKeyframeSampleEverySeconds;
    config.ocrKeyframeBoundaryRefineWindow = req.body?.ocrKeyframeBoundaryRefineWindow ?? 0.16;
    config.ocrKeyframeEmptyConfirmFrames = req.body?.ocrKeyframeEmptyConfirmFrames ?? 2;

    const responsePayload = await runExclusiveJobOperation(jobId, 'burned subtitle keyframe OCR', async (operationSignal) => {
      await resetManualArtifacts(paths, ['transcripts', 'translations', 'tts', 'exports']);
      const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
      await updateJob(jobId, {
        status: 'running',
        stage: 'manual_ocr_keyframe_burned_subtitles',
        percent: 10,
        message: `Running RapidOCR keyframe OCR with local timeline ${Number(config.ocrKeyframeTimelineFps) || 15} fps.`,
        error: null,
      });

      const ocrResult = await buildBurnedSubtitleKeyframeOcrSegments(sourceVideoPath, paths, config, jobId, operationSignal);
      const sourceSegments = normalizeClientSegments(addTimingBudget(ocrResult.segments, config));
      const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
      const sourceQcReportPath = path.join(paths.transcripts, 'source_qc_report.json');
      const sourceSegmentedSrtContent = segmentsToSrt(sourceSegments);
      await writeJson(sourceQcReportPath, createTimelineQcReport('source', sourceSegments, config));
      await exportSrt(sourceSegments, sourceSegmentedSrtPath);
      await writeJson(paths.transcriptJson, {
        provider: `${config.ocrKeyframeProvider}_keyframe_ocr`,
        sourceLanguage: config.sourceLanguage,
        ocrProvider: config.ocrKeyframeProvider,
        ocrMode: 'local_timeline_keyframe',
        ocrKeyframeTimelineFps: Number(config.ocrKeyframeTimelineFps) || 15,
        ocrCrop: config.ocrCrop || {
          x: Number(config.ocrCropX ?? 0) || 0,
          y: Number(config.ocrCropY ?? 0.72) || 0.72,
          w: Number(config.ocrCropW ?? 1) || 1,
          h: Number(config.ocrCropH ?? 0.24) || 0.24,
        },
        ocrPreserveFrameText: true,
        ocrRequireCjk: config.ocrRequireCjk !== false,
        ocrConcurrency: Number(config.ocrConcurrency) || 8,
        ocrReportPath: ocrResult.reportPath,
        rawSegmentCount: sourceSegments.length,
        segmentedSegmentCount: sourceSegments.length,
        sourceQcReportPath,
        sourceSegmentedSrtPath,
        sourceSegments,
        segments: sourceSegments,
      });

      const payload = {
        success: true,
        jobId,
        provider: `${config.ocrKeyframeProvider}_keyframe_ocr`,
        ocrProvider: config.ocrKeyframeProvider,
        ocrMode: 'local_timeline_keyframe',
        ocrPreserveFrameText: true,
        count: sourceSegments.length,
        rawCount: sourceSegments.length,
        localFramesScanned: ocrResult.report?.localFramesScanned || 0,
        groupsDetected: ocrResult.report?.groupsDetected || 0,
        rapidOcrRequests: ocrResult.report?.rapidOcrRequests || 0,
        ocrRequests: ocrResult.report?.ocrRequests || ocrResult.report?.rapidOcrRequests || 0,
        framesProcessed: ocrResult.report?.ocrRequests || ocrResult.report?.rapidOcrRequests || 0,
        framesScanned: ocrResult.report?.localFramesScanned || 0,
        framesWithText: ocrResult.report?.framesWithText || 0,
        framesFilteredOut: ocrResult.report?.framesFilteredOut || 0,
        elapsedSeconds: ocrResult.report?.elapsedSeconds || 0,
        scanSeconds: ocrResult.report?.scanSeconds || 0,
        ocrSeconds: ocrResult.report?.ocrSeconds || 0,
        ocrWorkers: ocrResult.report?.ocrWorkers || 1,
        timelineFps: ocrResult.report?.timelineFps || Number(config.ocrKeyframeTimelineFps) || 15,
        sourceSegments,
        segments: sourceSegments,
        ocrSrtPath: ocrResult.outputPath,
        ocrSrtUrl: toPublicJobUrl(jobId, ocrResult.outputPath),
        ocrReportPath: ocrResult.reportPath,
        ocrReportUrl: toPublicJobUrl(jobId, ocrResult.reportPath),
        sourceQcReportPath,
        sourceQcReportUrl: toPublicJobUrl(jobId, sourceQcReportPath),
        sourceSegmentedSrtPath,
        sourceSegmentedSrtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
        sourceSegmentedSrtContent,
        srtPath: sourceSegmentedSrtPath,
        srtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
        srtContent: sourceSegmentedSrtContent,
      };

      await updateJob(jobId, {
        status: 'completed',
        stage: 'manual_ocr_keyframe_burned_subtitles_done',
        percent: 100,
        message: `Keyframe OCR created ${sourceSegments.length} burned subtitle cues.`,
        result: payload,
        error: null,
      });

      return payload;
    }, { response: res });

    res.json(responsePayload);
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/ocr-test-frame', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        sourceLanguage: req.body?.sourceLanguage,
      },
    });
    config.ocrProvider = normalizeOcrProvider(req.body?.ocrProvider || req.body?.provider || config.ocrProvider);
    config.ocrCrop = req.body?.ocrCrop || req.body?.crop || null;
    config.ocrCropX = req.body?.ocrCropX;
    config.ocrCropY = req.body?.ocrCropY;
    config.ocrCropW = req.body?.ocrCropW;
    config.ocrCropH = req.body?.ocrCropH;
    config.ocrLanguageHints = req.body?.ocrLanguageHints || req.body?.languageHints || ['zh', 'zh-Hans'];
    config.ocrTestTime = req.body?.time ?? req.body?.currentTime ?? 0;

    const testResult = await runExclusiveJobOperation(jobId, 'OCR crop test', async (operationSignal) => {
      const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
      return testBurnedSubtitleOcrFrame(sourceVideoPath, paths, config, operationSignal);
    }, { response: res });

    res.json({
      success: true,
      jobId,
      provider: config.ocrProvider,
      time: testResult.time,
      text: testResult.text,
      textOneLine: testResult.textOneLine,
      confidence: testResult.confidence,
      previewImagePath: testResult.previewImagePath,
      previewImageUrl: toPublicJobUrl(jobId, testResult.previewImagePath),
      reportPath: testResult.reportPath,
      reportUrl: toPublicJobUrl(jobId, testResult.reportPath),
      framesProcessed: testResult.report?.framesProcessed || 0,
      framesWithText: testResult.report?.framesWithText || 0,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/ocr-frame-preview', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
    const timeSeconds = req.body?.time ?? req.body?.currentTime ?? 0;
    const frame = await extractManualFramePreview(sourceVideoPath, paths, timeSeconds);

    res.json({
      success: true,
      jobId,
      time: frame.time,
      width: frame.width,
      height: frame.height,
      imagePath: frame.outputPath,
      imageUrl: toPublicJobUrl(jobId, frame.outputPath),
      reportPath: frame.reportPath,
      reportUrl: toPublicJobUrl(jobId, frame.reportPath),
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/translate', async (req, res) => {
  const jobId = String(req.body?.jobId || '').trim();
  try {
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    let baseTranscript = [];
    const requestSegments = normalizeClientSegments(req.body?.segments || []);
    if (requestSegments.length) {
      baseTranscript = requestSegments;
    }
    if (!baseTranscript.length && req.body?.useStoredSource === true) {
      const transcriptJson = await readJson(paths.transcriptJson, null);
      baseTranscript = normalizeClientSegments(transcriptJson?.sourceSegments || transcriptJson?.segments || []);
    }
    if (!baseTranscript.length) {
      const transcriptJson = await readJson(paths.transcriptJson, null);
      baseTranscript = normalizeClientSegments(transcriptJson?.sourceSegments || transcriptJson?.segments || []);
    }

    const translationProvider = req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider;
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      targetLanguage: req.body?.targetLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        translationProvider,
        cliTranslationConcurrency: req.body?.cliTranslationConcurrency ?? req.body?.googleCloudConfig?.cliTranslationConcurrency,
        translationMode: req.body?.translationMode || req.body?.googleCloudConfig?.translationMode,
        sourceLanguage: req.body?.sourceLanguage,
        targetLanguage: req.body?.targetLanguage,
        userContext: req.body?.videoContext || req.body?.userContext || '',
        customGlossary: req.body?.customGlossary || '',
        translationDisplayMode: req.body?.translationDisplayMode || req.body?.googleCloudConfig?.translationDisplayMode,
      },
    });
    config.translationTimingValidationMode = 'off';
    config.translationTimingRewriteMaxPasses = 0;
    config.ttsTimingRewrite = false;
    config.translationProgress = async (event = {}) => {
      if (event.type === 'start' || event.type === 'story_start') {
        await addLog(jobId, 'info', `Dịch phụ đề: ${event.totalLines || 0} cụm nghĩa, ${event.totalChunks || 0} gói, chạy song song ${event.concurrency || 1}.`);
      } else if (event.type === 'chunk_start') {
        await addLog(jobId, 'info', `Đang dịch gói ${event.chunkIndex}/${event.totalChunks} (${event.lineCount || 0} dòng).`);
      } else if (event.type === 'chunk_done') {
        await addLog(jobId, 'success', `Xong gói dịch ${event.chunkIndex}/${event.totalChunks}.`);
      } else if (event.type === 'chunk_error') {
        await addLog(jobId, 'warning', `Gói dịch ${event.chunkIndex}/${event.totalChunks} lỗi, đang thử chia nhỏ: ${event.error || ''}`);
      }
    };
    let originalBaseTranscript = addTimingBudget(baseTranscript, config);
    // Prompt 1 grouping must not force Prompt 2 into isolated line-by-line
    // translation. Story v2 is the default for grouped sources; the direct
    // group translator remains an explicit legacy choice.
    const usesPrompt1Groups = req.body?.templateGroupTranslation === true
      || req.body?.googleCloudConfig?.templateGroupTranslation === true
      || (originalBaseTranscript.length > 0 && originalBaseTranscript.every((segment) => (
        segment.templateGroupCreatedBy === 'ai_grouping'
        || String(segment.id || '').startsWith('template-')
      )));
    config.templateGroupTranslation = usesPrompt1Groups && config.translationMode !== 'story_v2';
    config.storyNarrativeGrouping = usesPrompt1Groups && config.translationMode === 'story_v2';
    if (config.storyNarrativeGrouping) {
      // Use a long, self-contained story batch. This improves continuity while
      // retaining parallel translation across independent batches.
      config.storyContextTargetSeconds = 25;
      config.storyContextMaxSeconds = 30;
      config.storyRepairMaxAttempts = 2;
      config.storyVerifierEnabled = true;
    }
    if (shouldUseTemplateGroupTranslation(originalBaseTranscript, config)) {
      originalBaseTranscript = addTimingBudget(await hydrateTemplateGroupSourceSegments(paths, originalBaseTranscript), config);
      const translatedSegments = normalizeClientSegments(await translateTemplateGroups(originalBaseTranscript, config));
      const ttsUnits = addTimingBudget(translatedSegments.map((segment, index) => ({
        ...segment,
        id: segment.id || `template-tts-${index + 1}`,
        index,
        text: segment.ttsText || segment.finalText || segment.text,
        ttsText: segment.ttsText || segment.finalText || segment.text,
        prosodyText: segment.ttsText || segment.finalText || segment.text,
        sourceSegmentCount: Array.isArray(segment.sourceIds) ? segment.sourceIds.length : 1,
      })), { ...config, borrowGapSeconds: 0 });
      const finalSourceSegments = sourceSegmentsFromTranslated(translatedSegments);
      const sourceCoverageReportPath = path.join(paths.translations, 'source_coverage_report.json');
      const sourceCoverageReport = {
        name: 'template_group_coverage',
        status: 'ok',
        checkedAt: new Date().toISOString(),
        valid: true,
        sourceCount: originalBaseTranscript.length,
        groupedUnitCount: translatedSegments.length,
        coveredCount: translatedSegments.length,
        uniqueCoveredCount: translatedSegments.length,
        coveragePercent: originalBaseTranscript.length ? 100 : 0,
        missingIds: [],
        duplicateIds: [],
        unexpectedIds: [],
        duplicateSourceIds: [],
        orderValid: true,
      };
      const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
      const finalSrtPath = path.join(paths.exports, 'translated.srt');
      const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
      const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
      const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');

      await saveManualSourceTranscript(paths, originalBaseTranscript, {
        sourceLanguage: req.body?.sourceLanguage,
        updatedFromTimelineAt: new Date().toISOString(),
        translationMode: 'template_group_merged',
        sourceCoverageReportPath,
      });
      await resetManualArtifacts(paths, ['translations', 'tts', 'exports']);
      await writeJson(sourceCoverageReportPath, sourceCoverageReport);
      await exportSrt(translatedSegments, translatedSrtPath);
      await exportSrt(translatedSegments, finalSrtPath);
      await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, translatedSegments, config));
      await writeJson(readabilityQcReportPath, createReadabilityQcReport(translatedSegments, config));
      await writeJson(ttsQcReportPath, createTtsQcReport(ttsUnits, [], config));
      await writeJson(paths.translatedJson, {
        provider: translationProvider,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        translationMode: 'template_group_merged',
        translationDisplayMode: 'template_group_timeline',
        meaningUnits: translatedSegments,
        ttsUnits,
        rawSegments: translatedSegments,
        segments: translatedSegments,
        translationQcReportPath,
        readabilityQcReportPath,
        ttsQcReportPath,
        sourceCoverageReportPath,
        sourceCoverageReport,
      });

      await addLog(jobId, 'success', `Template group translation: ${translatedSegments.length} merged group(s), timeline kept from AI grouping.`);
      return res.json({
        success: true,
        jobId,
        translationMode: 'template_group_merged',
        rawCount: translatedSegments.length,
        count: translatedSegments.length,
        rows: translatedSegments.map((segment, index) => ({
          ...segment,
          index: index + 1,
          sourceText: segment.originalText,
          translatedText: segment.text,
          finalText: segment.text,
          status: 'translated',
        })),
        sourceCount: finalSourceSegments.length,
        sourceSegments: finalSourceSegments,
        sourceCoverageReport,
        sourceCoverageReportPath,
        sourceCoverageReportUrl: toPublicJobUrl(jobId, sourceCoverageReportPath),
        meaningUnits: translatedSegments,
        ttsUnits,
        ttsUnitCount: ttsUnits.length,
        translationDisplayMode: 'template_group_timeline',
        translationQcReportPath,
        translationQcReportUrl: toPublicJobUrl(jobId, translationQcReportPath),
        readabilityQcReportPath,
        readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
        ttsQcReportPath,
        ttsQcReportUrl: toPublicJobUrl(jobId, ttsQcReportPath),
        translationPacketCount: translatedSegments.length,
        sourceSrtContent: segmentsToSrt(finalSourceSegments),
        rawSegments: translatedSegments,
        segments: translatedSegments,
        rawSrtPath: translatedSrtPath,
        rawSrtUrl: toPublicJobUrl(jobId, translatedSrtPath),
        rawSrtContent: segmentsToSrt(translatedSegments),
        srtPath: finalSrtPath,
        srtUrl: toPublicJobUrl(jobId, finalSrtPath),
        srtContent: segmentsToSrt(translatedSegments),
      });
    }
    if (shouldUseStoryTranslation(config)) {
      const storyArtifact = await translateStorySegments(originalBaseTranscript, config);
      const translatedSegments = normalizeStoryDisplaySegments(storyArtifact, config);
      const ttsUnits = storyTtsUnits(storyArtifact, translatedSegments, config);
      const finalSourceSegments = sourceSegmentsFromTranslated(translatedSegments);
      const sourceCoverageReport = storySourceCoverageReport(storyArtifact);
      const sourceCoverageReportPath = path.join(paths.translations, 'source_coverage_report.json');
      const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
      const finalSrtPath = path.join(paths.exports, 'translated.srt');
      const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
      const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
      const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');

      await saveManualSourceTranscript(paths, originalBaseTranscript, {
        sourceLanguage: req.body?.sourceLanguage,
        updatedFromTimelineAt: new Date().toISOString(),
        translationMode: 'story_v2',
        sourceCoverageReportPath,
      });
      await resetManualArtifacts(paths, ['translations', 'tts', 'exports']);
      await writeJson(sourceCoverageReportPath, sourceCoverageReport);
      await exportSrt(translatedSegments, translatedSrtPath);
      await exportSrt(translatedSegments, finalSrtPath);
      await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, translatedSegments, config));
      await writeJson(readabilityQcReportPath, createReadabilityQcReport(translatedSegments, config));
      await writeJson(ttsQcReportPath, createTtsQcReport(ttsUnits, [], config));
      await writeJson(paths.translatedJson, {
        ...storyArtifact,
        provider: translationProvider,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        translationDisplayMode: 'story_timeline',
        ttsUnits,
        segments: translatedSegments,
        rawSegments: translatedSegments,
        translationQcReportPath,
        readabilityQcReportPath,
        ttsQcReportPath,
        sourceCoverageReportPath,
        sourceCoverageReport,
      });

      const rows = translatedSegments.map((segment, index) => ({
        ...segment,
        index: index + 1,
        sourceText: segment.originalText,
        translatedText: segment.text,
        finalText: segment.text,
        status: segment.status,
        errorMsg: segment.status === 'verified' ? '' : (storyArtifact.validation?.errors || []).join('; '),
      }));
      await addLog(
        jobId,
        storyArtifact.validation.valid ? 'success' : 'warning',
        `Story translation v2: ${storyArtifact.meaningAtoms.length} meaning atom(s), ${translatedSegments.length} Vietnamese sentence(s), ${storyArtifact.omissions.length} explicit omission(s), status ${storyArtifact.validation.status}.`
      );

      return res.json({
        success: true,
        jobId,
        schemaVersion: storyArtifact.schemaVersion,
        translationMode: storyArtifact.translationMode,
        rawCount: translatedSegments.length,
        count: translatedSegments.length,
        rows,
        sourceCount: storyArtifact.sourceCues.length,
        sourceSegments: storyArtifact.sourceCues.map((cue) => ({
          id: cue.id,
          originalId: cue.originalId,
          start: cue.start,
          end: cue.end,
          duration: cue.duration,
          text: cue.textZh,
        })),
        sourceCues: storyArtifact.sourceCues,
        meaningAtoms: storyArtifact.meaningAtoms,
        storyText: storyArtifact.storyText,
        storySegments: translatedSegments,
        omissions: storyArtifact.omissions,
        validation: storyArtifact.validation,
        sourceCoverageReport,
        sourceCoverageReportPath,
        sourceCoverageReportUrl: toPublicJobUrl(jobId, sourceCoverageReportPath),
        meaningUnits: translatedSegments,
        ttsUnits,
        ttsUnitCount: ttsUnits.length,
        translationDisplayMode: 'story_timeline',
        translationQcReportPath,
        translationQcReportUrl: toPublicJobUrl(jobId, translationQcReportPath),
        readabilityQcReportPath,
        readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
        ttsQcReportPath,
        ttsQcReportUrl: toPublicJobUrl(jobId, ttsQcReportPath),
        translationPacketCount: storyArtifact.validation.windows?.length || 0,
        sourceSrtContent: segmentsToSrt(originalBaseTranscript),
        rawSegments: translatedSegments,
        segments: translatedSegments,
        rawSrtPath: translatedSrtPath,
        rawSrtUrl: toPublicJobUrl(jobId, translatedSrtPath),
        rawSrtContent: segmentsToSrt(translatedSegments),
        srtPath: finalSrtPath,
        srtUrl: toPublicJobUrl(jobId, finalSrtPath),
        srtContent: segmentsToSrt(translatedSegments),
      });
    }
    const meaningUnits = addTimingBudget(buildPipelineTranslationUnits(originalBaseTranscript, {
      ...config,
      timelinePipelineMode: 'meaning_units',
    }, { mode: 'meaning_units' }).translationUnits, {
      ...config,
      borrowGapSeconds: 0,
    });
    const translationInputSegments = meaningUnits.map((unit, index) => ({
      ...unit,
      index,
      text: unit.sourceText || unit.text,
      originalText: unit.sourceText || unit.text,
      translatedText: '',
      finalText: '',
      sourceIds: unit.sourceRowIds || unit.sourceIds || [],
    }));

    if (!translationInputSegments.length) {
      throw new Error('No source SRT is available. Run STT first.');
    }

    const sourceCoverageReportPath = path.join(paths.translations, 'source_coverage_report.json');
    const sourceCoverageReport = assertSourceCoverage(originalBaseTranscript, meaningUnits);
    await writeJson(sourceCoverageReportPath, sourceCoverageReport);
    await addLog(
      jobId,
      'success',
      `Source grouping coverage ${sourceCoverageReport.uniqueCoveredCount}/${sourceCoverageReport.sourceCount}, missing 0, duplicate 0, order valid.`
    );

    const translatedPackets = normalizeClientSegments(alignTranslatedUnitsById(
      translationInputSegments,
      await translateSegments(translationInputSegments, config)
    ));
    const translatedMeaningUnits = meaningUnits.map((unit, index) => {
      const translated = translatedPackets[index] || {};
      const translatedText = normalizeSegmentText(translated.text || translated.translatedText || unit.sourceText || unit.text);
      const ttsText = ttsTextFromTranslation(translated.ttsText || translatedText, config);
      return {
        ...unit,
        translatedText,
        finalText: translatedText,
        text: translatedText,
        ttsText,
        translationTargetTtsRate: translated.translationTargetTtsRate,
        ttsTimingFit: translated.ttsTimingFit,
        ttsTimingProbe: translated.ttsTimingProbe,
        ttsTimingSummary: translated.ttsTimingSummary,
        ttsTimingRewriteApplied: translated.ttsTimingRewriteApplied === true,
        ttsTimingRewritePasses: Number(translated.ttsTimingRewritePasses) || 0,
        sourceIds: unit.sourceRowIds || unit.sourceIds || [],
        sourceRowIds: unit.sourceRowIds || unit.sourceIds || [],
      };
    });
    const useMeaningTimelineDisplay = config.translationDisplayMode === 'meaning_timeline';
    const displayMapping = useMeaningTimelineDisplay
      ? mapTranslatedUnitsToMergedDisplayRows(translatedMeaningUnits, originalBaseTranscript, {
        ...config,
        timelinePipelineMode: 'meaning_units',
      })
      : mapTranslatedUnitsToDisplayRows(translatedMeaningUnits, originalBaseTranscript, {
        ...config,
        timelinePipelineMode: 'meaning_units',
      }, {
        mode: 'meaning_units',
        translationUnits: meaningUnits,
      });
    const translatedSegments = addTimingBudget(normalizeClientSegments(displayMapping.displayRows), config);
    const ttsUnits = buildPipelineTtsUnits(translatedSegments, translatedMeaningUnits, config).ttsUnits;
    const finalSourceSegments = sourceSegmentsFromTranslated(translatedSegments);
    const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
    const finalSrtPath = path.join(paths.exports, 'translated.srt');
    const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
    const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
    const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');
    await saveManualSourceTranscript(paths, originalBaseTranscript, {
      sourceLanguage: req.body?.sourceLanguage,
      updatedFromTimelineAt: new Date().toISOString(),
      meaningUnitMode: true,
      meaningUnitCount: meaningUnits.length,
      sourceCoverageReportPath,
    });
    await resetManualArtifacts(paths, ['translations', 'tts', 'exports']);
    await writeJson(sourceCoverageReportPath, sourceCoverageReport);
    await exportSrt(translatedSegments, translatedSrtPath);
    await exportSrt(translatedSegments, finalSrtPath);
    await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, translatedSegments, config));
    await writeJson(readabilityQcReportPath, createReadabilityQcReport(translatedSegments, config));
    await writeJson(ttsQcReportPath, createTtsQcReport(ttsUnits, [], config));
    await writeJson(paths.translatedJson, {
      provider: translationProvider,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      translationDisplayMode: config.translationDisplayMode,
      meaningUnits: translatedMeaningUnits,
      ttsUnits,
      translationPackets: translationInputSegments,
      rawSegments: translatedPackets,
      segments: translatedSegments,
      translationQcReportPath,
      readabilityQcReportPath,
      ttsQcReportPath,
      sourceCoverageReportPath,
      sourceCoverageReport,
    });

    const rows = translatedSegments.map((segment, index) => ({
      id: segment.id,
      index: index + 1,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      originalText: String(segment.originalText || finalSourceSegments[index]?.text || ''),
      translatedText: segment.text,
      ttsTimingFit: segment.ttsTimingFit || null,
      ttsTimingProbe: segment.ttsTimingProbe || null,
    }));

    res.json({
      success: true,
      jobId,
      rawCount: translatedSegments.length,
      count: translatedSegments.length,
      rows,
      sourceCount: finalSourceSegments.length,
      sourceSegments: finalSourceSegments,
      sourceCoverageReport,
      sourceCoverageReportPath,
      sourceCoverageReportUrl: toPublicJobUrl(jobId, sourceCoverageReportPath),
      meaningUnits: translatedMeaningUnits,
      ttsUnits,
      ttsUnitCount: ttsUnits.length,
      translationDisplayMode: config.translationDisplayMode,
      translationQcReportPath,
      translationQcReportUrl: toPublicJobUrl(jobId, translationQcReportPath),
      readabilityQcReportPath,
      readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
      ttsQcReportPath,
      ttsQcReportUrl: toPublicJobUrl(jobId, ttsQcReportPath),
      translationPacketCount: translationInputSegments.length,
      sourceSrtContent: segmentsToSrt(finalSourceSegments),
      rawSegments: translatedPackets,
      segments: translatedSegments,
      rawSrtPath: translatedSrtPath,
      rawSrtUrl: toPublicJobUrl(jobId, translatedSrtPath),
      rawSrtContent: segmentsToSrt(translatedSegments),
      srtPath: finalSrtPath,
      srtUrl: toPublicJobUrl(jobId, finalSrtPath),
      srtContent: segmentsToSrt(translatedSegments),
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/retranslate-story-segment', async (req, res) => {
  const jobId = String(req.body?.jobId || '').trim();
  try {
    if (!jobId) throw new Error('Missing jobId.');
    const segmentId = String(req.body?.segmentId || '').trim();
    if (!segmentId) throw new Error('Missing story segmentId.');
    const paths = getJobPaths(jobId);
    const artifact = await readJson(paths.translatedJson, null);
    if (!artifact || artifact.schemaVersion !== 'story_translation_v2' || artifact.translationMode !== 'story_v2') {
      throw new Error('This job does not contain a story_translation_v2 artifact.');
    }
    const config = resolveGoogleCloudConfig({
      ...req.body,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        translationMode: 'story_v2',
        userContext: req.body?.videoContext || req.body?.userContext || '',
      },
    });
    const updated = await retranslateStorySegment(artifact, segmentId, config);
    const translatedSegments = normalizeStoryDisplaySegments(updated, config);
    const ttsUnits = storyTtsUnits(updated, translatedSegments, config);
    const finalSourceSegments = sourceSegmentsFromTranslated(translatedSegments);
    const translatedSrtPath = path.join(paths.translations, 'translated_raw.srt');
    const finalSrtPath = path.join(paths.exports, 'translated.srt');
    const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
    const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
    const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');
    await resetManualArtifacts(paths, ['tts']);
    await exportSrt(translatedSegments, translatedSrtPath);
    await exportSrt(translatedSegments, finalSrtPath);
    await writeJson(translationQcReportPath, createTranslationQcReport(finalSourceSegments, translatedSegments, config));
    await writeJson(readabilityQcReportPath, createReadabilityQcReport(translatedSegments, config));
    await writeJson(ttsQcReportPath, createTtsQcReport(ttsUnits, [], config));
    await writeJson(paths.translatedJson, {
      ...updated,
      provider: config.translationProvider,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      translationDisplayMode: 'story_timeline',
      ttsUnits,
      rawSegments: translatedSegments,
      segments: translatedSegments,
      translationQcReportPath,
      readabilityQcReportPath,
      ttsQcReportPath,
    });
    await addLog(jobId, updated.validation.valid ? 'success' : 'warning', `Retranslated story segment ${segmentId}; status ${updated.validation.status}.`);
    return res.json({
      success: true,
      jobId,
      ...updated,
      storySegments: translatedSegments,
      segments: translatedSegments,
      ttsUnits,
      meaningUnits: translatedSegments,
      translationQcReportPath,
      translationQcReportUrl: toPublicJobUrl(jobId, translationQcReportPath),
      readabilityQcReportPath,
      readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
      ttsQcReportPath,
      ttsQcReportUrl: toPublicJobUrl(jobId, ttsQcReportPath),
      srtPath: finalSrtPath,
      srtUrl: toPublicJobUrl(jobId, finalSrtPath),
    });
  } catch (error) {
    const mapped = classifyError(error);
    return res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/translate-line', async (req, res) => {
  try {
    const segment = req.body?.segment;
    if (!segment || !String(segment.text || '').trim()) {
      throw new Error('Missing segment text.');
    }

    const translationProvider = req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider;
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      targetLanguage: req.body?.targetLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        translationProvider,
        cliTranslationModel: req.body?.cliTranslationModel || req.body?.googleCloudConfig?.cliTranslationModel,
        cliTranslationConcurrency: req.body?.cliTranslationConcurrency ?? req.body?.googleCloudConfig?.cliTranslationConcurrency,
        translationMode: req.body?.translationMode || req.body?.googleCloudConfig?.translationMode,
        sourceLanguage: req.body?.sourceLanguage,
        targetLanguage: req.body?.targetLanguage,
        userContext: req.body?.videoContext || req.body?.userContext || '',
        customGlossary: req.body?.customGlossary || '',
      },
    });

    config.templateGroupTranslation = req.body?.templateGroupTranslation === true
      || req.body?.googleCloudConfig?.templateGroupTranslation === true;
    const translated = normalizeClientSegments(
      shouldUseTemplateGroupTranslation([segment], config)
        ? await translateTemplateGroups([segment], config)
        : await translateSegments([segment], config)
    );
    res.json({
      success: true,
      segment: translated[0] || null,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/retranslate-tts-errors', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      throw new Error('No TTS overflow rows were selected for repair.');
    }

    const translationProvider = req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider;
    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      targetLanguage: req.body?.targetLanguage || 'vi',
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        translationProvider,
        cliTranslationModel: req.body?.cliTranslationModel || req.body?.googleCloudConfig?.cliTranslationModel,
        cliTranslationConcurrency: req.body?.cliTranslationConcurrency ?? req.body?.googleCloudConfig?.cliTranslationConcurrency,
        sourceLanguage: req.body?.sourceLanguage,
        targetLanguage: req.body?.targetLanguage || 'vi',
      },
    });
    config.ttsOverflowRepairSingleRequest = true;
    config.ttsOverflowRepairBatchSize = items.length;
    config.ttsOverflowRepairConcurrency = 1;

    const repairs = await repairTtsOverflowTranslations(items, config);
    res.json({
      success: true,
      jobId,
      repairPromptVersion: TTS_OVERFLOW_REPAIR_PROMPT_VERSION,
      repairs,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/preview-tts-repair-srt', async (req, res) => {
  const jobId = String(req.body?.jobId || '').trim();
  try {
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const prepared = preparePreviewRepairItems(req.body?.items || []);
    if (!prepared.items.length) {
      throw new Error('No repaired subtitles are available for TTS preview.');
    }
    if (prepared.items.length > MAX_REPAIR_PREVIEW_CUES) {
      throw new Error(`TTS repair preview supports at most ${MAX_REPAIR_PREVIEW_CUES} cue(s) in one AIMAX request.`);
    }

    const result = await runExclusiveJobOperation(jobId, 'TTS repair preview', async (operationSignal) => {
      const paths = getJobPaths(jobId);
      const previewId = createRepairPreviewId();
      const {
        previewDir,
        batchWorkDir,
        audioPath: outputAudioPath,
        srtPath: outputSrtPath,
        reportPath,
      } = repairPreviewArtifactPaths(paths, previewId);
      await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(previewDir, { recursive: true });

      const config = resolveGoogleCloudConfig({
        ...req.body,
        targetLanguage: req.body?.targetLanguage || 'vi',
        googleCloudConfig: {
          ...(req.body?.googleCloudConfig || {}),
          ttsProvider: 'aimax_tts',
          ttsLanguageCode: req.body?.ttsLanguageCode || req.body?.googleCloudConfig?.ttsLanguageCode,
          ttsVoiceName: req.body?.ttsVoiceName || req.body?.googleCloudConfig?.ttsVoiceName,
          voiceGenderFilter: req.body?.voiceGenderFilter || req.body?.googleCloudConfig?.voiceGenderFilter,
          ssmlGender: req.body?.ssmlGender || req.body?.googleCloudConfig?.ssmlGender,
          aimaxProvider: req.body?.aimaxProvider || req.body?.googleCloudConfig?.aimaxProvider,
          aimaxModel: req.body?.aimaxModel || req.body?.googleCloudConfig?.aimaxModel,
          speakingRate: req.body?.speakingRate ?? req.body?.googleCloudConfig?.speakingRate,
        },
      });
      const previewConfig = {
        ...config,
        abortSignal: operationSignal,
        ttsProvider: 'aimax_tts',
        aimaxGenerateSrt: true,
        aimaxSrtBatchEnabled: true,
        aimaxSrtBatchMode: 'request_count',
        aimaxSrtRequestCount: 1,
        aimaxSrtBatchConcurrency: 1,
        preserveTtsAudio: true,
        ttsDurationControl: false,
        ttsFitEnabled: false,
        maxSpeakingRate: Number(config.speakingRate) || 1,
        maxEffectiveSpeakingRate: Number(config.speakingRate) || 1,
      };
      const segments = previewItemsToAimaxSegments(prepared.items);
      await addLog(jobId, 'info', `TTS preview bản sửa started: ${segments.length} cue(s), one AIMAX SRT request.`);
      const batchResult = await aimaxSrtBatchService.synthesizeTranslatedSrtBatches(
        segments,
        previewConfig,
        {
          workDir: batchWorkDir,
          outputAudioPath,
          outputSrtPath,
          onProgress: async (progress) => {
            const current = Number(progress.batchIndex) + 1;
            if (progress.status === 'completed') {
              await addLog(jobId, 'info', `TTS preview AIMAX batch ${current}/${progress.batchCount} completed (${progress.cueCount} cue).`);
            } else if (progress.status === 'reused') {
              await addLog(jobId, 'info', `TTS preview AIMAX batch ${current}/${progress.batchCount} reused (${progress.cueCount} cue).`);
            } else {
              await addLog(jobId, 'info', `TTS preview AIMAX batch ${current}/${progress.batchCount} started (${progress.cueCount} cue).`);
            }
          },
        }
      );
      const audioStats = await getFileStats(outputAudioPath);
      const srtStats = await getFileStats(outputSrtPath);
      const rows = buildPreviewRepairResults(prepared.items, batchResult.report || {})
        .map((row) => ({ ...row, preview_id: previewId }));
      const overflowCount = rows.filter((row) => row.status === 'overflow').length;
      const slackCount = rows.filter((row) => row.status === 'slack').length;
      const fitCount = rows.filter((row) => row.status === 'fit').length;
      await writeJson(reportPath, {
        ...batchResult,
        previewId,
        rows,
        skipped: prepared.skipped,
        audioFileSizeBytes: audioStats?.size || 0,
        srtFileSizeBytes: srtStats?.size || 0,
      });
      await addLog(jobId, overflowCount
        ? 'warn'
        : 'info', `TTS preview bản sửa finished: ${fitCount} khớp, ${slackCount} dư, ${overflowCount} tràn.`);
      return {
        success: true,
        jobId,
        previewId,
        mode: 'tts_repair_srt_preview',
        count: rows.length,
        skipped: prepared.skipped,
        rows,
        overflowCount,
        slackCount,
        fitCount,
        audioPath: audioStats?.size ? outputAudioPath : '',
        audioUrl: audioStats?.size ? toPublicJobUrl(jobId, outputAudioPath) : '',
        srtPath: srtStats?.size ? outputSrtPath : '',
        srtUrl: srtStats?.size ? toPublicJobUrl(jobId, outputSrtPath) : '',
        srtContent: srtStats?.size ? await fs.readFile(outputSrtPath, 'utf8') : '',
        reportPath,
        reportUrl: toPublicJobUrl(jobId, reportPath),
        report: batchResult.report || null,
      };
    });

    res.json(result);
  } catch (error) {
    const mapped = classifyError(error);
    if (jobId) {
      await addLog(jobId, 'error', mapped.detail || mapped.message || error.message || String(error)).catch(() => {});
    }
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/apply-tts-repair-srt', async (req, res) => {
  const jobId = String(req.body?.jobId || '').trim();
  try {
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const items = normalizeRepairApplyItems(req.body?.items || [], req.body?.previewId || req.body?.preview_id || '');
    if (!items.length) {
      throw new Error('No TTS repair preview rows are available to apply. Run TTS for the repaired row before applying.');
    }

    const result = await runExclusiveJobOperation(jobId, 'TTS repair apply', async (operationSignal) => {
      const paths = getJobPaths(jobId);
      const dubbedVoicePath = path.join(paths.tts, 'manual_dubbed_voice.wav');
      if (!await getFileStats(dubbedVoicePath)) {
        throw new Error('Generate the full TTS audio once before applying repaired cue audio.');
      }

      const manualTtsManifestPath = path.join(paths.tts, 'manual_tts_manifest.json');
      const previousManifest = await readJson(manualTtsManifestPath, {});
      const aimaxSrtBatchReport = await readJson(path.join(paths.tts, 'aimax_srt_batch_report.json'), null);
      const previousReport = req.body?.previousReport
        || previousManifest?.report
        || aimaxSrtBatchReport?.report
        || null;
      const groups = new Map();
      for (const item of items) {
        const previewId = normalizeRepairPreviewId(item.preview_id);
        if (!groups.has(previewId)) groups.set(previewId, []);
        groups.get(previewId).push(item);
      }

      const appliedRows = [];
      const appliedReportSegments = [];
      const appliedPreviewIds = [];
      const previewReportsById = new Map();

      for (const [previewId, groupItems] of groups.entries()) {
        if (operationSignal.aborted) throw new Error('Operation canceled.');
        const previewPaths = repairPreviewArtifactPaths(paths, previewId);
        const previewAudioReady = await getFileStats(previewPaths.audioPath);
        const previewReport = await readJson(previewPaths.reportPath, null);
        if (!previewAudioReady || !previewReport) {
          throw new Error(`TTS preview audio is missing for ${previewId}. Run TTS again for those repaired rows before applying.`);
        }
        previewReportsById.set(previewId, previewReport);
        const previewRowsById = new Map((Array.isArray(previewReport.rows) ? previewReport.rows : [])
          .map((row) => [String(row.row_id || ''), row])
          .filter(([rowId]) => rowId));
        const ranges = [];

        for (const item of groupItems) {
          const previewRow = previewRowsById.get(String(item.row_id));
          if (!previewRow) {
            throw new Error(`TTS preview result is missing for row ${item.row_id}. Run TTS again for that repaired row before applying.`);
          }
          if (String(previewRow.status || '') === 'overflow') {
            throw new Error(`Row ${item.row_id} still overflows in TTS preview. Shorten it and run TTS again before applying.`);
          }
          if (normalizeRepairApplyText(previewRow.repaired_translation) !== normalizeRepairApplyText(item.repaired_translation)) {
            throw new Error(`Row ${item.row_id} was edited after its last TTS preview. Run TTS again before applying.`);
          }
          ranges.push({ start: item.start, end: item.end });
          appliedRows.push({
            rowId: item.row_id,
            previewId,
            start: item.start,
            end: item.end,
            repairedTranslation: item.repaired_translation,
            status: previewRow.status || item.tts_preview_status || 'fit',
            slotSeconds: Number(previewRow.slot_seconds) || 0,
            audioSeconds: Number(previewRow.audio_seconds) || 0,
            deltaSeconds: Number(previewRow.delta_seconds) || 0,
          });
          appliedReportSegments.push(buildAppliedRepairReportSegment(item, previewRow));
        }

        appliedPreviewIds.push(previewId);
      }

      const previousBatchReport = Array.isArray(previousManifest?.batches) && previousManifest.batches.length
        ? previousManifest
        : aimaxSrtBatchReport;
      const rebuilt = await rebuildManualTtsFromAimaxClips({
        paths,
        outputPath: dubbedVoicePath,
        previousReport: previousBatchReport?.report || previousReport,
        previousBatchReport,
        previewReportsById,
        appliedRows,
        overrideClipByRowId: manualRowRerunClipOverrides(paths, previousManifest?.rowReruns || []),
      });
      if (!rebuilt) {
        throw new Error('Cannot safely rebuild the TTS timeline from its cue clips. Existing audio was kept unchanged; run full TTS again instead of mixing a repaired cue over it.');
      }
      const audioApplyMode = 'aimax_clip_rebuild';

      await clearManualVideoArtifacts(paths);
      const appliedRowIds = appliedRows.map((row) => row.rowId);
      const nextReport = mergeAppliedTtsRepairReport(previousReport || {}, appliedReportSegments, appliedRowIds);
      const applyReportPath = path.join(paths.tts, 'tts_repair_apply_report.json');
      await writeJson(applyReportPath, {
        ...nextReport,
        mode: 'tts_repair_apply',
        audioApplyMode,
        appliedRows,
        appliedPreviewIds,
        updatedAt: new Date().toISOString(),
      });

      const previousRepairApplies = Array.isArray(previousManifest?.repairApplies)
        ? previousManifest.repairApplies
        : [];
      await writeJson(manualTtsManifestPath, {
        ...(previousManifest && typeof previousManifest === 'object' ? previousManifest : {}),
        audioAccepted: true,
        audioPath: dubbedVoicePath,
        report: nextReport,
        ttsRepairApplyReportPath: applyReportPath,
        repairApplies: [
          ...previousRepairApplies,
          {
            rowIds: appliedRowIds,
            previewIds: appliedPreviewIds,
            audioApplyMode,
            updatedAt: new Date().toISOString(),
          },
        ].slice(-100),
      });

      const responsePayload = {
        success: true,
        jobId,
        mode: 'tts_repair_apply',
        audioApplyMode,
        appliedCount: appliedRows.length,
        appliedRows,
        appliedPreviewIds,
        audioPath: dubbedVoicePath,
        audioUrl: toPublicJobUrl(jobId, dubbedVoicePath),
        srtPath: previousManifest?.srtPath || '',
        srtUrl: previousManifest?.srtPath ? toPublicJobUrl(jobId, previousManifest.srtPath) : '',
        ttsQcReportPath: applyReportPath,
        ttsQcReportUrl: toPublicJobUrl(jobId, applyReportPath),
        report: nextReport,
      };
      await updateManualTtsJobResult(jobId, paths, responsePayload);
      await addLog(jobId, 'success', `Applied ${appliedRows.length} repaired TTS cue(s) to the existing manual audio.`);
      return responsePayload;
    });

    res.json(result);
  } catch (error) {
    const mapped = classifyError(error);
    if (jobId) {
      await addLog(jobId, 'error', mapped.detail || mapped.message || error.message || String(error)).catch(() => {});
    }
    res.status(400).json({ success: false, ...mapped });
  }
});

app.get('/api/manual/qc-summary/:jobId', async (req, res) => {
  try {
    const jobId = String(req.params?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }
    res.json(await buildManualQcSummary(jobId));
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/normalize-timeline', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    let sourceSegments = normalizeClientSegments(req.body?.sourceSegments || []);
    const onlySource = req.body?.onlySource === true;

    if (!sourceSegments.length) {
      const transcriptJson = await readJson(paths.transcriptJson, null);
      sourceSegments = normalizeClientSegments(transcriptJson?.sourceSegments || transcriptJson?.segments || []);
    }
    if (!sourceSegments.length) {
      throw new Error('No source SRT is available. Run STT first.');
    }

    const config = resolveGoogleCloudConfig({
      ...req.body,
      sourceLanguage: req.body?.sourceLanguage,
      targetLanguage: req.body?.targetLanguage,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        sourceLanguage: req.body?.sourceLanguage,
        targetLanguage: req.body?.targetLanguage,
      },
    });

    if (onlySource) {
      const finalSourceSegments = addTimingBudget(normalizeClientSegments(sourceSegments), config);
      const translationPackets = addTimingBudget(buildTranslationPackets(finalSourceSegments, config), config);
      await saveManualSourceTranscript(paths, finalSourceSegments, {
        sourceLanguage: config.sourceLanguage,
        timelineCheckedAt: new Date().toISOString(),
        timelinePostTranslateMergeDisabled: true,
        translationPacketCount: translationPackets.length,
        sourceCueCount: finalSourceSegments.length,
      });

      const sourceSegmentedSrtPath = path.join(paths.transcripts, 'source_segmented.srt');
      const rows = finalSourceSegments.map((segment, index) => ({
        id: segment.id,
        index: index + 1,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
        originalText: segment.text || '',
        translatedText: '',
      }));

      return res.json({
        success: true,
        jobId,
        sourceCount: finalSourceSegments.length,
        rawSourceCount: sourceSegments.length,
        rawTranslatedCount: 0,
        count: finalSourceSegments.length,
        translationPacketCount: translationPackets.length,
        rows,
        sourceSegments: finalSourceSegments,
        translationPackets,
        segments: finalSourceSegments,
        srtPath: sourceSegmentedSrtPath,
        srtUrl: toPublicJobUrl(jobId, sourceSegmentedSrtPath),
        srtContent: segmentsToSrt(finalSourceSegments),
      });
    }

    let translatedSegments = normalizeClientSegments(req.body?.translatedSegments || []);
    if (!translatedSegments.length) {
      const translatedJson = await readJson(paths.translatedJson, null);
      translatedSegments = normalizeClientSegments(translatedJson?.segments || translatedJson?.rawSegments || []);
    }
    if (!translatedSegments.length) {
      throw new Error('No translated subtitles are available. Run translation first.');
    }

    const sourceUnits = addTimingBudget(normalizeClientSegments(sourceSegments), config);
    const finalSegments = addTimingBudget(normalizeClientSegments(translatedSegments).map((segment, index) => {
      const source = sourceUnits[index] || {};
      const sourceText = String(segment.sourceText || segment.originalText || source.text || '').trim();
      return {
        ...segment,
        originalText: sourceText,
        sourceText,
      };
    }), config);
    const translationPackets = addTimingBudget(buildTranslationPackets(sourceUnits, config), config);

    await fs.mkdir(paths.translations, { recursive: true });
    await fs.mkdir(paths.exports, { recursive: true });
    await saveManualSourceTranscript(paths, sourceUnits, {
      sourceLanguage: config.sourceLanguage,
      timelineCheckedAt: new Date().toISOString(),
      timelinePostTranslateMergeDisabled: true,
      translationPacketCount: translationPackets.length,
      sourceCueCount: sourceUnits.length,
    });

    const normalizedSrtPath = path.join(paths.translations, 'translated_timeline_checked.srt');
    const finalSrtPath = path.join(paths.exports, 'translated.srt');
    const translationQcReportPath = path.join(paths.translations, 'translation_qc_report.json');
    const readabilityQcReportPath = path.join(paths.translations, 'readability_qc_report.json');
    await exportSrt(finalSegments, normalizedSrtPath);
    await exportSrt(finalSegments, finalSrtPath);
    await writeJson(translationQcReportPath, createTranslationQcReport(sourceUnits, finalSegments, config));
    await writeJson(readabilityQcReportPath, createReadabilityQcReport(finalSegments, config));
    await writeJson(paths.translatedJson, {
      provider: req.body?.translationProvider || req.body?.googleCloudConfig?.translationProvider || config.translationProvider,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      timelineChecked: true,
      timelinePostTranslateMergeDisabled: true,
      sourceSegmentCountBeforeTimelineCheck: sourceSegments.length,
      translatedSegmentCountBeforeTimelineCheck: translatedSegments.length,
      translationPacketCount: translationPackets.length,
      translationPackets,
      sourceSegments: sourceUnits,
      rawSegments: translatedSegments,
      segments: finalSegments,
      translationQcReportPath,
      readabilityQcReportPath,
    });

    const rows = finalSegments.map((segment, index) => ({
      id: segment.id,
      index: index + 1,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      originalText: segment.originalText || sourceUnits[index]?.text || '',
      translatedText: segment.text,
    }));

    res.json({
      success: true,
      jobId,
      sourceCount: sourceUnits.length,
      rawSourceCount: sourceSegments.length,
      rawTranslatedCount: translatedSegments.length,
      count: finalSegments.length,
      translationPacketCount: translationPackets.length,
      rows,
      sourceSegments: sourceUnits,
      translationPackets,
      segments: finalSegments,
      srtPath: finalSrtPath,
      srtUrl: toPublicJobUrl(jobId, finalSrtPath),
      srtContent: segmentsToSrt(finalSegments),
      normalizedSrtPath,
      normalizedSrtUrl: toPublicJobUrl(jobId, normalizedSrtPath),
      translationQcReportPath,
      translationQcReportUrl: toPublicJobUrl(jobId, translationQcReportPath),
      readabilityQcReportPath,
      readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
    });
  } catch (error) {
    const mapped = classifyError(error);
    if (jobId) {
      await addLog(jobId, 'error', mapped.detail || mapped.message || error.message || String(error)).catch(() => {});
    }
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/export-srt', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const segments = normalizeClientSegments(req.body?.segments || []);
    if (!segments.length) {
      throw new Error('No subtitles available to export.');
    }

    const fileName = String(req.body?.fileName || 'final_review.srt').trim() || 'final_review.srt';
    const requestedBaseName = fileName.replace(/\.srt$/i, '');
    const safeFileName = `${sanitizePathSegment(requestedBaseName, 'final_review')}.srt`;
    const outputPath = path.join(paths.exports, safeFileName);
    const config = resolveGoogleCloudConfig({
      ...req.body,
      googleCloudConfig: {
        ...(req.body?.googleCloudConfig || {}),
        targetLanguage: req.body?.targetLanguage,
      },
    });
    await exportSrt(segments, outputPath, {
      displayOptimized: req.body?.displayOptimized !== false,
      maxChars: req.body?.maxChars,
      maxLineLength: req.body?.maxLineLength,
    });
    const readabilityQcReportPath = await writeReadabilityQcReport(paths, segments, config);

    let savedOutputPath = '';
    const outputDirectory = String(req.body?.outputDirectory || '').trim();
    if (outputDirectory) {
      const folderName = sanitizePathSegment(req.body?.outputFolderName || '', '');
      const finalDirectory = req.body?.outputCreateFolder === false || !folderName
        ? outputDirectory
        : path.join(outputDirectory, folderName);
      await fs.mkdir(finalDirectory, { recursive: true });
      savedOutputPath = path.join(finalDirectory, safeFileName);
      await fs.copyFile(outputPath, savedOutputPath);
    }

    res.json({
      success: true,
      jobId,
      outputPath: savedOutputPath || outputPath,
      jobOutputPath: outputPath,
      savedOutputPath,
      outputUrl: toPublicJobUrl(jobId, outputPath),
      readabilityQcReportPath,
      readabilityQcReportUrl: toPublicJobUrl(jobId, readabilityQcReportPath),
      srtContent: await fs.readFile(outputPath, 'utf8'),
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/export-text', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const text = String(req.body?.text || '').trim();
    if (!text) {
      throw new Error('No text available to export.');
    }

    const fileName = String(req.body?.fileName || 'subtitle_text.txt').trim() || 'subtitle_text.txt';
    const requestedBaseName = fileName.replace(/\.txt$/i, '');
    const safeFileName = `${sanitizePathSegment(requestedBaseName, 'subtitle_text')}.txt`;
    const outputPath = path.join(paths.exports, safeFileName);

    await fs.mkdir(paths.exports, { recursive: true });
    await fs.writeFile(outputPath, `${text}\n`, 'utf8');

    let savedOutputPath = '';
    const outputDirectory = String(req.body?.outputDirectory || '').trim();
    if (outputDirectory) {
      const folderName = sanitizePathSegment(req.body?.outputFolderName || '', '');
      const finalDirectory = req.body?.outputCreateFolder === false || !folderName
        ? outputDirectory
        : path.join(outputDirectory, folderName);
      await fs.mkdir(finalDirectory, { recursive: true });
      savedOutputPath = path.join(finalDirectory, safeFileName);
      await fs.copyFile(outputPath, savedOutputPath);
    }

    res.json({
      success: true,
      jobId,
      outputPath: savedOutputPath || outputPath,
      jobOutputPath: outputPath,
      savedOutputPath,
      outputUrl: toPublicJobUrl(jobId, outputPath),
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/generate-tts', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const result = await runExclusiveJobOperation(jobId, 'TTS generation', async (operationSignal) => {
      const paths = getJobPaths(jobId);
      const rawSegments = Array.isArray(req.body?.segments) ? req.body.segments : [];
      const rawMeaningUnits = Array.isArray(req.body?.meaningUnits) ? req.body.meaningUnits : [];
      const rawTtsUnits = Array.isArray(req.body?.ttsUnits) ? req.body.ttsUnits : [];
      const rerunRowIds = [
        ...(Array.isArray(req.body?.rerunRowIds) ? req.body.rerunRowIds : []),
        req.body?.rerunRowId,
        req.body?.rerunTtsRowId,
      ].map((value) => String(value || '').trim()).filter(Boolean);
      const segments = normalizeClientSegments(rawSegments.map((segment) => ({
        ...segment,
        text: String(segment.text || segment.finalText || segment.translatedText || '').trim(),
      }))).filter((segment) => segment.text);

      if (!segments.length && !rawMeaningUnits.length && !rawTtsUnits.length) {
        throw new Error('No final subtitles are available for TTS.');
      }

      if (operationSignal.aborted) throw new Error('Operation canceled.');
      const manualTtsManifestPath = path.join(paths.tts, 'manual_tts_manifest.json');
      const previousManualTtsManifest = rerunRowIds.length
        ? await readJson(manualTtsManifestPath, null)
        : null;
      const requestedTtsProvider = String(req.body?.ttsProvider || req.body?.googleCloudConfig?.ttsProvider || '').trim().toLowerCase().replace(/-/g, '_');
      const preserveAimaxBatchCache = (
        ['aimax', 'aimax_tts', 'aimax_clone'].includes(requestedTtsProvider)
        && (req.body?.aimaxSrtBatchEnabled ?? req.body?.googleCloudConfig?.aimaxSrtBatchEnabled) === true
      );
      if (!rerunRowIds.length) {
        if (preserveAimaxBatchCache) {
          await resetManualTtsArtifacts(paths, { preserveAimaxSrtBatches: true });
        } else {
          await resetManualArtifacts(paths, ['tts']);
        }
      } else {
        await fs.mkdir(paths.tts, { recursive: true });
      }
      await clearManualVideoArtifacts(paths);
      if (operationSignal.aborted) throw new Error('Operation canceled.');

      const config = resolveGoogleCloudConfig({
        ...req.body,
        targetLanguage: req.body?.targetLanguage || 'vi',
        googleCloudConfig: {
          ...(req.body?.googleCloudConfig || {}),
          ttsProvider: req.body?.ttsProvider || req.body?.googleCloudConfig?.ttsProvider,
          ttsUnitMode: req.body?.ttsUnitMode || req.body?.googleCloudConfig?.ttsUnitMode,
          ttsLanguageCode: req.body?.ttsLanguageCode || req.body?.googleCloudConfig?.ttsLanguageCode,
          ttsVoiceName: req.body?.ttsVoiceName || req.body?.googleCloudConfig?.ttsVoiceName,
          voiceGenderFilter: req.body?.voiceGenderFilter || req.body?.googleCloudConfig?.voiceGenderFilter,
          ssmlGender: req.body?.ssmlGender || req.body?.googleCloudConfig?.ssmlGender,
          aimaxProvider: req.body?.aimaxProvider || req.body?.googleCloudConfig?.aimaxProvider,
          aimaxModel: req.body?.aimaxModel || req.body?.googleCloudConfig?.aimaxModel,
          aimaxSrtBatchEnabled: req.body?.aimaxSrtBatchEnabled ?? req.body?.googleCloudConfig?.aimaxSrtBatchEnabled,
          aimaxSrtBatchMode: req.body?.aimaxSrtBatchMode || req.body?.googleCloudConfig?.aimaxSrtBatchMode,
          aimaxSrtCuesPerRequest: req.body?.aimaxSrtCuesPerRequest ?? req.body?.googleCloudConfig?.aimaxSrtCuesPerRequest,
          aimaxSrtRequestCount: req.body?.aimaxSrtRequestCount ?? req.body?.googleCloudConfig?.aimaxSrtRequestCount,
          aimaxSrtBatchConcurrency: req.body?.aimaxSrtBatchConcurrency ?? req.body?.googleCloudConfig?.aimaxSrtBatchConcurrency,
          ttsConcurrency: req.body?.ttsConcurrency ?? req.body?.googleCloudConfig?.ttsConcurrency,
          ttsMaxAttempts: req.body?.ttsMaxAttempts ?? req.body?.googleCloudConfig?.ttsMaxAttempts,
          speakingRate: req.body?.speakingRate ?? req.body?.googleCloudConfig?.speakingRate,
          pitch: req.body?.pitch ?? req.body?.googleCloudConfig?.pitch,
          ttsFitEnabled: req.body?.ttsFitEnabled ?? req.body?.googleCloudConfig?.ttsFitEnabled,
          ttsFitMode: req.body?.ttsFitMode ?? req.body?.googleCloudConfig?.ttsFitMode,
          ttsFitMaxRate: req.body?.ttsFitMaxRate ?? req.body?.googleCloudConfig?.ttsFitMaxRate,
          ttsTextCleanupMode: req.body?.ttsTextCleanupMode ?? req.body?.googleCloudConfig?.ttsTextCleanupMode,
          voiceAlignShortClips: req.body?.voiceAlignShortClips ?? req.body?.googleCloudConfig?.voiceAlignShortClips,
          voiceAlignMode: req.body?.voiceAlignMode ?? req.body?.googleCloudConfig?.voiceAlignMode,
          voiceAlignMinSlackSeconds: req.body?.voiceAlignMinSlackSeconds ?? req.body?.googleCloudConfig?.voiceAlignMinSlackSeconds,
          voiceAlignMaxShiftSeconds: req.body?.voiceAlignMaxShiftSeconds ?? req.body?.googleCloudConfig?.voiceAlignMaxShiftSeconds,
        },
      });

      if (config.ttsProvider === 'aimax_tts' && config.aimaxSrtBatchEnabled === true) {
        if (rerunRowIds.length) {
          throw new Error('AIMAX SRT batch TTS must render the full SRT; single-row rerun is not supported.');
        }
        const aimaxSubtitleRows = prepareAimaxSrtBatchSubtitleRows(segments, config);
        if (!aimaxSubtitleRows.length) {
          throw new Error('AIMAX SRT batch TTS could not build readable subtitle cues.');
        }
        // Keep display rows intact for subtitles, but synthesize connected
        // narration as natural phrase groups instead of one provider request
        // per rigid subtitle slot.
        const aimaxTtsUnits = buildTtsUnitsFromTranslatedRows(aimaxSubtitleRows, {
          ...config,
          aimaxMergeSegments: true,
        });
        if (aimaxSubtitleRows.length > segments.length) {
          await addLog(jobId, 'info', `AIMAX subtitle safety split: ${segments.length} cue(s) -> ${aimaxSubtitleRows.length} cue(s) before SRT batch TTS.`);
        }
        if (aimaxTtsUnits.length < aimaxSubtitleRows.length) {
          await addLog(jobId, 'info', `AIMAX natural TTS grouping: ${aimaxSubtitleRows.length} subtitle cue(s) -> ${aimaxTtsUnits.length} narration group(s).`);
        }
        const dubbedVoicePath = path.join(paths.tts, 'manual_dubbed_voice.wav');
        const finalAimaxSrtPath = path.join(paths.tts, 'final_aimax.srt');
        const batchWorkDir = path.join(paths.tts, 'aimax_srt_batches');
        const reportPath = path.join(paths.tts, 'aimax_srt_batch_report.json');
        await addLog(
          jobId,
          'info',
          `AIMAX SRT batch TTS started: ${aimaxTtsUnits.length} narration group(s) from ${aimaxSubtitleRows.length} subtitle cue(s), mode ${config.aimaxSrtBatchMode}, ${config.aimaxSrtCuesPerRequest} cue/request, speed ${Number(config.speakingRate || 1).toFixed(2)}.`
        );
        const batchResult = await aimaxSrtBatchService.synthesizeTranslatedSrtBatches(
          aimaxTtsUnits,
          {
            ...config,
            aimaxMergeSegments: true,
            abortSignal: operationSignal,
            aimaxGenerateSrt: true,
            preserveTtsAudio: true,
            ttsDurationControl: false,
            // AIMAX first generates every cue at the selected speaking rate.
            // If anti-overflow is enabled, the batch service then speeds up
            // only cached local cue audio that the assembled timeline flags.
            ttsFitEnabled: req.body?.ttsFitEnabled !== false && req.body?.googleCloudConfig?.ttsFitEnabled !== false,
            ttsFitMaxRate: Number(config.speakingRate) || 1,
            maxSpeakingRate: Number(config.speakingRate) || 1,
            maxEffectiveSpeakingRate: autoAntiOverflowMaxSpeakingRate(Number(config.speakingRate) || 1),
          },
          {
            workDir: batchWorkDir,
            outputAudioPath: dubbedVoicePath,
            outputSrtPath: finalAimaxSrtPath,
            displaySegments: aimaxSubtitleRows,
            onProgress: async (progress) => {
              const current = Number(progress.batchIndex) + 1;
              if (progress.status === 'completed') {
                await addLog(jobId, 'info', `AIMAX SRT batch ${current}/${progress.batchCount} completed (${progress.cueCount} cue).`);
              } else if (progress.status === 'reused') {
                await addLog(jobId, 'info', `AIMAX SRT batch ${current}/${progress.batchCount} reused from project files (${progress.cueCount} cue).`);
              } else if (progress.status === 'resuming') {
                await addLog(jobId, 'info', `AIMAX SRT batch ${current}/${progress.batchCount} resumed existing AIMAX job (${progress.cueCount} cue).`);
              } else {
                await addLog(jobId, 'info', `AIMAX SRT batch ${current}/${progress.batchCount} started (${progress.cueCount} cue).`);
              }
            },
          }
        );
        const audioStats = await getFileStats(dubbedVoicePath);
        const srtStats = await getFileStats(finalAimaxSrtPath);
        const audioAccepted = Boolean(audioStats?.size);
        const translationPersistPaths = aimaxSubtitleRows.length > segments.length
          ? await persistAimaxSubtitleSafetySplit(paths, aimaxSubtitleRows, config)
          : {};
        await writeJson(reportPath, {
          ...batchResult,
          audioFileSizeBytes: audioStats?.size || 0,
          srtFileSizeBytes: srtStats?.size || 0,
        });
        if (!audioAccepted) {
          const missingAudioError = new Error('AIMAX SRT batch TTS did not create final dubbed audio. Missing manual_dubbed_voice.wav.');
          missingAudioError.syncReport = batchResult.report || null;
          throw missingAudioError;
        }
        await writeJson(path.join(paths.tts, 'manual_tts_manifest.json'), {
          provider: config.ttsProvider,
          mode: 'aimax_srt_batches',
          languageCode: config.ttsLanguageCode,
          voiceName: config.ttsVoiceName,
          aimaxProvider: config.aimaxProvider,
          aimaxModel: config.aimaxModel,
          speakingRate: config.speakingRate,
          sourceSegmentCount: segments.length,
          ttsSegmentCount: aimaxTtsUnits.length,
          subtitleCueCount: aimaxSubtitleRows.length,
          ttsGroupCount: aimaxTtsUnits.length,
          ttsGroups: aimaxTtsUnits,
          subtitleSafetySplitApplied: aimaxSubtitleRows.length > segments.length,
          batchCount: batchResult.batchCount,
          cueCount: batchResult.cueCount,
          strictPass: batchResult.strictPass,
          failedSegmentCount: batchResult.failedSegmentCount,
          overflowSegmentCount: batchResult.overflowSegmentCount,
          overlapSegmentCount: batchResult.overlapSegmentCount,
          antiOverflow: batchResult.antiOverflow,
          batches: batchResult.batches,
          audioAccepted,
          audioPath: audioAccepted ? dubbedVoicePath : '',
          srtPath: srtStats?.size ? finalAimaxSrtPath : '',
          reportPath,
        });
        if (batchResult.failedSegmentCount > 0) {
          await addLog(jobId, 'warn', `AIMAX SRT batch mapped to timeline with ${batchResult.failedSegmentCount} warning cue(s): ${batchResult.overflowSegmentCount || 0} overflow, ${batchResult.overlapSegmentCount || 0} overlap.`);
        } else {
          await addLog(jobId, 'info', `AIMAX SRT batch TTS completed: ${batchResult.batchCount} request(s), ${batchResult.cueCount} cue(s).`);
        }
        if (batchResult.antiOverflow?.applied) {
          const remainingOverflowCount = Number(batchResult.antiOverflow.stillOverflowCount) || 0;
          const postSpeedMajorOverflowSeconds = Number(batchResult.antiOverflow.postSpeedMajorOverflowSeconds) || TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS;
          const targetSpeakingRate = Number(batchResult.antiOverflow.maxTargetSpeakingRate || batchResult.antiOverflow.targetSpeakingRate) || 1;
          const targetLabel = batchResult.antiOverflow.rateMode === 'auto_per_cue'
            ? `tự động tối đa ${targetSpeakingRate.toFixed(2)}x`
            : `lên ${targetSpeakingRate.toFixed(2)}x`;
          await addLog(
            jobId,
            remainingOverflowCount ? 'warn' : 'success',
            remainingOverflowCount
              ? `Chống tràn AIMAX: đã tăng tốc audio có sẵn của ${batchResult.antiOverflow.triggeredCueCount} cue ${targetLabel}; còn ${remainingOverflowCount} cue tràn trên ${Number(batchResult.antiOverflow.triggerOverflowSeconds || TTS_TIMING_TRACE_OVERFLOW_SECONDS).toFixed(2)}s${batchResult.antiOverflow.stillMajorOverflowCount ? `, trong đó ${batchResult.antiOverflow.stillMajorOverflowCount} cue tràn từ ${postSpeedMajorOverflowSeconds}s` : ''}.`
              : `Chống tràn AIMAX: đã tăng tốc audio có sẵn của ${batchResult.antiOverflow.triggeredCueCount} cue ${targetLabel}; không còn cue nào tràn trên ${Number(batchResult.antiOverflow.triggerOverflowSeconds || TTS_TIMING_TRACE_OVERFLOW_SECONDS).toFixed(2)}s.`
          );
        }
        const responsePayload = {
          success: true,
          jobId,
          mode: 'aimax_srt_batches',
          sourceSegmentCount: segments.length,
          ttsSegmentCount: aimaxTtsUnits.length,
          subtitleCueCount: aimaxSubtitleRows.length,
          ttsGroupCount: aimaxTtsUnits.length,
          clipCount: batchResult.batchCount,
          batchCount: batchResult.batchCount,
          cueCount: batchResult.cueCount,
          rows: aimaxSubtitleRows,
          segments: aimaxSubtitleRows,
          accepted: audioAccepted,
          audioPath: audioAccepted ? dubbedVoicePath : '',
          audioUrl: audioAccepted ? toPublicJobUrl(jobId, dubbedVoicePath) : '',
          unsafeAudioPath: '',
          unsafeAudioUrl: '',
          audioFileSizeBytes: audioStats?.size || 0,
          srtPath: srtStats?.size ? finalAimaxSrtPath : '',
          srtUrl: srtStats?.size ? toPublicJobUrl(jobId, finalAimaxSrtPath) : '',
          srtContent: srtStats?.size ? await fs.readFile(finalAimaxSrtPath, 'utf8') : '',
          translationQcReportPath: translationPersistPaths.translationQcReportPath || '',
          translationQcReportUrl: translationPersistPaths.translationQcReportPath ? toPublicJobUrl(jobId, translationPersistPaths.translationQcReportPath) : '',
          readabilityQcReportPath: translationPersistPaths.readabilityQcReportPath || '',
          readabilityQcReportUrl: translationPersistPaths.readabilityQcReportPath ? toPublicJobUrl(jobId, translationPersistPaths.readabilityQcReportPath) : '',
          aimaxSrtBatchReportPath: reportPath,
          aimaxSrtBatchReportUrl: toPublicJobUrl(jobId, reportPath),
          aimaxSrtBatchReport: batchResult,
          report: batchResult.report || null,
          ttsFitPlan: null,
        };
        await updateManualTtsJobResult(jobId, paths, responsePayload);
        return responsePayload;
      }

      const sourceVideoPath = await resolveManualSourceVideoPath(jobId).catch(() => '');
      const sourceDurationSeconds = sourceVideoPath ? await getDurationSeconds(sourceVideoPath).catch(() => 0) : 0;
      const clipDir = path.join(paths.tts, 'manual_clips');
      const dubbedVoicePath = path.join(paths.tts, 'manual_dubbed_voice.wav');
      const maxNaturalSpeakingRate = naturalMaxSpeakingRate(config, config.ttsProvider);
      const strictTtsConfig = {
        ...config,
        abortSignal: operationSignal,
        preserveTtsAudio: true,
        ttsDurationControl: false,
        maxSpeakingRate: maxNaturalSpeakingRate,
        maxEffectiveSpeakingRate: maxNaturalSpeakingRate,
        stretchShortClips: false,
        continueOnTtsError: true,
      };
      strictTtsConfig.ttsFitEnabled = req.body?.ttsFitEnabled !== false && req.body?.googleCloudConfig?.ttsFitEnabled !== false;
      strictTtsConfig.ttsFitMode = String(req.body?.ttsFitMode || req.body?.googleCloudConfig?.ttsFitMode || 'balanced');
      // Anti-overflow is intentionally a post-render operation: render every
      // cue at the target rate, measure its actual audio, and recalculate every
      // cue whose measured overflow is above the trace tolerance.
      strictTtsConfig.ttsFitMeasuredOverflowOnly = strictTtsConfig.ttsFitEnabled;
      strictTtsConfig.ttsFitMeasuredOverflowThresholdSeconds = TTS_TIMING_TRACE_OVERFLOW_SECONDS;
      const requestedTtsUnitMode = effectiveTtsUnitModeForSegments(strictTtsConfig.ttsUnitMode, segments);
      strictTtsConfig.ttsUnitMode = requestedTtsUnitMode;
      strictTtsConfig.ttsFitMaxRate = Number(strictTtsConfig.speakingRate) || 1;
      strictTtsConfig.maxSpeakingRate = Number(strictTtsConfig.speakingRate) || 1;
      strictTtsConfig.maxEffectiveSpeakingRate = autoAntiOverflowMaxSpeakingRate(Number(strictTtsConfig.speakingRate) || 1);
      const manualTtsFitEnabled = strictTtsConfig.ttsFitEnabled !== false;
      // The initial pass must stay at the user's target rate.  Anti-overflow
      // speed is applied only after the assembled timeline proves a cue is
      // more than one second late.
      strictTtsConfig.preserveTtsAudio = true;
      strictTtsConfig.ttsDurationControl = false;
      strictTtsConfig.allowTextShortening = false;
      strictTtsConfig.naturalPhraseSync = false;
      strictTtsConfig.allowDurationPhraseSplit = false;
      strictTtsConfig.allowUnpunctuatedPhraseSplit = false;
      strictTtsConfig.voiceAlignShortClips = false;
      strictTtsConfig.voiceAlignMode = 'start';
      strictTtsConfig.voiceAlignMinSlackSeconds = Number(req.body?.voiceAlignMinSlackSeconds ?? req.body?.googleCloudConfig?.voiceAlignMinSlackSeconds ?? 0.05) || 0.05;
      strictTtsConfig.voiceAlignMaxShiftSeconds = Number(req.body?.voiceAlignMaxShiftSeconds ?? req.body?.googleCloudConfig?.voiceAlignMaxShiftSeconds ?? 0.6) || 0.6;
      let ttsUnitMode = effectiveTtsUnitModeForSegments(strictTtsConfig.ttsUnitMode, segments);
      if (ttsUnitMode === 'story_segments' && !rawTtsUnits.length) {
        ttsUnitMode = 'post_translation';
      }
      strictTtsConfig.ttsUnitMode = ttsUnitMode;
      const autoRepairOptions = resolveAutoTtsRepairOptions(req.body, rerunRowIds);
      const autoTtsRepairReportPath = path.join(paths.tts, 'auto_tts_repair_report.json');
      const autoTtsRepairReport = createAutoTtsRepairReport(autoRepairOptions);
      let workingSegments = segments;
      let workingRawMeaningUnits = rawMeaningUnits;
      let workingRawTtsUnits = rawTtsUnits;
      let translationPersistPaths = {};
      let renderResult = null;

      while (!renderResult) {
        if (operationSignal.aborted) throw new Error('Operation canceled.');
        const sourceTtsUnits = ttsUnitMode === 'story_segments'
          ? normalizeMeaningUnitsForTts(workingRawTtsUnits, workingSegments, strictTtsConfig)
          : ttsUnitMode === 'meaning_units'
          ? normalizeMeaningUnitsForTts(workingRawMeaningUnits, workingSegments, strictTtsConfig)
          : (workingRawTtsUnits.length
            ? normalizeMeaningUnitsForTts(workingRawTtsUnits, workingSegments, strictTtsConfig)
            : buildPipelineTtsUnits(workingSegments, workingRawMeaningUnits, strictTtsConfig, {
              builder: (displayRows) => buildTtsUnitsFromTranslatedRows(displayRows, strictTtsConfig),
            }).ttsUnits);
        const ttsUnits = addTimingBudget(sourceTtsUnits, {
          ...strictTtsConfig,
          borrowGapSeconds: 0,
        });
        const ttsFitPlan = planTtsFit(ttsUnits, strictTtsConfig);
        const fitRepairItems = collectFitRepairItems(ttsUnits, ttsFitPlan, workingSegments, autoRepairOptions);
        if (
          autoRepairOptions.enabled
          && fitRepairItems.length
          && autoTtsRepairReport.passes.length < autoRepairOptions.maxPasses
        ) {
          const repaired = await runAutoTtsRepairPass({
            jobId,
            phase: 'pre_tts_fit',
            passNumber: autoTtsRepairReport.passes.length + 1,
            inputItems: fitRepairItems,
            rows: workingSegments,
            rawMeaningUnits: workingRawMeaningUnits,
            rawTtsUnits: workingRawTtsUnits,
            config: strictTtsConfig,
            report: autoTtsRepairReport,
          });
          if (repaired.repairedRowIds.length) {
            workingSegments = repaired.rows;
            workingRawMeaningUnits = repaired.rawMeaningUnits;
            workingRawTtsUnits = repaired.rawTtsUnits;
            continue;
          }
        }

        const blockedUnits = (ttsFitPlan.units || []).filter((unit) => unit.action === 'manual_review');
        if (ttsUnitMode === 'story_segments' && blockedUnits.length) {
          autoTtsRepairReport.finalStatus = autoRepairOptions.enabled ? 'needs_manual_review' : 'skipped';
          if (autoRepairOptions.enabled || autoTtsRepairReport.passes.length) {
            await writeJson(autoTtsRepairReportPath, autoTtsRepairReport);
          }
          throw new Error(`Story TTS overflow requires review for: ${blockedUnits.map((unit) => unit.id || unit.index + 1).join(', ')}. Text was not shortened or clipped.`);
        }

        const fittedTtsUnits = applyPlanToUnits(ttsUnits, ttsFitPlan, strictTtsConfig);
        const previousBasedTtsSegments = rerunRowIds.length && previousManualTtsManifest?.ttsSegments?.length
          ? updatePreviousTtsSegmentsForRerun(previousManualTtsManifest.ttsSegments, workingSegments, rerunRowIds)
          : [];
        let ttsSegments = (previousBasedTtsSegments.length ? previousBasedTtsSegments : buildPhraseSegments(fittedTtsUnits, strictTtsConfig))
          .map((segment, index) => ({ ...segment, index }));
        const phrasePlan = summarizePhrasePlan(ttsSegments);
        const partialTtsReuse = rerunRowIds.length
          ? planPartialTtsReuse(previousManualTtsManifest, ttsSegments, rerunRowIds)
          : { enabled: false, indices: [], existingClips: [], rerunCount: ttsSegments.length, reusedCount: 0 };
        if (rerunRowIds.length && partialTtsReuse.enabled) {
          await addLog(
            jobId,
            'info',
            `TTS partial rerun: regenerating ${partialTtsReuse.rerunCount} clip(s), reusing ${partialTtsReuse.reusedCount} existing clip(s).`
          );
        } else if (rerunRowIds.length) {
          throw new Error('Single-row TTS rerun could not reuse the existing timeline audio; full timeline TTS was blocked.');
        }
        await addLog(
          jobId,
          'info',
          `TTS render started: ${partialTtsReuse.enabled ? partialTtsReuse.rerunCount : ttsSegments.length} new clip(s), ${partialTtsReuse.enabled ? partialTtsReuse.reusedCount : 0} reused, provider ${strictTtsConfig.ttsProvider || 'default'}, concurrency ${strictTtsConfig.ttsConcurrency || 'auto'}.`
        );
        let lastTtsProgressLogAt = 0;
        let clips = await synthesizeAllSegments(
          ttsSegments,
          strictTtsConfig,
          clipDir,
          partialTtsReuse.enabled
            ? {
              indices: partialTtsReuse.indices,
              existingClips: partialTtsReuse.existingClips,
              onProgress: async (progress) => {
                const now = Date.now();
                if (progress.done >= progress.total || now - lastTtsProgressLogAt >= 5000) {
                  lastTtsProgressLogAt = now;
                  await addLog(jobId, 'info', `TTS clips: ${progress.done}/${progress.total} (${progress.generated} new, ${progress.reused} reused, ${progress.failed} failed).`);
                }
              },
            }
            : {
              onProgress: async (progress) => {
                const now = Date.now();
                if (progress.done >= progress.total || now - lastTtsProgressLogAt >= 5000) {
                  lastTtsProgressLogAt = now;
                  await addLog(jobId, 'info', `TTS clips: ${progress.done}/${progress.total} (${progress.generated} new, ${progress.reused} reused, ${progress.failed} failed).`);
                }
              },
            }
        );
        if (operationSignal.aborted) throw new Error('Operation canceled.');
        await addLog(jobId, 'info', `TTS audio sync started for ${clips.length} clip(s).`);
        let aligned = await createAlignedAudio(ttsSegments, clips, dubbedVoicePath, {
          ...strictTtsConfig,
          syncMode: 'strict',
          addSilenceGaps: true,
          audioSampleRate: 32000,
          preserveTtsAudio: !manualTtsFitEnabled,
          normalizeLoudness: false,
          stretchShortClips: false,
          acceptOverflowSeconds: 0.03,
          retryOverflowSeconds: 0,
          strictEndGuardSeconds: 0.03,
          maxVoiceGapSeconds: 0,
          hardTrimOverflow: false,
          timelineDurationSeconds: sourceDurationSeconds,
          failOnStrictSync: false,
          maxEffectiveSpeakingRate: strictTtsConfig.maxEffectiveSpeakingRate,
        });
        // Recalculate every measured overflow. The one-second value remains a
        // severity label, not a reason to skip smaller overflow segments.
        const antiOverflowTriggerSeconds = TTS_TIMING_TRACE_OVERFLOW_SECONDS;
        const antiOverflowTargetSeconds = TTS_TIMING_TRACE_OVERFLOW_SECONDS;
        const antiOverflowMajorSeconds = TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS;
        const antiOverflowIndices = manualTtsFitEnabled
          ? findTimelineOverflowIndices(aligned.report, antiOverflowTriggerSeconds)
          : [];
        const targetRate = Number(strictTtsConfig.speakingRate) || 1;
        const reportByIndex = new Map((aligned.report?.segments || [])
          .map((item) => [Number(item.index), item])
          .filter(([index]) => Number.isInteger(index)));
        const clipByIndex = new Map(clips.map((clip) => [Number(clip.index), clip]));
        const speedByIndex = new Map();
        for (const index of antiOverflowIndices) {
          const clip = clipByIndex.get(index) || {};
          const clipBaseRate = Number(clip.ttsSpeakingRate) || targetRate;
          const speedFactor = antiOverflowSpeedFactorForReportItem(reportByIndex.get(index), {
            baseSpeakingRate: clipBaseRate,
            triggerOverflowSeconds: antiOverflowTriggerSeconds,
            targetOverflowSeconds: antiOverflowTargetSeconds,
          });
          if (speedFactor > 1.001) speedByIndex.set(index, speedFactor);
        }
        const antiOverflowSpeedFactors = [...speedByIndex.values()];
        if (antiOverflowSpeedFactors.length) {
          const maxAntiOverflowSpeedFactor = Math.max(...antiOverflowSpeedFactors);
          const minAntiOverflowSpeedFactor = Math.min(...antiOverflowSpeedFactors);
          const antiOverflowTargetRates = [...speedByIndex.entries()].map(([index, speedFactor]) => {
            const clip = clipByIndex.get(index) || {};
            return (Number(clip.ttsSpeakingRate) || targetRate) * speedFactor;
          });
          const antiOverflowRate = Number(Math.max(...antiOverflowTargetRates).toFixed(3));
          // This is deliberately after the first timeline assembly. Any cue
          // the normal checker flags as overflowing has its existing audio
          // sped up; no second TTS provider request is made.
          clips = clips.map((clip) => (
              speedByIndex.has(Number(clip.index))
              ? {
                ...clip,
                allowPostTtsSpeedProcessing: true,
                forcePostTtsSpeedProcessing: true,
                postTtsSpeedFactor: speedByIndex.get(Number(clip.index)),
                antiOverflowTargetSpeakingRate: Number(((Number(clip.ttsSpeakingRate) || targetRate) * speedByIndex.get(Number(clip.index))).toFixed(3)),
                antiOverflowTriggerSeconds,
                antiOverflowBeforeSpeedUp: timelineOverflowSeconds(aligned.report?.segments?.find((item) => Number(item.index) === Number(clip.index)) || {}),
              }
              : clip
          ));
          await addLog(jobId, 'warning', `Chống tràn TTS: ${antiOverflowSpeedFactors.length} cue tràn trên ${antiOverflowTriggerSeconds}s, tự tăng tốc audio từ ${minAntiOverflowSpeedFactor.toFixed(3)}x đến ${maxAntiOverflowSpeedFactor.toFixed(3)}x.`);
          aligned = await createAlignedAudio(ttsSegments, clips, dubbedVoicePath, {
            ...strictTtsConfig,
            syncMode: 'strict',
            addSilenceGaps: true,
            audioSampleRate: 32000,
            preserveTtsAudio: false,
            speedUpLongSegments: true,
            normalizeLoudness: false,
            stretchShortClips: false,
            acceptOverflowSeconds: 0.03,
            retryOverflowSeconds: 0,
            strictEndGuardSeconds: 0.03,
            maxVoiceGapSeconds: 0,
            hardTrimOverflow: false,
            timelineDurationSeconds: sourceDurationSeconds,
            failOnStrictSync: false,
            maxEffectiveSpeakingRate: antiOverflowRate,
            majorEndToleranceSeconds: antiOverflowMajorSeconds,
          });
          const stillOverflowCount = findTimelineOverflowIndices(aligned.report, antiOverflowTriggerSeconds - 0.000001).length;
          const stillMajorOverflowCount = findTimelineOverflowIndices(aligned.report, antiOverflowMajorSeconds - 0.000001).length;
          await addLog(
            jobId,
            stillOverflowCount ? 'warning' : 'success',
            stillOverflowCount
              ? `Chống tràn TTS: ${stillOverflowCount} cue vẫn tràn trên ${antiOverflowTriggerSeconds}s sau lần ghép lại${stillMajorOverflowCount ? `, trong đó ${stillMajorOverflowCount} cue tràn từ ${antiOverflowMajorSeconds}s` : ''}.`
              : `Chống tràn TTS: ${antiOverflowSpeedFactors.length} cue đã được tăng tốc audio; không còn cue nào tràn trên ${antiOverflowTriggerSeconds}s.`
          );
        }
        const ttsQcReport = createTtsQcReport(ttsSegments, clips, {
          ...strictTtsConfig,
          ttsFitPlan,
          ttsCleanupMode: strictTtsConfig.ttsTextCleanupMode || 'natural',
        });
        const syncQcReport = createSyncQcReport(aligned.report, strictTtsConfig);
        const postRepairItems = collectPostTtsRepairItems(ttsSegments, clips, aligned.report, workingSegments, autoRepairOptions);
        if (
          autoRepairOptions.enabled
          && postRepairItems.length
          && autoTtsRepairReport.passes.length < autoRepairOptions.maxPasses
        ) {
          const repaired = await runAutoTtsRepairPass({
            jobId,
            phase: 'post_tts_qc',
            passNumber: autoTtsRepairReport.passes.length + 1,
            inputItems: postRepairItems,
            rows: workingSegments,
            rawMeaningUnits: workingRawMeaningUnits,
            rawTtsUnits: workingRawTtsUnits,
            config: strictTtsConfig,
            report: autoTtsRepairReport,
          });
          if (repaired.repairedRowIds.length) {
            workingSegments = repaired.rows;
            workingRawMeaningUnits = repaired.rawMeaningUnits;
            workingRawTtsUnits = repaired.rawTtsUnits;
            await resetManualArtifacts(paths, ['tts']);
            await clearManualVideoArtifacts(paths);
            continue;
          }
        }

        const audioStats = await getFileStats(dubbedVoicePath);
        const audioAccepted = Boolean(audioStats?.size);
        const ttsQcReportPath = path.join(paths.tts, 'tts_qc_report.json');
        const syncQcReportPath = path.join(paths.tts, 'sync_qc_report.json');
        await writeJson(ttsQcReportPath, ttsQcReport);
        await writeJson(syncQcReportPath, syncQcReport);

        if (autoRepairOptions.enabled || autoTtsRepairReport.passes.length) {
          autoTtsRepairReport.finalStatus = postRepairItems.length ? 'needs_manual_review' : (autoTtsRepairReport.changedRows.length ? 'repaired' : 'skipped');
          await writeJson(autoTtsRepairReportPath, autoTtsRepairReport);
        }
        if (autoTtsRepairReport.changedRows.length) {
          translationPersistPaths = await persistAutoTtsRepairTranslation(
            jobId,
            paths,
            workingSegments,
            workingRawMeaningUnits,
            workingRawTtsUnits,
            strictTtsConfig,
            { autoTtsRepairReportPath }
          );
        }

        await writeJson(path.join(paths.tts, 'manual_tts_manifest.json'), {
          provider: config.ttsProvider,
          languageCode: config.ttsLanguageCode,
          voiceName: config.ttsVoiceName,
          aimaxProvider: config.aimaxProvider,
          aimaxModel: config.aimaxModel,
          speakingRate: config.speakingRate,
          ttsUnitMode,
          outputSampleRate: aligned.outputSampleRate,
          normalizeLoudness: false,
          timelineDurationSeconds: sourceDurationSeconds,
          sourceSegmentCount: workingSegments.length,
          meaningUnitCount: fittedTtsUnits.length,
          ttsUnitCount: fittedTtsUnits.length,
          ttsSegmentCount: ttsSegments.length,
          meaningUnits: fittedTtsUnits,
          ttsUnits: fittedTtsUnits,
          ttsFitPlan,
          phrasePlan,
          ttsSegments,
          clips,
          autoTtsRepairReport: autoTtsRepairReport.enabled ? autoTtsRepairReport : null,
          autoTtsRepairReportPath: autoTtsRepairReport.enabled ? autoTtsRepairReportPath : '',
          partialTts: {
            requestedRowIds: rerunRowIds,
            enabled: partialTtsReuse.enabled,
            rerunCount: partialTtsReuse.enabled ? partialTtsReuse.rerunCount : ttsSegments.length,
            reusedCount: partialTtsReuse.enabled ? partialTtsReuse.reusedCount : 0,
          },
          report: aligned.report,
          ttsQcReportPath,
          syncQcReportPath,
          audioAccepted,
          audioPath: audioAccepted ? dubbedVoicePath : '',
          unsafeAudioPath: '',
        });

        const syncedReportSegments = aligned.report?.segments || [];
        const syncedReportById = new Map(syncedReportSegments.map((item) => [String(item.id), item]));
        const syncedReportByIndex = new Map(syncedReportSegments.map((item) => [Number(item.index), item]));

        const syncedGroupSegments = ttsSegments.map((ttsSegment, idx) => {
          const reportItem = syncedReportById.get(String(ttsSegment.id)) || syncedReportByIndex.get(idx) || {};
          const start = Number(reportItem.actualStartSeconds ?? ttsSegment.start) || 0;
          const end = Number(reportItem.actualEndSeconds ?? ttsSegment.end) || (start + 0.1);
          const duration = Number(reportItem.actualDurationSeconds || (end - start));
          const text = String(ttsSegment.finalText || ttsSegment.translatedText || ttsSegment.text || '').trim();
          return {
            ...ttsSegment,
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
            duration: Number(duration.toFixed(3)),
            text,
            finalText: text,
            translatedText: text,
            ttsText: text,
            translationMerged: text,
          };
        });

        const normalizedSrtPath = path.join(paths.translations, 'translated_timeline_checked.srt');
        const finalSrtPath = path.join(paths.exports, 'translated.srt');
        await exportSrt(syncedGroupSegments, normalizedSrtPath);
        await exportSrt(syncedGroupSegments, finalSrtPath);

        const previousTranslatedJson = await readJson(paths.translatedJson, null) || {};
        await writeJson(paths.translatedJson, {
          ...previousTranslatedJson,
          segments: syncedGroupSegments,
          rawSegments: syncedGroupSegments,
          meaningUnits: syncedGroupSegments,
          ttsUnits: syncedGroupSegments,
          updatedAfterTtsAt: new Date().toISOString(),
        });

        renderResult = {
          success: true,
          jobId,
          sourceSegmentCount: workingSegments.length,
          meaningUnitCount: ttsUnits.length,
          ttsUnitMode,
          ttsUnitCount: fittedTtsUnits.length,
          ttsSegmentCount: ttsSegments.length,
          clipCount: clips.length,
          clips,
          partialTts: {
            requestedRowIds: rerunRowIds,
            enabled: partialTtsReuse.enabled,
            rerunCount: partialTtsReuse.enabled ? partialTtsReuse.rerunCount : ttsSegments.length,
            reusedCount: partialTtsReuse.enabled ? partialTtsReuse.reusedCount : 0,
          },
          ttsFitPlan,
          accepted: audioAccepted,
          audioPath: audioAccepted ? dubbedVoicePath : '',
          audioUrl: audioAccepted ? toPublicJobUrl(jobId, dubbedVoicePath) : '',
          unsafeAudioPath: '',
          unsafeAudioUrl: '',
          audioFileSizeBytes: audioStats?.size || 0,
          ttsQcReportPath,
          syncQcReportPath,
          ttsQcReportUrl: toPublicJobUrl(jobId, ttsQcReportPath),
          syncQcReportUrl: toPublicJobUrl(jobId, syncQcReportPath),
          autoTtsRepairReport: autoTtsRepairReport.enabled ? autoTtsRepairReport : null,
          autoTtsRepairReportPath: autoTtsRepairReport.enabled ? autoTtsRepairReportPath : '',
          autoTtsRepairReportUrl: autoTtsRepairReport.enabled ? toPublicJobUrl(jobId, autoTtsRepairReportPath) : '',
          readabilityQcReportPath: translationPersistPaths.readabilityQcReportPath || '',
          readabilityQcReportUrl: translationPersistPaths.readabilityQcReportPath ? toPublicJobUrl(jobId, translationPersistPaths.readabilityQcReportPath) : '',
          translationQcReportPath: translationPersistPaths.translationQcReportPath || '',
          translationQcReportUrl: translationPersistPaths.translationQcReportPath ? toPublicJobUrl(jobId, translationPersistPaths.translationQcReportPath) : '',
          srtPath: finalSrtPath,
          srtUrl: toPublicJobUrl(jobId, finalSrtPath),
          srtContent: segmentsToSrt(syncedGroupSegments),
          normalizedSrtPath,
          normalizedSrtUrl: toPublicJobUrl(jobId, normalizedSrtPath),
          rows: syncedGroupSegments,
          segments: syncedGroupSegments,
          meaningUnits: syncedGroupSegments,
          ttsUnits: syncedGroupSegments,
          report: aligned.report,
        };
      }

      await updateManualTtsJobResult(jobId, paths, renderResult);
      return renderResult;
    });

    res.json(result);
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped, ...(error.syncReport ? { report: error.syncReport } : {}) });
  }
});

app.post('/api/manual/rerun-tts-row', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const result = await runExclusiveJobOperation(jobId, 'TTS row rerun', async (operationSignal) => {
      const paths = getJobPaths(jobId);
      const rawRow = req.body?.row && typeof req.body.row === 'object' ? req.body.row : null;
      const rows = normalizeClientSegments(rawRow ? [{
        ...rawRow,
        text: String(rawRow.text || rawRow.finalText || rawRow.translatedText || '').trim(),
      }] : []).filter((segment) => segment.text);
      const row = rows[0];
      if (!row) {
        throw new Error('No subtitle row is available for TTS rerun.');
      }

      const dubbedVoicePath = path.join(paths.tts, 'manual_dubbed_voice.wav');
      if (!await getFileStats(dubbedVoicePath)) {
        throw new Error('Generate the full TTS audio once before rerunning a single timeline row.');
      }

      const config = resolveGoogleCloudConfig({
        ...req.body,
        targetLanguage: req.body?.targetLanguage || 'vi',
        googleCloudConfig: {
          ...(req.body?.googleCloudConfig || {}),
          ttsProvider: req.body?.ttsProvider || req.body?.googleCloudConfig?.ttsProvider,
          ttsLanguageCode: req.body?.ttsLanguageCode || req.body?.googleCloudConfig?.ttsLanguageCode,
          ttsVoiceName: req.body?.ttsVoiceName || req.body?.googleCloudConfig?.ttsVoiceName,
          voiceGenderFilter: req.body?.voiceGenderFilter || req.body?.googleCloudConfig?.voiceGenderFilter,
          ssmlGender: req.body?.ssmlGender || req.body?.googleCloudConfig?.ssmlGender,
          aimaxProvider: req.body?.aimaxProvider || req.body?.googleCloudConfig?.aimaxProvider,
          aimaxModel: req.body?.aimaxModel || req.body?.googleCloudConfig?.aimaxModel,
          ttsConcurrency: req.body?.ttsConcurrency ?? req.body?.googleCloudConfig?.ttsConcurrency,
          ttsMaxAttempts: req.body?.ttsMaxAttempts ?? req.body?.googleCloudConfig?.ttsMaxAttempts,
          speakingRate: req.body?.speakingRate ?? req.body?.googleCloudConfig?.speakingRate,
          pitch: req.body?.pitch ?? req.body?.googleCloudConfig?.pitch,
          ttsFitEnabled: req.body?.ttsFitEnabled ?? req.body?.googleCloudConfig?.ttsFitEnabled,
          ttsFitMode: req.body?.ttsFitMode ?? req.body?.googleCloudConfig?.ttsFitMode,
          ttsFitMaxRate: req.body?.ttsFitMaxRate ?? req.body?.googleCloudConfig?.ttsFitMaxRate,
          ttsTextCleanupMode: req.body?.ttsTextCleanupMode ?? req.body?.googleCloudConfig?.ttsTextCleanupMode,
        },
      });
      const strictTtsConfig = {
        ...config,
        abortSignal: operationSignal,
        preserveTtsAudio: false,
        ttsDurationControl: config.ttsFitEnabled !== false,
        ttsFitEnabled: req.body?.ttsFitEnabled !== false && req.body?.googleCloudConfig?.ttsFitEnabled !== false,
        ttsFitMode: String(req.body?.ttsFitMode || req.body?.googleCloudConfig?.ttsFitMode || 'balanced'),
        ttsFitMaxRate: Number(config.speakingRate) || 1,
        allowTextShortening: false,
        naturalPhraseSync: false,
        allowDurationPhraseSplit: false,
        allowUnpunctuatedPhraseSplit: false,
        voiceAlignShortClips: false,
        voiceAlignMode: 'start',
        stretchShortClips: false,
        continueOnTtsError: true,
      };
      strictTtsConfig.maxSpeakingRate = Number(config.speakingRate) || 1;
      strictTtsConfig.maxEffectiveSpeakingRate = autoAntiOverflowMaxSpeakingRate(Number(config.speakingRate) || 1);
      strictTtsConfig.preserveTtsAudio = !strictTtsConfig.ttsDurationControl;

      const rowId = String(row.id || rawRow.id || `row-${Date.now()}`);
      const start = Number(row.start) || 0;
      const end = Number(row.end) || (start + Math.max(0.1, Number(row.duration) || 0.8));
      const finalText = normalizeSegmentText(row.finalText || row.translatedText || row.text);
      const ttsText = ttsTextFromTranslation(finalText, strictTtsConfig) || finalText;
      const ttsUnits = addTimingBudget([{
        ...row,
        id: rowId,
        start,
        end,
        duration: Number(Math.max(0.1, end - start).toFixed(3)),
        text: ttsText,
        ttsText,
        prosodyText: ttsText,
        finalText,
        translatedText: finalText,
        sourceIds: [rowId],
        sourceRowIds: [rowId],
      }], {
        ...strictTtsConfig,
        borrowGapSeconds: 0,
      });
      const ttsFitPlan = planTtsFit(ttsUnits, strictTtsConfig);
      const fittedTtsUnits = applyPlanToUnits(ttsUnits, ttsFitPlan, strictTtsConfig);
      const ttsSegments = buildPhraseSegments(fittedTtsUnits, strictTtsConfig)
        .map((segment, index) => ({ ...segment, index, sourceIds: [rowId], sourceRowIds: [rowId] }));
      const safeRowId = sanitizePathSegment(rowId, 'row');
      const rowClipDir = path.join(paths.tts, 'manual_row_reruns', safeRowId);
      await resetJobDirectory(paths, rowClipDir);
      const clips = await synthesizeAllSegments(ttsSegments, strictTtsConfig, rowClipDir);
      if (operationSignal.aborted) throw new Error('Operation canceled.');

      const sourceAudioDuration = await getDurationSeconds(dubbedVoicePath);
      const replacementAudioPath = path.join(rowClipDir, 'timeline_replacement.wav');
      const aligned = await createAlignedAudio(ttsSegments, clips, replacementAudioPath, {
        ...strictTtsConfig,
        syncMode: 'strict',
        addSilenceGaps: true,
        audioSampleRate: 32000,
        normalizeLoudness: false,
        acceptOverflowSeconds: 0.03,
        retryOverflowSeconds: 0,
        strictEndGuardSeconds: 0.03,
        maxVoiceGapSeconds: 0,
        hardTrimOverflow: false,
        timelineDurationSeconds: sourceAudioDuration,
        failOnStrictSync: false,
      });
      const rerunReport = aligned.report || {};
      const rerunHasOverflow = (Number(rerunReport.overflowSegmentCount) || 0) > 0
        || (Number(rerunReport.maxEndOverflowSeconds) || 0) > 0;
      const rerunHasOverlap = (Number(rerunReport.overlapSegmentCount) || 0) > 0;
      // A right-click rerun must meet the same timing gate as the main TTS
      // flow. Never replace the current row audio with a clip that spills into
      // its next cue, even when FFmpeg managed to render a preview file.
      let replacementReady = Boolean(aligned.outputPath) && !rerunHasOverflow && !rerunHasOverlap;
      const manualTtsManifestPath = path.join(paths.tts, 'manual_tts_manifest.json');
      const previousManifest = await readJson(manualTtsManifestPath, {});
      const previousBatchReport = await readJson(path.join(paths.tts, 'aimax_srt_batch_report.json'), null);
      const previousReport = previousManifest?.report || previousBatchReport?.report || null;
      const rowReruns = Array.isArray(previousManifest?.rowReruns) ? previousManifest.rowReruns : [];
      let rerunClip = null;
      let rebuiltTimeline = null;
      if (replacementReady) {
        rerunClip = clips.find((clip) => String(clip?.path || '').trim()) || null;
        const overrideClipByRowId = manualRowRerunClipOverrides(
          paths,
          rowReruns.filter((item) => String(item?.rowId || item?.row_id || '') !== rowId)
        );
        if (rerunClip?.path) {
          overrideClipByRowId.set(rowId, rerunClip.path);
        }
        rebuiltTimeline = rerunClip
          ? await rebuildManualTtsFromAimaxClips({
            paths,
            outputPath: dubbedVoicePath,
            previousReport,
            previousBatchReport,
            previewReportsById: new Map(),
            appliedRows: [{ rowId }],
            overrideClipByRowId,
          })
          : null;
        replacementReady = Boolean(rebuiltTimeline?.outputPath);
      }
      if (replacementReady) {
        await clearManualVideoArtifacts(paths);
      }

      const previousClips = Array.isArray(previousManifest?.clips) ? previousManifest.clips : [];
      const nextReusableClips = previousClips.map((clip) => clip);
      await writeJson(manualTtsManifestPath, {
        ...previousManifest,
        audioAccepted: true,
        audioPath: dubbedVoicePath,
        clips: nextReusableClips,
        report: replacementReady ? rebuiltTimeline.report : (previousManifest?.report || previousReport || aligned.report),
        rowReruns: [
          ...rowReruns.filter((item) => String(item.rowId) !== rowId),
          {
            rowId,
            finalText,
            ttsText,
            start,
            end,
            ttsFitPlan,
            ttsSegments,
            clipPath: replacementReady && rerunClip?.path ? rerunClip.path : '',
            clipUrl: replacementReady && rerunClip?.path ? toPublicJobUrl(jobId, rerunClip.path) : null,
            clipCount: clips.length,
            report: replacementReady ? rebuiltTimeline.report : aligned.report,
            replacedAudio: replacementReady,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      await addLog(
        jobId,
        replacementReady ? 'success' : 'warning',
        replacementReady
          ? `TTS reran timeline row ${rowId} by rebuilding its cue timeline; kept every other cached voice clip unchanged.`
          : `TTS did not safely rebuild timeline row ${rowId}; kept existing audio and marked the row for repair.`
      );

      return {
        success: true,
        jobId,
        rowId,
        finalText,
        ttsText,
        ttsFitPlan,
        report: replacementReady ? rebuiltTimeline.report : aligned.report,
        audioPath: dubbedVoicePath,
        audioUrl: toPublicJobUrl(jobId, dubbedVoicePath),
        accepted: replacementReady,
      };
    }, { response: res });

    res.json(result);
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped, ...(error.syncReport ? { report: error.syncReport } : {}) });
  }
});

app.post('/api/manual/cancel-operation', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const active = activeJobOperations.get(jobId);
    if (!active) {
      return res.json({ success: true, jobId, canceled: false, message: 'No active operation.' });
    }

    const force = req.body?.force === true;
    requestActiveJobOperationCancel(jobId, active, 'manual cancel', force ? 1 : ACTIVE_OPERATION_FORCE_RELEASE_MS);
    if (force) {
      releaseActiveJobOperation(jobId, active, 'manual force cancel');
    }
    return res.json({
      success: true,
      jobId,
      canceled: true,
      label: active.label,
      operationId: active.operationId,
      forceReleased: force,
      message: `Cancel requested for ${active.label}.`,
    });
  } catch (error) {
    const mapped = classifyError(error);
    return res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/mux-video', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const sourceVideoPath = await resolveManualSourceVideoPath(jobId);
    const includeDubbedAudio = req.body?.includeDubbedAudio !== false;
    const requestedAudioPath = String(req.body?.audioPath || '').trim();
    const defaultAudioPath = path.join(paths.tts, 'manual_dubbed_voice.wav');
    const audioPath = includeDubbedAudio ? (requestedAudioPath || defaultAudioPath) : '';
    if (includeDubbedAudio && !await getFileStats(audioPath)) {
      throw new Error('Dubbed audio is missing. Run TTS again or disable Dubbed audio before exporting.');
    }
    const requestedFileName = String(req.body?.fileName || 'manual_final_dubbed.mp4').trim() || 'manual_final_dubbed.mp4';
    const outputFormat = String(req.body?.outputFormat || path.extname(requestedFileName).slice(1) || 'mp4').toLowerCase();
    const safeFormat = ['mp4', 'mkv', 'avi'].includes(outputFormat) ? outputFormat : 'mp4';
    const baseName = sanitizePathSegment(requestedFileName.replace(/\.(mp4|mkv|avi)$/i, ''), 'manual_final_dubbed');
    const outputPath = path.join(paths.exports, `${baseName}.${safeFormat}`);
    const subtitlePath = String(req.body?.subtitlePath || '').trim();
    const subtitleStyle = req.body?.subtitleStyle || {};
    const subtitleSegments = normalizeClientSegments(req.body?.subtitleSegments || []);
    // Timeline rows take priority over a saved SRT. This is important after a
    // user edits, moves, or splits subtitle rows in the manual editor.
    const requestedBurnSubtitles = Boolean(req.body?.burnSubtitles && (subtitleSegments.length || subtitlePath));
    const requestedSoftSubtitles = Boolean(req.body?.softSubtitles && (subtitleSegments.length || subtitlePath));
    const outputAspectRatio = String(req.body?.outputAspectRatio || '').trim();
    const aspectMaxLineLength = outputAspectRatio === '9:16' ? 22 : 32;
    const maxLineLength = Math.max(18, Math.min(aspectMaxLineLength, Number(subtitleStyle.maxCharsPerLine || subtitleStyle.maxLineLength || 32)));
    const subtitleExportOptions = {
      displayOptimized: true,
      // Match the editor preview: split long narration into separate timed
      // subtitle cues, rather than only wrapping it inside one large card.
      maxChars: Math.max(18, maxLineLength),
      maxLineLength,
    };
    const writeSubtitleArtifact = async (targetPath) => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (subtitleSegments.length) {
        await exportSrt(subtitleSegments, targetPath, subtitleExportOptions);
      } else if (subtitlePath && path.resolve(subtitlePath) !== path.resolve(targetPath)) {
        await fs.copyFile(subtitlePath, targetPath);
      }
      return targetPath;
    };

    let burnSubtitlePath = subtitlePath;
    if (requestedBurnSubtitles && subtitleSegments.length) {
      burnSubtitlePath = path.join(paths.exports, `${baseName}.display.srt`);
      await writeSubtitleArtifact(burnSubtitlePath);
    }
    const softSubtitlePath = requestedSoftSubtitles
      ? await writeSubtitleArtifact(path.join(paths.exports, `${baseName}.srt`))
      : '';
    await mergeVideoAndAudio(sourceVideoPath, audioPath, outputPath, {
      includeDubbedAudio,
      keepBackgroundMusic: Boolean(req.body?.keepBackgroundMusic),
      originalAudioVolume: Number(req.body?.originalAudioVolume ?? 0.18),
      burnSubtitles: Boolean(req.body?.burnSubtitles && burnSubtitlePath),
      subtitlePath: burnSubtitlePath || undefined,
      embedSoftSubtitles: requestedSoftSubtitles,
      softSubtitlePath,
      softSubtitleLanguage: req.body?.softSubtitleLanguage || 'und',
      softSubtitleTitle: req.body?.softSubtitleTitle || 'DubFlow subtitles',
      subtitleStyle,
      textOverlay: req.body?.textOverlay || null,
      musicEnabled: req.body?.musicEnabled,
      musicPath: req.body?.musicPath,
      musicVolume: req.body?.musicVolume,
      musicFade: req.body?.musicFade,
      logoEnabled: req.body?.logoEnabled,
      logoPath: req.body?.logoPath,
      logoPosition: req.body?.logoPosition,
      logoX: req.body?.logoX,
      logoY: req.body?.logoY,
      logoSize: req.body?.logoSize,
      logoOpacity: req.body?.logoOpacity,
      randomLogoText: req.body?.randomLogoText,
      randomLogoPaths: req.body?.randomLogoPaths,
      randomIntervalSeconds: req.body?.randomIntervalSeconds,
      subtitleCoverEnabled: req.body?.subtitleCoverEnabled,
      backgroundColor: req.body?.backgroundColor,
      backgroundOpacity: req.body?.backgroundOpacity,
      subtitleCoverMode: req.body?.subtitleCoverMode,
      subtitleCoverBlur: req.body?.subtitleCoverBlur,
      subtitleCoverFeather: req.body?.subtitleCoverFeather,
      subtitleCoverColor: req.body?.subtitleCoverColor,
      subtitleCoverOpacity: req.body?.subtitleCoverOpacity,
      subtitleCoverX: req.body?.subtitleCoverX,
      subtitleCoverY: req.body?.subtitleCoverY,
      subtitleCoverW: req.body?.subtitleCoverW,
      subtitleCoverH: req.body?.subtitleCoverH,
      outputQuality: req.body?.outputQuality,
      outputAspectRatio,
    });

    let savedOutputPath = '';
    let savedSoftSubtitlePath = '';
    const outputDirectory = String(req.body?.outputDirectory || '').trim();
    if (outputDirectory) {
      const folderName = sanitizePathSegment(req.body?.outputFolderName || '', '');
      const finalDirectory = req.body?.outputCreateFolder === false || !folderName
        ? outputDirectory
        : path.join(outputDirectory, folderName);
      await fs.mkdir(finalDirectory, { recursive: true });
      savedOutputPath = path.join(finalDirectory, `${baseName}.${safeFormat}`);
      await fs.copyFile(outputPath, savedOutputPath);
      if (softSubtitlePath) {
        savedSoftSubtitlePath = path.join(finalDirectory, `${baseName}.srt`);
        await fs.copyFile(softSubtitlePath, savedSoftSubtitlePath);
      }
    }

    const outputStats = await getFileStats(outputPath);
    res.json({
      success: true,
      jobId,
      outputPath: savedOutputPath || outputPath,
      jobOutputPath: outputPath,
      savedOutputPath,
      outputUrl: toPublicJobUrl(jobId, outputPath),
      outputFileSizeBytes: outputStats?.size || 0,
      softSubtitlePath: savedSoftSubtitlePath || softSubtitlePath,
      softSubtitleJobPath: softSubtitlePath,
      savedSoftSubtitlePath,
      softSubtitleUrl: softSubtitlePath ? toPublicJobUrl(jobId, softSubtitlePath) : '',
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/delete-project-job', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }
    if (activeJobOperations.has(jobId)) {
      throw new Error('This job is still running. Stop the current task before deleting it.');
    }

    const paths = getJobPaths(jobId);
    const jobsRoot = path.resolve(__dirname, 'jobs');
    const downloadsRoot = path.resolve(__dirname, 'downloads');
    const jobRoot = path.resolve(paths.root);
    const downloadRoot = path.resolve(paths.downloads);
    if (!jobRoot.startsWith(`${jobsRoot}${path.sep}`)) {
      throw new Error('Unsafe job path.');
    }
    if (!downloadRoot.startsWith(`${downloadsRoot}${path.sep}`)) {
      throw new Error('Unsafe download path.');
    }

    await rmWithRetry(jobRoot, { recursive: true, force: true });
    await rmWithRetry(downloadRoot, { recursive: true, force: true });
    res.json({ success: true, jobId });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/manual/clear-artifacts', async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Missing jobId.');
    }

    const paths = getJobPaths(jobId);
    const scope = String(req.body?.scope || 'source').trim().toLowerCase();
    if (scope === 'source') {
      await resetManualArtifacts(paths, ['transcripts', 'translations', 'tts', 'exports']);
    } else if (scope === 'translation') {
      await resetManualArtifacts(paths, ['translations', 'tts', 'exports']);
    } else if (scope === 'voice') {
      await resetManualArtifacts(paths, ['tts']);
      await clearManualVideoArtifacts(paths);
    } else if (scope === 'video') {
      await clearManualVideoArtifacts(paths);
    } else {
      throw new Error(`Unsupported clear scope: ${scope}`);
    }

    res.json({ success: true, jobId, scope });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.post('/api/check-transcript', async (req, res) => {
  const videoId = extractVideoId(req.body.videoUrl);
  if (!videoId) {
    return res.status(400).json(buildError('INVALID_YOUTUBE_URL', 'The YouTube URL is invalid.', 'Invalid YouTube URL', 'Paste a full YouTube watch URL and retry.'));
  }

  const result = await validateTranscriptAvailability(videoId);
  return res.json(result);
});

function recoveredJobUrl(jobId, ...parts) {
  return `/jobs/${encodeURIComponent(jobId)}/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

function existingRecoveredFile(paths, key) {
  return paths[key] && fsNative.existsSync(paths[key]) ? paths[key] : '';
}

function pickRecoveredSegments(translatedJson, transcriptJson, status) {
  const translated = [
    translatedJson?.rawSegments,
    translatedJson?.segments,
    translatedJson?.translatedSegments,
  ].find((segments) => Array.isArray(segments) && segments.length);
  if (translated) return { segments: translated, translated: true };

  const transcript = [
    transcriptJson?.segmentedSegments,
    transcriptJson?.sourceSegments,
    transcriptJson?.rawSegments,
    status?.result?.sourceSegments,
  ].find((segments) => Array.isArray(segments) && segments.length);
  return { segments: transcript || [], translated: false };
}

function rowsWithRecoveredTtsReport(rows = [], report = null) {
  const reportItems = Array.isArray(report?.segments) ? report.segments : [];
  if (!reportItems.length) return rows;

  const byRowId = new Map();
  for (const item of reportItems) {
    const sourceIds = [
      ...(Array.isArray(item.sourceRowIds) ? item.sourceRowIds : []),
      ...(Array.isArray(item.sourceIds) ? item.sourceIds : []),
    ].map(String).filter(Boolean);
    const timingWarning = Math.abs(Number(item.startDriftSeconds) || 0) > 0.04
      || (Number(item.endOverflowSeconds) || 0) >= postSpeedMajorOverflowThreshold(item)
      || (Number(item.overlapNextSeconds) || 0) >= postSpeedMajorOverflowThreshold(item);
    for (const sourceId of sourceIds) {
      byRowId.set(sourceId, {
        status: timingWarning ? 'warn' : 'ok',
        ttsUnitId: String(item.id || ''),
        ttsUnitIndex: Number(item.index) || 0,
        startDriftSeconds: Number(item.startDriftSeconds) || 0,
        cueEndOverflowSeconds: Number(item.cueEndOverflowSeconds) || 0,
        endOverflowSeconds: Number(item.endOverflowSeconds) || 0,
        overlapNextSeconds: Number(item.overlapNextSeconds) || 0,
        speedFactor: Number(item.speedFactor) || 1,
        effectiveSpeedFactor: Number(item.effectiveSpeedFactor) || 1,
      });
    }
  }

  return rows.map((row) => ({
    ...row,
    ttsSync: byRowId.get(String(row.id)) || null,
  }));
}

async function recoverProjectFromJob(jobId) {
  const paths = getJobPaths(jobId);
  const [status, translatedJson, transcriptJson, manualTtsManifest, aimaxSrtBatchReport] = await Promise.all([
    readJson(paths.status, null),
    readJson(paths.translatedJson, null),
    readJson(paths.transcriptJson, null),
    readJson(path.join(paths.tts, 'manual_tts_manifest.json'), null),
    readJson(path.join(paths.tts, 'aimax_srt_batch_report.json'), null),
  ]);
  if (!status && !translatedJson && !transcriptJson && !fsNative.existsSync(paths.sourceVideo)) return null;

  const recoveredTranslation = translatedJson ? adaptLegacyTranslationArtifact(translatedJson) : null;
  const { segments, translated } = pickRecoveredSegments(recoveredTranslation, transcriptJson, status);
  const recoveredTtsReport = manualTtsManifest?.report || aimaxSrtBatchReport?.report || null;
  const rows = rowsWithRecoveredTtsReport(segments.map((segment, index) => {
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) || start + Math.max(0.1, Number(segment.duration) || 1);
    const sourceText = String(segment.sourceText || segment.originalText || (translated ? '' : segment.text) || '').trim();
    const translatedText = String(segment.translatedText || segment.finalText || (translated ? segment.text : '') || '').trim();
    return {
      id: String(segment.id || `job-${jobId}-${index + 1}`),
      index: index + 1,
      start,
      end,
      duration: Math.max(0.1, end - start),
      sourceText,
      translatedText,
      finalText: String(segment.finalText || translatedText || '').trim(),
      sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String) : [],
      sourceRowIds: Array.isArray(segment.sourceRowIds) ? segment.sourceRowIds.map(String) : [],
      atomIds: Array.isArray(segment.atomIds) ? segment.atomIds.map(String) : [],
      validationStatus: String(segment.validationStatus || segment.status || ''),
      status: String(segment.status || 'pending'),
    };
  }), recoveredTtsReport);

  const stat = await fs.stat(paths.root).catch(() => null);
  const updatedAt = Date.parse(status?.updatedAt || status?.createdAt || '') || Number(stat?.mtimeMs) || Date.now();
  const sourceVideoPath = existingRecoveredFile(paths, 'sourceVideo');
  const previewVideoPath = fsNative.existsSync(path.join(paths.source, 'preview_source.mp4'))
    ? path.join(paths.source, 'preview_source.mp4')
    : sourceVideoPath;
  const translatedSrtPath = existingRecoveredFile(paths, 'translatedSrt');
  const rawSrtPath = fsNative.existsSync(path.join(paths.transcripts, 'raw_source.srt'))
    ? path.join(paths.transcripts, 'raw_source.srt')
    : '';
  const sourceSegmentedSrtPath = fsNative.existsSync(path.join(paths.transcripts, 'source_segmented.srt'))
    ? path.join(paths.transcripts, 'source_segmented.srt')
    : '';
  const manualDubbedPath = fsNative.existsSync(path.join(paths.tts, 'manual_dubbed_voice.wav'))
    ? path.join(paths.tts, 'manual_dubbed_voice.wav')
    : '';
  const audioPath = existingRecoveredFile(paths, 'sourceAudio') || existingRecoveredFile(paths, 'speechAudio');
  const name = String(status?.title || status?.sourceTitle || status?.message || `Job ${jobId.slice(0, 8)}`).trim();

  const state = {
    projectId: `job-${jobId}`,
    projectName: name,
    source: {
      mode: 'local',
      videoPath: sourceVideoPath,
      videoUrl: '',
      title: name,
    },
    job: {
      jobId,
      sourceVideoUrl: sourceVideoPath ? recoveredJobUrl(jobId, 'source', 'source_video.mp4') : '',
      previewVideoUrl: previewVideoPath ? recoveredJobUrl(jobId, 'source', path.basename(previewVideoPath)) : '',
      audioUrl: audioPath ? recoveredJobUrl(jobId, path.basename(path.dirname(audioPath)), path.basename(audioPath)) : '',
      audioPath,
      durationSeconds: Number(status?.durationSeconds || status?.result?.durationSeconds || 0) || 0,
    },
    rows,
    meaningUnits: Array.isArray(manualTtsManifest?.meaningUnits) ? manualTtsManifest.meaningUnits : [],
    ttsUnits: Array.isArray(manualTtsManifest?.ttsUnits)
      ? manualTtsManifest.ttsUnits
      : (Array.isArray(recoveredTranslation?.ttsUnits) ? recoveredTranslation.ttsUnits : []),
    storyTranslation: recoveredTranslation ? {
      schemaVersion: recoveredTranslation.schemaVersion,
      storyText: recoveredTranslation.storyText || '',
      sourceCues: recoveredTranslation.sourceCues || [],
      meaningAtoms: recoveredTranslation.meaningAtoms || [],
      omissions: recoveredTranslation.omissions || [],
      validation: recoveredTranslation.validation || null,
    } : null,
    selectedRowId: rows[0]?.id || '',
    currentStage: status?.stage || 'recovered',
    outputs: {
      srtPath: translatedSrtPath,
      srtUrl: translatedSrtPath ? recoveredJobUrl(jobId, 'exports', 'translated.srt') : '',
      rawSrtPath,
      rawSrtUrl: rawSrtPath ? recoveredJobUrl(jobId, 'transcripts', 'raw_source.srt') : '',
      sourceSegmentedSrtPath,
      sourceSegmentedSrtUrl: sourceSegmentedSrtPath ? recoveredJobUrl(jobId, 'transcripts', 'source_segmented.srt') : '',
      audioPath: manualDubbedPath,
      audioUrl: manualDubbedPath ? recoveredJobUrl(jobId, 'tts', 'manual_dubbed_voice.wav') : '',
      ttsReport: recoveredTtsReport,
      aimaxSrtBatchReportPath: aimaxSrtBatchReport ? path.join(paths.tts, 'aimax_srt_batch_report.json') : '',
      aimaxSrtBatchReportUrl: aimaxSrtBatchReport ? recoveredJobUrl(jobId, 'tts', 'aimax_srt_batch_report.json') : '',
      aimaxSrtBatchReport: aimaxSrtBatchReport || null,
    },
    config: {
      translationMode: recoveredTranslation?.translationMode || undefined,
      ttsUnitMode: manualTtsManifest?.ttsUnitMode || undefined,
      ttsProvider: manualTtsManifest?.provider || undefined,
      ttsLanguageCode: manualTtsManifest?.languageCode || undefined,
      ttsVoiceName: manualTtsManifest?.voiceName || undefined,
      speakingRate: Number(manualTtsManifest?.speakingRate) || undefined,
    },
    logs: [`Đã khôi phục project từ Backend/jobs/${jobId}.`],
  };

  return {
    id: state.projectId,
    name,
    updatedAt,
    state,
  };
}

app.get('/api/manual/recover-projects', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const jobIds = await listJobIds();
    const recovered = await Promise.all(jobIds.map((jobId) => recoverProjectFromJob(jobId).catch(() => null)));
    const projects = recovered
      .filter((project) => project && (project.state.rows?.length || project.state.source?.videoPath))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    res.json({ success: true, projects });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json({ success: false, ...mapped });
  }
});

app.get('/api/job-status/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    res.json(job);
  } catch {
    res.status(404).json(buildError('JOB_NOT_FOUND', 'Job not found.', 'The requested job does not exist.', 'Start a new job and retry.'));
  }
});

async function startJobHandler(req, res) {
  try {
    const body = req.body || {};
    const sourceType = body.sourceType || (body.videoPath ? 'local' : 'youtube');
    const initialMessage = sourceType === 'local' ? 'Local file job created.' : 'YouTube job created.';
    const { jobId } = await createJob({
      message: initialMessage,
      stage: STAGES.CREATED.stage,
      percent: STAGES.CREATED.percent,
      status: 'queued',
    });

    processJob(jobId, body).catch(async (error) => {
      const mapped = classifyError(error);
      await addLog(jobId, 'error', mapped.detail);
      await updateJob(jobId, {
        status: 'failed',
        percent: 100,
        stage: 'failed',
        message: mapped.message,
        error: {
          code: mapped.code,
          message: mapped.message,
          detail: mapped.detail,
          suggestion: mapped.suggestion,
        },
      }).catch(() => {});
    });

    res.json({
      success: true,
      jobId,
      status: 'queued',
      percent: 0,
      message: initialMessage,
    });
  } catch (error) {
    const mapped = classifyError(error);
    res.status(400).json(mapped);
  }
}

app.post('/api/start', startJobHandler);
app.post('/api/dub-video', startJobHandler);

app.use((error, req, res, next) => {
  const mapped = classifyError(error);
  res.status(500).json(mapped);
});

async function startServer() {
  await failOrphanedJobsOnStartup();
  await standaloneTtsService.initialize();
  const server = app.listen(PORT, () => {
    console.log('DubFlow backend service is running.');
  });
  const configuredHttpTimeoutMs = Number(process.env.DUBFLOW_HTTP_TIMEOUT_MS);
  const longRequestTimeoutMs = Number.isFinite(configuredHttpTimeoutMs) && configuredHttpTimeoutMs > 0
    ? Math.round(configuredHttpTimeoutMs)
    : 0;
  server.requestTimeout = longRequestTimeoutMs;
  server.headersTimeout = longRequestTimeoutMs ? longRequestTimeoutMs + 60 * 1000 : 0;
  server.timeout = longRequestTimeoutMs;
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = app;



