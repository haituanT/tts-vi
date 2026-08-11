const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const jobsRoot = path.join(__dirname, '..', 'jobs');
const downloadsRoot = path.join(__dirname, '..', 'downloads');
const jobFolders = ['source', 'audio', 'transcripts', 'translations', 'tts', 'exports'];
const RETRYABLE_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EEXIST']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFileError(error) {
  return RETRYABLE_FILE_ERRORS.has(error?.code);
}

async function writeTempFileWithRetry(filePath, payload) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  let lastError = null;

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const tempPath = path.join(
      directory,
      `.${basename}.${process.pid}.${Date.now()}.${uuidv4()}.tmp`
    );

    try {
      await fs.writeFile(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
      return tempPath;
    } catch (error) {
      lastError = error;
      await fs.unlink(tempPath).catch(() => {});

      if (!isRetryableFileError(error)) {
        throw error;
      }

      await sleep(Math.min(1000, 50 * attempt));
    }
  }

  throw lastError;
}

function getJobPaths(jobId) {
  const root = path.join(jobsRoot, jobId);
  const downloadRoot = path.join(downloadsRoot, jobId);

  return {
    root,
    source: path.join(root, 'source'),
    audio: path.join(root, 'audio'),
    transcripts: path.join(root, 'transcripts'),
    translations: path.join(root, 'translations'),
    tts: path.join(root, 'tts'),
    exports: path.join(root, 'exports'),
    downloads: downloadRoot,
    status: path.join(root, 'status.json'),
    sourceVideo: path.join(root, 'source', 'source_video.mp4'),
    sourceAudio: path.join(root, 'audio', 'source_audio.wav'),
    speechAudio: path.join(root, 'audio', 'speech_16000_mono.wav'),
    transcriptJson: path.join(root, 'transcripts', 'transcript.json'),
    translatedJson: path.join(root, 'translations', 'translated.json'),
    finalDubbedAudio: path.join(root, 'tts', 'final_dubbed_audio.wav'),
    dubbedVideo: path.join(root, 'exports', 'dubbed_video.mp4'),
    translatedSrt: path.join(root, 'exports', 'translated.srt'),
    translatedVtt: path.join(root, 'exports', 'translated.vtt'),
    syncReportJson: path.join(root, 'exports', 'sync_report.json'),
  };
}

async function ensureJobFolders(jobId) {
  const paths = getJobPaths(jobId);
  await fs.mkdir(paths.root, { recursive: true });
  await Promise.all(jobFolders.map((folder) => fs.mkdir(paths[folder], { recursive: true })));
  await fs.mkdir(paths.downloads, { recursive: true });
  return paths;
}

async function writeJson(filePath, data) {
  const payload = JSON.stringify(data, null, 2);
  const tempPath = await writeTempFileWithRetry(filePath, payload);
  const verifyWrittenJson = async () => {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  };

  // Windows can transiently lock files while another process reads status.json.
  // Use copy fallback with short retries instead of a single rename call.
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      try {
        await fs.copyFile(tempPath, filePath);
        if (await verifyWrittenJson()) return;
        lastError = new Error(`JSON write verification failed for ${filePath}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableFileError(error)) {
          throw error;
        }
        await sleep(Math.min(1500, 75 * attempt));
      }
    }

    // Final fallback: direct write. This is less atomic, but keeps progress
    // updates from failing a translation when Windows briefly holds the file.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await fs.writeFile(filePath, payload, 'utf8');
        if (await verifyWrittenJson()) return;
        lastError = new Error(`JSON write verification failed for ${filePath}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableFileError(error)) {
          throw error;
        }
        await sleep(Math.min(1500, 100 * attempt));
      }
    }

    throw lastError;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function createJob(initialPatch = {}) {
  const jobId = uuidv4();
  const paths = await ensureJobFolders(jobId);
  const now = new Date().toISOString();
  const status = {
    jobId,
    status: 'queued',
    percent: 0,
    stage: 'job_created',
    message: 'Job created',
    logs: [
      {
        time: now,
        level: 'info',
        message: 'Job created.',
      },
    ],
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...initialPatch,
  };

  await writeJson(paths.status, status);
  return { jobId, paths, job: status };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function recoverJobStatus(jobId, paths) {
  const rootStat = await fs.stat(paths.root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error('Job not found');
  }

  await ensureJobFolders(jobId);
  const translated = await pathExists(paths.translatedJson);
  const transcript = await pathExists(paths.transcriptJson);
  const dubbed = await pathExists(paths.dubbedVideo);
  const sourceVideo = await pathExists(paths.sourceVideo);
  const now = new Date().toISOString();
  const updatedAt = new Date(rootStat.mtimeMs || Date.now()).toISOString();
  const status = {
    jobId,
    status: translated || transcript || sourceVideo ? 'completed' : 'recovered',
    percent: translated || transcript || sourceVideo ? 100 : 0,
    stage: translated ? 'translated' : transcript ? 'transcribed' : sourceVideo ? 'source_ready' : 'recovered',
    message: 'Recovered job status from existing job artifacts.',
    logs: [
      {
        time: now,
        level: 'warning',
        message: 'status.json was missing or corrupt; recovered from existing job artifacts.',
      },
    ],
    result: {
      sourceVideoPath: sourceVideo ? paths.sourceVideo : '',
      transcriptJsonPath: transcript ? paths.transcriptJson : '',
      translatedJsonPath: translated ? paths.translatedJson : '',
      dubbedVideoPath: dubbed ? paths.dubbedVideo : '',
    },
    error: null,
    createdAt: new Date(rootStat.birthtimeMs || rootStat.ctimeMs || Date.now()).toISOString(),
    updatedAt,
    recoveredAt: now,
  };

  await writeJson(paths.status, status);
  return status;
}

async function getJob(jobId) {
  const paths = getJobPaths(jobId);
  const status = await readJson(paths.status);
  if (!status) {
    return recoverJobStatus(jobId, paths);
  }
  return status;
}

async function updateJob(jobId, patch = {}) {
  const paths = getJobPaths(jobId);
  const current = (await readJson(paths.status)) || {
    jobId,
    logs: [],
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
  };

  const next = {
    ...current,
    ...patch,
    logs: patch.logs || current.logs || [],
    updatedAt: new Date().toISOString(),
  };

  await writeJson(paths.status, next);
  return next;
}

async function addLog(jobId, level, message) {
  const current = await getJob(jobId);
  const nextLogs = [
    ...(current.logs || []),
    {
      time: new Date().toISOString(),
      level,
      message,
    },
  ];

  return updateJob(jobId, { logs: nextLogs });
}

async function listJobIds() {
  try {
    const entries = await fs.readdir(jobsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

module.exports = {
  addLog,
  createJob,
  ensureJobFolders,
  getJob,
  getJobPaths,
  listJobIds,
  readJson,
  updateJob,
  writeJson,
};
