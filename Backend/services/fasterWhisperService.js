const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePythonExecutable } = require('./pythonRuntimeService');

const execFileAsync = promisify(execFile);

const FASTER_WHISPER_MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large-v3']);
const FASTER_WHISPER_DEVICES = new Set(['auto', 'cpu', 'cuda']);
const FASTER_WHISPER_COMPUTE_TYPES = new Set(['default', 'int8', 'int8_float16', 'float16', 'float32']);

function normalizeOption(value, allowed, fallback) {
  const option = String(value || '').trim().toLowerCase();
  return allowed.has(option) ? option : fallback;
}

function toWhisperModel(sttModel) {
  const model = String(sttModel || '').trim();
  return FASTER_WHISPER_MODELS.has(model) ? model : 'small';
}

function normalizeBooleanOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeIntegerOption(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, safe));
}

function normalizeNumberOption(value, fallback, min, max) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, safe));
}

function getRuntimeOptions(config = {}) {
  return {
    device: normalizeOption(
      config.fasterWhisperDevice || process.env.FASTER_WHISPER_DEVICE,
      FASTER_WHISPER_DEVICES,
      'auto'
    ),
    computeType: normalizeOption(
      config.fasterWhisperComputeType || process.env.FASTER_WHISPER_COMPUTE_TYPE,
      FASTER_WHISPER_COMPUTE_TYPES,
      'int8'
    ),
  };
}

async function transcribeAudio(audioPath, config) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'faster_whisper_transcribe.py');
  const runtime = getRuntimeOptions(config);
  const vadFilter = normalizeBooleanOption(
    config.fasterWhisperVadFilter ?? process.env.DUBFLOW_FW_VAD_FILTER,
    false
  );
  const beamSize = normalizeIntegerOption(
    config.fasterWhisperBeamSize ?? process.env.DUBFLOW_FW_BEAM_SIZE,
    3,
    1,
    12
  );
  const bestOf = normalizeIntegerOption(
    config.fasterWhisperBestOf ?? process.env.DUBFLOW_FW_BEST_OF,
    1,
    1,
    12
  );
  const conditionOnPreviousText = normalizeBooleanOption(
    config.fasterWhisperConditionOnPreviousText ?? process.env.DUBFLOW_FW_CONDITION_ON_PREVIOUS_TEXT,
    false
  );
  const noSpeechThreshold = normalizeNumberOption(
    config.fasterWhisperNoSpeechThreshold ?? process.env.DUBFLOW_FW_NO_SPEECH_THRESHOLD,
    0.45,
    0.05,
    0.95
  );
  const enableWordTimestamps = normalizeBooleanOption(
    config.enableWordTimestamps ?? process.env.DUBFLOW_ENABLE_WORD_TIMESTAMPS,
    true
  );

  try {
    const { stdout } = await execFileAsync(
      resolvePythonExecutable(),
      [
        scriptPath,
        '--audio',
        audioPath,
        '--model',
        toWhisperModel(config.sttModel),
        '--language',
        config.sourceLanguage || '',
        '--device',
        runtime.device,
        '--compute-type',
        runtime.computeType,
        '--vad-filter',
        String(vadFilter),
        '--beam-size',
        String(beamSize),
        '--best-of',
        String(bestOf),
        '--condition-on-previous-text',
        String(conditionOnPreviousText),
        '--no-speech-threshold',
        String(noSpeechThreshold),
        '--word-timestamps',
        String(enableWordTimestamps),
        '--word-cue-mode',
        'false',
      ],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 20,
        timeout: 1000 * 60 * 60,
      }
    );

    const segments = JSON.parse(stdout);
    if (!Array.isArray(segments) || !segments.length) {
      throw new Error('Faster Whisper returned no transcript segments.');
    }

    return segments;
  } catch (error) {
    const details = error.stderr || error.message;
    throw new Error(`Faster Whisper STT failed: ${details}`);
  }
}

module.exports = {
  getRuntimeOptions,
  transcribeAudio,
};
