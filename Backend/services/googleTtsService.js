const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getGoogleRequestOptions } = require('./googleAuthService');
const { resolvePythonExecutable } = require('./pythonRuntimeService');
const edgeTtsService = require('./edgeTtsService');
const aimaxTtsService = require('./aimaxTtsService');

const TTS_SCOPE = ['https://www.googleapis.com/auth/cloud-platform'];
const execFileAsync = promisify(execFile);
const googleVoiceListCache = new Map();

function isEdgeTtsProvider(config = {}) {
  return String(config.ttsProvider || '').trim() === 'edge_tts';
}

function isAimaxProvider(config = {}) {
  return String(config.ttsProvider || '').trim() === 'aimax_tts';
}

function throwIfAborted(config = {}) {
  if (config.abortSignal?.aborted) {
    throw new Error('Operation canceled.');
  }
}

function ttsErrorMessage(error) {
  return String(error?.message || error || 'TTS failed.').replace(/\s+/g, ' ').trim();
}

function buildFailedClip(segment = {}, index = 0, error = null, apiAttempt = 1, provider = '') {
  const message = ttsErrorMessage(error);
  return {
    id: segment.id,
    index,
    provider,
    path: '',
    start: segment.start,
    end: segment.end,
    duration: segment.duration,
    allowedDuration: segment.allowedDuration,
    slotDuration: segment.slotDuration,
    borrowableGap: segment.borrowableGap,
    actualDuration: 0,
    ttsSpeakingRate: Number(segment.suggestedRate) || 1,
    ttsSpeedAppliedByProvider: ['aimax_tts', 'google_cloud_tts', 'edge_tts'].includes(provider),
    allowPostTtsSpeedProcessing: false,
    ttsAttempts: 0,
    ttsApiAttempts: apiAttempt,
    ttsRatio: 0,
    ttsOverflowSeconds: 0,
    ttsFit: segment.ttsFit || null,
    ttsFailed: true,
    ttsError: true,
    errorCode: 'TTS_FAILED',
    errorMessage: message,
    error_reason: message,
    sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds : [],
    sourceRowIds: Array.isArray(segment.sourceRowIds) ? segment.sourceRowIds : [],
  };
}

function isChirpHdVoice(voiceName = '') {
  return voiceName.includes('Chirp3-HD') || voiceName.includes('Chirp-HD');
}

function normalizeGender(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'MALE' || text === 'FEMALE' || text === 'NEUTRAL') return text;
  if (text === 'ALL') return '';
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  if (text.startsWith('N')) return 'NEUTRAL';
  return '';
}

function resolveGenderPreference(config = {}) {
  return normalizeGender(config.voiceGenderFilter) || normalizeGender(config.ssmlGender);
}

function inferGoogleVoiceGender(voiceName = '') {
  const lower = String(voiceName || '').toLowerCase();
  if (/(charon|fenrir|iapetus|puck)/i.test(lower)) return 'MALE';
  if (/(achernar|aoede|gacrux)/i.test(lower)) return 'FEMALE';
  return '';
}

function voiceGender(voice = {}) {
  return normalizeGender(voice.ssmlGender || voice.gender || voice.SsmlGender) || inferGoogleVoiceGender(voice.name || voice.voiceName);
}

function voiceName(voice = {}) {
  return String(voice.name || voice.voiceName || voice.ShortName || '').trim();
}

function languageMatches(candidate, requested) {
  const candidateText = String(candidate || '').trim().toLowerCase();
  const requestedText = String(requested || '').trim().toLowerCase();
  if (!candidateText || !requestedText) return true;
  const aliases = {
    'zh-cn': ['cmn-cn'],
    'cmn-cn': ['zh-cn'],
  };
  return candidateText === requestedText
    || candidateText.startsWith(`${requestedText}-`)
    || requestedText.startsWith(`${candidateText}-`)
    || (aliases[requestedText] || []).includes(candidateText)
    || (aliases[candidateText] || []).includes(requestedText);
}

function voiceSupportsLanguage(voice = {}, requestedLanguage = '') {
  const codes = Array.isArray(voice.languageCodes) ? voice.languageCodes : [];
  if (!codes.length) return true;
  return codes.some((code) => languageMatches(code, requestedLanguage));
}

function googleVoiceCacheKey(languageCode, config = {}) {
  return [
    String(languageCode || config.ttsLanguageCode || 'vi-VN').trim(),
    String(config.credentialsMode || '').trim(),
    String(config.projectId || '').trim(),
    String(config.apiKey || '').trim(),
    String(config.applicationCredentials || '').trim(),
  ].join('|');
}

async function fetchGoogleVoices(languageCode, config = {}) {
  const requestedLanguage = languageCode || config.ttsLanguageCode || 'vi-VN';
  const cacheKey = googleVoiceCacheKey(requestedLanguage, config);
  if (!googleVoiceListCache.has(cacheKey)) {
    googleVoiceListCache.set(cacheKey, (async () => {
      const requestOptions = await getGoogleRequestOptions(config, TTS_SCOPE);
      const response = await axios.get('https://texttospeech.googleapis.com/v1/voices', {
        params: {
          ...requestOptions.params,
          languageCode: requestedLanguage,
        },
        headers: requestOptions.headers,
      });
      return response.data.voices || [];
    })());
  }
  return googleVoiceListCache.get(cacheKey);
}

async function resolveGoogleVoiceConfig(config = {}) {
  const languageCode = config.ttsLanguageCode || config.targetLanguage;
  const requestedName = String(config.ttsVoiceName || '').trim();
  const requestedGender = resolveGenderPreference(config);
  const voice = { languageCode };

  // Google Cloud TTS rejects SSML_VOICE_GENDER_NEUTRAL for synthesis.
  // In DubFlow, NEUTRAL means "no gender preference", so omit the field and
  // let the selected voice (or Google) determine the gender.
  if (requestedGender && requestedGender !== 'NEUTRAL') {
    voice.ssmlGender = requestedGender;
  }

  if (!requestedName && (!requestedGender || requestedGender === 'NEUTRAL')) {
    return voice;
  }

  const voices = await fetchGoogleVoices(languageCode, config);

  const selected = voices.find((item) => voiceName(item) === requestedName);
  if (requestedName) {
    if (!selected) {
      throw new Error(`Selected Google TTS voice '${requestedName}' was not found for language '${languageCode}'.`);
    }
    if (!voiceSupportsLanguage(selected, languageCode)) {
      throw new Error(`Selected Google TTS voice '${requestedName}' does not support language '${languageCode}'.`);
    }
    const selectedGender = voiceGender(selected);
    if (requestedGender && requestedGender !== 'NEUTRAL' && selectedGender && selectedGender !== requestedGender) {
      throw new Error(`Selected Google TTS voice '${requestedName}' is ${selectedGender}, not requested ${requestedGender}.`);
    }
    voice.name = requestedName;
    return voice;
  }

  if (selected && (!requestedGender || requestedGender === 'NEUTRAL' || voiceGender(selected) === requestedGender)) {
    voice.name = requestedName;
    return voice;
  }

  if (requestedGender && requestedGender !== 'NEUTRAL') {
    const matched = voices.find((item) => voiceGender(item) === requestedGender);
    if (matched) {
      voice.name = voiceName(matched);
    }
  }

  return voice;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEdgeNoAudioError(error) {
  const message = String(error?.stderr || error?.message || error || '').toLowerCase();
  return message.includes('no audio was received')
    || message.includes('noaudioreceived')
    || message.includes('produced no audio')
    || message.includes('produced an empty audio')
    || message.includes('empty audio file');
}

function isQuotaExhaustedError(error) {
  const message = String(error?.stderr || error?.message || error || '').toLowerCase();
  const status = Number(error?.response?.status || error?.status || error?.statusCode);
  return status === 429
    || message.includes('resource has been exhausted')
    || message.includes('resource_exhausted')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests');
}

function quotaRetryDelayMs(apiAttempt = 1, failed = []) {
  const serverDelayMs = Math.max(0, ...failed.map((item) => Number(item?.error?.rateLimitRetryMs) || 0));
  if (serverDelayMs > 0) {
    return Math.min(90000, serverDelayMs + 500);
  }
  return Math.min(45000, 4000 * (2 ** Math.max(0, apiAttempt - 1)));
}

function summarizeFailedSegments(failed = [], limit = 8) {
  const items = failed.slice(0, limit).map((item) => `#${item.index + 1}: ${item.error?.message || item.error}`);
  if (failed.length > limit) {
    items.push(`... and ${failed.length - limit} more segment(s)`);
  }
  return items.join('; ');
}

async function buildGoogleVoiceConfig(config = {}) {
  const voice = {
    languageCode: config.ttsLanguageCode || config.targetLanguage,
  };

  if (config.ttsProvider === 'google_cloud_tts') {
    return resolveGoogleVoiceConfig(config);
  }

  if (config.ttsVoiceName) {
    voice.name = config.ttsVoiceName;
  } else if (config.ssmlGender) {
    voice.ssmlGender = config.ssmlGender;
  }

  return voice;
}

async function getAudioDuration(filePath) {
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

function shortenTextForDuration(text, targetDurationSeconds) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;

  const cps = 13; // conservative Vietnamese-oriented fallback for dubbing.
  const maxChars = Math.max(14, Math.floor(Math.max(0.1, targetDurationSeconds) * cps));
  if (cleaned.length <= maxChars) return cleaned;

  const pieces = cleaned
    .split(/([,.;:!?\uff0c\u3002\uff01\uff1f\uff1b\uff1a])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const combined = `${token}${next}`.trim();
        if (combined) parts.push(combined);
      }
      return parts;
    }, []);

  if (pieces.length > 1) {
    let out = '';
    for (const piece of pieces) {
      const candidate = out ? `${out} ${piece}` : piece;
      if (candidate.length > maxChars) break;
      out = candidate;
    }
    if (out && out.length >= Math.floor(maxChars * 0.6)) return out;
  }

  const words = cleaned.split(/\s+/);
  let compact = '';
  for (const word of words) {
    const candidate = compact ? `${compact} ${word}` : word;
    if (candidate.length > maxChars) break;
    compact = candidate;
  }

  if (compact && compact.length >= Math.floor(maxChars * 0.55)) return compact;
  return cleaned.slice(0, maxChars).trim();
}

function shortenTextByRatio(text, keepRatio) {
  const cleaned = compactVietnameseDubbingText(String(text || '').replace(/\s+/g, ' ').trim());
  if (!cleaned) return cleaned;

  const maxChars = Math.max(18, Math.floor(cleaned.length * keepRatio));
  if (cleaned.length <= maxChars) return cleaned;

  const softened = cleanVietnameseDubbingText(cleaned);
  if (softened.length <= maxChars || softened.length < cleaned.length) {
    return softened;
  }

  const clauses = cleaned
    .split(/([,.;:!?\u3002\uff01\uff1f\uff1b\uff1a\uff0c])/)
    .reduce((parts, token, index, source) => {
      if (index % 2 === 0) {
        const next = source[index + 1] || '';
        const combined = `${token}${next}`.trim();
        if (combined) parts.push(combined);
      }
      return parts;
    }, []);

  if (clauses.length > 1) {
    let out = '';
    for (const clause of clauses) {
      const candidate = out ? `${out} ${clause}` : clause;
      if (candidate.length > maxChars) break;
      out = candidate;
    }
    if (out && out.length >= Math.floor(maxChars * 0.65)) return out;
  }

  const words = cleaned.split(/\s+/);
  let out = '';
  for (const word of words) {
    const candidate = out ? `${out} ${word}` : word;
    if (candidate.length > maxChars) break;
    out = candidate;
  }

  return out || shortenTextForDuration(cleaned, Math.max(0.5, maxChars / 13));
}

function compactVietnameseDubbingText(text) {
  return String(text || '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanVietnameseDubbingText(text) {
  return compactVietnameseDubbingText(String(text || ''))
    .replace(/\s+/g, ' ')
    .replace(/\bđã cố gắng\b/gi, 'cố')
    .replace(/\bcố gắng\b/gi, 'cố')
    .replace(/\btuy nhiên\b/gi, 'nhưng')
    .replace(/\bmột cách\b/gi, '')
    .replace(/\bthực sự\b/gi, '')
    .replace(/\brất nhiều\b/gi, 'nhiều')
    .replace(/\bvô cùng\b/gi, 'rất')
    .replace(/\bhang động\b/gi, 'hang')
    .replace(/\banh ta\b/gi, 'anh')
    .replace(/\bcô ta\b/gi, 'cô')
    .replace(/\bngười đàn ông\b/gi, 'người này')
    .replace(/\bngười phụ nữ\b/gi, 'người này')
    .replace(/\bnhanh chóng bị mất phương hướng\b/gi, 'nhanh chóng mất phương hướng')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function rewriteTextForDuration(text, segment, config, overflowSeconds) {
  if (config.allowTextShortening !== true) {
    return text;
  }

  const keepRatio = overflowSeconds <= (Number(config.retryOverflowSeconds) || 1.5) ? 0.9 : 0.82;
  return shortenTextByRatio(text, keepRatio);
}
async function synthesizeSegmentAudio(segment, config, outputPath, overrides = {}) {
  throwIfAborted(config);
  const text = String(overrides.text ?? segment.text ?? '').trim();
  const requestedSpeakingRate = Number(overrides.speakingRate || segment.suggestedRate || config.speakingRate || 1);
  if (!text) {
    await fs.writeFile(outputPath, Buffer.alloc(0));
    return { outputPath, speakingRate: requestedSpeakingRate, text };
  }

  if (isEdgeTtsProvider(config)) {
    const speakingRate = requestedSpeakingRate;
    try {
      await execFileAsync(
        resolvePythonExecutable(),
        [
          path.join(__dirname, '..', 'scripts', 'edge_tts_helper.py'),
          'synthesize',
          '--text',
          text,
          '--voice',
          edgeTtsService.resolveEdgeVoiceName(config),
          '--language-code',
          config.ttsLanguageCode || 'vi-VN',
          '--gender',
          edgeTtsService.resolveGenderPreference(config),
          '--rate',
          edgeTtsService.toEdgeRate(speakingRate),
          '--output',
          outputPath,
        ],
        {
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          signal: config.abortSignal,
        }
      );
      return { outputPath, speakingRate, text };
    } catch (error) {
      const message = error.stderr || error.message || 'Unknown Edge TTS error';
      throw new Error(`TTS failed: ${message}`);
    }
  }

  if (isAimaxProvider(config)) {
    return aimaxTtsService.synthesizeSegmentAudio(segment, config, outputPath, overrides);
  }

  const requestOptions = await getGoogleRequestOptions(config, TTS_SCOPE);

  try {
    const audioConfig = {
      audioEncoding: 'MP3',
      speakingRate: requestedSpeakingRate || 1,
    };
    const requestedSampleRate = Number(config.audioSampleRate || config.outputSampleRate || 32000);
    if (Number.isFinite(requestedSampleRate) && requestedSampleRate >= 16000 && requestedSampleRate <= 48000) {
      audioConfig.sampleRateHertz = Math.round(requestedSampleRate);
    }

    if (!isChirpHdVoice(config.ttsVoiceName || '')) {
      audioConfig.pitch = Number(config.pitch) || 0;
    }

    const response = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        input: { text },
        voice: await buildGoogleVoiceConfig(config),
        audioConfig,
      },
      {
        params: requestOptions.params,
        headers: requestOptions.headers,
        signal: config.abortSignal,
      }
    );

    await fs.writeFile(outputPath, Buffer.from(response.data.audioContent, 'base64'));
    return { outputPath, speakingRate: Number(audioConfig.speakingRate || 1), text };
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message;
    throw new Error(`TTS failed: ${message}`);
  }
}

async function synthesizeSegmentWithDurationFit(segment, config, outputPath) {
  throwIfAborted(config);
  const segmentStart = Number(segment.start) || 0;
  const segmentEnd = Number(segment.end) || 0;
  const timelineDuration = segmentEnd > segmentStart ? segmentEnd - segmentStart : 0;
  const nominalDuration = Math.max(0.1, Number(segment.duration) || 0, timelineDuration);
  const allowedDuration = Math.max(nominalDuration, Number(segment.allowedDuration) || nominalDuration);
  const defaultAcceptOverflowSeconds = Math.max(0, Number(config.acceptOverflowSeconds) || 0);
  const defaultRetryOverflowSeconds = Math.max(defaultAcceptOverflowSeconds, Number(config.retryOverflowSeconds) || 2.5);
  const acceptOverflowSeconds = segment.naturalPhrase
    ? Math.min(defaultAcceptOverflowSeconds, 0.25)
    : defaultAcceptOverflowSeconds;
  const retryOverflowSeconds = segment.naturalPhrase
    ? Math.max(acceptOverflowSeconds, Math.min(defaultRetryOverflowSeconds, 0.65))
    : defaultRetryOverflowSeconds;
  const retryLimitDuration = allowedDuration + acceptOverflowSeconds;
  const preserveTtsAudio = config.preserveTtsAudio !== false;
  const allowDurationControl = !preserveTtsAudio && config.ttsDurationControl !== false && nominalDuration > 0.2;

  if (!allowDurationControl) {
    const result = await synthesizeSegmentAudio(segment, config, outputPath);
    const actualDuration = await getAudioDuration(outputPath);
    return {
      outputPath,
      actualDuration,
      speakingRate: result.speakingRate,
      usedText: result.text,
      attempts: 1,
      ratio: allowedDuration > 0 ? actualDuration / allowedDuration : 1,
      overflowSeconds: Math.max(0, actualDuration - allowedDuration),
    };
  }

  let text = String(segment.text || '').trim();
  const baseSpeakingRate = clamp(Number(segment.suggestedRate || config.speakingRate) || 1, 0.75, 2.0);
  let speakingRate = baseSpeakingRate;
  const minSpeakingRate = clamp(Math.max(Number(config.minSpeakingRate) || baseSpeakingRate, baseSpeakingRate), baseSpeakingRate, 2.0);
  const maxSpeakingRate = clamp(Math.max(Number(config.maxSpeakingRate) || 1.25, minSpeakingRate), minSpeakingRate, 2.0);

  const configuredAttempts = Number(config.ttsMaxAttempts);
  const maxAttempts = Math.max(1, Math.min(4, Math.round(Number.isFinite(configuredAttempts) ? configuredAttempts : (isEdgeTtsProvider(config) ? 2 : 3))));

  let best = null;
  const attemptPaths = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptPath = attempt === maxAttempts ? outputPath : outputPath.replace(/\.(mp3|wav)$/i, `_attempt${attempt}.$1`);
    if (attemptPath !== outputPath) {
      attemptPaths.push(attemptPath);
    }
    const synth = await synthesizeSegmentAudio(segment, config, attemptPath, { text, speakingRate });
    const actualDuration = await getAudioDuration(attemptPath);
    const ratio = allowedDuration > 0 ? actualDuration / allowedDuration : 1;
    const overflowSeconds = Math.max(0, actualDuration - allowedDuration);

    const snapshot = {
      outputPath: attemptPath,
      actualDuration,
      ratio,
      overflowSeconds,
      speakingRate: synth.speakingRate,
      usedText: synth.text,
      attempts: attempt,
    };
    if (!best || snapshot.overflowSeconds < best.overflowSeconds) {
      best = snapshot;
    }

    if (actualDuration <= retryLimitDuration) {
      best = snapshot;
      break;
    }

    if (actualDuration > retryLimitDuration) {
      const neededRate = actualDuration / Math.max(0.1, retryLimitDuration);
      const nextRate = clamp(speakingRate * Math.min(1.08, neededRate), speakingRate, maxSpeakingRate);
      if (nextRate > speakingRate + 0.01) {
        speakingRate = nextRate;
        continue;
      }

      if (config.allowTextShortening !== true) {
        best = snapshot;
        break;
      }

      const shorter = await rewriteTextForDuration(text, segment, config, overflowSeconds);
      if (shorter && shorter !== text) {
        text = shorter;
        speakingRate = clamp(Math.max(speakingRate, minSpeakingRate), minSpeakingRate, maxSpeakingRate);
      }
      continue;
    }

    // Clip is short: keep the user's chosen speed and let sync add natural silence.
    break;
  }

  if (best && best.outputPath !== outputPath) {
    await fs.copyFile(best.outputPath, outputPath);
  }
  await Promise.all(attemptPaths.map((attemptPath) => fs.rm(attemptPath, { force: true }).catch(() => {})));

  const finalDuration = await getAudioDuration(outputPath);
  return {
    outputPath,
    actualDuration: finalDuration || (best?.actualDuration || 0),
    speakingRate: best?.speakingRate || speakingRate,
    usedText: best?.usedText || text,
    attempts: best?.attempts || 1,
    ratio: allowedDuration > 0 ? (finalDuration || best?.actualDuration || 0) / allowedDuration : 1,
    overflowSeconds: Math.max(0, (finalDuration || best?.actualDuration || 0) - allowedDuration),
  };
}

async function previewVoice(text, config) {
  if (isEdgeTtsProvider(config)) {
    return edgeTtsService.previewVoice(text, config);
  }

  if (isAimaxProvider(config)) {
    return aimaxTtsService.previewVoice(text, config);
  }

  const requestOptions = await getGoogleRequestOptions(config, TTS_SCOPE);
  const audioConfig = {
    audioEncoding: 'MP3',
    speakingRate: Number(config.speakingRate) || 1,
  };
  const requestedSampleRate = Number(config.audioSampleRate || config.outputSampleRate || 32000);
  if (Number.isFinite(requestedSampleRate) && requestedSampleRate >= 16000 && requestedSampleRate <= 48000) {
    audioConfig.sampleRateHertz = Math.round(requestedSampleRate);
  }

  if (!isChirpHdVoice(config.ttsVoiceName || '')) {
    audioConfig.pitch = Number(config.pitch) || 0;
  }

  const response = await axios.post(
    'https://texttospeech.googleapis.com/v1/text:synthesize',
    {
      input: { text: text || 'This is a voice preview.' },
      voice: await buildGoogleVoiceConfig(config),
      audioConfig,
    },
    {
      params: requestOptions.params,
      headers: requestOptions.headers,
    }
  );

  return Buffer.from(response.data.audioContent, 'base64');
}

async function synthesizeAllSegments(segments, config, outputDir, options = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  throwIfAborted(config);
  const clips = new Array(segments.length);
  const progress = {
    total: segments.length,
    done: 0,
    generated: 0,
    reused: 0,
    failed: 0,
  };
  async function emitProgress() {
    if (typeof options.onProgress !== 'function') return;
    await options.onProgress({ ...progress }).catch(() => {});
  }
  const requestedIndices = Array.isArray(options.indices)
    ? [...new Set(options.indices.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < segments.length))]
    : null;
  const existingClips = Array.isArray(options.existingClips) ? options.existingClips : [];
  for (const clip of existingClips) {
    const index = Number(clip?.index);
    const clipPath = String(clip?.path || '').trim();
    if (!Number.isInteger(index) || index < 0 || index >= segments.length || !clipPath) continue;
    try {
      await fs.access(clipPath);
      clips[index] = {
        ...clip,
        id: segments[index].id,
        index,
        start: segments[index].start,
        end: segments[index].end,
        duration: segments[index].duration,
        allowedDuration: segments[index].allowedDuration,
        slotDuration: segments[index].slotDuration,
        borrowableGap: segments[index].borrowableGap,
      };
      progress.reused += 1;
      progress.done += 1;
    } catch {
      // Missing old clips are regenerated below.
    }
  }
  if (progress.reused) {
    await emitProgress();
  }
  const isAimax = isAimaxProvider(config);
  const isEdge = isEdgeTtsProvider(config);
  const retryFailedSegments = true;
  const continueOnTtsError = config.continueOnTtsError === true;
  const configuredConcurrency = Number(config.ttsConcurrency);
  const defaultConcurrency = isEdge ? 20 : isAimax ? 30 : 3;
  const maxConcurrency = isEdge ? 20 : isAimax ? 30 : 20;
  const concurrency = Math.max(1, Math.min(maxConcurrency, Math.round(Number.isFinite(configuredConcurrency) ? configuredConcurrency : defaultConcurrency)));
  const maxFailedSegmentAttempts = retryFailedSegments
    ? Math.max(1, Math.min(isEdge ? 6 : 5, Math.round(Number(config.ttsMaxAttempts) || (isEdge ? 4 : 3))))
    : 1;
  let firstError = null;

  async function synthesizeAt(index, apiAttempt = 1) {
    throwIfAborted(config);
    const outputPath = path.join(outputDir, `segment_${index}.mp3`);
    const fit = await synthesizeSegmentWithDurationFit(segments[index], config, outputPath);
    throwIfAborted(config);
    clips[index] = {
      id: segments[index].id,
      index,
      provider: config.ttsProvider,
      path: outputPath,
      start: segments[index].start,
      end: segments[index].end,
      duration: segments[index].duration,
      allowedDuration: segments[index].allowedDuration,
      slotDuration: segments[index].slotDuration,
      borrowableGap: segments[index].borrowableGap,
      actualDuration: fit.actualDuration,
      ttsSpeakingRate: fit.speakingRate,
      ttsSpeedAppliedByProvider: ['aimax_tts', 'google_cloud_tts', 'edge_tts'].includes(config.ttsProvider),
      allowPostTtsSpeedProcessing: !['aimax_tts', 'google_cloud_tts', 'edge_tts'].includes(config.ttsProvider),
      ttsAttempts: fit.attempts,
      ttsApiAttempts: apiAttempt,
      ttsRatio: Number((fit.ratio || 1).toFixed(3)),
      ttsOverflowSeconds: Number((fit.overflowSeconds || 0).toFixed(3)),
      ttsFit: segments[index].ttsFit || null,
    };
    progress.generated += 1;
    progress.done += 1;
    await emitProgress();
  }

  async function worker(indices, failed, apiAttempt, cursor) {
    while (!firstError) {
      if (config.abortSignal?.aborted) {
        firstError = new Error('Operation canceled.');
        break;
      }
      const index = indices[cursor.next];
      cursor.next += 1;
      if (index === undefined) break;
      try {
        await synthesizeAt(index, apiAttempt);
      } catch (error) {
        if (retryFailedSegments) {
          failed.push({ index, error });
        } else {
          firstError = error;
          break;
        }
      }
    }
  }

  const pendingIndices = requestedIndices !== null
    ? requestedIndices.filter((index) => !clips[index])
    : segments.map((_, index) => index);

  if (isEdge) {
    const queue = pendingIndices.map((index) => ({ index, attempt: 1 }));
    const cursor = { next: 0 };
    const failed = [];

    async function edgeWorker() {
      while (!firstError) {
        if (config.abortSignal?.aborted) {
          firstError = new Error('Operation canceled.');
          break;
        }

        const item = queue[cursor.next];
        cursor.next += 1;
        if (!item) break;

        try {
          await synthesizeAt(item.index, item.attempt);
        } catch (error) {
          const retryableForContinue = continueOnTtsError || isEdgeNoAudioError(error);
          if (retryableForContinue && item.attempt < maxFailedSegmentAttempts) {
            await sleep(Math.min(6000, 650 * item.attempt));
            queue.push({ index: item.index, attempt: item.attempt + 1 });
            continue;
          }
          if (retryableForContinue) {
            failed.push({ index: item.index, error });
            continue;
          }
          firstError = error;
          break;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => edgeWorker()));

    if (firstError) {
      throw firstError;
    }
    if (failed.length) {
      const failedList = summarizeFailedSegments(failed);
      if (continueOnTtsError) {
        for (const item of failed) {
          clips[item.index] = buildFailedClip(segments[item.index], item.index, item.error, maxFailedSegmentAttempts, config.ttsProvider);
          progress.failed += 1;
          progress.done += 1;
        }
        await emitProgress();
        return clips.filter(Boolean);
      }
      throw new Error(`Edge TTS failed after ${maxFailedSegmentAttempts} attempts for segment(s): ${failedList}`);
    }

    return clips.filter(Boolean);
  }

  let pending = pendingIndices;
  for (let apiAttempt = 1; apiAttempt <= maxFailedSegmentAttempts && pending.length; apiAttempt += 1) {
    const failed = [];
    const cursor = { next: 0 };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker(pending, failed, apiAttempt, cursor)));
    if (firstError) break;
    pending = failed.map((item) => item.index);
    if (pending.length && apiAttempt < maxFailedSegmentAttempts) {
      const quotaLimited = failed.some((item) => isQuotaExhaustedError(item.error));
      if (quotaLimited) {
        await sleep(quotaRetryDelayMs(apiAttempt, failed));
      } else if (isAimax) {
        await sleep(Math.min(6000, 900 * apiAttempt));
      }
    }
    if (pending.length && apiAttempt >= maxFailedSegmentAttempts) {
      const failedList = summarizeFailedSegments(failed);
      const providerLabel = isAimax ? 'AIMAX' : isEdge ? 'Edge' : 'Google Cloud';
      if (continueOnTtsError) {
        for (const item of failed) {
          clips[item.index] = buildFailedClip(segments[item.index], item.index, item.error, apiAttempt, config.ttsProvider);
          progress.failed += 1;
          progress.done += 1;
        }
        await emitProgress();
        pending = [];
        break;
      }
      throw new Error(`${providerLabel} TTS failed after ${maxFailedSegmentAttempts} attempts for segment(s): ${failedList}`);
    }
  }

  if (firstError) {
    throw firstError;
  }

  return clips.filter(Boolean);
}

async function listVoices(languageCode, config) {
  if (isEdgeTtsProvider(config)) {
    return edgeTtsService.listVoices(languageCode, config);
  }

  if (isAimaxProvider(config)) {
    return aimaxTtsService.listVoices(languageCode, config);
  }

  const requestOptions = await getGoogleRequestOptions(config, TTS_SCOPE);
  const response = await axios.get('https://texttospeech.googleapis.com/v1/voices', {
    params: {
      ...requestOptions.params,
      languageCode,
    },
    headers: requestOptions.headers,
  });

  return response.data.voices || [];
}

module.exports = {
  previewVoice,
  synthesizeSegmentAudio,
  synthesizeAllSegments,
  listVoices,
  _private: {
    buildGoogleVoiceConfig,
  },
};

