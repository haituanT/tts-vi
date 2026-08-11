const { listVoices, previewVoice } = require('./googleTtsService');

function mapGoogleError(error, fallback) {
  const detail = error.response?.data?.error?.message || error.message || fallback;
  return detail;
}

function shouldCheckGoogleTts(config = {}) {
  return config.ttsProvider === 'google_cloud_tts';
}

function skipped(message) {
  return { ok: true, skipped: true, message };
}

async function checkCredentials(config) {
  if (!shouldCheckGoogleTts(config)) {
    return skipped('Google Cloud credentials are not required for the current provider selection.');
  }
  if (config.apiKey || config.applicationCredentials) {
    return { ok: true, message: 'Credentials are present.' };
  }
  return { ok: false, message: 'No Google Cloud credentials were provided.' };
}

async function checkTextToSpeech(config) {
  if (!shouldCheckGoogleTts(config)) {
    return skipped('Google Cloud Text-to-Speech is not selected.');
  }
  try {
    await previewVoice('This is a preflight check.', config);
    return { ok: true, message: 'Text-to-Speech API is reachable.' };
  } catch (error) {
    return { ok: false, message: mapGoogleError(error, 'Text-to-Speech check failed.') };
  }
}

async function checkVoices(config) {
  if (!shouldCheckGoogleTts(config)) {
    return skipped('Google Cloud voice list is not selected.');
  }
  try {
    const voices = await listVoices(config.ttsLanguageCode || 'vi-VN', config);
    if (config.ttsVoiceName && !voices.some((voice) => voice.name === config.ttsVoiceName)) {
      return {
        ok: false,
        message: `Selected voice ${config.ttsVoiceName} was not found for ${config.ttsLanguageCode}.`,
        count: voices.length,
      };
    }

    return {
      ok: true,
      message: `Loaded ${voices.length} voices.`,
      count: voices.length,
    };
  } catch (error) {
    return { ok: false, message: mapGoogleError(error, 'Voice list check failed.'), count: 0 };
  }
}

async function checkGoogleCloudConfig(config) {
  const checks = {
    credentials: await checkCredentials(config),
    speechToText: skipped('STT now uses Faster Whisper Local or Groq Whisper only.'),
    translation: skipped('Translation now uses Codex CLI or Antigravity CLI only.'),
    textToSpeech: await checkTextToSpeech(config),
    voices: await checkVoices(config),
  };

  const errors = [];
  const warnings = [];

  for (const [name, result] of Object.entries(checks)) {
    if (!result.ok) {
      errors.push({ service: name, message: result.message });
    }
  }

  if (config.credentialsMode === 'api_key') {
    warnings.push('For local testing only. Prefer backend .env or a service account for production.');
  }

  return {
    success: errors.length === 0,
    checks,
    warnings,
    errors,
  };
}

module.exports = {
  checkGoogleCloudConfig,
  checkTextToSpeech,
};
