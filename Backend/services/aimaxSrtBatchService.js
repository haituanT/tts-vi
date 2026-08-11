const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveMediaBinary } = require('./mediaBinaryService');

const aimaxTtsService = require('./aimaxTtsService');
const { parseSrtEntries, formatSrtEntries } = require('./googleTranslateService');
const { createAlignedAudio } = require('./syncService');

const execFileAsyncRaw = promisify(execFile);
const execFileAsync = (command, ...args) => execFileAsyncRaw(resolveMediaBinary(command), ...args);
const inflateRawAsync = promisify(zlib.inflateRaw);
const DEFAULT_CUES_PER_REQUEST = 30;
const DEFAULT_BATCH_CONCURRENCY = 1;
const MAX_CUES_PER_REQUEST = 200;
const MAX_BATCH_CONCURRENCY = 3;
const OUTPUT_SAMPLE_RATE = 32000;
const BATCH_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const TIMING_TRACE_OVERFLOW_SECONDS = 0.02;
const TIMING_MAJOR_OVERFLOW_SECONDS = 1.0;
const POST_SPEED_MAJOR_OVERFLOW_SECONDS = 1.0;
const AUTO_ANTI_OVERFLOW_MAX_SPEAKING_RATE = 1.6;
const AUTO_ANTI_OVERFLOW_TARGET_GUARD_SECONDS = 0.5;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;

function roundMetric(value) {
  return Number(Number(value || 0).toFixed(3));
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function postSpeedMajorOverflowThreshold(item = {}, fallback = TIMING_MAJOR_OVERFLOW_SECONDS) {
  const postSpeed = Number(item.speedFactor) > 1.001;
  return postSpeed ? POST_SPEED_MAJOR_OVERFLOW_SECONDS : fallback;
}

function normalizeCueText(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCueSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const start = Number(segment?.start) || 0;
      const end = Number(segment?.end) || start + Math.max(0.1, Number(segment?.duration) || 1);
      const text = normalizeCueText(
        segment?.ttsText
        || segment?.finalText
        || segment?.translatedText
        || segment?.text
      );
      if (!text) return null;
      const id = String(segment?.id || `cue-${index + 1}`);
      const explicitSourceIds = [
        ...(Array.isArray(segment?.sourceRowIds) ? segment.sourceRowIds : []),
        ...(Array.isArray(segment?.sourceIds) ? segment.sourceIds : []),
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      const sourceIds = Array.from(new Set(explicitSourceIds.length ? explicitSourceIds : [id]));
      return {
        id,
        index,
        cueNumber: Number(segment?.index) || index + 1,
        start,
        end: Math.max(start + 0.05, end),
        duration: Math.max(0.05, end - start),
        text,
        sourceIds,
        sourceRowIds: sourceIds,
        sourceSegmentCount: Number(segment?.sourceSegmentCount) || sourceIds.length || 1,
      };
    })
    .filter(Boolean)
    .map((cue, position) => ({ ...cue, position }));
}

function clampInteger(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function resolveCuesPerRequest(config = {}) {
  return clampInteger(
    config.aimaxSrtCuesPerRequest ?? config.aimaxSrtBatchCueCount ?? config.aimaxSrtCueBatchSize,
    DEFAULT_CUES_PER_REQUEST,
    1,
    MAX_CUES_PER_REQUEST
  );
}

function resolveRequestCount(config = {}, cueCount = 0) {
  const requested = Number(config.aimaxSrtRequestCount ?? config.aimaxSrtBatchRequestCount);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.max(1, Math.min(Math.max(1, cueCount), Math.round(requested)));
}

function shouldUseRequestCount(config = {}) {
  return String(config.aimaxSrtBatchMode || '').trim() === 'request_count';
}

function resolveBatchConcurrency(config = {}) {
  return clampInteger(
    config.aimaxSrtBatchConcurrency,
    DEFAULT_BATCH_CONCURRENCY,
    1,
    MAX_BATCH_CONCURRENCY
  );
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function batchCacheIdentity(batch = {}, config = {}) {
  const provider = String(config.aimaxProvider || process.env.AIMAX_TTS_PROVIDER || 'minimax').trim().toLowerCase();
  const model = String(
    config.aimaxModel
    || process.env.AIMAX_TTS_MODEL
    || (provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'speech-2.8-hd')
  ).trim();
  return {
    version: 1,
    textHash: batch.textHash || hashText(batch.text || ''),
    cueCount: Number(batch.cues?.length || batch.cueCount || 0),
    provider,
    model,
    voiceId: String(config.ttsVoiceName || config.aimaxVoiceId || '').trim(),
    languageCode: String(config.ttsLanguageCode || config.targetLanguage || '').trim(),
    speakingRate: Number(Number(config.speakingRate || 1).toFixed(3)),
  };
}

function batchCacheIdentityMatches(actual = {}, expected = {}) {
  return [
    'textHash',
    'cueCount',
    'provider',
    'model',
    'voiceId',
    'languageCode',
    'speakingRate',
  ].every((key) => String(actual[key] ?? '') === String(expected[key] ?? ''));
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireBatchWorkDirLock(workDir) {
  await fs.mkdir(workDir, { recursive: true });
  const lockPath = path.join(workDir, '.aimax_srt_batch.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const [lock, stat] = await Promise.all([
        readJsonSafe(lockPath),
        fs.stat(lockPath).catch(() => null),
      ]);
      const ageMs = stat ? Date.now() - Number(stat.mtimeMs || 0) : BATCH_LOCK_STALE_MS + 1;
      const alive = processIsAlive(lock?.pid);
      if (alive) {
        throw new Error('AIMAX SRT batch is already running for this project. Wait for it to finish or cancel it before starting again.');
      }
      if (!lock?.pid && ageMs < BATCH_LOCK_STALE_MS) {
        throw new Error('AIMAX SRT batch lock is active for this project. Wait for it to finish or cancel it before starting again.');
      }
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error('AIMAX SRT batch lock could not be acquired.');
}

function buildCueBatches(cues = [], config = {}) {
  const normalized = normalizeCueSegments(cues);
  if (!normalized.length) return [];

  const requestCount = resolveRequestCount(config, normalized.length);
  const useRequestCount = shouldUseRequestCount(config) && requestCount > 0;
  const cuesPerBatch = useRequestCount
    ? Math.ceil(normalized.length / requestCount)
    : resolveCuesPerRequest(config);

  const batches = [];
  for (let start = 0; start < normalized.length; start += cuesPerBatch) {
    const batchCues = normalized.slice(start, start + cuesPerBatch);
    batches.push({
      index: batches.length,
      startCueIndex: batchCues[0].index,
      endCueIndex: batchCues[batchCues.length - 1].index,
      cues: batchCues,
      text: batchCues.map((cue) => cue.text).join('\n'),
      textHash: hashText(batchCues.map((cue) => cue.text).join('\n')),
    });
  }
  return batches;
}

function concatListValue(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function concatAudioFiles(inputPaths, outputPath, workDir, sampleRate = OUTPUT_SAMPLE_RATE) {
  if (!inputPaths.length) {
    throw new Error('No AIMAX batch audio files are available to concatenate.');
  }
  if (inputPaths.length === 1) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPaths[0],
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      ...(String(outputPath).toLowerCase().endsWith('.mp3')
        ? ['-c:a', 'libmp3lame', '-b:a', '192k']
        : ['-c:a', 'pcm_s16le']),
      outputPath,
    ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return outputPath;
  }

  const listPath = path.join(workDir, 'aimax_srt_concat_list.txt');
  await fs.writeFile(
    listPath,
    inputPaths.map((filePath) => `file '${concatListValue(filePath)}'`).join('\n'),
    'utf8'
  );
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRate),
    ...(String(outputPath).toLowerCase().endsWith('.mp3')
      ? ['-c:a', 'libmp3lame', '-b:a', '192k']
      : ['-c:a', 'pcm_s16le']),
    outputPath,
  ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return outputPath;
}

async function audioDurationSeconds(filePath) {
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

async function extractCueClip(inputPath, outputPath, startSeconds, durationSeconds, sampleRate = OUTPUT_SAMPLE_RATE) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', Math.max(0, Number(startSeconds) || 0).toFixed(3),
    '-i', inputPath,
    '-t', Math.max(0.05, Number(durationSeconds) || 0.05).toFixed(3),
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    outputPath,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return outputPath;
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('AIMAX segments ZIP is invalid: missing end of central directory.');
}

function safeZipEntryRelativePath(entryName = '') {
  const normalized = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part.includes(':'))) return '';
  return path.join(...parts);
}

async function extractZipToDirectory(zipPath, outputDir) {
  const root = path.resolve(outputDir);
  const buffer = await fs.readFile(zipPath);
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const extracted = [];
  let cursor = centralDirectoryOffset;

  await fs.mkdir(root, { recursive: true });

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new Error('AIMAX segments ZIP is invalid: bad central directory entry.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    cursor += 46 + fileNameLength + extraLength + commentLength;

    const relativePath = safeZipEntryRelativePath(name);
    if (!relativePath) continue;
    if (flags & 0x01) {
      throw new Error(`AIMAX segments ZIP entry is encrypted: ${name}`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('AIMAX segments ZIP64 archives are not supported.');
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
      throw new Error(`AIMAX segments ZIP is invalid: bad local header for ${name}`);
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = await inflateRawAsync(compressed);
    } else {
      throw new Error(`AIMAX segments ZIP uses unsupported compression method ${method}: ${name}`);
    }

    const targetPath = path.resolve(root, relativePath);
    if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content);
    extracted.push({ name, path: targetPath, size: content.length });
  }

  return extracted;
}

async function collectFilesRecursive(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function findAimaxSegmentFiles(rootDir, expectedCount = 0, options = {}) {
  const files = await collectFilesRecursive(rootDir);
  const numbered = files
    .map((filePath) => {
      const match = path.basename(filePath).match(/^line_(\d+)\.(mp3|wav|m4a)$/i);
      return match ? {
        lineNumber: Number(match[1]),
        entryIndex: Number(match[1]) - 1,
        fileName: path.basename(filePath),
        audioPath: filePath,
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.lineNumber - right.lineNumber);

  const batchLabel = `batch ${Number(options.batchIndex || 0) + 1}`;
  if (expectedCount > 0 && numbered.length !== expectedCount) {
    throw new Error(`AIMAX segments ZIP cue count mismatch for ${batchLabel}: expected ${expectedCount} line audio file(s), got ${numbered.length}.`);
  }

  const seen = new Set();
  for (const file of numbered) {
    if (seen.has(file.lineNumber)) {
      throw new Error(`AIMAX segments ZIP has duplicate ${file.fileName} in ${batchLabel}.`);
    }
    seen.add(file.lineNumber);
  }

  const max = expectedCount || numbered.length;
  for (let index = 1; index <= max; index += 1) {
    if (!seen.has(index)) {
      throw new Error(`AIMAX segments ZIP is missing line_${String(index).padStart(3, '0')} audio in ${batchLabel}.`);
    }
  }

  return numbered;
}

async function extractAimaxSegmentsZip(zipPath, outputDir, options = {}) {
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(outputDir, { recursive: true });
  await extractZipToDirectory(zipPath, outputDir);
  return findAimaxSegmentFiles(outputDir, Number(options.expectedCount) || 0, options);
}

async function attachSegmentDurations(files = []) {
  return Promise.all(files.map(async (file) => ({
    ...file,
    durationSeconds: await audioDurationSeconds(file.audioPath),
  })));
}

function segmentDurationSum(files = []) {
  return roundMetric(files.reduce((sum, file) => sum + (Number(file.durationSeconds) || 0), 0));
}

async function legacyBatchSrtMatches(srtPath, batch = {}) {
  try {
    const content = await fs.readFile(srtPath, 'utf8');
    const entries = parseSrtEntries(content);
    if (entries.length !== batch.cues.length) return false;
    return entries.every((entry, index) => (
      normalizeCueText(entry.text).toLowerCase() === normalizeCueText(batch.cues[index]?.text).toLowerCase()
    ));
  } catch {
    return false;
  }
}

async function loadReusableBatchSegments(batch, paths = {}, config = {}) {
  const expected = batchCacheIdentity(batch, config);
  const meta = await readJsonSafe(paths.metaPath);
  if (meta && !batchCacheIdentityMatches(meta, expected)) {
    return null;
  }
  if (!meta && !(await legacyBatchSrtMatches(paths.srtPath, batch))) {
    return null;
  }

  let segmentFiles = [];
  try {
    if (await fileExists(paths.segmentsDir)) {
      segmentFiles = await findAimaxSegmentFiles(paths.segmentsDir, batch.cues.length, {
        batchIndex: batch.index,
      });
    }
  } catch {
    segmentFiles = [];
  }

  if (!segmentFiles.length && await fileExists(paths.segmentsZipPath)) {
    segmentFiles = await extractAimaxSegmentsZip(paths.segmentsZipPath, paths.segmentsDir, {
      expectedCount: batch.cues.length,
      batchIndex: batch.index,
    });
  }
  if (!segmentFiles.length) return null;

  const withDurations = await attachSegmentDurations(segmentFiles);
  return {
    jobId: meta?.jobId || '',
    segmentsUrl: meta?.segmentsUrl || '',
    segmentsZipPath: paths.segmentsZipPath,
    segmentsDir: paths.segmentsDir,
    segmentFiles: withDurations,
    durationSeconds: segmentDurationSum(withDurations),
    outputMode: meta ? 'segments_url_cached' : 'segments_url_legacy_cached',
  };
}

function resumableBatchJobId(meta = {}, batch = {}, config = {}) {
  if (!meta?.jobId) return '';
  return batchCacheIdentityMatches(meta, batchCacheIdentity(batch, config))
    ? String(meta.jobId || '').trim()
    : '';
}

async function writeBatchSegmentsMeta(metaPath, batch = {}, config = {}, created = {}, extra = {}) {
  const meta = {
    ...batchCacheIdentity(batch, config),
    jobId: created.jobId || '',
    segmentsUrl: created.segmentsUrl || '',
    segmentsZipPath: created.segmentsZipPath || '',
    status: extra.status || 'completed',
    createdAt: extra.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function buildAimaxTimelineReport(segments = [], options = {}) {
  const traceEndToleranceSeconds = TIMING_TRACE_OVERFLOW_SECONDS;
  const defaultMajorEndToleranceSeconds = Number(options.majorEndToleranceSeconds) || TIMING_MAJOR_OVERFLOW_SECONDS;
  const totalSegments = segments.length;
  const overflowSegmentCount = segments.filter((item) => (Number(item.endOverflowSeconds) || 0) > traceEndToleranceSeconds).length;
  const overlapSegmentCount = segments.filter((item) => (Number(item.overlapNextSeconds) || 0) > traceEndToleranceSeconds).length;
  const majorOverflowSegmentCount = segments.filter((item) => (
    (Number(item.endOverflowSeconds) || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const majorOverlapSegmentCount = segments.filter((item) => (
    (Number(item.overlapNextSeconds) || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const minorOverflowSegmentCount = Math.max(0, overflowSegmentCount - majorOverflowSegmentCount);
  const minorOverlapSegmentCount = Math.max(0, overlapSegmentCount - majorOverlapSegmentCount);
  const failedSegmentCount = segments.filter((item) => (
    item.ttsError === true
    || item.status === 'error'
    || Math.abs(Number(item.unplannedStartDriftSeconds ?? item.startDriftSeconds) || 0) > 0.04
    || (Number(item.endOverflowSeconds) || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
    || (Number(item.overlapNextSeconds) || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const maxEndOverflowSeconds = totalSegments
    ? Math.max(...segments.map((item) => Number(item.endOverflowSeconds) || 0))
    : 0;
  const avgDurationDeltaSeconds = totalSegments
    ? segments.reduce((sum, item) => sum + Math.abs(Number(item.durationDeltaSeconds) || 0), 0) / totalSegments
    : 0;

  return {
    quality: failedSegmentCount ? 'warning' : 'good',
    placementMode: 'absolute_timeline',
    provider: 'aimax_tts',
    mode: 'aimax_srt_batches',
    totalSegments,
    avgStartDriftSeconds: 0,
    maxStartDriftSeconds: 0,
    maxActualStartDriftSeconds: 0,
    centeredClipCount: 0,
    avgVoiceAlignShiftSeconds: 0,
    maxVoiceAlignShiftSeconds: 0,
    avgDurationDeltaSeconds: roundMetric(avgDurationDeltaSeconds),
    within150msPercent: totalSegments ? 100 : 0,
    within40msPercent: totalSegments ? 100 : 0,
    overflowSegmentCount,
    overlapSegmentCount,
    minorOverflowSegmentCount,
    minorOverlapSegmentCount,
    majorOverflowSegmentCount,
    majorOverlapSegmentCount,
    failedSegmentCount,
    maxEndOverflowSeconds: roundMetric(maxEndOverflowSeconds),
    strictPass: failedSegmentCount === 0,
    timelineDurationSeconds: roundMetric(options.timelineDurationSeconds || 0),
    message: failedSegmentCount
      ? 'AIMAX SRT batch was mapped to the original timeline, but one or more cues overflow their source slot.'
      : 'AIMAX SRT batch was mapped to the original subtitle timeline.',
    segments,
  };
}

function reportSegmentsFromMappedItems(mappedItems = [], options = {}) {
  const speakingRate = Number(options.speakingRate) || 1;
  return mappedItems.map((item, position) => {
    const cue = item.cue || {};
    const nextCue = mappedItems[position + 1]?.cue || null;
    const sourceIds = Array.isArray(cue.sourceIds) && cue.sourceIds.length
      ? cue.sourceIds
      : [cue.id].filter(Boolean);
    const sourceRowIds = Array.isArray(cue.sourceRowIds) && cue.sourceRowIds.length
      ? cue.sourceRowIds
      : sourceIds;
    const expectedStart = Math.max(0, Number(cue.start) || 0);
    const expectedEnd = Math.max(expectedStart + 0.05, Number(cue.end) || expectedStart + (Number(cue.duration) || 0.05));
    const actualDuration = Math.max(0.05, Number(item.audioDurationSeconds) || 0.05);
    const actualEnd = expectedStart + actualDuration;
    const slotSeconds = Math.max(0.05, expectedEnd - expectedStart);
    const cueEndOverflowSeconds = Math.max(0, actualEnd - expectedEnd);
    const nextStart = nextCue ? Math.max(0, Number(nextCue.start) || 0) : null;
    const overlapNextSeconds = nextStart === null ? 0 : Math.max(0, actualEnd - nextStart);

    return {
      id: cue.id || `cue-${position + 1}`,
      sourceIds,
      sourceRowIds,
      sourceSegmentCount: Number(cue.sourceSegmentCount) || sourceIds.length || 1,
      index: Number.isFinite(Number(cue.position)) ? Number(cue.position) : position,
      expectedStartSeconds: roundMetric(expectedStart),
      expectedEndSeconds: roundMetric(expectedEnd),
      actualStartSeconds: roundMetric(expectedStart),
      actualEndSeconds: roundMetric(actualEnd),
      startDriftSeconds: 0,
      unplannedStartDriftSeconds: 0,
      voiceAlignApplied: false,
      voiceAlignMode: 'start',
      voiceAlignSlackSeconds: 0,
      voiceAlignShiftSeconds: 0,
      expectedDurationSeconds: roundMetric(slotSeconds),
      availableSlotDurationSeconds: roundMetric(slotSeconds),
      targetDurationSeconds: roundMetric(slotSeconds),
      actualDurationSeconds: roundMetric(actualDuration),
      durationDeltaSeconds: roundMetric(actualDuration - slotSeconds),
      speedFactor: 1,
      effectiveSpeedFactor: roundMetric(speakingRate),
      maxEffectiveSpeedFactor: roundMetric(speakingRate),
      overflowAfterFitSeconds: roundMetric(cueEndOverflowSeconds),
      cueEndOverflowSeconds: roundMetric(cueEndOverflowSeconds),
      endOverflowSeconds: roundMetric(cueEndOverflowSeconds),
      overlapNextSeconds: roundMetric(overlapNextSeconds),
      aimaxBatchIndex: item.batchIndex,
      aimaxEntryIndex: item.entryIndex,
      aimaxSourceMode: item.sourceMode || 'srt_split_fallback',
      aimaxSegmentFileName: item.segmentFileName || '',
    };
  });
}

function mapSyncReportToCueOverflow(report = {}, options = {}) {
  const segments = Array.isArray(report.segments)
    ? report.segments.map((item) => {
      const cueEndOverflowSeconds = Number(item.cueEndOverflowSeconds) || 0;
      return {
        ...item,
        endOverflowSeconds: roundMetric(Math.max(Number(item.endOverflowSeconds) || 0, cueEndOverflowSeconds)),
      };
    })
    : [];
  return buildAimaxTimelineReport(segments, {
    timelineDurationSeconds: options.timelineDurationSeconds ?? report.timelineDurationSeconds,
    majorEndToleranceSeconds: options.majorEndToleranceSeconds,
  });
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
    : TIMING_TRACE_OVERFLOW_SECONDS;
  const overflowSeconds = timelineOverflowSeconds(reportItem);
  if (overflowSeconds <= triggerOverflowSeconds) return 1;

  const actualDuration = reportItemActualDurationSeconds(reportItem);
  if (!actualDuration) return 1;

  const parsedTargetOverflowSeconds = Number(options.targetOverflowSeconds);
  const targetOverflowSeconds = Math.max(
    0,
    (Number.isFinite(parsedTargetOverflowSeconds) ? parsedTargetOverflowSeconds : TIMING_TRACE_OVERFLOW_SECONDS)
      - AUTO_ANTI_OVERFLOW_TARGET_GUARD_SECONDS
  );
  const targetDuration = Math.max(0.08, actualDuration - Math.max(0, overflowSeconds - targetOverflowSeconds));
  const requiredFactor = actualDuration / targetDuration;
  const baseSpeakingRate = clampNumber(options.baseSpeakingRate, 0.5, 2.0);
  const maxSpeakingRate = autoAntiOverflowMaxSpeakingRate(baseSpeakingRate);
  const maxFactor = Math.max(1, maxSpeakingRate / Math.max(0.1, baseSpeakingRate));
  return Number(Math.min(maxFactor, Math.max(1.02, requiredFactor)).toFixed(3));
}

function overflowCueIds(report = {}, thresholdSeconds = TIMING_TRACE_OVERFLOW_SECONDS) {
  const threshold = Math.max(0, Number(thresholdSeconds) || 0);
  return new Set((Array.isArray(report?.segments) ? report.segments : [])
    .filter((segment) => timelineOverflowSeconds(segment) > threshold)
    .map((segment) => reportSegmentKey(segment))
    .filter(Boolean));
}

function reportSegmentKey(segment = {}) {
  return String(segment.id || segment.sourceRowIds?.[0] || segment.sourceIds?.[0] || '').trim();
}

function mergeAimaxReportSegmentMetadata(report = {}, metadataReport = {}) {
  const metadataById = new Map((Array.isArray(metadataReport?.segments) ? metadataReport.segments : [])
    .map((segment) => [reportSegmentKey(segment), segment])
    .filter(([id]) => id));

  if (!metadataById.size || !Array.isArray(report?.segments)) return report;

  return {
    ...report,
    segments: report.segments.map((segment) => {
      const metadata = metadataById.get(reportSegmentKey(segment));
      if (!metadata) return segment;
      return {
        ...segment,
        aimaxBatchIndex: segment.aimaxBatchIndex ?? metadata.aimaxBatchIndex,
        aimaxEntryIndex: segment.aimaxEntryIndex ?? metadata.aimaxEntryIndex,
        aimaxSourceMode: segment.aimaxSourceMode || metadata.aimaxSourceMode,
        aimaxSegmentFileName: segment.aimaxSegmentFileName || metadata.aimaxSegmentFileName || '',
      };
    }),
  };
}

function mergeBatchSrtEntries(batchResults = [], options = {}) {
  const enforceCueCount = options.enforceCueCount !== false;
  const merged = [];
  const mappedItems = [];
  const batches = [...batchResults].sort((a, b) => a.index - b.index);

  for (const batch of batches) {
    const entries = Array.isArray(batch.entries)
      ? batch.entries
      : parseSrtEntries(String(batch.srtContent || ''));
    const cues = Array.isArray(batch.cues) ? batch.cues : [];
    const expectedCueCount = Number(batch.cueCount ?? batch.cues?.length ?? 0);
    const segmentFiles = Array.isArray(batch.segmentFiles)
      ? [...batch.segmentFiles].sort((left, right) => Number(left.entryIndex) - Number(right.entryIndex))
      : [];
    if (segmentFiles.length) {
      if (enforceCueCount && expectedCueCount > 0 && segmentFiles.length !== expectedCueCount) {
        throw new Error(`AIMAX segments cue count mismatch for batch ${batch.index + 1}: expected ${expectedCueCount}, got ${segmentFiles.length}.`);
      }

      for (let entryIndex = 0; entryIndex < segmentFiles.length; entryIndex += 1) {
        const cue = cues[entryIndex] || {};
        const segmentFile = segmentFiles[entryIndex];
        const start = Math.max(0, Number(cue.start) || 0);
        const end = Math.max(start + 0.05, Number(cue.end) || start + (Number(cue.duration) || 0.05));
        const audioDurationSeconds = Math.max(0.05, Number(segmentFile.durationSeconds) || Number(segmentFile.duration) || 0.05);
        merged.push({
          index: merged.length + 1,
          start,
          end,
          text: normalizeCueText(cue.text),
        });
        mappedItems.push({
          cue,
          batchIndex: batch.index,
          entryIndex,
          cueClipPath: segmentFile.audioPath,
          entryStart: 0,
          entryEnd: audioDurationSeconds,
          audioDurationSeconds,
          text: normalizeCueText(cue.text),
          sourceMode: batch.outputMode || 'segments_url',
          segmentFileName: segmentFile.fileName || path.basename(segmentFile.audioPath || ''),
        });
      }
      continue;
    }

    if (enforceCueCount && expectedCueCount > 0 && entries.length !== expectedCueCount) {
      throw new Error(`AIMAX SRT cue count mismatch for batch ${batch.index + 1}: expected ${expectedCueCount}, got ${entries.length}.`);
    }

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      const cue = cues[entryIndex] || {};
      const start = Math.max(0, Number(cue.start) || 0);
      const end = Math.max(start + 0.05, Number(cue.end) || start + (Number(cue.duration) || 0.05));
      const entryStart = Math.max(0, Number(entry.start) || 0);
      const entryEnd = Math.max(entryStart + 0.05, Number(entry.end) || entryStart + 0.05);
      const audioDurationSeconds = Math.max(0.05, entryEnd - entryStart);
      merged.push({
        index: merged.length + 1,
        start,
        end,
        text: normalizeCueText(entry.text),
      });
      mappedItems.push({
        cue,
        batchIndex: batch.index,
        entryIndex,
        batchAudioPath: batch.audioPath,
        entryStart,
        entryEnd,
        audioDurationSeconds,
        text: normalizeCueText(entry.text),
        sourceMode: 'srt_split_fallback',
      });
    }
  }

  const srtDurationSeconds = Math.max(0, ...merged.map((entry) => Number(entry.end) || 0));
  const timelineDurationSeconds = Math.max(
    srtDurationSeconds,
    0,
    ...mappedItems.map((item) => Math.max(Number(item.cue?.end) || 0, (Number(item.cue?.start) || 0) + (Number(item.audioDurationSeconds) || 0)))
  );
  const reportSegments = reportSegmentsFromMappedItems(mappedItems, options);
  return {
    entries: merged,
    srtContent: formatSrtEntries(merged),
    durationSeconds: roundMetric(timelineDurationSeconds),
    srtDurationSeconds: roundMetric(srtDurationSeconds),
    timelineDurationSeconds: roundMetric(timelineDurationSeconds),
    mappedItems,
    report: buildAimaxTimelineReport(reportSegments, { timelineDurationSeconds }),
  };
}

async function synthesizeTranslatedSrtBatches(segments, config = {}, options = {}) {
  const cues = normalizeCueSegments(segments);
  if (!cues.length) {
    throw new Error('AIMAX SRT batch TTS requires at least one translated cue.');
  }
  const displayCues = normalizeCueSegments(options.displaySegments || segments);
  const batches = buildCueBatches(cues, config);
  if (!batches.length) {
    throw new Error('AIMAX SRT batch TTS could not build cue batches.');
  }

  const workDir = options.workDir || path.join(path.dirname(options.outputAudioPath), 'aimax_srt_batches');
  const outputAudioPath = options.outputAudioPath;
  const outputSrtPath = options.outputSrtPath;
  if (!outputAudioPath || !outputSrtPath) {
    throw new Error('AIMAX SRT batch TTS requires outputAudioPath and outputSrtPath.');
  }

  await fs.mkdir(workDir, { recursive: true });
  const releaseBatchLock = await acquireBatchWorkDirLock(workDir);

  try {
  const results = new Array(batches.length);
  const concurrency = resolveBatchConcurrency(config);
  let cursor = 0;

  async function emitProgress(payload) {
    if (typeof options.onProgress !== 'function') return;
    await options.onProgress(payload).catch(() => {});
  }

  const synthesizeTextWithSrt = typeof options.synthesizeTextWithSrt === 'function'
    ? options.synthesizeTextWithSrt
    : aimaxTtsService.synthesizeTextWithSrt;

  async function worker() {
    while (cursor < batches.length) {
      if (config.abortSignal?.aborted) {
        throw new Error('Operation canceled.');
      }
      const batch = batches[cursor];
      cursor += 1;
      const stem = `batch_${String(batch.index + 1).padStart(3, '0')}`;
      const audioPath = path.join(workDir, `${stem}.mp3`);
      const srtPath = path.join(workDir, `${stem}.srt`);
      const segmentsZipPath = path.join(workDir, `${stem}_segments.zip`);
      const segmentsDir = path.join(workDir, `${stem}_segments`);
      const metaPath = path.join(workDir, `${stem}_segments.meta.json`);
      const reusable = await loadReusableBatchSegments(batch, {
        srtPath,
        segmentsZipPath,
        segmentsDir,
        metaPath,
      }, config);
      if (reusable) {
        if (reusable.outputMode === 'segments_url_legacy_cached') {
          await writeBatchSegmentsMeta(metaPath, batch, config, {
            jobId: reusable.jobId,
            segmentsUrl: reusable.segmentsUrl,
            segmentsZipPath: reusable.segmentsZipPath,
          }).catch(() => {});
        }
        results[batch.index] = {
          ...batch,
          jobId: reusable.jobId,
          audioPath,
          srtPath,
          segmentsUrl: reusable.segmentsUrl,
          segmentsZipPath: reusable.segmentsZipPath,
          segmentsDir: reusable.segmentsDir,
          segmentFiles: reusable.segmentFiles,
          outputMode: reusable.outputMode,
          srtContent: '',
          entries: [],
          durationSeconds: reusable.durationSeconds,
          cueCount: batch.cues.length,
        };
        await emitProgress({
          status: 'reused',
          batchIndex: batch.index,
          batchCount: batches.length,
          cueCount: batch.cues.length,
          durationSeconds: reusable.durationSeconds,
        });
        continue;
      }
      const existingMeta = await readJsonSafe(metaPath);
      const existingJobId = resumableBatchJobId(existingMeta, batch, config);
      await emitProgress({
        status: existingJobId ? 'resuming' : 'running',
        batchIndex: batch.index,
        batchCount: batches.length,
        cueCount: batch.cues.length,
      });
      let created;
      try {
        created = await synthesizeTextWithSrt(
          batch.text,
          {
            ...config,
            aimaxGenerateSrt: true,
          },
          audioPath,
          srtPath,
          {
            splitByLine: true,
            speakingRate: config.speakingRate,
            preferSegments: true,
            requireSegments: true,
            segmentsOnly: true,
            segmentsZipPath,
            existingJobId,
            onJobCreated: async (job) => {
              await writeBatchSegmentsMeta(metaPath, batch, config, job, { status: 'pending' });
            },
          }
        );
      } catch (error) {
        if (existingJobId && /job failed/i.test(String(error?.message || ''))) {
          await fs.unlink(metaPath).catch(() => {});
        }
        throw error;
      }
      if (!created.segmentsZipPath) {
        throw new Error(`AIMAX SRT batch ${batch.index + 1} did not return cue segment audio files.`);
      }
      const extractedFiles = await extractAimaxSegmentsZip(created.segmentsZipPath, segmentsDir, {
        expectedCount: batch.cues.length,
        batchIndex: batch.index,
      });
      const segmentFiles = await attachSegmentDurations(extractedFiles);
      const durationSeconds = segmentDurationSum(segmentFiles);
      await writeBatchSegmentsMeta(metaPath, batch, config, created);
      results[batch.index] = {
        ...batch,
        jobId: created.jobId,
        audioPath,
        srtPath,
        segmentsUrl: created.segmentsUrl || '',
        segmentsZipPath: created.segmentsZipPath || '',
        segmentsDir,
        segmentFiles,
        outputMode: 'segments_url',
        srtContent: '',
        entries: [],
        durationSeconds,
        cueCount: batch.cues.length,
      };
      await emitProgress({
        status: 'completed',
        batchIndex: batch.index,
        batchCount: batches.length,
        cueCount: batch.cues.length,
        durationSeconds,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  const missing = results.findIndex((result) => !result);
  if (missing >= 0) {
    throw new Error(`AIMAX SRT batch ${missing + 1} did not complete.`);
  }

  const mergedSrt = mergeBatchSrtEntries(results, {
    speakingRate: config.speakingRate,
  });
  const displayEntries = displayCues.map((cue, index) => ({
    index: index + 1,
    start: cue.start,
    end: cue.end,
    text: cue.text,
  }));
  const displaySrtContent = formatSrtEntries(displayEntries);
  const displaySrtDurationSeconds = Math.max(0, ...displayEntries.map((entry) => Number(entry.end) || 0));
  const timelineDurationSeconds = roundMetric(Math.max(
    mergedSrt.timelineDurationSeconds,
    displaySrtDurationSeconds
  ));
  await fs.mkdir(path.dirname(outputSrtPath), { recursive: true });
  // The provider receives grouped narration cues, but exported subtitles keep
  // the original display rows and their timeline boundaries.
  await fs.writeFile(outputSrtPath, displaySrtContent, 'utf8');

  const cueClipDir = path.join(workDir, 'cue_clips');
  await fs.mkdir(cueClipDir, { recursive: true });
  const cueClips = [];
  for (let index = 0; index < mergedSrt.mappedItems.length; index += 1) {
    const item = mergedSrt.mappedItems[index];
    const clipPath = path.join(cueClipDir, `cue_${String(index + 1).padStart(5, '0')}.wav`);
    const sourceClipPath = item.cueClipPath || clipPath;
    if (!item.cueClipPath) {
      await extractCueClip(
        item.batchAudioPath,
        clipPath,
        item.entryStart,
        item.audioDurationSeconds,
        OUTPUT_SAMPLE_RATE
      );
    }
    cueClips.push({
      id: item.cue?.id || `cue-${index + 1}`,
      index: Number.isFinite(Number(item.cue?.position)) ? Number(item.cue.position) : index,
      path: sourceClipPath,
      provider: 'aimax_tts',
      speakingRate: Number(config.speakingRate) || 1,
      ttsSpeakingRate: Number(config.speakingRate) || 1,
      ttsSpeedAppliedByProvider: true,
      allowPostTtsSpeedProcessing: false,
      aimaxBatchIndex: item.batchIndex,
      aimaxEntryIndex: item.entryIndex,
      aimaxSourceMode: item.sourceMode || 'srt_split_fallback',
      aimaxSegmentFileName: item.segmentFileName || '',
    });
  }

  let aligned = await createAlignedAudio(cues, cueClips, outputAudioPath, {
    ...config,
    ttsProvider: 'aimax_tts',
    preserveTtsAudio: true,
    // Group audio is placed as a continuous narration track.  Subtitle rows
    // remain on their original timeline, but inter-group silence is capped.
    syncMode: 'natural',
    addSilenceGaps: false,
    maxVoiceGapSeconds: Number(config.maxVoiceGapSeconds ?? 0.12) || 0.12,
    voiceAlignShortClips: false,
    speedUpLongSegments: false,
    stretchShortClips: false,
    failOnStrictSync: false,
    normalizeLoudness: config.normalizeLoudness,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    timelineDurationSeconds,
  });
  const syncReport = mapSyncReportToCueOverflow(mergeAimaxReportSegmentMetadata(aligned.report || mergedSrt.report, mergedSrt.report), {
    timelineDurationSeconds,
  });
  const antiOverflowEnabled = config.ttsFitEnabled !== false;
  const baseSpeakingRate = Number(config.speakingRate) || 1;
  // Recalculate every cue with measured overflow. The 0.02s trace tolerance
  // filters measurement noise; one-second overflow is only a severity label.
  const cueIdsToSpeedUp = antiOverflowEnabled
    ? overflowCueIds(syncReport, TIMING_TRACE_OVERFLOW_SECONDS)
    : new Set();
  let finalSyncReport = syncReport;
  let antiOverflow = {
    enabled: antiOverflowEnabled,
    baseSpeakingRate,
    targetSpeakingRate: baseSpeakingRate,
    rateMode: 'auto_per_cue',
    triggerOverflowSeconds: TIMING_TRACE_OVERFLOW_SECONDS,
    targetOverflowSeconds: TIMING_TRACE_OVERFLOW_SECONDS,
    triggeredCueCount: 0,
    stillOverflowCount: 0,
    stillMajorOverflowCount: 0,
  };

  // AIMAX has already supplied one audio file per narration group.  When a
  // group spills past its combined timeline span, reuse that exact file and
  // apply atempo during a second assembly; never make a new provider request.
  if (cueIdsToSpeedUp.size) {
    const firstReportById = new Map((syncReport.segments || [])
      .map((segment) => [reportSegmentKey(segment), segment])
      .filter(([id]) => id));
    const speedById = new Map();
    for (const id of cueIdsToSpeedUp) {
      const speedFactor = antiOverflowSpeedFactorForReportItem(firstReportById.get(id), {
        baseSpeakingRate,
        triggerOverflowSeconds: TIMING_TRACE_OVERFLOW_SECONDS,
        targetOverflowSeconds: TIMING_TRACE_OVERFLOW_SECONDS,
      });
      if (speedFactor > 1.001) speedById.set(id, speedFactor);
    }
    const speedFactors = [...speedById.values()];
    const maxSpeedFactor = speedFactors.length ? Math.max(...speedFactors) : 1;
    const minSpeedFactor = speedFactors.length ? Math.min(...speedFactors) : 1;
    const antiOverflowRate = Number((baseSpeakingRate * maxSpeedFactor).toFixed(3));
    const acceleratedCueClips = cueClips.map((clip) => {
      const id = String(clip.id || '').trim();
      const speedFactor = speedById.get(id);
      if (!speedFactor) return clip;
      return {
        ...clip,
        // The provider flag normally prevents atempo for AIMAX.  This is a
        // deliberate post-TTS timeline repair of its cached local audio.
        allowPostTtsSpeedProcessing: true,
        forcePostTtsSpeedProcessing: true,
        postTtsSpeedFactor: speedFactor,
        antiOverflowTargetSpeakingRate: Number((baseSpeakingRate * speedFactor).toFixed(3)),
        antiOverflowTriggerSeconds: TIMING_TRACE_OVERFLOW_SECONDS,
        antiOverflowBeforeSpeedUp: timelineOverflowSeconds(firstReportById.get(id)),
      };
    });
    if (speedFactors.length) {
      aligned = await createAlignedAudio(cues, acceleratedCueClips, outputAudioPath, {
        ...config,
        ttsProvider: 'aimax_tts',
        preserveTtsAudio: false,
        syncMode: 'natural',
        addSilenceGaps: false,
        maxVoiceGapSeconds: Number(config.maxVoiceGapSeconds ?? 0.12) || 0.12,
        voiceAlignShortClips: false,
        speedUpLongSegments: true,
        stretchShortClips: false,
        failOnStrictSync: false,
        normalizeLoudness: config.normalizeLoudness,
        outputSampleRate: OUTPUT_SAMPLE_RATE,
        timelineDurationSeconds,
        maxEffectiveSpeakingRate: antiOverflowRate,
        majorEndToleranceSeconds: POST_SPEED_MAJOR_OVERFLOW_SECONDS,
      });
      finalSyncReport = mapSyncReportToCueOverflow(mergeAimaxReportSegmentMetadata(aligned.report || mergedSrt.report, mergedSrt.report), {
        timelineDurationSeconds,
        majorEndToleranceSeconds: POST_SPEED_MAJOR_OVERFLOW_SECONDS,
      });
      antiOverflow = {
        ...antiOverflow,
        applied: true,
        speedFactor: Number(maxSpeedFactor.toFixed(3)),
        minSpeedFactor: Number(minSpeedFactor.toFixed(3)),
        maxSpeedFactor: Number(maxSpeedFactor.toFixed(3)),
        targetSpeakingRate: antiOverflowRate,
        minTargetSpeakingRate: Number((baseSpeakingRate * minSpeedFactor).toFixed(3)),
        maxTargetSpeakingRate: antiOverflowRate,
        triggeredCueCount: speedFactors.length,
        stillOverflowCount: overflowCueIds(finalSyncReport, TIMING_TRACE_OVERFLOW_SECONDS).size,
        stillMajorOverflowCount: overflowCueIds(finalSyncReport, POST_SPEED_MAJOR_OVERFLOW_SECONDS - 0.000001).size,
        postSpeedMajorOverflowSeconds: POST_SPEED_MAJOR_OVERFLOW_SECONDS,
      };
    }
  }
  const finalDurationSeconds = await audioDurationSeconds(outputAudioPath);

  return {
    success: true,
    mode: 'aimax_srt_batches',
    cueCount: cues.length,
    displayCueCount: displayCues.length,
    ttsGroupCount: cues.length,
    batchCount: batches.length,
    cuesPerRequest: resolveCuesPerRequest(config),
    requestCount: batches.length,
    batchConcurrency: concurrency,
    outputAudioPath,
    outputSrtPath,
    durationSeconds: finalDurationSeconds || timelineDurationSeconds,
    srtDurationSeconds: roundMetric(displaySrtDurationSeconds),
    ttsSrtDurationSeconds: mergedSrt.srtDurationSeconds,
    timelineDurationSeconds,
    report: finalSyncReport,
    overflowSegmentCount: finalSyncReport.overflowSegmentCount,
    overlapSegmentCount: finalSyncReport.overlapSegmentCount,
    failedSegmentCount: finalSyncReport.failedSegmentCount,
    strictPass: finalSyncReport.strictPass,
    antiOverflow,
    batches: results.map((result) => ({
      index: result.index,
      jobId: result.jobId,
      cueCount: result.cues.length,
      startCueIndex: result.startCueIndex,
      endCueIndex: result.endCueIndex,
      audioPath: result.audioPath,
      srtPath: result.srtPath,
      segmentsUrl: result.segmentsUrl,
      segmentsZipPath: result.segmentsZipPath,
      segmentsDir: result.segmentsDir,
      outputMode: result.outputMode,
      segmentFileCount: result.segmentFiles.length,
      durationSeconds: result.durationSeconds,
      returnedSrtCueCount: result.entries.length,
    })),
  };
  } finally {
    await releaseBatchLock();
  }
}

module.exports = {
  buildCueBatches,
  mergeBatchSrtEntries,
  normalizeCueSegments,
  synthesizeTranslatedSrtBatches,
  _private: {
    acquireBatchWorkDirLock,
    audioDurationSeconds,
    batchCacheIdentity,
    batchCacheIdentityMatches,
    buildAimaxTimelineReport,
    concatAudioFiles,
    extractAimaxSegmentsZip,
    findAimaxSegmentFiles,
    hashText,
    loadReusableBatchSegments,
    mergeAimaxReportSegmentMetadata,
    normalizeCueText,
    reportSegmentKey,
    resumableBatchJobId,
    resolveBatchConcurrency,
    resolveCuesPerRequest,
    resolveRequestCount,
    overflowCueIds,
    antiOverflowSpeedFactorForReportItem,
    postSpeedMajorOverflowThreshold,
  },
};
