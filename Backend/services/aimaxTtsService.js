const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const DEFAULT_BASE_URL = 'https://aimaxstudio.com';
const DEFAULT_PROVIDER = 'minimax';
const DEFAULT_MODEL = 'speech-2.8-hd';
const DEFAULT_SAMPLE_RATE = 24000;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 0;
const DEFAULT_SRT_READY_TIMEOUT_MS = 180000;
const DEFAULT_SEGMENTS_READY_TIMEOUT_MS = 180000;
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_DELAY_MS = 1200;
const DEFAULT_HTTP_RETRY_ATTEMPTS = 3;
const HTTP_RETRY_DELAY_MS = 2500;
const DEFAULT_API_REQUESTS_PER_MINUTE = 60;
const API_RATE_WINDOW_MS = 60000;
const RATE_LIMIT_GRACE_MS = 250;
const DEFAULT_MAX_CONCURRENT_JOBS = 30;
const HARD_MAX_CONCURRENT_JOBS = 30;

const apiRequestTimestamps = [];
let apiLimiterQueue = Promise.resolve();
let rateLimitCooldownUntil = 0;
const activeJobSlotQueue = [];
let activeJobSlotCount = 0;

const LANGUAGE_NAMES = {
  'vi-VN': 'Vietnamese',
  vi: 'Vietnamese',
  'en-US': 'English',
  en: 'English',
  'zh-CN': 'Chinese',
  zh: 'Chinese',
  'ja-JP': 'Japanese',
  ja: 'Japanese',
  'ko-KR': 'Korean',
  ko: 'Korean',
  'th-TH': 'Thai',
  th: 'Thai',
  'id-ID': 'Indonesian',
  id: 'Indonesian',
  'fr-FR': 'French',
  fr: 'French',
  'de-DE': 'German',
  de: 'German',
  'es-ES': 'Spanish',
  es: 'Spanish',
};

const LANGUAGE_NAME_TO_CODE = Object.entries(LANGUAGE_NAMES).reduce((acc, [code, name]) => {
  if (!code.includes('-')) return acc;
  acc[String(name).toLowerCase()] = code;
  return acc;
}, {});

function trimSlashes(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function baseUrl(config = {}) {
  return trimSlashes(config.aimaxBaseUrl || process.env.AIMAX_BASE_URL || DEFAULT_BASE_URL);
}

function apiKey(config = {}) {
  const key = String(config.aimaxApiKey || process.env.AIMAX_API_KEY || '').trim();
  if (!key) {
    throw new Error('AIMAX TTS requires AIMAX_API_KEY in Backend/.env.');
  }
  return key;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveProvider(config = {}) {
  const provider = String(config.aimaxProvider || process.env.AIMAX_TTS_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider === 'elevenlabs' ? 'elevenlabs' : 'minimax';
}

function resolveModel(config = {}, provider = resolveProvider(config)) {
  const fallback = provider === 'elevenlabs' ? 'eleven_multilingual_v2' : DEFAULT_MODEL;
  return String(config.aimaxModel || process.env.AIMAX_TTS_MODEL || fallback).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveApiRateLimit(config = {}) {
  const requested = Number(config.aimaxRequestsPerMinute || process.env.AIMAX_TTS_REQUESTS_PER_MINUTE || DEFAULT_API_REQUESTS_PER_MINUTE);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_API_REQUESTS_PER_MINUTE;
  return Math.max(1, Math.min(120, Math.round(requested)));
}

function resolvePollTimeoutMs(config = {}) {
  const configured = [
    config.aimaxPollTimeoutMs,
    process.env.AIMAX_TTS_POLL_TIMEOUT_MS,
    process.env.DUBFLOW_AIMAX_TTS_POLL_TIMEOUT_MS,
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (configured === undefined) return DEFAULT_POLL_TIMEOUT_MS;

  const requested = Number(configured);
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_POLL_TIMEOUT_MS;
  if (requested === 0) return 0;
  return Math.max(30000, Math.round(requested));
}

function resolveSrtReadyTimeoutMs(config = {}) {
  const configured = [
    config.aimaxSrtReadyTimeoutMs,
    process.env.AIMAX_TTS_SRT_READY_TIMEOUT_MS,
    process.env.DUBFLOW_AIMAX_TTS_SRT_READY_TIMEOUT_MS,
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (configured === undefined) return DEFAULT_SRT_READY_TIMEOUT_MS;

  const requested = Number(configured);
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_SRT_READY_TIMEOUT_MS;
  return Math.round(requested);
}

function resolveSegmentsReadyTimeoutMs(config = {}) {
  const configured = [
    config.aimaxSegmentsReadyTimeoutMs,
    process.env.AIMAX_TTS_SEGMENTS_READY_TIMEOUT_MS,
    process.env.DUBFLOW_AIMAX_TTS_SEGMENTS_READY_TIMEOUT_MS,
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (configured === undefined) return DEFAULT_SEGMENTS_READY_TIMEOUT_MS;

  const requested = Number(configured);
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_SEGMENTS_READY_TIMEOUT_MS;
  return Math.round(requested);
}

function resolveMaxConcurrentJobs(config = {}) {
  const requested = Number(
    config.aimaxMaxConcurrentJobs
    || process.env.AIMAX_TTS_MAX_CONCURRENT_JOBS
    || DEFAULT_MAX_CONCURRENT_JOBS
  );
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_MAX_CONCURRENT_JOBS;
  return Math.max(1, Math.min(HARD_MAX_CONCURRENT_JOBS, Math.round(requested)));
}

function removeQueuedJobSlot(entry) {
  const index = activeJobSlotQueue.indexOf(entry);
  if (index >= 0) {
    activeJobSlotQueue.splice(index, 1);
  }
}

function cleanupJobSlotEntry(entry) {
  if (entry.abortSignal && entry.abortHandler) {
    entry.abortSignal.removeEventListener('abort', entry.abortHandler);
  }
  entry.abortSignal = null;
  entry.abortHandler = null;
}

function pumpJobSlots() {
  while (activeJobSlotQueue.length) {
    const entry = activeJobSlotQueue[0];
    if (entry.canceled) {
      activeJobSlotQueue.shift();
      cleanupJobSlotEntry(entry);
      continue;
    }

    if (activeJobSlotCount >= resolveMaxConcurrentJobs(entry.config)) {
      return;
    }

    activeJobSlotQueue.shift();
    cleanupJobSlotEntry(entry);
    activeJobSlotCount += 1;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      activeJobSlotCount = Math.max(0, activeJobSlotCount - 1);
      pumpJobSlots();
    });
  }
}

async function acquireAimaxJobSlot(config = {}) {
  throwIfAborted(config);
  return new Promise((resolve, reject) => {
    const entry = {
      config,
      resolve,
      reject,
      canceled: false,
      abortSignal: config.abortSignal || null,
      abortHandler: null,
    };

    if (entry.abortSignal) {
      entry.abortHandler = () => {
        entry.canceled = true;
        removeQueuedJobSlot(entry);
        cleanupJobSlotEntry(entry);
        reject(new Error('Operation canceled.'));
      };
      entry.abortSignal.addEventListener('abort', entry.abortHandler, { once: true });
    }

    activeJobSlotQueue.push(entry);
    pumpJobSlots();
  });
}

function pruneApiRequestTimestamps(now = Date.now()) {
  while (apiRequestTimestamps.length && now - apiRequestTimestamps[0] >= API_RATE_WINDOW_MS) {
    apiRequestTimestamps.shift();
  }
}

async function waitForApiRequestSlot(config = {}) {
  const previous = apiLimiterQueue.catch(() => {});
  const current = previous.then(async () => {
    const limit = resolveApiRateLimit(config);
    while (true) {
      throwIfAborted(config);
      let now = Date.now();
      if (rateLimitCooldownUntil > now) {
        await sleep(rateLimitCooldownUntil - now + RATE_LIMIT_GRACE_MS);
        continue;
      }

      pruneApiRequestTimestamps(now);
      if (apiRequestTimestamps.length < limit) {
        apiRequestTimestamps.push(now);
        return;
      }

      const waitMs = Math.max(0, apiRequestTimestamps[0] + API_RATE_WINDOW_MS - now);
      await sleep(waitMs + RATE_LIMIT_GRACE_MS);
      now = Date.now();
      pruneApiRequestTimestamps(now);
    }
  });
  apiLimiterQueue = current.catch(() => {});
  await current;
}

function parseRetryAfterMs(response, data = {}) {
  const header = response?.headers?.get?.('retry-after');
  const retryAfter = header || data.retry_after || data.retryAfter || data.retry_after_seconds;
  if (!retryAfter) return 0;
  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric <= 1000 ? numeric * 1000 : numeric;
  }
  const dateMs = Date.parse(String(retryAfter));
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

function isRateLimitedResponse(response, detail = '') {
  const text = String(detail || '').toLowerCase();
  return Number(response?.status) === 429
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('request limit');
}

function isTransientHttpStatus(status) {
  return [502, 503, 504, 520, 521, 522, 523, 524].includes(Number(status));
}

function resolveHttpRetryAttempts(config = {}) {
  const configured = [
    config.aimaxHttpRetryAttempts,
    process.env.AIMAX_TTS_HTTP_RETRY_ATTEMPTS,
    process.env.DUBFLOW_AIMAX_TTS_HTTP_RETRY_ATTEMPTS,
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const requested = Number(configured);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_HTTP_RETRY_ATTEMPTS;
  return Math.max(1, Math.min(6, Math.round(requested)));
}

function stripHtmlTags(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#38;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlTitle(value = '') {
  const match = String(value || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtmlTags(match[1]) : '';
}

function describeAimaxApiFailure(response, data = {}) {
  const rawDetail = data.error_message || data.message || data.detail || data.raw || response.statusText || '';
  const rawText = String(rawDetail || '');
  const status = Number(response?.status) || 0;
  const statusText = String(response?.statusText || '').trim();
  if (rawText.match(/<!doctype html|<html[\s>]/i)) {
    const title = extractHtmlTitle(rawText);
    const label = [status || '', statusText].filter(Boolean).join(' ').trim();
    return [
      `AIMAX server returned ${label || 'an HTTP error'}.`,
      title ? `Provider page: ${title}.` : '',
      isTransientHttpStatus(status) ? 'This is a temporary AIMAX/Cloudflare server error; retry later if it persists.' : '',
    ].filter(Boolean).join(' ');
  }
  return rawText.replace(/\s+/g, ' ').trim() || statusText || 'Unknown AIMAX API error.';
}

function noteRateLimitCooldown(delayMs = 0) {
  const fallbackMs = 60000;
  const waitMs = Math.max(1000, Number(delayMs) || fallbackMs);
  rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + waitMs);
}

function describeFetchError(error) {
  const cause = error?.cause;
  const causeDetail = [
    cause?.code,
    cause?.syscall,
    cause?.hostname || cause?.address,
    cause?.port,
  ].filter(Boolean).join(' ');
  return causeDetail
    ? `${error.message || error} (${causeDetail})`
    : `${error.message || error}`;
}

function isFetchNetworkError(error) {
  if (!error || error.name !== 'TypeError') return false;
  if (String(error.message || '').toLowerCase().includes('fetch failed')) return true;
  return Boolean(error.cause?.code);
}

async function fetchWithNetworkRetry(url, options = {}, attempts = NETWORK_RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (!isFetchNetworkError(error) || attempt >= attempts) {
        const detail = isFetchNetworkError(error) ? describeFetchError(error) : (error.message || error);
        throw new Error(`AIMAX network request failed for ${url}: ${detail}`);
      }
      await sleep(NETWORK_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function throwIfAborted(config = {}) {
  if (config.abortSignal?.aborted) {
    throw new Error('Operation canceled.');
  }
}

function resolveLanguage(config = {}) {
  const requested = String(config.aimaxLanguage || config.ttsLanguageCode || config.targetLanguage || 'vi-VN').trim();
  return LANGUAGE_NAMES[requested] || LANGUAGE_NAMES[requested.split('-')[0]] || requested || 'Vietnamese';
}

function normalizeVoiceLanguageCode(value = '', requestedCode = '') {
  const raw = String(value || '').trim();
  const requested = String(requestedCode || '').trim();
  if (!raw) return requested || 'vi-VN';
  const namedCode = LANGUAGE_NAME_TO_CODE[raw.toLowerCase()];
  if (namedCode) {
    return LANGUAGE_NAMES[requested] === raw ? requested : namedCode;
  }
  return raw;
}

async function resolveVoiceId(config = {}) {
  const voiceId = String(config.ttsVoiceName || config.aimaxVoiceId || '').trim();
  if (voiceId) {
    return voiceId;
  }
  const voices = await listVoices(config.ttsLanguageCode || config.targetLanguage || 'vi-VN', config);
  const fallbackVoiceId = String(voices[0]?.name || voices[0]?.voiceName || '').trim();
  if (fallbackVoiceId) {
    config.ttsVoiceName = fallbackVoiceId;
    return fallbackVoiceId;
  }
  throw new Error('AIMAX TTS requires selecting a cloned voice.');
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJson(endpoint, config = {}, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const networkAttempts = method === 'GET' ? NETWORK_RETRY_ATTEMPTS : 1;
  const httpAttempts = resolveHttpRetryAttempts(config);
  let lastError = null;

  for (let attempt = 1; attempt <= httpAttempts; attempt += 1) {
    await waitForApiRequestSlot(config);
    const response = await fetchWithNetworkRetry(`${baseUrl(config)}${endpoint}`, {
      ...options,
      headers: {
        'X-API-Key': apiKey(config),
        ...(options.headers || {}),
      },
      signal: config.abortSignal,
    }, networkAttempts);
    const data = await parseJsonResponse(response);
    if (response.ok) {
      return data;
    }

    const detail = describeAimaxApiFailure(response, data);
    const error = new Error(`AIMAX API failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.statusCode = response.status;
    error.transient = isTransientHttpStatus(response.status);
    if (isRateLimitedResponse(response, detail)) {
      error.rateLimitRetryMs = parseRetryAfterMs(response, data) || 60000;
      noteRateLimitCooldown(error.rateLimitRetryMs);
    }

    lastError = error;
    if (!error.transient || attempt >= httpAttempts) {
      throw error;
    }

    const retryAfterMs = parseRetryAfterMs(response, data);
    await sleep(retryAfterMs || HTTP_RETRY_DELAY_MS * attempt);
  }

  throw lastError;
}

function normalizeGender(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  return text || 'CLONE';
}

async function listVoices(languageCode, config = {}) {
  const data = await requestJson('/api/v1/voices/my', config);
  const voices = Array.isArray(data.voices) ? data.voices : [];
  return voices.map((voice) => {
    const id = String(voice.voice_id || voice.id || '').trim();
    const name = String(voice.name || id).trim();
    const language = normalizeVoiceLanguageCode(voice.language, languageCode || config.ttsLanguageCode || 'vi-VN');
    const gender = normalizeGender(voice.gender);
    return id ? {
      name: id,
      voiceName: id,
      displayName: name,
      label: name && name !== id ? `${name} (${id})` : id,
      ssmlGender: gender,
      gender,
      languageCodes: [language],
      naturalSampleRateHertz: DEFAULT_SAMPLE_RATE,
      family: 'AIMAX Clone',
      provider: 'aimax_tts',
      audioUrl: voice.audio_url || voice.generated_audio_cdn_url || '',
    } : null;
  }).filter(Boolean);
}

async function createTtsJob(text, config = {}, overrides = {}) {
  const form = new FormData();
  const provider = resolveProvider(config);
  const speakingRate = provider === 'elevenlabs'
    ? clamp(Number(overrides.speakingRate || config.speakingRate || 1), 0.7, 1.2)
    : clamp(Number(overrides.speakingRate || config.speakingRate || 1), 0.5, 2.0);
  const enableSrt = overrides.enableSrt === true || config.aimaxGenerateSrt === true;
  const splitByLine = enableSrt && overrides.splitByLine !== false;
  const matchSrtTime = enableSrt && overrides.matchSrtTime === true;
  form.append('provider', provider);
  form.append('voice_id', await resolveVoiceId(config));
  form.append('text', text);
  form.append('speed', String(speakingRate));
  form.append('vol', String(clamp(Number(config.aimaxVolume || process.env.AIMAX_TTS_VOLUME || 1), 0.01, 10.0)));
  form.append('model', resolveModel(config, provider));
  form.append('language', resolveLanguage(config));
  form.append('normalize', 'true');
  form.append('enable_srt', String(enableSrt));
  form.append('split_by_line', String(splitByLine));
  form.append('match_srt_time', String(matchSrtTime));
  if (provider === 'elevenlabs') {
    form.append('stability', String(clamp(Number(config.aimaxStability || process.env.AIMAX_TTS_STABILITY || 0.5), 0, 1)));
    form.append('similarity', String(clamp(Number(config.aimaxSimilarity || process.env.AIMAX_TTS_SIMILARITY || 0.75), 0, 1)));
    form.append('style_exaggeration', String(clamp(Number(config.aimaxStyleExaggeration || process.env.AIMAX_TTS_STYLE_EXAGGERATION || 0.3), 0, 1)));
    form.append('use_speaker_boost', String(config.aimaxUseSpeakerBoost ?? process.env.AIMAX_TTS_USE_SPEAKER_BOOST ?? true));
  }

  const data = await requestJson('/api/v1/tts/generate', config, {
    method: 'POST',
    body: form,
  });
  const audioUrl = extractAudioUrl(data);
  const srtUrl = extractSrtUrl(data);
  const segmentsUrl = extractSegmentsUrl(data);
  if (!data.job_id && !audioUrl && !segmentsUrl) {
    throw new Error(`AIMAX TTS did not return a job_id. Response: ${JSON.stringify(data)}`);
  }
  return {
    jobId: data.job_id,
    status: data.status,
    audioUrl,
    srtUrl,
    segmentsUrl,
    charsDeducted: data.chars_deducted,
    speakingRate,
  };
}

async function waitForJob(jobId, config = {}, options = {}) {
  if (!jobId) {
    throw new Error('AIMAX TTS did not return a job_id to poll.');
  }
  const startedAt = Date.now();
  const pollTimeoutMs = resolvePollTimeoutMs(config);
  const srtReadyTimeoutMs = resolveSrtReadyTimeoutMs(config);
  const segmentsReadyTimeoutMs = resolveSegmentsReadyTimeoutMs(config);
  const hasPollTimeout = pollTimeoutMs > 0;
  const requireSrt = options.requireSrt === true;
  const requireSegments = options.requireSegments === true;
  const segmentsOnly = options.segmentsOnly === true;
  const preferSegments = options.preferSegments === true || requireSegments;
  let firstAudioReadyAt = 0;
  let firstSegmentsWaitAt = 0;
  let lastStatus = '';
  let lastProgress = '';
  while (!hasPollTimeout || Date.now() - startedAt < pollTimeoutMs) {
    throwIfAborted(config);
    const data = await requestJson(`/api/v1/tts/jobs/${encodeURIComponent(jobId)}`, config);
    const status = String(data.status || '').toLowerCase();
    lastStatus = status || lastStatus;
    lastProgress = [
      data.progress !== undefined ? `progress ${data.progress}` : '',
      data.completed_chunks !== undefined && data.total_chunks !== undefined ? `chunks ${data.completed_chunks}/${data.total_chunks}` : '',
    ].filter(Boolean).join(', ') || lastProgress;
    const audioUrl = extractAudioUrl(data);
    const srtUrl = extractSrtUrl(data);
    const segmentsUrl = extractSegmentsUrl(data);
    if (status === 'completed' || status === 'success' || audioUrl || (segmentsOnly && segmentsUrl)) {
      if (segmentsOnly) {
        if (!segmentsUrl) {
          if (!firstSegmentsWaitAt) firstSegmentsWaitAt = Date.now();
          const timedOut = segmentsReadyTimeoutMs <= 0 || Date.now() - firstSegmentsWaitAt >= segmentsReadyTimeoutMs;
          if (requireSegments && timedOut) {
            throw new Error(`AIMAX TTS completed without segments_url for job ${jobId}.`);
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        return data;
      }
      if (!audioUrl) {
        throw new Error(`AIMAX TTS completed without audio_url for job ${jobId}.`);
      }
      if (requireSrt && !srtUrl) {
        if (!firstAudioReadyAt) firstAudioReadyAt = Date.now();
        if (srtReadyTimeoutMs > 0 && Date.now() - firstAudioReadyAt >= srtReadyTimeoutMs) {
          throw new Error(`AIMAX TTS completed without srt_url for job ${jobId}.`);
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (preferSegments && !segmentsUrl) {
        if (!firstSegmentsWaitAt) firstSegmentsWaitAt = Date.now();
        const timedOut = segmentsReadyTimeoutMs <= 0 || Date.now() - firstSegmentsWaitAt >= segmentsReadyTimeoutMs;
        if (requireSegments && timedOut) {
          throw new Error(`AIMAX TTS completed without segments_url for job ${jobId}.`);
        }
        if (!timedOut) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      }
      return data;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`AIMAX TTS job failed: ${data.error_message || data.message || jobId}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const detail = [lastStatus ? `last status ${lastStatus}` : '', lastProgress].filter(Boolean).join(', ');
  throw new Error(`AIMAX TTS job timed out after ${Math.round(pollTimeoutMs / 1000)}s: ${jobId}${detail ? ` (${detail})` : ''}`);
}

async function downloadAudio(audioUrl, outputPath, config = {}) {
  const url = /^https?:\/\//i.test(audioUrl) ? audioUrl : `${baseUrl(config)}${audioUrl}`;
  const response = await fetchWithNetworkRetry(url, {
    headers: { 'X-API-Key': apiKey(config) },
    signal: config.abortSignal,
  });
  if (!response.ok) {
    throw new Error(`AIMAX audio download failed (${response.status}): ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error('AIMAX audio download returned an empty file.');
  }
  await fs.writeFile(outputPath, bytes);
}

async function downloadSegmentsZip(segmentsUrl, outputPath, config = {}) {
  const url = /^https?:\/\//i.test(segmentsUrl) ? segmentsUrl : `${baseUrl(config)}${segmentsUrl}`;
  const response = await fetchWithNetworkRetry(url, {
    headers: { 'X-API-Key': apiKey(config) },
    signal: config.abortSignal,
  });
  if (!response.ok) {
    throw new Error(`AIMAX segments download failed (${response.status}): ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error('AIMAX segments download returned an empty file.');
  }
  await fs.writeFile(outputPath, bytes);
}

function firstString(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function extractAudioUrl(data = {}) {
  return firstString(
    data.audio_url,
    data.audioUrl,
    data.generated_audio_cdn_url,
    data.generatedAudioCdnUrl,
    data.output_audio_url,
    data.outputAudioUrl,
    data.result?.audio_url,
    data.result?.audioUrl,
    data.output?.audio_url,
    data.output?.audioUrl
  );
}

function extractSrtUrl(data = {}) {
  return firstString(
    data.srt_url,
    data.srtUrl,
    data.subtitle_url,
    data.subtitleUrl,
    data.subtitles_url,
    data.subtitlesUrl,
    data.caption_url,
    data.captionUrl,
    data.captions_url,
    data.captionsUrl,
    data.result?.srt_url,
    data.result?.srtUrl,
    data.output?.srt_url,
    data.output?.srtUrl
  );
}

function extractSegmentsUrl(data = {}) {
  return firstString(
    data.segments_url,
    data.segmentsUrl,
    data.chunks_url,
    data.chunksUrl,
    data.segment_zip_url,
    data.segmentZipUrl,
    data.result?.segments_url,
    data.result?.segmentsUrl,
    data.result?.chunks_url,
    data.result?.chunksUrl,
    data.output?.segments_url,
    data.output?.segmentsUrl,
    data.output?.chunks_url,
    data.output?.chunksUrl
  );
}

async function downloadTextAsset(assetUrl, outputPath, config = {}) {
  const url = /^https?:\/\//i.test(assetUrl) ? assetUrl : `${baseUrl(config)}${assetUrl}`;
  const response = await fetchWithNetworkRetry(url, {
    headers: { 'X-API-Key': apiKey(config) },
    signal: config.abortSignal,
  });
  if (!response.ok) {
    throw new Error(`AIMAX text asset download failed (${response.status}): ${response.statusText}`);
  }
  const text = await response.text();
  if (!String(text || '').trim()) {
    throw new Error('AIMAX text asset download returned an empty file.');
  }
  await fs.writeFile(outputPath, text, 'utf8');
}

async function synthesizeSegmentAudio(segment, config, outputPath, overrides = {}) {
  throwIfAborted(config);
  const text = String(overrides.text ?? segment.text ?? '').trim();
  const speakingRate = clamp(Number(overrides.speakingRate || config.speakingRate || 1), 0.5, 2.0);
  if (!text) {
    await fs.writeFile(outputPath, Buffer.alloc(0));
    return { outputPath, speakingRate, text };
  }

  const releaseJobSlot = await acquireAimaxJobSlot(config);
  try {
    const created = await createTtsJob(text, config, { speakingRate });
    const completed = created.audioUrl
      ? { audio_url: created.audioUrl }
      : await waitForJob(created.jobId, config);
    await downloadAudio(completed.audio_url, outputPath, config);
    return { outputPath, speakingRate, text };
  } catch (error) {
    const wrapped = new Error(`AIMAX TTS failed: ${error.message || error}`);
    wrapped.status = error.status;
    wrapped.statusCode = error.statusCode;
    wrapped.rateLimitRetryMs = error.rateLimitRetryMs;
    throw wrapped;
  } finally {
    releaseJobSlot();
  }
}

async function synthesizeTextWithSrt(text, config, outputAudioPath, outputSrtPath, overrides = {}) {
  throwIfAborted(config);
  const value = String(text || '').trim();
  if (!value) {
    throw new Error('AIMAX SRT TTS requires non-empty text.');
  }

  const releaseJobSlot = await acquireAimaxJobSlot(config);
  try {
    const segmentsOnly = overrides.segmentsOnly === true;
    const existingJobId = String(overrides.existingJobId || '').trim();
    const created = existingJobId
      ? {
        jobId: existingJobId,
        status: 'resuming',
        audioUrl: '',
        srtUrl: '',
        segmentsUrl: '',
        charsDeducted: 0,
        speakingRate: clamp(Number(overrides.speakingRate || config.speakingRate || 1), 0.5, 2.0),
      }
      : await createTtsJob(value, config, {
        speakingRate: overrides.speakingRate,
        enableSrt: true,
        splitByLine: overrides.splitByLine !== false,
        matchSrtTime: false,
      });
    if (!existingJobId && typeof overrides.onJobCreated === 'function') {
      await overrides.onJobCreated(created);
    }
    const preferSegments = segmentsOnly || overrides.preferSegments === true || Boolean(overrides.segmentsZipPath) || overrides.requireSegments === true;
    const shouldPoll = segmentsOnly
      ? (!created.segmentsUrl && created.jobId)
      : (!created.audioUrl || !created.srtUrl || (preferSegments && !created.segmentsUrl && created.jobId));
    const completed = !shouldPoll
      ? created
      : await waitForJob(created.jobId, config, {
        requireSrt: !segmentsOnly,
        preferSegments,
        requireSegments: segmentsOnly || overrides.requireSegments === true,
        segmentsOnly,
      });
    const audioUrl = extractAudioUrl(completed);
    const srtUrl = extractSrtUrl(completed);
    const segmentsUrl = extractSegmentsUrl(completed);
    if (segmentsOnly) {
      if (!segmentsUrl) {
        throw new Error(`AIMAX SRT TTS completed without segments_url for job ${created.jobId || ''}.`);
      }
      if (overrides.segmentsZipPath) {
        await downloadSegmentsZip(segmentsUrl, overrides.segmentsZipPath, config);
      }
      return {
        jobId: created.jobId || completed.job_id || completed.id || '',
        status: completed.status || created.status || '',
        audioUrl,
        srtUrl,
        segmentsUrl,
        segmentsZipPath: overrides.segmentsZipPath || '',
        outputAudioPath: '',
        outputSrtPath: '',
        speakingRate: created.speakingRate,
        charsDeducted: created.charsDeducted,
        text: value,
      };
    }
    if (!audioUrl) {
      throw new Error(`AIMAX SRT TTS completed without audio_url for job ${created.jobId || ''}.`);
    }
    if (!srtUrl) {
      throw new Error(`AIMAX SRT TTS completed without srt_url for job ${created.jobId || ''}.`);
    }
    await downloadAudio(audioUrl, outputAudioPath, config);
    await downloadTextAsset(srtUrl, outputSrtPath, config);
    if (overrides.segmentsZipPath && segmentsUrl) {
      await downloadSegmentsZip(segmentsUrl, overrides.segmentsZipPath, config);
    }
    return {
      jobId: created.jobId || completed.job_id || completed.id || '',
      status: completed.status || created.status || '',
      audioUrl,
      srtUrl,
      segmentsUrl,
      segmentsZipPath: segmentsUrl && overrides.segmentsZipPath ? overrides.segmentsZipPath : '',
      outputAudioPath,
      outputSrtPath,
      speakingRate: created.speakingRate,
      charsDeducted: created.charsDeducted,
      text: value,
    };
  } catch (error) {
    const wrapped = new Error(`AIMAX SRT TTS failed: ${error.message || error}`);
    wrapped.status = error.status;
    wrapped.statusCode = error.statusCode;
    wrapped.rateLimitRetryMs = error.rateLimitRetryMs;
    throw wrapped;
  } finally {
    releaseJobSlot();
  }
}

async function previewVoice(text, config = {}) {
  const tempFile = path.join(os.tmpdir(), `dubflow_aimax_preview_${Date.now()}.mp3`);
  try {
    await synthesizeSegmentAudio({ text: text || 'Day la cau nghe thu giong doc cho DubFlow.' }, config, tempFile);
    return await fs.readFile(tempFile);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

module.exports = {
  listVoices,
  previewVoice,
  synthesizeSegmentAudio,
  synthesizeTextWithSrt,
  _private: {
    acquireAimaxJobSlot,
    resolveMaxConcurrentJobs,
    resolveApiRateLimit,
    resolvePollTimeoutMs,
    resolveSrtReadyTimeoutMs,
    resolveSegmentsReadyTimeoutMs,
    resolveHttpRetryAttempts,
    describeAimaxApiFailure,
    isTransientHttpStatus,
    extractAudioUrl,
    extractSrtUrl,
    extractSegmentsUrl,
    createTtsJob,
    downloadSegmentsZip,
    resetAimaxJobSlotsForTest() {
      activeJobSlotQueue.splice(0, activeJobSlotQueue.length);
      activeJobSlotCount = 0;
    },
    activeAimaxJobSlotsForTest() {
      return activeJobSlotCount;
    },
  },
};
