const fs = require('fs').promises;
const fsNative = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { promisify } = require('util');

const { synthesizeSegmentAudio } = require('./googleTtsService');
const { sanitizePathSegment } = require('./outputService');

const execFileAsync = promisify(execFile);
const HISTORY_LIMIT = 20;
const TARGET_CHARS = 350;
const MAX_CHARS = 500;
const SAMPLE_RATE = 32000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'standalone-tts-history.json');
const TEMP_ROOT = path.join(os.tmpdir(), 'DubFlowStandaloneTts');
const activeOperations = new Map();

function normalizeSpaces(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function findSplitIndex(text, limit, target = TARGET_CHARS) {
  const window = text.slice(0, Math.min(limit, text.length));
  const candidates = [
    /[.!?。！？…]["'”’）)\]]*\s+/g,
    /[,;:，；：]["'”’）)\]]*\s+/g,
    /\s+/g,
  ];

  for (const pattern of candidates) {
    let best = -1;
    let match;
    while ((match = pattern.exec(window)) !== null) {
      const end = match.index + match[0].length;
      if (end <= limit && (best < 0 || Math.abs(end - target) < Math.abs(best - target))) {
        best = end;
      }
    }
    if (best > 0) return best;
  }

  return Math.min(limit, text.length);
}

function splitParagraph(paragraph, target = TARGET_CHARS, max = MAX_CHARS) {
  const chunks = [];
  let remaining = String(paragraph || '').replace(/\s+/g, ' ').trim();

  while (remaining.length > max) {
    const splitAt = findSplitIndex(remaining, max, target);
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function planSegments(text, options = {}) {
  const normalized = normalizeSpaces(text);
  if (!normalized) return [];

  const target = Math.max(100, Math.min(MAX_CHARS, Number(options.targetChars) || TARGET_CHARS));
  const max = Math.max(target, Math.min(MAX_CHARS, Number(options.maxChars) || MAX_CHARS));
  const paragraphs = normalized.split(/\n{2,}/).map((item) => item.replace(/\n+/g, ' ').trim()).filter(Boolean);
  const segments = [];

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const chunks = splitParagraph(paragraph, target, max);
    chunks.forEach((chunk, chunkIndex) => {
      segments.push({
        id: `segment-${segments.length + 1}`,
        index: segments.length,
        text: chunk,
        breakAfter: chunkIndex === chunks.length - 1 && paragraphIndex < paragraphs.length - 1
          ? 'paragraph'
          : 'sentence',
      });
    });
  });

  if (segments.length) segments[segments.length - 1].breakAfter = 'none';
  return segments;
}

function validateSegments(input = []) {
  if (!Array.isArray(input) || !input.length) {
    throw new Error('Standalone TTS requires at least one text segment.');
  }

  return input.map((segment, index) => {
    const text = String(segment?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error(`Standalone TTS segment ${index + 1} is empty.`);
    if (text.length > MAX_CHARS) {
      throw new Error(`Standalone TTS segment ${index + 1} exceeds ${MAX_CHARS} characters.`);
    }
    return {
      id: String(segment.id || `segment-${index + 1}`),
      index,
      text,
      breakAfter: ['none', 'paragraph', 'sentence'].includes(segment.breakAfter)
        ? segment.breakAfter
        : (index === input.length - 1 ? 'none' : 'sentence'),
    };
  });
}

function defaultOutputDirectory() {
  const userRoot = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(userRoot || process.cwd(), 'Videos', 'DubFlow', 'TTS');
}

function timestampFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `tts_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function uniqueOutputPath(outputDirectory, requestedName, extension) {
  const baseInput = String(requestedName || '').replace(/\.(mp3|wav)$/i, '');
  const baseName = sanitizePathSegment(baseInput, timestampFileName());
  let candidate = path.join(outputDirectory, `${baseName}.${extension}`);
  let suffix = 2;
  while (fsNative.existsSync(candidate)) {
    candidate = path.join(outputDirectory, `${baseName}_${suffix}.${extension}`);
    suffix += 1;
  }
  return candidate;
}

function providerConcurrency(config = {}) {
  const max = config.ttsProvider === 'google_cloud_tts'
      ? 3
      : config.ttsProvider === 'edge_tts'
        ? 20
        : config.ttsProvider === 'aimax_tts'
          ? 30
          : 6;
  return Math.max(1, Math.min(max, Math.round(Number(config.ttsConcurrency) || 1)));
}

async function readHistory() {
  try {
    const value = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
    return Array.isArray(value) ? value.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function writeHistory(history) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2)}\n`, 'utf8');
}

async function upsertHistory(item) {
  const history = await readHistory();
  const next = [item, ...history.filter((entry) => entry.id !== item.id)].slice(0, HISTORY_LIMIT);
  await writeHistory(next);
  return next;
}

function publicOperation(operation) {
  return {
    operationId: operation.id,
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    provider: operation.provider,
    voiceName: operation.voiceName,
    outputFormat: operation.outputFormat,
    totalSegments: operation.segments.length,
    completedSegments: operation.segments.filter((segment) => segment.status === 'completed').length,
    failedSegments: operation.segments.filter((segment) => segment.status === 'failed').length,
    segments: operation.segments.map(({ id, index, text, breakAfter, status, attempts, error }) => ({
      id,
      index,
      text,
      breakAfter,
      status,
      attempts,
      error,
    })),
    error: operation.error || '',
    result: operation.result || null,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Operation canceled.');
    error.code = 'OPERATION_CANCELED';
    throw error;
  }
}

async function createSilence(outputPath, milliseconds) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=32000:cl=mono',
    '-t', (milliseconds / 1000).toFixed(3),
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    outputPath,
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

async function normalizeClip(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    outputPath,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

function concatListValue(filePath) {
  return String(filePath).replace(/'/g, "'\\''").replace(/\\/g, '/');
}

async function concatClips(files, outputPath, outputFormat, workDir) {
  const listPath = path.join(workDir, 'concat_list.txt');
  await fs.writeFile(listPath, files.map((file) => `file '${concatListValue(file)}'`).join('\n'), 'utf8');
  const codecArgs = outputFormat === 'mp3'
    ? ['-c:a', 'libmp3lame', '-b:a', '192k']
    : ['-c:a', 'pcm_s16le'];
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    ...codecArgs,
    outputPath,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

async function audioDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return Number(Number(stdout.trim()).toFixed(3)) || 0;
  } catch {
    return 0;
  }
}

async function synthesizeWithRetry(operation, segment, config, workDir) {
  const extension = 'mp3';
  const maxAttempts = Math.max(1, Math.min(5, Number(config.ttsMaxAttempts) || 1));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(operation.controller.signal);
    segment.status = attempt === 1 ? 'running' : 'retrying';
    segment.attempts = attempt;
    segment.error = '';
    operation.updatedAt = new Date().toISOString();
    const rawPath = path.join(workDir, `raw_${String(segment.index).padStart(4, '0')}.${extension}`);
    const normalizedPath = path.join(workDir, `clip_${String(segment.index).padStart(4, '0')}.wav`);
    try {
      await synthesizeSegmentAudio(
        { id: segment.id, index: segment.index, text: segment.text },
        { ...config, abortSignal: operation.controller.signal },
        rawPath
      );
      throwIfAborted(operation.controller.signal);
      await normalizeClip(rawPath, normalizedPath);
      segment.status = 'completed';
      segment.outputPath = normalizedPath;
      operation.updatedAt = new Date().toISOString();
      return normalizedPath;
    } catch (error) {
      lastError = error;
      segment.error = error.message || String(error);
      if (operation.controller.signal.aborted) throw error;
    }
  }

  segment.status = 'failed';
  throw lastError || new Error(`TTS failed for segment ${segment.index + 1}.`);
}

async function processOperation(operation, config) {
  const workDir = path.join(TEMP_ROOT, operation.id);
  operation.status = 'running';
  operation.updatedAt = new Date().toISOString();

  try {
    await fs.mkdir(workDir, { recursive: true });
    const concurrency = providerConcurrency(config);
    let nextIndex = 0;
    let firstError = null;

    async function worker() {
      while (!firstError) {
        throwIfAborted(operation.controller.signal);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= operation.segments.length) return;
        try {
          await synthesizeWithRetry(operation, operation.segments[index], config, workDir);
        } catch (error) {
          firstError = error;
          operation.failureTriggered = true;
          operation.controller.abort();
          throw error;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, operation.segments.length) }, () => worker()));
    throwIfAborted(operation.controller.signal);

    const pauseShort = path.join(workDir, 'pause_120.wav');
    const pauseParagraph = path.join(workDir, 'pause_300.wav');
    await Promise.all([createSilence(pauseShort, 120), createSilence(pauseParagraph, 300)]);
    const concatFiles = [];
    operation.segments.forEach((segment, index) => {
      concatFiles.push(segment.outputPath);
      if (index < operation.segments.length - 1) {
        concatFiles.push(segment.breakAfter === 'paragraph' ? pauseParagraph : pauseShort);
      }
    });

    await fs.mkdir(operation.outputDirectory, { recursive: true });
    const outputPath = await uniqueOutputPath(operation.outputDirectory, operation.fileName, operation.outputFormat);
    const tempOutput = path.join(workDir, `final.${operation.outputFormat}`);
    await concatClips(concatFiles, tempOutput, operation.outputFormat, workDir);
    await fs.copyFile(tempOutput, outputPath);
    const stats = await fs.stat(outputPath);
    const durationSeconds = await audioDuration(outputPath);

    operation.status = 'completed';
    operation.updatedAt = new Date().toISOString();
    operation.result = {
      id: operation.id,
      fileName: path.basename(outputPath),
      outputPath,
      outputDirectory: path.dirname(outputPath),
      outputFormat: operation.outputFormat,
      fileSizeBytes: stats.size,
      durationSeconds,
      audioUrl: `/api/standalone-tts/files/${encodeURIComponent(operation.id)}`,
      downloadUrl: `/api/standalone-tts/files/${encodeURIComponent(operation.id)}?download=1`,
    };
    await upsertHistory({
      id: operation.id,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      status: operation.status,
      provider: operation.provider,
      voiceName: operation.voiceName,
      segmentCount: operation.segments.length,
      ...operation.result,
    });
  } catch (error) {
    const canceled = operation.userCanceled === true || (error.code === 'OPERATION_CANCELED' && operation.failureTriggered !== true);
    operation.status = canceled ? 'canceled' : 'failed';
    operation.updatedAt = new Date().toISOString();
    operation.error = canceled ? 'Operation canceled.' : (error.message || String(error));
    operation.segments.forEach((segment) => {
      if (['queued', 'running', 'retrying'].includes(segment.status)) {
        segment.status = canceled ? 'canceled' : 'failed';
        if (!segment.error) segment.error = operation.error;
      }
    });
    await upsertHistory({
      id: operation.id,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      status: operation.status,
      provider: operation.provider,
      voiceName: operation.voiceName,
      segmentCount: operation.segments.length,
      outputFormat: operation.outputFormat,
      fileName: '',
      outputPath: '',
      outputDirectory: operation.outputDirectory,
      fileSizeBytes: 0,
      durationSeconds: 0,
      error: operation.error,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startOperation(body = {}, config = {}) {
  const safeConfig = {
    ...config,
    ttsProvider: ['edge_tts', 'google_cloud_tts', 'aimax_tts'].includes(config.ttsProvider) ? config.ttsProvider : 'edge_tts',
  };
  const segments = validateSegments(body.segments).map((segment) => ({
    ...segment,
    status: 'queued',
    attempts: 0,
    error: '',
    outputPath: '',
  }));
  const outputFormat = String(body.outputFormat || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const outputDirectory = path.resolve(String(body.outputDirectory || '').trim() || defaultOutputDirectory());
  const now = new Date().toISOString();
  const operation = {
    id: randomUUID(),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    provider: safeConfig.ttsProvider,
    voiceName: safeConfig.ttsVoiceName || '',
    outputFormat,
    outputDirectory,
    fileName: String(body.fileName || '').trim() || timestampFileName(),
    segments,
    error: '',
    result: null,
    controller: new AbortController(),
    userCanceled: false,
    failureTriggered: false,
  };
  activeOperations.set(operation.id, operation);
  await upsertHistory({
    id: operation.id,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    status: operation.status,
    provider: operation.provider,
    voiceName: operation.voiceName,
    segmentCount: segments.length,
    outputFormat,
    fileName: '',
    outputPath: '',
    outputDirectory,
    fileSizeBytes: 0,
    durationSeconds: 0,
  });
  setImmediate(() => processOperation(operation, safeConfig));
  return publicOperation(operation);
}

async function getOperation(operationId) {
  const operation = activeOperations.get(String(operationId || ''));
  if (operation) return publicOperation(operation);
  const history = await readHistory();
  const item = history.find((entry) => entry.id === String(operationId || ''));
  if (!item) return null;
  return {
    operationId: item.id,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    provider: item.provider,
    voiceName: item.voiceName,
    outputFormat: item.outputFormat,
    totalSegments: item.segmentCount || 0,
    completedSegments: item.status === 'completed' ? item.segmentCount || 0 : 0,
    failedSegments: item.status === 'failed' ? item.segmentCount || 0 : 0,
    segments: [],
    error: item.error || '',
    result: item.outputPath ? {
      id: item.id,
      fileName: item.fileName,
      outputPath: item.outputPath,
      outputDirectory: item.outputDirectory,
      outputFormat: item.outputFormat,
      fileSizeBytes: item.fileSizeBytes,
      durationSeconds: item.durationSeconds,
      audioUrl: `/api/standalone-tts/files/${encodeURIComponent(item.id)}`,
      downloadUrl: `/api/standalone-tts/files/${encodeURIComponent(item.id)}?download=1`,
    } : null,
  };
}

function cancelOperation(operationId) {
  const operation = activeOperations.get(String(operationId || ''));
  if (!operation || ['completed', 'failed', 'canceled'].includes(operation.status)) {
    return { canceled: false };
  }
  operation.userCanceled = true;
  operation.controller.abort();
  operation.updatedAt = new Date().toISOString();
  return { canceled: true, operation: publicOperation(operation) };
}

async function historyWithAvailability() {
  const history = await readHistory();
  return history.map((item) => ({
    ...item,
    missing: Boolean(item.outputPath) && !fsNative.existsSync(item.outputPath),
    audioUrl: item.outputPath && fsNative.existsSync(item.outputPath)
      ? `/api/standalone-tts/files/${encodeURIComponent(item.id)}`
      : '',
    downloadUrl: item.outputPath && fsNative.existsSync(item.outputPath)
      ? `/api/standalone-tts/files/${encodeURIComponent(item.id)}?download=1`
      : '',
  }));
}

async function clearHistory() {
  await writeHistory([]);
}

async function resolveResultFile(operationId) {
  const active = activeOperations.get(String(operationId || ''));
  if (active?.result?.outputPath && fsNative.existsSync(active.result.outputPath)) {
    return active.result.outputPath;
  }
  const history = await readHistory();
  const item = history.find((entry) => entry.id === String(operationId || ''));
  return item?.outputPath && fsNative.existsSync(item.outputPath) ? item.outputPath : '';
}

async function initialize() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const history = await readHistory();
  let changed = false;
  const next = history.map((item) => {
    if (['queued', 'running'].includes(item.status)) {
      changed = true;
      return {
        ...item,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        error: 'Backend restarted before the standalone TTS task completed.',
      };
    }
    return item;
  });
  if (changed) await writeHistory(next);
}

module.exports = {
  cancelOperation,
  clearHistory,
  defaultOutputDirectory,
  getOperation,
  historyWithAvailability,
  initialize,
  planSegments,
  resolveResultFile,
  startOperation,
  _private: {
    findSplitIndex,
    normalizeSpaces,
    providerConcurrency,
    splitParagraph,
    uniqueOutputPath,
    validateSegments,
  },
};
