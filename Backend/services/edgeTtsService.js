const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePythonExecutable } = require('./pythonRuntimeService');

const execFileAsync = promisify(execFile);
const EDGE_TTS_SCRIPT = path.join(__dirname, '..', 'scripts', 'edge_tts_helper.py');

const EDGE_DEFAULT_VOICES = {
  'vi-VN': { MALE: 'vi-VN-NamMinhNeural', FEMALE: 'vi-VN-HoaiMyNeural', NEUTRAL: 'vi-VN-HoaiMyNeural' },
  'en-US': { MALE: 'en-US-GuyNeural', FEMALE: 'en-US-AriaNeural', NEUTRAL: 'en-US-AriaNeural' },
  'ja-JP': { MALE: 'ja-JP-KeitaNeural', FEMALE: 'ja-JP-NanamiNeural', NEUTRAL: 'ja-JP-NanamiNeural' },
  'ko-KR': { MALE: 'ko-KR-InJoonNeural', FEMALE: 'ko-KR-SunHiNeural', NEUTRAL: 'ko-KR-SunHiNeural' },
  'zh-CN': { MALE: 'zh-CN-YunxiNeural', FEMALE: 'zh-CN-XiaoxiaoNeural', NEUTRAL: 'zh-CN-XiaoxiaoNeural' },
  'es-ES': { MALE: 'es-ES-AlvaroNeural', FEMALE: 'es-ES-ElviraNeural', NEUTRAL: 'es-ES-ElviraNeural' },
  'fr-FR': { MALE: 'fr-FR-HenriNeural', FEMALE: 'fr-FR-DeniseNeural', NEUTRAL: 'fr-FR-DeniseNeural' },
  'de-DE': { MALE: 'de-DE-ConradNeural', FEMALE: 'de-DE-KatjaNeural', NEUTRAL: 'de-DE-KatjaNeural' },
  'th-TH': { MALE: 'th-TH-NiwatNeural', FEMALE: 'th-TH-PremwadeeNeural', NEUTRAL: 'th-TH-PremwadeeNeural' },
  'id-ID': { MALE: 'id-ID-ArdiNeural', FEMALE: 'id-ID-GadisNeural', NEUTRAL: 'id-ID-GadisNeural' },
};

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
  const requested = normalizeGender(config.voiceGenderFilter) || normalizeGender(config.ssmlGender);
  return requested === 'NEUTRAL' ? '' : requested;
}

function inferEdgeVoiceGender(voiceName = '') {
  const lower = String(voiceName || '').toLowerCase();
  if (/(namminh|andrew|brian|guy|roger|steffan|yunjian|yunxi|yunyang|keita|daichi|naoki|hyunsu|injoon|niwat|ardi|henri|conrad|killian|alvaro)/i.test(lower)) {
    return 'MALE';
  }
  if (/(hoaimy|aria|ava|emma|jenny|michelle|xiaoxiao|xiaoyi|yunxia|nanami|aoi|mayu|shiori|sunhi|premwadee|gadis|denise|eloise|vivienne|amala|katja|seraphina|elvira|ximena)/i.test(lower)) {
    return 'FEMALE';
  }
  return '';
}

function defaultEdgeVoice(languageCode = 'en-US', gender = '') {
  const defaults = EDGE_DEFAULT_VOICES[languageCode] || EDGE_DEFAULT_VOICES['en-US'];
  const normalizedGender = normalizeGender(gender);
  return defaults[normalizedGender] || defaults.NEUTRAL || defaults.FEMALE || defaults.MALE;
}

function resolveEdgeVoiceName(config = {}) {
  const requestedVoice = String(config.ttsVoiceName || '').trim();
  if (requestedVoice) return requestedVoice;
  return defaultEdgeVoice(config.ttsLanguageCode, resolveGenderPreference(config));
}

function toEdgeRate(speakingRate = 1) {
  const numeric = Number(speakingRate || 1);
  const percent = Math.round((numeric - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

async function runEdgeTts(args) {
  const { stdout } = await execFileAsync(resolvePythonExecutable(), [EDGE_TTS_SCRIPT, ...args], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: Math.max(15000, Number(process.env.DUBFLOW_EDGE_TTS_TIMEOUT_MS) || 120000),
  });
  return stdout.trim();
}

async function listVoices(languageCode, config = {}) {
  const stdout = await runEdgeTts(['list', '--language-code', languageCode || config.ttsLanguageCode || 'vi-VN']);
  const data = JSON.parse(stdout || '{"voices": []}');
  return Array.isArray(data.voices) ? data.voices : [];
}

async function previewVoice(text, config = {}) {
  const tempFile = path.join(os.tmpdir(), `dubflow_edge_preview_${Date.now()}.mp3`);
  try {
    await runEdgeTts([
      'synthesize',
      '--text',
      text || 'This is a voice preview.',
      '--voice',
      resolveEdgeVoiceName(config),
      '--language-code',
      config.ttsLanguageCode || 'vi-VN',
      '--gender',
      resolveGenderPreference(config),
      '--rate',
      toEdgeRate(config.speakingRate || 1),
      '--output',
      tempFile,
    ]);
    return await fs.readFile(tempFile);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

module.exports = {
  listVoices,
  previewVoice,
  resolveEdgeVoiceName,
  resolveGenderPreference,
  toEdgeRate,
};
