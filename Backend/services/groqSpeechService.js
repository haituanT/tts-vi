const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const GROQ_TRANSCRIPTIONS_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const SAFE_GROQ_STT_MODELS = new Set(['whisper-large-v3-turbo', 'whisper-large-v3']);
const RETRYABLE_HTTP_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

function normalizeSecretList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getGroqApiKeys(config = {}) {
  return Array.from(new Set([
    ...normalizeSecretList(config.groqApiKey),
    ...normalizeSecretList(config.groqApiKeys),
    ...normalizeSecretList(process.env.GROQ_API_KEY),
    ...normalizeSecretList(process.env.GROQ_API_KEYS),
  ]));
}

function normalizeGroqModel(value) {
  const model = String(value || process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo').trim();
  return SAFE_GROQ_STT_MODELS.has(model) ? model : 'whisper-large-v3-turbo';
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return '';
  return raw.split(/[-_]/)[0].toLowerCase();
}

function normalizeNumber(value, fallback, min, max) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function normalizeInteger(value, fallback, min, max) {
  return Math.round(normalizeNumber(value, fallback, min, max));
}

function getRuntimeOptions(config = {}) {
  const chunkSeconds = normalizeInteger(
    config.groqChunkSeconds ?? process.env.GROQ_STT_CHUNK_SECONDS,
    120,
    30,
    600
  );
  const overlapSeconds = normalizeInteger(
    config.groqOverlapSeconds ?? process.env.GROQ_STT_OVERLAP_SECONDS,
    8,
    2,
    Math.min(20, Math.max(2, Math.floor(chunkSeconds / 3)))
  );
  const keys = getGroqApiKeys(config);
  const concurrency = normalizeInteger(
    config.groqConcurrency ?? process.env.GROQ_STT_CONCURRENCY,
    Math.min(3, Math.max(1, keys.length || 1)),
    1,
    Math.min(6, Math.max(1, keys.length || 1))
  );

  return {
    chunkSeconds,
    overlapSeconds,
    concurrency,
    model: normalizeGroqModel(config.sttModel),
    keyCount: keys.length,
  };
}

async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
    { windowsHide: true }
  );
  return Number(stdout.trim()) || 0;
}

function buildChunkPlan(durationSeconds, options) {
  const duration = Math.max(0.01, Number(durationSeconds) || 0.01);
  const chunkSeconds = Math.max(30, Number(options.chunkSeconds) || 120);
  const overlapSeconds = Math.max(2, Math.min(Number(options.overlapSeconds) || 8, chunkSeconds / 3));
  const strideSeconds = Math.max(10, chunkSeconds - overlapSeconds);
  const chunks = [];

  for (let offset = 0, index = 0; offset < duration; index += 1) {
    const length = Math.min(chunkSeconds, duration - offset);
    chunks.push({
      index,
      offset: Number(offset.toFixed(3)),
      duration: Number(length.toFixed(3)),
    });
    if (offset + length >= duration) break;
    offset += strideSeconds;
  }

  return chunks;
}

async function createAudioChunks(audioPath, options) {
  const duration = await getAudioDuration(audioPath);
  const plan = buildChunkPlan(duration, options);
  const chunkDir = path.join(path.dirname(audioPath), 'groq_stt_chunks');
  await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(chunkDir, { recursive: true });

  const chunks = [];
  for (const chunk of plan) {
    const outputPath = path.join(chunkDir, `groq_chunk_${String(chunk.index + 1).padStart(4, '0')}.flac`);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(chunk.offset),
        '-t',
        String(chunk.duration),
        '-i',
        audioPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'flac',
        outputPath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );
    chunks.push({ ...chunk, path: outputPath });
  }

  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGroqError(error) {
  const status = Number(error?.status || error?.response?.status);
  return RETRYABLE_HTTP_CODES.has(status) || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
}

function getRetryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter || error?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30000, retryAfter * 1000);
  }
  return Math.min(12000, 700 * (2 ** attempt));
}

async function postGroqTranscription(chunk, config, apiKey) {
  const audioBuffer = await fs.readFile(chunk.path);
  const audioBlob = new Blob([audioBuffer], { type: 'audio/flac' });
  const form = new FormData();
  form.append('file', audioBlob, path.basename(chunk.path));
  form.append('model', normalizeGroqModel(config.sttModel));
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('timestamp_granularities[]', 'segment');
  if (config.enableWordTimestamps !== false) {
    form.append('timestamp_granularities[]', 'word');
  }
  const language = normalizeLanguage(config.sourceLanguage);
  if (language) {
    form.append('language', language);
  }
  const prompt = String(config.sttHint || config.userHint || '').trim();
  if (prompt) {
    form.append('prompt', prompt.slice(0, 224));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000 * 60 * 5);
  try {
    const response = await fetch(GROQ_TRANSCRIPTIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || `Groq request failed with HTTP ${response.status}.`);
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      error.data = data;
      throw error;
    }
    return data || {};
  } finally {
    clearTimeout(timeout);
  }
}

async function transcribeChunkWithRetry(chunk, config, apiKeys) {
  let lastError = null;
  const maxAttempts = Math.max(apiKeys.length * 2, 2);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const apiKey = apiKeys[(chunk.index + attempt) % apiKeys.length];
    try {
      return await postGroqTranscription(chunk, config, apiKey);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isRetryableGroqError(error)) {
        break;
      }
      await sleep(getRetryDelayMs(error, attempt));
    }
  }

  const detail = lastError?.data?.error?.message
    || lastError?.data?.message
    || lastError?.response?.data?.error?.message
    || lastError?.response?.data?.message
    || lastError?.message
    || 'Groq transcription request failed.';
  throw new Error(`Groq STT failed on chunk ${chunk.index + 1}: ${detail}`);
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return output;
}

function normalizeTextForSimilarity(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textUnits(text) {
  const normalized = normalizeTextForSimilarity(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words;
  return Array.from(normalized.replace(/\s+/g, ''));
}

function textSimilarity(left, right) {
  const leftUnits = new Set(textUnits(left));
  const rightUnits = new Set(textUnits(right));
  if (!leftUnits.size || !rightUnits.size) return 0;
  let overlap = 0;
  for (const unit of leftUnits) {
    if (rightUnits.has(unit)) overlap += 1;
  }
  return overlap / Math.min(leftUnits.size, rightUnits.size);
}

function overlapRatio(left, right) {
  const start = Math.max(Number(left.start) || 0, Number(right.start) || 0);
  const end = Math.min(Number(left.end) || 0, Number(right.end) || 0);
  const overlap = Math.max(0, end - start);
  const shorter = Math.max(0.05, Math.min(
    Math.max(0.05, (Number(left.end) || 0) - (Number(left.start) || 0)),
    Math.max(0.05, (Number(right.end) || 0) - (Number(right.start) || 0))
  ));
  return overlap / shorter;
}

function segmentQualityScore(segment) {
  const text = String(segment.text || '').trim();
  const duration = Math.max(0.05, (Number(segment.end) || 0) - (Number(segment.start) || 0));
  const noSpeechPenalty = Number(segment.noSpeechProb || segment.no_speech_prob || 0) * 12;
  return text.length + (duration * 2) + (Number(segment.chunkIndex) || 0) * 0.15 - noSpeechPenalty;
}

function isDuplicateSegment(candidate, existing, overlapSeconds) {
  const timeRelated = candidate.start <= existing.end + Math.max(1.2, overlapSeconds)
    && candidate.end >= existing.start - Math.max(1.2, overlapSeconds);
  if (!timeRelated) return false;
  const similarity = textSimilarity(candidate.text, existing.text);
  const timeOverlap = overlapRatio(candidate, existing);
  if (similarity >= 0.72 && timeOverlap >= 0.12) return true;
  if (similarity >= 0.9 && Math.abs(candidate.start - existing.start) <= overlapSeconds + 1) return true;
  const contained = candidate.start >= existing.start - 0.15 && candidate.end <= existing.end + 0.15;
  return contained && similarity >= 0.55;
}

function dedupeSegments(segments, options = {}) {
  const overlapSeconds = Number(options.overlapSeconds) || 8;
  const output = [];
  const sorted = [...segments]
    .map((segment) => ({
      ...segment,
      text: String(segment.text || '').replace(/\s+/g, ' ').trim(),
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
    }))
    .filter((segment) => segment.text && segment.end > segment.start + 0.03)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (const candidate of sorted) {
    const searchStart = Math.max(0, output.length - 12);
    let duplicateIndex = -1;
    for (let index = output.length - 1; index >= searchStart; index -= 1) {
      if (isDuplicateSegment(candidate, output[index], overlapSeconds)) {
        duplicateIndex = index;
        break;
      }
    }

    if (duplicateIndex >= 0) {
      if (segmentQualityScore(candidate) > segmentQualityScore(output[duplicateIndex])) {
        output[duplicateIndex] = candidate;
      }
      continue;
    }

    output.push(candidate);
  }

  const ordered = output.sort((a, b) => a.start - b.start || a.end - b.end);
  const normalized = [];
  for (const segment of ordered) {
    const previous = normalized[normalized.length - 1];
    let start = Number(segment.start) || 0;
    let end = Number(segment.end) || (start + 0.1);
    if (previous && start < previous.end) {
      start = previous.end;
    }
    if (end <= start + 0.04) continue;
    normalized.push({
      ...segment,
      index: normalized.length + 1,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number((end - start).toFixed(3)),
    });
  }

  return normalized;
}

function responseToSegments(response, chunk) {
  const source = Array.isArray(response?.segments) ? response.segments : [];
  const responseWords = Array.isArray(response?.words)
    ? response.words
        .map((word) => {
          const localStart = Number(word.start) || 0;
          const localEnd = Number(word.end) || 0;
          const start = chunk.offset + Math.max(0, Math.min(chunk.duration, localStart));
          const end = chunk.offset + Math.max(0, Math.min(chunk.duration, localEnd));
          const text = String(word.word || word.text || '').trim();
          if (!text || end <= start) return null;
          return {
            text,
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
          };
        })
        .filter(Boolean)
    : [];
  return source
    .map((segment, index) => {
      const localStart = Number(segment.start) || 0;
      const localEnd = Number(segment.end) || 0;
      const start = chunk.offset + Math.max(0, Math.min(chunk.duration, localStart));
      const end = chunk.offset + Math.max(0, Math.min(chunk.duration, localEnd));
      const words = responseWords.filter((word) => {
        const midpoint = ((Number(word.start) || 0) + (Number(word.end) || 0)) / 2;
        return midpoint >= start - 0.02 && midpoint <= end + 0.02;
      });
      const output = {
        id: `groq-${chunk.index + 1}-${index + 1}`,
        text: String(segment.text || '').trim(),
        start: Number(start.toFixed(3)),
        end: Number(Math.max(start + 0.05, end).toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        avgLogprob: segment.avg_logprob,
        compressionRatio: segment.compression_ratio,
        noSpeechProb: segment.no_speech_prob,
        chunkIndex: chunk.index,
      };
      if (words.length) {
        output.words = words;
      }
      return output;
    })
    .filter((segment) => segment.text);
}

async function transcribeAudio(audioPath, config = {}) {
  const apiKeys = getGroqApiKeys(config);
  if (!apiKeys.length) {
    throw new Error('Groq STT requires GROQ_API_KEY or GROQ_API_KEYS.');
  }

  const runtime = getRuntimeOptions(config);
  const chunks = await createAudioChunks(audioPath, runtime);
  const responses = await mapLimit(chunks, runtime.concurrency, async (chunk) => {
    const response = await transcribeChunkWithRetry(chunk, { ...config, sttModel: runtime.model }, apiKeys);
    return { chunk, response };
  });
  const allSegments = responses.flatMap(({ chunk, response }) => responseToSegments(response, chunk));
  const segments = dedupeSegments(allSegments, runtime);

  if (!segments.length) {
    throw new Error('Groq STT returned no transcript segments.');
  }

  return segments;
}

module.exports = {
  getGroqApiKeys,
  getRuntimeOptions,
  normalizeGroqModel,
  transcribeAudio,
};
