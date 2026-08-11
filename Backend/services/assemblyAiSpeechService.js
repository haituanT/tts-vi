const fs = require('fs').promises;
const fsNative = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SAFE_ASSEMBLYAI_STT_MODELS = new Set(['universal-3-5-pro', 'universal-2']);
const RETRYABLE_HTTP_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const ASSEMBLYAI_UPLOAD_LIMIT_BYTES = 2.2 * 1024 * 1024 * 1024;
const ASSEMBLYAI_TRANSCRIPT_LIMIT_SECONDS = 10 * 60 * 60;

function resolveBundledTool(command) {
  const exeName = process.platform === 'win32' ? `${command}.exe` : command;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'tools', 'ffmpeg', 'dist', 'bin', exeName),
    path.resolve(process.cwd(), 'tools', 'ffmpeg', 'dist', 'bin', exeName),
  ];
  return candidates.find((candidate) => fsNative.existsSync(candidate)) || command;
}

function normalizeSecretList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAssemblyAiApiKeys(config = {}) {
  return Array.from(new Set([
    ...normalizeSecretList(config.assemblyAiApiKey),
    ...normalizeSecretList(config.assemblyAiApiKeys),
    ...normalizeSecretList(process.env.ASSEMBLYAI_API_KEY),
    ...normalizeSecretList(process.env.ASSEMBLYAI_API_KEYS),
  ]));
}

function normalizeAssemblyAiModel(value) {
  const model = String(value || process.env.ASSEMBLYAI_STT_MODEL || 'universal-3-5-pro').trim();
  return SAFE_ASSEMBLYAI_STT_MODELS.has(model) ? model : 'universal-3-5-pro';
}

function speechModelFallbackList(model) {
  if (model === 'universal-2') return ['universal-2'];
  return ['universal-3-5-pro', 'universal-2'];
}

function normalizeNumber(value, fallback, min, max) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function normalizeInteger(value, fallback, min, max) {
  return Math.round(normalizeNumber(value, fallback, min, max));
}

function getBaseUrl(config = {}) {
  const explicit = String(config.assemblyAiBaseUrl || process.env.ASSEMBLYAI_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const region = String(config.assemblyAiRegion || process.env.ASSEMBLYAI_REGION || 'us').trim().toLowerCase();
  return region === 'eu' ? 'https://api.eu.assemblyai.com' : 'https://api.assemblyai.com';
}

function getRuntimeOptions(config = {}) {
  const keys = getAssemblyAiApiKeys(config);
  const chunkSeconds = normalizeInteger(
    config.assemblyAiChunkSeconds ?? process.env.ASSEMBLYAI_STT_CHUNK_SECONDS,
    180,
    60,
    600
  );
  const overlapSeconds = normalizeInteger(
    config.assemblyAiOverlapSeconds ?? process.env.ASSEMBLYAI_STT_OVERLAP_SECONDS,
    6,
    2,
    Math.min(30, Math.max(2, Math.floor(chunkSeconds / 4)))
  );
  const concurrency = normalizeInteger(
    config.assemblyAiConcurrency ?? process.env.ASSEMBLYAI_STT_CONCURRENCY,
    Math.min(3, Math.max(1, keys.length || 1)),
    1,
    Math.min(6, Math.max(1, keys.length || 1))
  );
  const model = normalizeAssemblyAiModel(config.sttModel);

  return {
    chunkSeconds,
    overlapSeconds,
    concurrency,
    model,
    speechModels: speechModelFallbackList(model),
    keyCount: keys.length,
    baseUrl: getBaseUrl(config),
    processingMode: String(config.assemblyAiProcessingMode || process.env.ASSEMBLYAI_STT_PROCESSING_MODE || 'parallel').trim().toLowerCase(),
  };
}

async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync(
    resolveBundledTool('ffprobe'),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
    { windowsHide: true }
  );
  return Number(stdout.trim()) || 0;
}

function buildChunkPlan(durationSeconds, options) {
  const duration = Math.max(0.01, Number(durationSeconds) || 0.01);
  const chunkSeconds = Math.max(60, Number(options.chunkSeconds) || 180);
  const overlapSeconds = Math.max(2, Math.min(Number(options.overlapSeconds) || 6, chunkSeconds / 4));
  const strideSeconds = Math.max(20, chunkSeconds - overlapSeconds);
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
  const chunkDir = path.join(path.dirname(audioPath), 'assemblyai_stt_chunks');
  await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(chunkDir, { recursive: true });

  const chunks = [];
  for (const chunk of plan) {
    const outputPath = path.join(chunkDir, `assemblyai_chunk_${String(chunk.index + 1).padStart(4, '0')}.flac`);
    await execFileAsync(
        resolveBundledTool('ffmpeg'),
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

async function createAssemblyAiWorkItems(audioPath, options) {
  const [duration, stats] = await Promise.all([
    getAudioDuration(audioPath),
    fs.stat(audioPath),
  ]);
  const processingMode = String(options.processingMode || '').toLowerCase();
  const forceChunking = ['chunked', 'chunks', 'parallel', 'fast'].includes(processingMode);
  const forceWholeFile = ['whole', 'whole_file', 'single'].includes(processingMode);
  const canSubmitWholeFile = duration <= ASSEMBLYAI_TRANSCRIPT_LIMIT_SECONDS && stats.size <= ASSEMBLYAI_UPLOAD_LIMIT_BYTES;

  if (forceWholeFile && canSubmitWholeFile) {
    return [{
      index: 0,
      offset: 0,
      duration: Number(Math.max(0.01, duration).toFixed(3)),
      path: audioPath,
      wholeFile: true,
    }];
  }

  if (forceWholeFile && !canSubmitWholeFile) {
    throw new Error('AssemblyAI whole-file mode cannot submit this audio because it exceeds AssemblyAI upload/transcript limits.');
  }

  if (forceChunking || !canSubmitWholeFile) {
    return createAudioChunks(audioPath, options);
  }

  return createAudioChunks(audioPath, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAssemblyAiError(error) {
  const status = Number(error?.status || error?.response?.status);
  return RETRYABLE_HTTP_CODES.has(status) || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
}

function getRetryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter || error?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(45000, retryAfter * 1000);
  }
  return Math.min(15000, 900 * (2 ** attempt));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `AssemblyAI request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    error.data = data;
    throw error;
  }
  return data;
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return '';
  return raw.split(/[-_]/)[0].toLowerCase();
}

function parseKeyterms(config = {}) {
  const raw = [
    config.customGlossary,
    config.assemblyAiKeyterms,
  ].filter(Boolean).join('\n');
  const model = normalizeAssemblyAiModel(config.sttModel);
  const maxTerms = model === 'universal-2' ? 200 : 1000;
  return Array.from(new Set(String(raw)
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item && item.split(/\s+/).length <= 6)))
    .slice(0, maxTerms);
}

function buildPrompt(config = {}) {
  const prompt = String(config.assemblyAiPrompt || config.sttHint || config.userHint || config.userContext || config.autoContext || '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = prompt.split(/\s+/).filter(Boolean);
  return words.slice(0, 1500).join(' ');
}

function languageName(language) {
  const code = String(language || '').trim().split(/[-_]/)[0].toLowerCase();
  return {
    en: 'English',
    zh: 'Chinese',
    cmn: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    vi: 'Vietnamese',
    th: 'Thai',
    id: 'Indonesian',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
  }[code] || '';
}

function promptWithLanguage(config = {}) {
  const prompt = buildPrompt(config);
  if (!prompt) return '';
  const name = languageName(config.sourceLanguage);
  if (!name) return prompt;
  return `Transcribe in ${name}. ${prompt}`;
}

function buildTranscriptPayload(uploadUrl, config = {}, runtime = {}) {
  const language = normalizeLanguage(config.sourceLanguage);
  const payload = {
    audio_url: uploadUrl,
    speech_models: runtime.speechModels || speechModelFallbackList(runtime.model),
    punctuate: true,
    format_text: true,
  };

  if (language) {
    payload.language_code = language;
  } else {
    payload.language_detection = true;
  }

  const prompt = runtime.model === 'universal-2' ? '' : promptWithLanguage(config);
  if (prompt) {
    payload.prompt = prompt;
  }

  const keyterms = parseKeyterms(config);
  if (keyterms.length) {
    payload.keyterms_prompt = keyterms;
  }

  return payload;
}

async function uploadAudio(chunk, apiKey, runtime) {
  const audioBuffer = await fs.readFile(chunk.path);
  const data = await fetchJson(`${runtime.baseUrl}/v2/upload`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/octet-stream',
    },
    body: audioBuffer,
  });
  if (!data.upload_url) {
    throw new Error('AssemblyAI upload did not return an upload URL.');
  }
  return data.upload_url;
}

async function submitTranscript(uploadUrl, config, apiKey, runtime) {
  const data = await fetchJson(`${runtime.baseUrl}/v2/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildTranscriptPayload(uploadUrl, config, runtime)),
  });
  if (!data.id) {
    throw new Error('AssemblyAI did not return a transcript id.');
  }
  return data.id;
}

async function pollTranscript(transcriptId, apiKey, runtime) {
  const startedAt = Date.now();
  const timeoutMs = normalizeInteger(process.env.ASSEMBLYAI_STT_TIMEOUT_MINUTES, 90, 5, 240) * 60 * 1000;
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const data = await fetchJson(`${runtime.baseUrl}/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });
    if (data.status === 'completed') return data;
    if (data.status === 'error') {
      const error = new Error(data.error || `AssemblyAI transcript ${transcriptId} failed.`);
      error.status = 400;
      error.data = data;
      throw error;
    }
    await sleep(Math.min(8000, 2500 + (attempt * 250)));
    attempt += 1;
  }

  throw new Error(`AssemblyAI transcript ${transcriptId} timed out.`);
}

async function fetchSentences(transcriptId, apiKey, runtime) {
  const data = await fetchJson(`${runtime.baseUrl}/v2/transcript/${transcriptId}/sentences`, {
    headers: { authorization: apiKey },
  });
  return Array.isArray(data.sentences) ? data.sentences : [];
}

async function transcribeChunk(chunk, config, apiKey, runtime) {
  const uploadUrl = await uploadAudio(chunk, apiKey, runtime);
  const transcriptId = await submitTranscript(uploadUrl, config, apiKey, runtime);
  const transcript = await pollTranscript(transcriptId, apiKey, runtime);
  const sentences = await fetchSentences(transcriptId, apiKey, runtime).catch(() => []);
  return { transcriptId, transcript, sentences };
}

async function transcribeChunkWithRetry(chunk, config, apiKeys, runtime) {
  let lastError = null;
  const maxAttempts = Math.max(apiKeys.length * 2, 2);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const apiKey = apiKeys[(chunk.index + attempt) % apiKeys.length];
    try {
      return await transcribeChunk(chunk, config, apiKey, runtime);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isRetryableAssemblyAiError(error)) {
        break;
      }
      await sleep(getRetryDelayMs(error, attempt));
    }
  }

  const detail = lastError?.data?.error
    || lastError?.data?.message
    || lastError?.message
    || 'AssemblyAI transcription request failed.';
  throw new Error(`AssemblyAI STT failed on chunk ${chunk.index + 1}: ${detail}`);
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

function msToSeconds(value) {
  return Number(((Number(value) || 0) / 1000).toFixed(3));
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanWordSegmentText(text) {
  return normalizeText(text)
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1')
    .replace(/\s+([,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001])/g, '$1')
    .replace(/([,.!?;:\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .trim();
}

function countCueUnits(text) {
  const clean = cleanWordSegmentText(text);
  const cjk = clean.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  if (cjk.length) return cjk.length;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.length;
  return clean.length;
}

function isStrongCueBoundary(text) {
  return /[.!?;:\u3002\uff01\uff1f\uff1b\uff1a]\s*$/.test(cleanWordSegmentText(text));
}

function isSoftCueBoundary(text) {
  return /[,\u3001\uff0c]\s*$/.test(cleanWordSegmentText(text));
}

function isSemanticCueBoundary(text) {
  const clean = cleanWordSegmentText(text);
  return /(\u4e86|\u7740|\u8fc7|\u540e|\u524d|\u65f6|\u91cc|\u4e2d|\u4e0a|\u4e0b|\u5185|\u5916|\u8d77\u6765|\u4e0b\u53bb|\u56e0\u4e3a|\u6240\u4ee5|\u4f46\u662f|\u7136\u540e|\u7136\u800c)$/.test(clean);
}

function startsWithDependentCjk(text) {
  return /^(\u7684|\u5730|\u5f97|\u4e86|\u7740|\u8fc7|\u4e0b|\u4e0a|\u4e2d|\u91cc|\u5185|\u5916|\u4eec|\u5417|\u5462|\u5427|\u554a|\u5440|\u5c06|\u4f1a|\u662f|\u5728|\u548c|\u4e0e|\u53ca|\u6216|\u5374|\u624d|\u5c31)/.test(cleanWordSegmentText(text));
}

function startsWithNewClause(text) {
  return /^(\u4f46|\u800c|\u7136\u540e|\u5927\u5bb6\u597d|\u521a|\u6211|\u4ed6|\u5979|\u8fd9\u91cc|\u8fd9\u65f6|\u63a5\u7740|\u968f\u540e|\u6700\u7ec8|\u4e00\u5929\u540e|\u53e6\u5916|\u540c\u65f6)/.test(cleanWordSegmentText(text));
}

function endsWithWeakCjk(text) {
  const clean = cleanWordSegmentText(text);
  return /(\u56e0\u4e3a|\u7531\u4e8e|\u5728|\u548c|\u4e0e|\u53ca|\u6216|\u800c|\u4f46|\u4f46\u662f|\u7136\u540e|\u4e00\u4e2a|\u8fd9|\u90a3|\u628a|\u88ab|\u5c06|\u5411|\u4ece|\u5bf9|\u4e3a|\u7ed9|\u8ba9|\u4f7f|\u5230|\u6c88|\u975e)$/.test(clean);
}

function wordGapSeconds(currentWord, nextWord) {
  if (!currentWord || !nextWord) return 0;
  return Math.max(0, Number(nextWord.start) - Number(currentWord.end));
}

function lookaheadText(buffer, index, nextWord) {
  return cleanWordSegmentText([
    index + 1 < buffer.length ? buffer[index + 1].text : nextWord?.text,
    index + 2 < buffer.length ? buffer[index + 2].text : '',
  ].filter(Boolean).join(''));
}

function startsWithActionCue(buffer, index, nextWord) {
  return /^(\u8eb2\u907f|\u907f\u514d|\u5bfb\u627e|\u627e\u5230|\u5f00\u59cb|\u51b3\u5b9a|\u5192\u9669|\u53d1\u751f|\u642d\u4e58|\u5c1d\u8bd5|\u7ef4\u4fee|\u88c5\u4e0a)/.test(lookaheadText(buffer, index, nextWord));
}

function cueDuration(buffer) {
  if (!buffer.length) return 0;
  return Math.max(0, buffer[buffer.length - 1].end - buffer[0].start);
}

function cueText(buffer) {
  return cleanWordSegmentText(buffer.map((item) => item.text).join(' '));
}

function cueBreakScore(buffer, index, options, nextWord) {
  const prefix = buffer.slice(0, index + 1);
  const text = cueText(prefix);
  const duration = cueDuration(prefix);
  const units = countCueUnits(text);
  if (duration < options.minCueSeconds && units < options.minCueUnits) return -Infinity;
  if (duration > options.maxCueSeconds + 0.8 || units > options.maxCueUnits + 10) return -Infinity;

  const next = index + 1 < buffer.length ? buffer[index + 1] : nextWord;
  const gap = wordGapSeconds(buffer[index], next);
  const strong = isStrongCueBoundary(text);
  const soft = isSoftCueBoundary(text);
  const semantic = isSemanticCueBoundary(text);
  const clauseStart = startsWithNewClause(next?.text || '');
  const actionStart = startsWithActionCue(buffer, index, nextWord);
  const badNext = startsWithDependentCjk(next?.text || '');
  const weakEnd = endsWithWeakCjk(text);
  const durationPenalty = Math.abs(duration - options.targetCueSeconds) * 18;
  const unitPenalty = Math.abs(units - options.targetCueUnits) * 2.2;

  let score = 100 - durationPenalty - unitPenalty;
  if (strong) score += 120;
  if (soft) score += 50;
  if (semantic) score += 18;
  if (gap >= options.pauseCueSeconds) score += 90;
  if (gap >= options.longPauseCueSeconds) score += 50;
  if (clauseStart && duration >= options.minClauseCueSeconds) score += 95;
  if (actionStart && duration >= options.minClauseCueSeconds) score += 55;
  if (duration >= options.softCueSeconds || units >= options.targetCueUnits) score += 12;
  if (badNext && !strong && gap < options.pauseCueSeconds) score -= 140;
  if (weakEnd && !strong && !soft && gap < options.pauseCueSeconds && !clauseStart) score -= 85;
  if (/\u5361\u8f66$/.test(text) && /^\u5e95/.test(next?.text || '')) score -= 120;
  if (duration > options.maxCueSeconds) score -= (duration - options.maxCueSeconds) * 40;
  return score;
}

function bestCueBreakIndex(buffer, options, nextWord) {
  let best = -1;
  let bestScore = -Infinity;

  for (let index = 0; index < buffer.length; index += 1) {
    const score = cueBreakScore(buffer, index, options, nextWord);

    if (score > bestScore) {
      bestScore = score;
      best = index + 1;
    }
  }

  return best;
}

function transcriptWordsToSegments(result, chunk) {
  const words = Array.isArray(result.transcript?.words)
    ? result.transcript.words
        .map((word) => {
          const localStart = msToSeconds(word.start);
          const localEnd = msToSeconds(word.end);
          const start = chunk.offset + Math.max(0, Math.min(chunk.duration, localStart));
          const end = chunk.offset + Math.max(0, Math.min(chunk.duration, localEnd));
          const text = normalizeText(word.text || word.word);
          if (!text || end <= start) return null;
          return {
            text,
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
            confidence: word.confidence,
          };
        })
        .filter(Boolean)
    : [];
  if (!words.length) return [];

  const options = {
    minCueSeconds: 1.0,
    minClauseCueSeconds: 1.1,
    softCueSeconds: 2.5,
    targetCueSeconds: 3.0,
    maxCueSeconds: 4.35,
    pauseCueSeconds: 0.24,
    longPauseCueSeconds: 0.32,
    minCueUnits: 6,
    minCommaCueUnits: 4,
    targetCueUnits: 15,
    maxCueUnits: 22,
    startPadSeconds: 0.08,
    endPadSeconds: 0.12,
  };
  const segments = [];
  let buffer = [];

  function pushSegment(wordsForSegment, nextStart) {
    if (!wordsForSegment.length) return;
    const previous = segments[segments.length - 1];
    const rawStart = wordsForSegment[0].start;
    const rawEnd = wordsForSegment[wordsForSegment.length - 1].end;
    let start = Math.max(0, rawStart - options.startPadSeconds);
    let end = rawEnd + options.endPadSeconds;
    if (previous) start = Math.max(start, previous.end + 0.02);
    if (Number.isFinite(nextStart)) end = Math.min(end, nextStart - 0.02);
    if (end <= start) {
      start = rawStart;
      end = rawEnd;
    }
    const text = cueText(wordsForSegment);
    if (text && end > start) {
      segments.push({
        id: `assemblyai-${chunk.index + 1}-word-${segments.length + 1}`,
        text,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        confidence: wordsForSegment.reduce((sum, word) => sum + (Number(word.confidence) || 0), 0) / Math.max(1, wordsForSegment.length),
        transcriptId: result.transcriptId,
        speechModelUsed: result.transcript?.speech_model_used || '',
        chunkIndex: chunk.index,
        words: wordsForSegment.map((word) => ({ ...word })),
        wordTimestampSource: true,
      });
    }
  }

  function flush(count = buffer.length, nextStart) {
    if (!buffer.length || count <= 0) return;
    const taken = buffer.splice(0, count);
    const followingStart = Number.isFinite(nextStart) ? nextStart : buffer[0]?.start;
    pushSegment(taken, followingStart);
  }

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const nextWord = words[index + 1];
    buffer.push(word);
    const text = cueText(buffer);
    const duration = cueDuration(buffer);
    const units = countCueUnits(text);
    const gapAfter = wordGapSeconds(word, nextWord);
    const strongBoundary = isStrongCueBoundary(text);
    const softBoundary = isSoftCueBoundary(text);
    const semanticBoundary = isSemanticCueBoundary(text);
    const pauseBoundary = gapAfter >= options.pauseCueSeconds;
    const clauseBoundary = startsWithNewClause(nextWord?.text || '');
    const shouldSoftFlush = (
      strongBoundary && duration >= options.minCueSeconds
    ) || (
      softBoundary && duration >= options.minCueSeconds && units >= options.minCommaCueUnits
    ) || (
      pauseBoundary && duration >= options.minCueSeconds
    ) || (
      clauseBoundary && duration >= options.minClauseCueSeconds
    ) || (
      semanticBoundary && duration >= options.softCueSeconds && units >= options.targetCueUnits
    );
    const shouldHardFlush = duration >= options.maxCueSeconds || units >= options.maxCueUnits;

    if (shouldSoftFlush) {
      if (clauseBoundary && !strongBoundary && !softBoundary && buffer.length > 1) {
        const breakIndex = bestCueBreakIndex(buffer, options, nextWord);
        flush(breakIndex > 0 ? breakIndex : buffer.length, nextWord?.start);
      } else {
        flush(buffer.length, nextWord?.start);
      }
    } else if (shouldHardFlush) {
      const breakIndex = bestCueBreakIndex(buffer, options, nextWord);
      flush(breakIndex > 0 ? breakIndex : buffer.length, nextWord?.start);
    }
  }
  flush();

  return segments;
}

function shouldUseAssemblyAiSentences(config = {}) {
  return ['segment_timestamps', 'sentence_timestamps', 'assemblyai_sentences'].includes(String(config.sttTimestampMode || '').trim());
}

function responseToSegments(result, chunk, config = {}) {
  if (!shouldUseAssemblyAiSentences(config)) {
    const wordSegments = transcriptWordsToSegments(result, chunk);
    if (wordSegments.length) return wordSegments;
  }

  const source = result.sentences.length
    ? result.sentences
    : [{ text: result.transcript?.text || '', start: 0, end: Math.round(chunk.duration * 1000), words: result.transcript?.words || [] }];

  return source
    .map((sentence, index) => {
      const localStart = msToSeconds(sentence.start);
      const localEnd = msToSeconds(sentence.end);
      const start = chunk.offset + Math.max(0, Math.min(chunk.duration, localStart));
      const end = chunk.offset + Math.max(0, Math.min(chunk.duration, localEnd));
      const words = Array.isArray(sentence.words)
        ? sentence.words
            .map((word) => {
              const wordStart = chunk.offset + Math.max(0, Math.min(chunk.duration, msToSeconds(word.start)));
              const wordEnd = chunk.offset + Math.max(0, Math.min(chunk.duration, msToSeconds(word.end)));
              const text = normalizeText(word.text || word.word);
              if (!text || wordEnd <= wordStart) return null;
              return {
                text,
                start: Number(wordStart.toFixed(3)),
                end: Number(wordEnd.toFixed(3)),
                confidence: word.confidence,
              };
            })
            .filter(Boolean)
        : [];

      return {
        id: `assemblyai-${chunk.index + 1}-${index + 1}`,
        text: normalizeText(sentence.text),
        start: Number(start.toFixed(3)),
        end: Number(Math.max(start + 0.05, end).toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        confidence: sentence.confidence,
        transcriptId: result.transcriptId,
        speechModelUsed: result.transcript?.speech_model_used || '',
        chunkIndex: chunk.index,
        words,
        assemblyAiSentenceSource: Boolean(result.sentences.length),
      };
    })
    .filter((segment) => segment.text && segment.end > segment.start);
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
  return text.length + (duration * 2) + (Number(segment.confidence) || 0) * 8 + (Number(segment.chunkIndex) || 0) * 0.15;
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
      text: normalizeText(segment.text),
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

async function transcribeAudio(audioPath, config = {}) {
  const apiKeys = getAssemblyAiApiKeys(config);
  if (!apiKeys.length) {
    throw new Error('AssemblyAI STT requires ASSEMBLYAI_API_KEY, ASSEMBLYAI_API_KEYS, or AssemblyAI keys in the UI.');
  }

  const runtime = getRuntimeOptions(config);
  const chunks = await createAssemblyAiWorkItems(audioPath, runtime);
  const responses = await mapLimit(chunks, runtime.concurrency, async (chunk) => {
    const response = await transcribeChunkWithRetry(chunk, { ...config, sttModel: runtime.model }, apiKeys, runtime);
    return { chunk, response };
  });
  const allSegments = responses.flatMap(({ chunk, response }) => responseToSegments(response, chunk, config));
  const segments = dedupeSegments(allSegments, runtime);

  if (!segments.length) {
    throw new Error('AssemblyAI STT returned no transcript segments.');
  }

  return segments;
}

module.exports = {
  getAssemblyAiApiKeys,
  getRuntimeOptions,
  normalizeAssemblyAiModel,
  transcribeAudio,
};
