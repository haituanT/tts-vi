'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Languages,
  Loader2,
  Mic2,
  Pause,
  Pencil,
  Play,
  Plus,
  Scissors,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import { playErrorSound } from '../lib/audioFeedback';
import QcReportPanel from './qc/QcReportPanel';
import StandaloneTtsWorkspace from './StandaloneTtsWorkspace';

const API_BASE = (process.env.NEXT_PUBLIC_DUBFLOW_API_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '');
const STORAGE_KEY = 'dubflow.reupStudio.v5';
const PROJECTS_STORAGE_KEY = 'dubflow.reupStudio.projects.v1';
const DELETED_PROJECTS_STORAGE_KEY = 'dubflow.reupStudio.deletedProjects.v1';
const SETTINGS_STORAGE_KEY = 'dubflow.reupStudio.settings.v1';
const GOOGLE_TTS_USAGE_STORAGE_KEY = 'dubflow.googleTtsUsage.v1';
const DEFAULT_TTS_RATE = 1;
const DEFAULT_AIMAX_BASE_URL = 'https://aimaxstudio.com';
const DEFAULT_AIMAX_MODEL = 'speech-2.8-hd';
const DEFAULT_AIMAX_PROVIDER = 'minimax';
const DEFAULT_MAX_CHARS_PER_LINE = 32;
const TTS_TIMING_TRACE_OVERFLOW_SECONDS = 0.02;
const TTS_TIMING_MAJOR_OVERFLOW_SECONDS = 1.0;
const TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS = 1.0;
const TTS_TIMING_START_DRIFT_SECONDS = 0.04;
const TTS_REPAIR_PROMPT_VERSION = 'minimal-comma-v3';
const TTS_REPAIR_TABLE_COLUMN_DEFAULTS = {
  apply: 72,
  index: 56,
  start: 154,
  end: 154,
  text: 620,
  repair: 420,
  error: 340,
};
const TTS_REPAIR_TABLE_COLUMN_MIN = {
  apply: 58,
  index: 44,
  start: 112,
  end: 112,
  text: 260,
  repair: 240,
  error: 220,
};
const TTS_REPAIR_TABLE_COLUMN_MAX = {
  apply: 110,
  index: 96,
  start: 260,
  end: 260,
  text: 1100,
  repair: 820,
  error: 760,
};
const LOGO_POSITION_OPTIONS = [
  { value: 'custom', label: 'Tự do – kéo trực tiếp trên video' },
  { value: 'top-left', label: 'Góc trên bên trái' },
  { value: 'top-center', label: 'Phía trên chính giữa' },
  { value: 'top-right', label: 'Góc trên bên phải' },
  { value: 'middle-left', label: 'Chính giữa bên trái' },
  { value: 'center', label: 'Chính giữa video' },
  { value: 'middle-right', label: 'Chính giữa bên phải' },
  { value: 'bottom-left', label: 'Góc dưới bên trái' },
  { value: 'bottom-center', label: 'Phía dưới chính giữa' },
  { value: 'bottom-right', label: 'Góc dưới bên phải' },
];
const AIMAX_TTS_MODELS = {
  minimax: [
    { value: 'speech-2.8-hd', label: 'Speed 2.8 HD' },
    { value: 'speech-2.8-turbo', label: 'Speed 2.8 Turbo' },
    { value: 'speech-2.6-hd', label: 'Speed 2.6 HD' },
    { value: 'speech-2.6-turbo', label: 'Speed 2.6 Turbo' },
    { value: 'speech-2.5-hd-preview', label: 'Speed 2.5 HD Preview' },
    { value: 'speech-2.5-turbo-preview', label: 'Speed 2.5 Turbo Preview' },
    { value: 'speech-02-hd', label: 'Speech 02 HD' },
    { value: 'speech-02-turbo', label: 'Speech 02 Turbo' },
    { value: 'speech-01-hd', label: 'Speech 01 HD' },
    { value: 'speech-01-turbo', label: 'Speech 01 Turbo' },
  ],
  elevenlabs: [
    { value: 'eleven_v3', label: 'Eleven v3' },
    { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
    { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
    { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
    { value: 'eleven_turbo_v2', label: 'Turbo v2 (EN)' },
    { value: 'eleven_flash_v2', label: 'Flash v2 (EN)' },
  ],
};
const CONTEXT_MENU_WIDTH = 208;
const CONTEXT_MENU_HEIGHT = 122;
const CONTEXT_MENU_MARGIN = 8;
const SUBTITLE_SAMPLE_TEXT = 'Đây là mẫu phụ đề tiếng Việt có dấu';
const COLOR_SWATCHES = [
  '#ffffff',
  '#f8fafc',
  '#111827',
  '#000000',
  '#facc15',
  '#f97316',
  '#ef4444',
  '#dc2626',
  '#22c55e',
  '#14b8a6',
  '#38bdf8',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#111111',
  '#9b2226',
];
function getDesktopPicker() {
  if (typeof window === 'undefined') return null;
  return window.dubflowDesktop || null;
}

function maxTtsConcurrencyForProvider(provider) {
  if (provider === 'google_cloud_tts') return 20;
  if (provider === 'edge_tts') return 20;
  if (provider === 'aimax_tts') return 30;
  return 6;
}

function defaultTtsConcurrencyForProvider(provider) {
  if (provider === 'google_cloud_tts') return 3;
  if (provider === 'edge_tts') return 20;
  if (provider === 'aimax_tts') return 30;
  return 3;
}

function defaultTtsAttemptsForProvider(provider) {
  return ['edge_tts', 'google_cloud_tts', 'aimax_tts'].includes(provider) ? 3 : 1;
}

function clampTtsConcurrency(provider, value) {
  const max = maxTtsConcurrencyForProvider(provider);
  return Math.min(Math.max(Number(value) || defaultTtsConcurrencyForProvider(provider), 1), max);
}

function normalizeAimaxSrtBatchMode(value) {
  return value === 'request_count' ? 'request_count' : 'cue_count';
}

function clampAimaxSrtCuesPerRequest(value) {
  return Math.max(1, Math.min(200, Math.round(Number(value) || 70)));
}

function normalizeConfiguredAimaxSrtCuesPerRequest(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && Math.round(numeric) === 30) return 70;
  return clampAimaxSrtCuesPerRequest(value);
}

function clampAimaxSrtRequestCount(value) {
  return Math.max(1, Math.min(100, Math.round(Number(value) || 3)));
}

function clampAimaxSrtBatchConcurrency(value) {
  return Math.max(1, Math.min(3, Math.round(Number(value) || 1)));
}

function aimaxModelOptions(provider) {
  return AIMAX_TTS_MODELS[provider === 'elevenlabs' ? 'elevenlabs' : 'minimax'];
}

function defaultAimaxModelForProvider(provider) {
  return provider === 'elevenlabs' ? 'eleven_multilingual_v2' : DEFAULT_AIMAX_MODEL;
}

const DEFAULT_STATE = {
  projectId: `project-${Date.now()}`,
  projectName: 'New project',
  source: { mode: 'local', videoPath: '', videoUrl: '', title: '' },
  job: {
    jobId: '',
    sourceVideoUrl: '',
    previewVideoUrl: '',
    audioUrl: '',
    audioPath: '',
    durationSeconds: 0,
  },
  rows: [],
  meaningUnits: [],
  ttsUnits: [],
  ttsRepairBasket: [],
  storyTranslation: null,
  selectedRowId: '',
  currentTime: 0,
  currentStage: 'idle',
  busy: false,
  logs: [],
  error: '',
  outputs: {
    srtPath: '',
    srtUrl: '',
    softSubtitlePath: '',
    softSubtitleUrl: '',
    rawSrtPath: '',
    rawSrtUrl: '',
    wordLevelSrtPath: '',
    wordLevelSrtUrl: '',
    sourceSegmentedSrtPath: '',
    sourceSegmentedSrtUrl: '',
    sourceTemplateGroupJsonPath: '',
    sourceTemplateGroupJsonUrl: '',
    sourceTemplateGroupSrtPath: '',
    sourceTemplateGroupSrtUrl: '',
    sourceSrtPath: '',
    sourceSrtUrl: '',
    audioPath: '',
    audioUrl: '',
    videoPath: '',
    videoUrl: '',
    sourceQcReportPath: '',
    sourceQcReportUrl: '',
    sourceCoverageReportPath: '',
    sourceCoverageReportUrl: '',
    translationQcReportPath: '',
    translationQcReportUrl: '',
    readabilityQcReportPath: '',
    readabilityQcReportUrl: '',
    ttsQcReportPath: '',
    ttsQcReportUrl: '',
    syncQcReportPath: '',
    syncQcReportUrl: '',
    autoTtsRepairReportPath: '',
    autoTtsRepairReportUrl: '',
    autoTtsRepairReport: null,
    aimaxSrtBatchReportPath: '',
    aimaxSrtBatchReportUrl: '',
    aimaxSrtBatchReport: null,
    qcSummary: null,
    ttsReport: null,
    ttsFitPlan: null,
  },
  config: {
    googleApiKey: '',
    googleProjectId: '',
    googleServiceAccountPath: '',
    googleSttLocation: 'us',
    groqApiKey: '',
    groqBackupKeys: '',
    assemblyAiApiKey: '',
    assemblyAiBackupKeys: '',
    assemblyAiPrompt: '',
    assemblyAiKeyterms: '',
    assemblyAiProcessingMode: 'parallel',
    assemblyAiChunkSeconds: 180,
    assemblyAiOverlapSeconds: 6,
    assemblyAiConcurrency: 3,
    sttProvider: 'faster_whisper_local',
    sttModel: 'large-v3',
    sttTimestampMode: 'word_timestamps',
    nlpSourceResegment: false,
    subtitleGroupSettingsVersion: 1,
    subtitleGroupEnabled: false,
    subtitleGroupLanguage: 'source',
    subtitleGroupBatchSize: 60,
    subtitleGroupConcurrency: 3,
    subtitleGroupProvider: 'codex_cli',
    subtitleGroupModel: '',
    ocrProvider: 'rapidocr',
    ocrFps: 2,
    ocrCropX: 0,
    ocrCropY: 0.72,
    ocrCropW: 1,
    ocrCropH: 0.24,
    ocrMergeSimilarity: 0.86,
    ocrMaxEmptyGap: 0.45,
    ocrMinDuration: 0.25,
    ocrRequireCjk: true,
    ocrSkipUnchanged: true,
    ocrChangeThreshold: 0.025,
    ocrConcurrency: 8,
    ocrMaxKeyframeGap: 1.5,
    ocrKeyframeProvider: 'rapidocr',
    ocrKeyframeTimelineFps: 30,
    ocrKeyframeBoundaryRefineWindow: 0.16,
    ocrLanguageHints: 'zh,zh-Hans',
    sourceLanguage: 'zh',
    translationProvider: 'codex_cli',
    translationMode: 'story_v2',
    cliTranslationModel: '',
    cliTranslationConcurrency: 3,
    targetLanguage: 'vi',
    videoContext: '',
    customGlossary: '',
    translationTargetTtsRate: 1,
    translationTimingValidationMode: 'estimate_plus_probe',
    translationTimingRewriteMaxPasses: 2,
    normalizeTimelineBeforeTranslate: true,
    translationDisplayMode: 'source_timeline',
    timelineMergeGapSeconds: 0.35,
    timelineBreakGapSeconds: 0.5,
    timelineMaxUnitDuration: 2.8,
    timelineGuardSeconds: 0.15,
    videoSpeed: 1,
    autoAdjustSpeed: false,
    subtitleOffsetMs: 0,
    maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
    lineBreakMode: 'auto',
    subtitleFontFamily: 'Arial',
    subtitleFontSize: 32,
    subtitlePreviewEnabled: true,
    subtitleTextColor: '#ffffff',
    subtitleOutlineEnabled: false,
    subtitleOutlineColor: '#000000',
    subtitlePosition: 'bottom',
    subtitlePositionX: 50,
    subtitlePositionY: 88,
    subtitleBoxEnabled: true,
    subtitleBoxColor: '#111111',
    subtitleBoxOpacity: 82,
    subtitleBoxRadius: 8,
    subtitleCoverEnabled: false,
    subtitleCoverMode: 'blur',
    subtitleCoverBlur: 18,
    subtitleCoverFeather: 12,
    subtitleCoverColor: '#000000',
    subtitleCoverOpacity: 85,
    subtitleCoverX: 26,
    subtitleCoverY: 82,
    subtitleCoverW: 48,
    subtitleCoverH: 8,
    overlayEnabled: false,
    overlayText: '',
    overlayX: 50,
    overlayY: 50,
    overlayStart: 0,
    overlayEnd: 5,
    backgroundColor: '#000000',
    backgroundOpacity: 0,
    backgroundApplyTo: 'selected',
    musicEnabled: false,
    musicPath: '',
    musicVolume: 35,
    musicFade: true,
    logoEnabled: false,
    logoPath: '',
    logoPosition: 'custom',
    logoX: 88,
    logoY: 12,
    logoSize: 18,
    logoOpacity: 90,
    randomLogoText: false,
    randomLogoPaths: '',
    randomIntervalSeconds: 5,
    outputDirectory: '',
    outputCreateFolder: true,
    outputFolderName: '',
    outputFormat: 'mp4',
    outputAspectRatio: 'source',
    outputQuality: 80,
    includeDubbedAudio: true,
    keepOriginalAudioTrack: false,
    sourceAudioEnabled: true,
    dubbedAudioEnabled: true,
    originalPreviewVolume: 50,
    dubbedPreviewVolume: 100,
    ttsProvider: 'edge_tts',
    ttsUnitMode: 'story_segments',
    ttsLanguageCode: 'vi-VN',
    ttsVoiceName: '',
    ssmlGender: 'NEUTRAL',
    aimaxApiKey: '',
    aimaxBaseUrl: DEFAULT_AIMAX_BASE_URL,
    aimaxProvider: DEFAULT_AIMAX_PROVIDER,
    aimaxModel: DEFAULT_AIMAX_MODEL,
    aimaxSrtBatchEnabled: false,
    aimaxSrtBatchMode: 'cue_count',
    aimaxSrtCuesPerRequest: 70,
    aimaxSrtRequestCount: 3,
    aimaxSrtBatchConcurrency: 1,
    speakingRate: DEFAULT_TTS_RATE,
    ttsFitEnabled: true,
    ttsFitMode: 'balanced',
    ttsFitMaxRate: DEFAULT_TTS_RATE,
    autoTtsRepairEnabled: false,
    autoTtsRepairMaxPasses: 2,
    autoTtsRepairMinOverflowSeconds: 0.08,
    autoTtsRepairMaxRowsPerPass: 20,
    ttsTextCleanupMode: 'natural',
    voiceGenderFilter: 'all',
    voiceFamilyFilter: 'all',
    voiceSampleRateFilter: 'all',
    voiceControlsFilter: 'all',
    pitch: 0,
    syncMode: 'strict',
    addSilenceGaps: true,
    maxVoiceGapSeconds: 0.06,
    voiceAlignShortClips: false,
    voiceAlignMode: 'start',
    voiceAlignMinSlackSeconds: 0.05,
    voiceAlignMaxShiftSeconds: 0.6,
    naturalPhraseSync: false,
    phraseLengthMode: 'natural',
    pauseStyle: 'natural',
    targetPhraseSeconds: 1.6,
    maxPhraseSeconds: 3.2,
    ttsConcurrency: 3,
    ttsMaxAttempts: 1,
    keepBackgroundMusic: false,
    originalAudioVolume: 0.18,
    softSubtitles: true,
    burnSubtitles: false,
    outputFileName: 'final_dubbed.mp4',
    naturalDubTargetMinSeconds: 2.0,
    naturalDubTargetMaxSeconds: 4.2,
    maxMeaningUnitSourceRows: 3,
  },
  health: null,
  voices: [],
  voicePreviewAudio: '',
};

const CLEARED_TTS_OUTPUTS = {
  audioPath: '',
  audioUrl: '',
  videoPath: '',
  videoUrl: '',
  ttsQcReportPath: '',
  ttsQcReportUrl: '',
  syncQcReportPath: '',
  syncQcReportUrl: '',
  autoTtsRepairReportPath: '',
  autoTtsRepairReportUrl: '',
  autoTtsRepairReport: null,
  aimaxSrtBatchReportPath: '',
  aimaxSrtBatchReportUrl: '',
  aimaxSrtBatchReport: null,
  qcSummary: null,
  ttsReport: null,
  ttsFitPlan: null,
};

function hasGeneratedTtsOutput(outputs = {}) {
  return Boolean(
    outputs.audioPath
      || outputs.audioUrl
      || outputs.videoPath
      || outputs.videoUrl
      || outputs.ttsQcReportPath
      || outputs.ttsQcReportUrl
      || outputs.syncQcReportPath
      || outputs.syncQcReportUrl
      || outputs.autoTtsRepairReportPath
      || outputs.autoTtsRepairReportUrl
      || outputs.autoTtsRepairReport
      || outputs.aimaxSrtBatchReportPath
      || outputs.aimaxSrtBatchReportUrl
      || outputs.aimaxSrtBatchReport
      || outputs.ttsReport
      || outputs.ttsFitPlan
  );
}

const STT_PROVIDERS = [
  { value: 'faster_whisper_local', label: 'Faster Whisper cục bộ (GPU)' },
  { value: 'groq_speech_to_text', label: 'Groq Whisper' },
  { value: 'assemblyai_speech_to_text', label: 'AssemblyAI' },
];

const STT_MODELS = {
  faster_whisper_local: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  groq_speech_to_text: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  assemblyai_speech_to_text: ['universal-3-5-pro', 'universal-2'],
};

const STT_TIMESTAMP_MODES = [
  { value: 'segment_timestamps', label: 'Theo câu/đoạn' },
  { value: 'word_timestamps', label: 'Theo từng từ' },
];

const ASSEMBLYAI_TIMESTAMP_MODES = [
  { value: 'word_timestamps', label: 'Từng từ thông minh' },
  { value: 'segment_timestamps', label: 'Câu AssemblyAI tự chia' },
];

const TRANSLATION_PROVIDERS = [
  { value: 'codex_cli', label: 'Codex CLI' },
  { value: 'antigravity_cli', label: 'Antigravity CLI' },
];
const CLI_TRANSLATION_PROVIDERS = new Set(['codex_cli', 'antigravity_cli']);
const CLI_TRANSLATION_MODEL_OPTIONS = {
  codex_cli: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  antigravity_cli: [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ],
};

const getCliTranslationModelOptions = (provider) => CLI_TRANSLATION_MODEL_OPTIONS[provider] || [];
const getCliTranslationModelSelectValue = (provider, model) => {
  const normalized = String(model || '').trim();
  const options = getCliTranslationModelOptions(provider);
  return normalized && options.includes(normalized) ? normalized : '';
};
const getCliTranslationCustomModel = (provider, model) => {
  const normalized = String(model || '').trim();
  const options = getCliTranslationModelOptions(provider);
  return normalized && !options.includes(normalized) ? normalized : '';
};
const optionLabel = (options, value, fallback = '') => (
  options.find((item) => item.value === value)?.label || fallback || String(value || '')
);
const translationProviderLabel = (provider) => optionLabel(TRANSLATION_PROVIDERS, provider, provider || 'Chưa chọn');
const translationModelLabel = (provider, model) => String(model || '').trim() || getCliTranslationModelOptions(provider)[0] || 'Mặc định';
const ttsProviderLabel = (provider) => ({
  edge_tts: 'Edge TTS',
  google_cloud_tts: 'Google Cloud TTS',
  aimax_tts: 'AIMAX Clone',
}[provider] || provider || 'Chưa chọn');
const ttsModelLabel = (config = {}) => {
  if (config.ttsProvider === 'aimax_tts') {
    return [config.aimaxProvider || DEFAULT_AIMAX_PROVIDER, config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider)]
      .filter(Boolean)
      .join(' / ');
  }
  return config.ttsVoiceName || config.ttsLanguageCode || 'Giọng mặc định';
};

const SRT_IMPORT_TYPES = [
  { value: 'source', label: 'SRT gốc' },
  { value: 'translated', label: 'SRT dịch' },
  { value: 'final', label: 'SRT hoàn chỉnh' },
];

function normalizeOutputAspectRatio(value) {
  const text = String(value || '').trim();
  return ['source', '16:9', '9:16', '4:3'].includes(text) ? text : 'source';
}

function aspectRatioNumber(value) {
  if (value === '16:9') return 16 / 9;
  if (value === '9:16') return 9 / 16;
  if (value === '4:3') return 4 / 3;
  return 0;
}

const LANGUAGES = [
  { value: 'auto', label: 'Tự động' },
  { value: 'zh', label: 'Tiếng Trung' },
  { value: 'en', label: 'Tiếng Anh' },
  { value: 'ja', label: 'Tiếng Nhật' },
  { value: 'ko', label: 'Tiếng Hàn' },
  { value: 'vi', label: 'Tiếng Việt' },
];
const SUBTITLE_GROUP_LANGUAGE_OPTIONS = [
  { value: 'source', label: 'Theo ngôn ngữ gốc' },
  ...LANGUAGES,
];
const TTS_LANGUAGES = ['vi-VN', 'en-US', 'zh-CN', 'ja-JP', 'ko-KR', 'th-TH', 'id-ID', 'fr-FR', 'de-DE', 'es-ES'];
const EDGE_FALLBACK_VOICES = {
  'vi-VN': ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'],
  'en-US': ['en-US-AriaNeural', 'en-US-AvaNeural', 'en-US-AndrewNeural', 'en-US-BrianNeural', 'en-US-EmmaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural', 'en-US-MichelleNeural', 'en-US-RogerNeural', 'en-US-SteffanNeural'],
  'zh-CN': ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-YunyangNeural'],
  'ja-JP': ['ja-JP-KeitaNeural', 'ja-JP-NanamiNeural', 'ja-JP-AoiNeural', 'ja-JP-DaichiNeural', 'ja-JP-MayuNeural', 'ja-JP-NaokiNeural', 'ja-JP-ShioriNeural'],
  'ko-KR': ['ko-KR-HyunsuNeural', 'ko-KR-InJoonNeural', 'ko-KR-SunHiNeural'],
  'th-TH': ['th-TH-NiwatNeural', 'th-TH-PremwadeeNeural'],
  'id-ID': ['id-ID-ArdiNeural', 'id-ID-GadisNeural'],
  'fr-FR': ['fr-FR-DeniseNeural', 'fr-FR-EloiseNeural', 'fr-FR-HenriNeural', 'fr-FR-RemyMultilingualNeural', 'fr-FR-VivienneMultilingualNeural'],
  'de-DE': ['de-DE-AmalaNeural', 'de-DE-ConradNeural', 'de-DE-KatjaNeural', 'de-DE-KillianNeural', 'de-DE-SeraphinaMultilingualNeural'],
  'es-ES': ['es-ES-AlvaroNeural', 'es-ES-ElviraNeural', 'es-ES-XimenaNeural'],
};
const GOOGLE_FALLBACK_VOICES = {
  'vi-VN': ['vi-VN-Chirp3-HD-Achernar', 'vi-VN-Chirp3-HD-Aoede', 'vi-VN-Chirp3-HD-Charon', 'vi-VN-Chirp3-HD-Fenrir', 'vi-VN-Chirp3-HD-Gacrux', 'vi-VN-Chirp3-HD-Iapetus', 'vi-VN-Neural2-A', 'vi-VN-Neural2-D', 'vi-VN-Wavenet-A', 'vi-VN-Wavenet-B', 'vi-VN-Wavenet-C', 'vi-VN-Wavenet-D', 'vi-VN-Standard-A', 'vi-VN-Standard-B', 'vi-VN-Standard-C', 'vi-VN-Standard-D'],
  'en-US': ['en-US-Chirp3-HD-Achernar', 'en-US-Chirp3-HD-Aoede', 'en-US-Chirp3-HD-Charon', 'en-US-Chirp3-HD-Fenrir', 'en-US-Chirp3-HD-Gacrux', 'en-US-Chirp3-HD-Iapetus', 'en-US-Neural2-A', 'en-US-Neural2-C', 'en-US-Neural2-D', 'en-US-Neural2-E', 'en-US-Neural2-F', 'en-US-Neural2-G', 'en-US-Neural2-H', 'en-US-Neural2-I', 'en-US-Neural2-J', 'en-US-Studio-O', 'en-US-Studio-Q', 'en-US-Wavenet-A', 'en-US-Wavenet-D', 'en-US-Wavenet-F', 'en-US-Wavenet-J'],
  'zh-CN': ['cmn-CN-Chirp3-HD-Achernar', 'cmn-CN-Chirp3-HD-Aoede', 'cmn-CN-Chirp3-HD-Charon', 'cmn-CN-Chirp3-HD-Fenrir', 'cmn-CN-Chirp3-HD-Gacrux', 'cmn-CN-Chirp3-HD-Iapetus', 'cmn-CN-Wavenet-A', 'cmn-CN-Wavenet-B', 'cmn-CN-Wavenet-C', 'cmn-CN-Wavenet-D', 'cmn-CN-Standard-A', 'cmn-CN-Standard-B', 'cmn-CN-Standard-C', 'cmn-CN-Standard-D'],
  'ja-JP': ['ja-JP-Chirp3-HD-Achernar', 'ja-JP-Chirp3-HD-Aoede', 'ja-JP-Chirp3-HD-Charon', 'ja-JP-Chirp3-HD-Fenrir', 'ja-JP-Chirp3-HD-Gacrux', 'ja-JP-Chirp3-HD-Iapetus', 'ja-JP-Neural2-B', 'ja-JP-Neural2-C', 'ja-JP-Neural2-D', 'ja-JP-Wavenet-A', 'ja-JP-Wavenet-B', 'ja-JP-Wavenet-C', 'ja-JP-Wavenet-D'],
  'ko-KR': ['ko-KR-Chirp3-HD-Achernar', 'ko-KR-Chirp3-HD-Aoede', 'ko-KR-Chirp3-HD-Charon', 'ko-KR-Chirp3-HD-Fenrir', 'ko-KR-Chirp3-HD-Gacrux', 'ko-KR-Chirp3-HD-Iapetus', 'ko-KR-Neural2-A', 'ko-KR-Neural2-B', 'ko-KR-Neural2-C', 'ko-KR-Wavenet-A', 'ko-KR-Wavenet-B', 'ko-KR-Wavenet-C', 'ko-KR-Wavenet-D'],
  'th-TH': ['th-TH-Chirp3-HD-Achernar', 'th-TH-Chirp3-HD-Aoede', 'th-TH-Chirp3-HD-Charon', 'th-TH-Chirp3-HD-Fenrir', 'th-TH-Chirp3-HD-Gacrux', 'th-TH-Chirp3-HD-Iapetus', 'th-TH-Neural2-C', 'th-TH-Wavenet-C', 'th-TH-Standard-A'],
  'id-ID': ['id-ID-Chirp3-HD-Achernar', 'id-ID-Chirp3-HD-Aoede', 'id-ID-Chirp3-HD-Charon', 'id-ID-Chirp3-HD-Fenrir', 'id-ID-Chirp3-HD-Gacrux', 'id-ID-Chirp3-HD-Iapetus', 'id-ID-Neural2-A', 'id-ID-Neural2-B', 'id-ID-Neural2-C', 'id-ID-Neural2-D', 'id-ID-Wavenet-A', 'id-ID-Wavenet-B', 'id-ID-Wavenet-C', 'id-ID-Wavenet-D'],
  'fr-FR': ['fr-FR-Chirp3-HD-Achernar', 'fr-FR-Chirp3-HD-Aoede', 'fr-FR-Chirp3-HD-Charon', 'fr-FR-Chirp3-HD-Fenrir', 'fr-FR-Chirp3-HD-Gacrux', 'fr-FR-Chirp3-HD-Iapetus', 'fr-FR-Neural2-A', 'fr-FR-Neural2-B', 'fr-FR-Neural2-C', 'fr-FR-Neural2-D', 'fr-FR-Neural2-E', 'fr-FR-Wavenet-A', 'fr-FR-Wavenet-B', 'fr-FR-Wavenet-C', 'fr-FR-Wavenet-D', 'fr-FR-Wavenet-E'],
  'de-DE': ['de-DE-Chirp3-HD-Achernar', 'de-DE-Chirp3-HD-Aoede', 'de-DE-Chirp3-HD-Charon', 'de-DE-Chirp3-HD-Fenrir', 'de-DE-Chirp3-HD-Gacrux', 'de-DE-Chirp3-HD-Iapetus', 'de-DE-Neural2-B', 'de-DE-Neural2-C', 'de-DE-Neural2-D', 'de-DE-Wavenet-A', 'de-DE-Wavenet-B', 'de-DE-Wavenet-C', 'de-DE-Wavenet-D'],
  'es-ES': ['es-ES-Chirp3-HD-Achernar', 'es-ES-Chirp3-HD-Aoede', 'es-ES-Chirp3-HD-Charon', 'es-ES-Chirp3-HD-Fenrir', 'es-ES-Chirp3-HD-Gacrux', 'es-ES-Chirp3-HD-Iapetus', 'es-ES-Neural2-A', 'es-ES-Neural2-B', 'es-ES-Neural2-C', 'es-ES-Neural2-D', 'es-ES-Neural2-E', 'es-ES-Neural2-F', 'es-ES-Wavenet-B', 'es-ES-Wavenet-C', 'es-ES-Wavenet-D'],
};

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function safeLocalStorageSet(key, value) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`Không thể lưu dữ liệu cục bộ cho ${key}:`, error);
    return false;
  }
}

function googleTtsUsageMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function googleTtsBillingTier(voiceName = '') {
  const name = String(voiceName || '').toLowerCase();
  if (name.includes('chirp3-hd') || name.includes('chirp-hd')) {
    return { id: 'chirp3_hd', label: 'Chirp 3 HD', freeChars: 1000000, rpm: 200, usdPerMillion: 30 };
  }
  if (name.includes('studio')) {
    return { id: 'studio', label: 'Studio', freeChars: 1000000, rpm: 500, usdPerMillion: 160 };
  }
  if (name.includes('neural2')) {
    return { id: 'neural2', label: 'Neural2', freeChars: 1000000, rpm: 1000, usdPerMillion: 16 };
  }
  if (name.includes('polyglot')) {
    return { id: 'polyglot', label: 'Polyglot', freeChars: 1000000, rpm: 1000, usdPerMillion: 16 };
  }
  if (name.includes('wavenet')) {
    return { id: 'wavenet', label: 'WaveNet', freeChars: 4000000, rpm: 1000, usdPerMillion: 4 };
  }
  if (name.includes('standard')) {
    return { id: 'standard', label: 'Standard', freeChars: 4000000, rpm: 1000, usdPerMillion: 4 };
  }
  return { id: 'cloud_tts', label: 'Cloud TTS', freeChars: 1000000, rpm: 1000, usdPerMillion: 16 };
}

function formatInteger(value) {
  return Math.round(Number(value) || 0).toLocaleString('vi-VN');
}

function formatUsd(value) {
  return (Number(value) || 0).toLocaleString('vi-VN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function countGoogleTtsBillableChars(text = '') {
  return Array.from(String(text || '')).length;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const SUBTITLE_FONT_SIZE_MIN = 10;
const SUBTITLE_FONT_SIZE_MAX = 96;
const SUBTITLE_LOAD_FONT_SIZE_MAX = 48;

function parseDecimal(value, fallback = 0) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSubtitleFontSize(value) {
  const parsed = parseDecimal(value, DEFAULT_STATE.config.subtitleFontSize);
  return Number(clamp(parsed, SUBTITLE_FONT_SIZE_MIN, SUBTITLE_FONT_SIZE_MAX).toFixed(0));
}

function normalizeLoadedSubtitleFontSize(value) {
  const parsed = parseDecimal(value, DEFAULT_STATE.config.subtitleFontSize);
  if (parsed > SUBTITLE_LOAD_FONT_SIZE_MAX) return DEFAULT_STATE.config.subtitleFontSize;
  return normalizeSubtitleFontSize(parsed);
}

function normalizeSpeakingRate(value) {
  return Number(clamp(parseDecimal(value, DEFAULT_TTS_RATE), 0.5, 2).toFixed(2));
}

function normalizeTranslationTargetTtsRate(value) {
  return Number(clamp(parseDecimal(value, 1), 0.75, 1.5).toFixed(2));
}

function normalizeVoiceAlignMaxShift(value) {
  const parsed = parseDecimal(value, DEFAULT_STATE.config.voiceAlignMaxShiftSeconds);
  if (parsed > 2) return DEFAULT_STATE.config.voiceAlignMaxShiftSeconds;
  return Number(clamp(parsed, 0, 2).toFixed(2));
}

function getDefaultSttModel(provider) {
  if (provider === 'faster_whisper_local') return 'large-v3';
  if (provider === 'groq_speech_to_text') return 'whisper-large-v3-turbo';
  if (provider === 'assemblyai_speech_to_text') return 'universal-3-5-pro';
  return (STT_MODELS[provider] || ['default'])[0];
}

function defaultSttPatchForProvider(provider) {
  const patch = {
    sttProvider: provider,
    sttModel: getDefaultSttModel(provider),
  };
  if (provider === 'assemblyai_speech_to_text') {
    patch.sttTimestampMode = 'word_timestamps';
    patch.nlpSourceResegment = false;
  }
  return patch;
}

function isSubtitleCueGroupingEnabled(config = {}) {
  return config.subtitleGroupSettingsVersion === 1 && config.subtitleGroupEnabled === true;
}

function shouldUseSourceResegment(config = {}) {
  return config.sttProvider !== 'assemblyai_speech_to_text'
    && !isSubtitleCueGroupingEnabled(config)
    && config.nlpSourceResegment !== false;
}

function isPlayInterruptedError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return error?.name === 'AbortError' || message.includes('interrupted by a call to pause') || message.includes('interrupted by a new load request');
}

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remain = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
}

function formatDurationRange(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remain = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
}

let taskDoneAudioContext = null;
let lastTaskDoneSoundAt = 0;

function getTaskDoneAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!taskDoneAudioContext || taskDoneAudioContext.state === 'closed') {
    taskDoneAudioContext = new AudioContextClass();
  }
  return taskDoneAudioContext;
}

function primeTaskDoneSound() {
  const audioContext = getTaskDoneAudioContext();
  if (!audioContext) return null;
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

function playTaskDoneSound() {
  const audioContext = primeTaskDoneSound();
  if (!audioContext) return;
  const nowMs = Date.now();
  if (nowMs - lastTaskDoneSoundAt < 500) return;
  lastTaskDoneSoundAt = nowMs;

  const play = () => {
    const startAt = audioContext.currentTime + 0.03;
    [
      { frequency: 880, offset: 0, duration: 0.16 },
      { frequency: 1174.66, offset: 0.14, duration: 0.18 },
      { frequency: 1567.98, offset: 0.30, duration: 0.26 },
    ].forEach((note) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = startAt + note.offset;
      const noteEnd = noteStart + note.duration;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.05);
    });
  };

  if (audioContext.state === 'suspended') {
    audioContext.resume().then(play).catch(() => {});
  } else {
    play();
  }
}

function logTime() {
  return new Date().toLocaleTimeString('vi-VN', { hour12: false });
}

function formatSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function hexToRgba(hex, opacity = 0) {
  const clean = String(hex || '#000000').replace('#', '');
  const value = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean.padEnd(6, '0').slice(0, 6);
  const number = Number.parseInt(value, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${clamp(Number(opacity) || 0, 0, 100) / 100})`;
}

function fileNameFromPath(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function parseSrtTimestamp(value) {
  const match = String(value || '').trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  const [, hours, minutes, seconds, ms] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(ms.padEnd(3, '0').slice(0, 3)) / 1000;
}

function parseSrtText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block, index) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes('-->'));
      if (timeIndex < 0) return null;
      const [startText, endText] = lines[timeIndex].split('-->').map((part) => part.trim());
      const start = parseSrtTimestamp(startText);
      const end = parseSrtTimestamp(endText);
      const content = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!content || end <= start) return null;
      return {
        id: `srt-${Date.now()}-${index + 1}`,
        index: index + 1,
        start,
        end,
        duration: end - start,
        text: content,
      };
    })
    .filter(Boolean);
}

function toPlayableMediaSrc(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
  if (/^\/(jobs|downloads)\//i.test(url) || /^\/api\/manual\/(preview-)?video\//i.test(url)) return `${API_BASE}${url}`;
  return '';
}

function cacheBustUrl(value) {
  const url = String(value || '').trim();
  if (!url || /^(blob:|data:)/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

function localFilePreviewSrc(value) {
  const filePath = String(value || '').trim();
  if (!filePath) return '';
  if (/^(blob:|data:|https?:\/\/)/i.test(filePath)) return filePath;
  if (/^file:\/\//i.test(filePath)) return filePath;
  return `${API_BASE}/api/local-file?path=${encodeURIComponent(filePath)}`;
}

function cssFontFamily(value) {
  const font = String(value || 'Arial').trim().replace(/["']/g, '');
  if (/^arial$/i.test(font)) return '"Arial", "Helvetica Neue", Helvetica, sans-serif';
  return `"${font}", Arial, sans-serif`;
}

function normalizeSubtitleDisplayText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function subtitlePreviewCharWidth(char) {
  if (/\s/.test(char)) return 0.32;
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) return 1;
  if (/[A-Z]/.test(char)) return 0.68;
  if (/[.,;:!?'"()[\]{}]/.test(char)) return 0.36;
  if (/[0-9]/.test(char)) return 0.55;
  if (char.charCodeAt(0) > 127) return 0.62;
  return 0.56;
}

function subtitlePreviewLineWidth(text) {
  return Array.from(String(text || '')).reduce((sum, char) => sum + subtitlePreviewCharWidth(char), 0);
}

function subtitlePreviewVideoContentWidth(video) {
  const rect = video?.getBoundingClientRect?.();
  if (!video || !rect || !rect.width || !rect.height) return 0;
  const naturalRatio = (Number(video.videoWidth) || 16) / Math.max(1, Number(video.videoHeight) || 9);
  const boxRatio = rect.width / Math.max(1, rect.height);
  return boxRatio > naturalRatio ? rect.height * naturalRatio : rect.width;
}

function fitSubtitlePreviewFontSize(lines, baseFontSize, contentWidth, boxEnabled) {
  const cleanLines = (Array.isArray(lines) ? lines : [lines])
    .map(normalizeSubtitleDisplayText)
    .filter(Boolean);
  if (!cleanLines.length || !(Number(contentWidth) > 0)) return baseFontSize;

  const availableWidth = Math.max(24, Number(contentWidth) * 0.94 - (boxEnabled ? 14 : 0));
  const widestLine = Math.max(...cleanLines.map(subtitlePreviewLineWidth), 1);
  const fitted = availableWidth / widestLine;
  return Number(clamp(Math.min(baseFontSize, fitted), SUBTITLE_FONT_SIZE_MIN, baseFontSize).toFixed(2));
}

function wrapSubtitleForPreview(text, maxLineLength = 34) {
  const words = normalizeSubtitleDisplayText(text)
    .split(/(\s+)/)
    .map((part) => part.trim())
    .filter(Boolean);
  const maxWidth = Math.max(10, Math.min(52, Number(maxLineLength) || 34) * 0.58);
  const lines = [];
  let line = '';

  const splitLongToken = (token) => {
    let part = '';
    for (const char of Array.from(token)) {
      const next = part ? `${part}${char}` : char;
      if (subtitlePreviewLineWidth(next) <= maxWidth || !part) {
        part = next;
      } else {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(part);
        part = char;
      }
    }
    return part;
  };

  for (const rawWord of words) {
    const word = subtitlePreviewLineWidth(rawWord) > maxWidth ? splitLongToken(rawWord) : rawWord;
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (subtitlePreviewLineWidth(next) <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function splitLongPreviewSubtitle(text, maxChars) {
  let rest = normalizeSubtitleDisplayText(text);
  const chunks = [];

  while (rest.length > maxChars) {
    let cut = -1;
    // Prefer a punctuation boundary just after the nominal limit. This is the
    // same semantic split used by the export renderer.
    const punctuationSearchArea = rest.slice(0, Math.ceil(maxChars * 1.3) + 1);
    for (const pattern of [/[.!?;:。！？；：,，]\s/g]) {
      let match;
      while ((match = pattern.exec(punctuationSearchArea))) {
        cut = match.index + match[0].length;
      }
    }

    if (cut < Math.floor(maxChars * 0.45)) {
      cut = -1;
      const searchArea = rest.slice(0, maxChars + 1);
      const pattern = /\s/g;
      let match;
      while ((match = pattern.exec(searchArea))) {
        cut = match.index + match[0].length;
      }
    }

    if (cut < 1) cut = maxChars;
    chunks.push(normalizeSubtitleDisplayText(rest.slice(0, cut)));
    rest = normalizeSubtitleDisplayText(rest.slice(cut));
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function startsWithDependentPreviewWord(text) {
  return /^(này|đó|ấy|kia|rằng|và|hoặc|nhưng|mà|của|cho|với|tại|ở|để|là|mét|km|kilomet|ki-lô-mét|centimet|cm|milimét|mm|độ|phút|giây|năm|tuổi|ngày|tháng|đô|đồng|%|,|\.|;|:|\)|\])/i.test(normalizeSubtitleDisplayText(text));
}

function endsWithDanglingPreviewNumber(text) {
  return /(?:^|\s)(\d+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)$/i.test(normalizeSubtitleDisplayText(text));
}

function repairPreviewSubtitleChunks(chunks, maxChars) {
  const repaired = [];
  const minChunkChars = Math.max(12, Math.floor(maxChars * 0.26));

  for (const rawChunk of chunks) {
    const chunk = normalizeSubtitleDisplayText(rawChunk);
    if (!chunk) continue;

    const previous = repaired[repaired.length - 1];
    const shouldAttachToPrevious = previous && (
      chunk.length < minChunkChars
      || startsWithDependentPreviewWord(chunk)
      || endsWithDanglingPreviewNumber(previous)
    );

    if (shouldAttachToPrevious && `${previous} ${chunk}`.length <= Math.round(maxChars * 1.35)) {
      repaired[repaired.length - 1] = normalizeSubtitleDisplayText(`${previous} ${chunk}`);
    } else {
      repaired.push(chunk);
    }
  }

  return repaired;
}

function subtitleLineLengthForConfig(config = {}, aspectRatio = 0) {
  const configured = Math.max(18, Math.min(DEFAULT_MAX_CHARS_PER_LINE, Number(config.maxCharsPerLine) || DEFAULT_MAX_CHARS_PER_LINE));
  const ratio = Number(aspectRatio) || 0;
  if (ratio > 0 && ratio <= 0.7) return Math.min(configured, 22);
  if (ratio > 0 && ratio < 1.05) return Math.min(configured, 26);
  return configured;
}

function formatSubtitleMaxWordsPerLine(text, maxWords = 15) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ').filter(Boolean);
  if (words.length <= maxWords) {
    return [clean];
  }

  const numLines = Math.ceil(words.length / maxWords);
  const targetWordsPerLine = Math.ceil(words.length / numLines);

  const lines = [];
  let remainingText = clean;

  while (remainingText) {
    const remWords = remainingText.split(' ').filter(Boolean);
    if (remWords.length <= maxWords) {
      lines.push(remainingText);
      break;
    }

    let foundPunctuationIndex = -1;
    for (let offset = 0; offset <= 3; offset++) {
      const candidates = [targetWordsPerLine + offset, targetWordsPerLine - offset];
      for (const idx of candidates) {
        if (idx > 0 && idx < remWords.length) {
          const w = remWords[idx - 1];
          if (/[.,!?;:，。！？；:]/.test(w)) {
            foundPunctuationIndex = idx;
            break;
          }
        }
      }
      if (foundPunctuationIndex !== -1) break;
    }

    const cutIndex = foundPunctuationIndex !== -1 ? foundPunctuationIndex : targetWordsPerLine;
    const lineText = remWords.slice(0, cutIndex).join(' ');
    lines.push(lineText);
    remainingText = remWords.slice(cutIndex).join(' ');
  }

  return lines;
}

function activePreviewSubtitleChunk(row, text, currentTime, maxLineLength) {
  const cleanText = normalizeSubtitleDisplayText(text);
  if (!cleanText) return '';

  // A preview cue is deliberately short: long narration is shown as timed
  // chunks instead of being kept in one oversized two-line subtitle card.
  const maxChars = Math.max(18, maxLineLength);
  const chunks = repairPreviewSubtitleChunks(splitLongPreviewSubtitle(cleanText, maxChars), maxChars);
  if (chunks.length <= 1) return cleanText;

  const start = Number(row?.start) || 0;
  const end = Math.max(start + 0.01, Number(row?.end) || start + Number(row?.duration) || start + 1);
  const duration = Math.max(0.01, end - start);
  const elapsed = Math.min(duration, Math.max(0, Number(currentTime) - start));
  const totalWeight = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
  let cursor = 0;

  for (const chunk of chunks) {
    const chunkDuration = duration * (Math.max(1, chunk.length) / totalWeight);
    cursor += chunkDuration;
    if (elapsed <= cursor) return chunk;
  }

  return chunks[chunks.length - 1];
}

function isManualStreamUrl(value) {
  return /\/api\/manual\/video\//i.test(String(value || ''));
}

function inferPreviewUrlFromSource(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  return url.replace(/source_video\.[a-z0-9]+$/i, 'preview_source.mp4');
}

function ensureUniqueRowIds(rows = []) {
  const seen = new Map();
  return (rows || []).map((row, index) => {
    const baseId = String(row?.id || `row-${index + 1}`).trim() || `row-${index + 1}`;
    const count = seen.get(baseId) || 0;
    seen.set(baseId, count + 1);
    return {
      ...row,
      id: count === 0 ? baseId : `${baseId}__${count + 1}`,
    };
  });
}

function hasDuplicateRowIds(rows = []) {
  const seen = new Set();
  return (rows || []).some((row, index) => {
    const id = String(row?.id || `row-${index + 1}`).trim() || `row-${index + 1}`;
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

function mapSourceRows(segments = []) {
  return ensureUniqueRowIds(segments.map((segment, index) => {
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) || start + Math.max(0.1, Number(segment.duration) || 1);
    return {
      id: String(segment.id || `row-${index + 1}`),
      index: index + 1,
      start,
      end,
      duration: Math.max(0.1, end - start),
      sourceText: String(segment.text || '').trim(),
      sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String).filter(Boolean) : [String(segment.id || `row-${index + 1}`)],
      sourceRowIds: Array.isArray(segment.sourceRowIds)
        ? segment.sourceRowIds.map(String).filter(Boolean)
        : (Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String).filter(Boolean) : [String(segment.id || `row-${index + 1}`)]),
      originalCues: Array.isArray(segment.originalCues) ? segment.originalCues : [],
      groupId: segment.groupId || '',
      templateGroupCreatedBy: segment.templateGroupCreatedBy || '',
      templateGroupReason: segment.templateGroupReason || '',
      words: Array.isArray(segment.words) ? segment.words : [],
      translatedText: '',
      finalText: '',
      dirty: false,
    };
  }));
}

function findBaseRowForSegment(rows = [], segment = {}, fallbackIndex = 0) {
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || start + Math.max(0.1, Number(segment.duration) || 1);
  let best = null;
  let bestOverlap = 0;

  for (const row of rows || []) {
    const rowStart = Number(row.start) || 0;
    const rowEnd = Number(row.end) || rowStart + Math.max(0.1, Number(row.duration) || 1);
    const overlap = Math.max(0, Math.min(end, rowEnd) - Math.max(start, rowStart));
    if (overlap > bestOverlap) {
      best = row;
      bestOverlap = overlap;
    }
  }

  return best || rows[fallbackIndex] || {};
}

function mergeTranslatedRows(segments = [], rows = []) {
  return ensureUniqueRowIds(segments.map((segment, index) => {
    const base = findBaseRowForSegment(rows, segment, index);
    const start = Number(segment.start ?? base.start) || 0;
    const end = Number(segment.end ?? base.end) || start + Math.max(0.1, Number(segment.duration ?? base.duration) || 1);
    const text = String(segment.text || segment.translatedText || '').trim();
    return {
      id: String(segment.id || base.id || `row-${index + 1}`),
      index: index + 1,
      start,
      end,
      duration: Math.max(0.1, end - start),
      sourceText: String(segment.originalText || base.sourceText || '').trim(),
      translatedText: text,
      finalText: text,
      ttsText: String(segment.ttsText || '').trim(),
      sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String).filter(Boolean) : [String(segment.id || base.id || '')].filter(Boolean),
      sourceRowIds: Array.isArray(segment.sourceRowIds)
        ? segment.sourceRowIds.map(String).filter(Boolean)
        : (Array.isArray(segment.sourceIds) ? segment.sourceIds.map(String).filter(Boolean) : [String(segment.id || base.id || '')].filter(Boolean)),
      atomIds: Array.isArray(segment.atomIds) ? segment.atomIds.map(String).filter(Boolean) : [],
      status: String(segment.status || segment.validationStatus || 'translated'),
      validationStatus: String(segment.validationStatus || segment.status || ''),
      errorMsg: String(segment.errorMsg || '').trim(),
      meaningUnitId: String(segment.meaningUnitId || '').trim(),
      ttsTimingFit: segment.ttsTimingFit && typeof segment.ttsTimingFit === 'object' ? segment.ttsTimingFit : null,
      ttsTimingProbe: segment.ttsTimingProbe && typeof segment.ttsTimingProbe === 'object' ? segment.ttsTimingProbe : null,
      dirty: false,
    };
  }));
}

function rowsToSegments(rows, field) {
  return rows
    .map((row) => ({
      id: row.id,
      start: row.start,
      end: row.end,
      duration: row.duration,
      text: rowText(row, field),
      ttsText: row.ttsText || row.finalText || row.translatedText || '',
      originalText: row.sourceText,
      translatedText: row.translatedText,
      finalText: row.finalText,
      sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds : [row.id].filter(Boolean),
      sourceRowIds: Array.isArray(row.sourceRowIds)
        ? row.sourceRowIds
        : (Array.isArray(row.sourceIds) ? row.sourceIds : [row.id].filter(Boolean)),
      originalCues: Array.isArray(row.originalCues) ? row.originalCues : [],
      groupId: row.groupId || '',
      templateGroupCreatedBy: row.templateGroupCreatedBy || '',
      templateGroupReason: row.templateGroupReason || '',
      words: Array.isArray(row.words) ? row.words : [],
      atomIds: Array.isArray(row.atomIds) ? row.atomIds : [],
      status: row.status,
      validationStatus: row.validationStatus,
    }))
    .filter((segment) => segment.text);
}

function rowText(row, preferredField = 'finalText') {
  if (!row) return '';
  const preferred = String(row[preferredField] || '').trim();
  if (preferred) return preferred;
  if (preferredField === 'sourceText') {
    return String(row.sourceText || row.finalText || row.translatedText || '').trim();
  }
  return String(row.finalText || row.translatedText || row.sourceText || '').trim();
}

function unitSourceIds(unit = {}) {
  return Array.from(new Set([
    ...(Array.isArray(unit.sourceIds) ? unit.sourceIds : []),
    ...(Array.isArray(unit.sourceRowIds) ? unit.sourceRowIds : []),
    unit.id,
    unit.segmentId,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function rowTimelineReferenceIds(row = {}) {
  return Array.from(new Set([
    row.id,
    row.segmentId,
    ...(Array.isArray(row.sourceRowIds) ? row.sourceRowIds : []),
    ...(Array.isArray(row.sourceIds) ? row.sourceIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function unitTimelineReferenceIds(unit = {}) {
  const explicit = [
    ...(Array.isArray(unit.sourceRowIds) ? unit.sourceRowIds : []),
    ...(Array.isArray(unit.sourceIds) ? unit.sourceIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const refs = explicit.length
    ? explicit
    : [unit.id, unit.segmentId].map((value) => String(value || '').trim()).filter(Boolean);
  return Array.from(new Set(refs.filter((ref) => !ref.startsWith('meaning-'))));
}

function updateUnitsForAppliedRows(units = [], nextRows = [], targetIds = new Set(), finalField = 'finalText') {
  if (!Array.isArray(units) || !targetIds?.size) return units;
  const rowsById = new Map(nextRows.map((row) => [String(row.id), row]));
  return units.map((unit) => {
    const ids = unitSourceIds(unit);
    if (!ids.some((id) => targetIds.has(id))) return unit;
    const unitRows = ids.map((id) => rowsById.get(id)).filter(Boolean);
    const text = unitRows.length
      ? unitRows.map((row) => rowText(row, finalField)).filter(Boolean).join(' ')
      : String(unit.text || unit.finalText || unit.translatedText || unit.ttsText || '').trim();
    if (!text) return unit;
    return {
      ...unit,
      translatedText: text,
      finalText: text,
      text,
      ttsText: text,
      prosodyText: text,
    };
  });
}

function rowsWithFinalText(rows) {
  return rows.map((row) => {
    const text = rowText(row, 'finalText');
    if (!text) return row;
    return {
      ...row,
      translatedText: String(row.translatedText || '').trim() || text,
      finalText: String(row.finalText || '').trim() || text,
    };
  });
}

function isTemplateGroupRow(row = {}) {
  return row.templateGroupCreatedBy === 'ai_grouping'
    || Array.isArray(row.originalCues) && row.originalCues.length > 0
    || String(row.id || '').startsWith('template-');
}

function rowsAreTemplateGroups(rows = []) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(isTemplateGroupRow);
}

function effectiveTtsUnitModeForRows(mode, rows = []) {
  const normalized = ['story_segments', 'meaning_units', 'post_translation'].includes(mode) ? mode : DEFAULT_STATE.config.ttsUnitMode;
  return normalized === 'story_segments' && rowsAreTemplateGroups(rows) ? 'post_translation' : normalized;
}

function formatSecondsShort(value) {
  const seconds = Math.abs(Number(value) || 0);
  return `${seconds.toFixed(seconds >= 1 ? 1 : 2)}s`;
}

function formatSignedSeconds(value) {
  const seconds = Number(value) || 0;
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  return `${sign}${formatSecondsShort(seconds)}`;
}

function ttsMajorOverflowThreshold(item = {}) {
  return Number(item.speedFactor) > 1.001
    ? TTS_POST_SPEED_MAJOR_OVERFLOW_SECONDS
    : TTS_TIMING_MAJOR_OVERFLOW_SECONDS;
}

function ttsReportItemMetrics(item = {}) {
  const ttsError = item.ttsError === true || item.status === 'error' || Boolean(item.errorMessage || item.error_reason);
  const actualDriftSeconds = Number(item.startDriftSeconds) || 0;
  const alignedByPlanner = item.voiceAlignApplied === true;
  const unplannedStartDriftSeconds = Number.isFinite(Number(item.unplannedStartDriftSeconds))
    ? Number(item.unplannedStartDriftSeconds)
    : (alignedByPlanner ? 0 : actualDriftSeconds);
  const endOverflowSeconds = Number(item.endOverflowSeconds) || 0;
  const cueEndOverflowSeconds = Number(item.cueEndOverflowSeconds) || 0;
  const overlapNextSeconds = Number(item.overlapNextSeconds) || 0;
  const maxOverflowSeconds = Math.max(0, endOverflowSeconds, overlapNextSeconds);
  const majorOverflowThreshold = ttsMajorOverflowThreshold(item);
  const hasTraceOverflow = maxOverflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS;
  const hasMajorOverflow = maxOverflowSeconds >= majorOverflowThreshold;
  const hasStartDrift = Math.abs(unplannedStartDriftSeconds) > TTS_TIMING_START_DRIFT_SECONDS;
  const timingNotice = ttsError || hasStartDrift || hasTraceOverflow;
  const timingWarning = ttsError
    || hasStartDrift
    || hasMajorOverflow;
  const overflowSeverity = hasMajorOverflow ? 'major' : (hasTraceOverflow ? 'minor' : 'none');
  return {
    timingNotice,
    timingWarning,
    ttsError,
    actualDriftSeconds,
    unplannedStartDriftSeconds,
    alignedByPlanner,
    cueEndOverflowSeconds,
    endOverflowSeconds,
    overlapNextSeconds,
    maxOverflowSeconds,
    overflowSeverity,
  };
}

function ttsReportItemSourceIds(item = {}) {
  return [
    ...(Array.isArray(item.sourceRowIds) ? item.sourceRowIds : []),
    ...(Array.isArray(item.sourceIds) ? item.sourceIds : []),
    item.id,
  ].map(String).filter(Boolean);
}

function hasTtsSyncWarning(ttsSync) {
  if (!ttsSync) return false;
  const ttsError = ttsSync.ttsError === true || ttsSync.status === 'error' || Boolean(ttsSync.errorMessage || ttsSync.error_reason);
  const drift = Number.isFinite(Number(ttsSync.unplannedStartDriftSeconds))
    ? Number(ttsSync.unplannedStartDriftSeconds)
    : Number(ttsSync.startDriftSeconds) || 0;
  const overflow = Number(ttsSync.endOverflowSeconds) || 0;
  const overlap = Number(ttsSync.overlapNextSeconds) || 0;
  return ttsError
    || Math.abs(drift) > TTS_TIMING_START_DRIFT_SECONDS
    || Math.max(overflow, overlap) >= ttsMajorOverflowThreshold(ttsSync);
}

function hasTtsSyncNotice(ttsSync) {
  if (!ttsSync) return false;
  const ttsError = ttsSync.ttsError === true || ttsSync.status === 'error' || Boolean(ttsSync.errorMessage || ttsSync.error_reason);
  const drift = Number.isFinite(Number(ttsSync.unplannedStartDriftSeconds))
    ? Number(ttsSync.unplannedStartDriftSeconds)
    : Number(ttsSync.startDriftSeconds) || 0;
  const overflow = Number(ttsSync.endOverflowSeconds) || 0;
  const overlap = Number(ttsSync.overlapNextSeconds) || 0;
  return ttsError
    || Math.abs(drift) > TTS_TIMING_START_DRIFT_SECONDS
    || Math.max(overflow, overlap) > TTS_TIMING_TRACE_OVERFLOW_SECONDS;
}

function overlapSeconds(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function rowIdForTtsWarning(item, rows = [], claimedRowIds = new Set()) {
  const rowById = new Map(rows.map((row) => [String(row.id), row]));
  const sourceIds = ttsReportItemSourceIds(item);
  const directRows = sourceIds.map((id) => rowById.get(id)).filter(Boolean);
  if (directRows.length) {
    const metrics = ttsReportItemMetrics(item);
    const candidates = directRows.filter((row) => !claimedRowIds.has(String(row.id)));
    const pool = candidates.length ? candidates : directRows;
    const itemStart = Number(item.expectedStartSeconds ?? item.start ?? item.actualStartSeconds);
    const itemEnd = Number(item.expectedEndSeconds ?? item.end ?? item.actualEndSeconds);
    const timelineRows = Number.isFinite(itemStart) && Number.isFinite(itemEnd) && itemEnd > itemStart
      ? pool
        .map((row) => ({
          row,
          overlap: overlapSeconds(itemStart, itemEnd, Number(row.start) || 0, Number(row.end) || Number(row.start) || 0),
        }))
        .filter((entry) => entry.overlap > 0.001)
      : [];
    if (metrics.maxOverflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS) {
      if (timelineRows.length) {
        const boundaryRow = timelineRows.reduce((best, entry) => {
          const endDistance = Math.abs((Number(entry.row.end) || 0) - itemEnd);
          const bestEndDistance = Math.abs((Number(best.row.end) || 0) - itemEnd);
          if (endDistance !== bestEndDistance) return endDistance < bestEndDistance ? entry : best;
          return entry.overlap > best.overlap ? entry : best;
        }, timelineRows[0]);
        return String(boundaryRow.row.id);
      }
      return String(pool.reduce((best, row) => (Number(row.end) || 0) > (Number(best.end) || 0) ? row : best, pool[0]).id);
    }
    if (Math.abs(metrics.unplannedStartDriftSeconds) > TTS_TIMING_START_DRIFT_SECONDS) {
      if (timelineRows.length) {
        const boundaryRow = timelineRows.reduce((best, entry) => {
          const startDistance = Math.abs((Number(entry.row.start) || 0) - itemStart);
          const bestStartDistance = Math.abs((Number(best.row.start) || 0) - itemStart);
          if (startDistance !== bestStartDistance) return startDistance < bestStartDistance ? entry : best;
          return entry.overlap > best.overlap ? entry : best;
        }, timelineRows[0]);
        return String(boundaryRow.row.id);
      }
      return String(pool.reduce((best, row) => (Number(row.start) || 0) < (Number(best.start) || 0) ? row : best, pool[0]).id);
    }
    if (timelineRows.length) {
      return String(timelineRows.reduce((best, entry) => entry.overlap > best.overlap ? entry : best, timelineRows[0]).row.id);
    }
    return String(pool[0].id);
  }

  const itemStart = Number(item.expectedStartSeconds ?? item.start ?? item.actualStartSeconds);
  const itemEnd = Number(item.expectedEndSeconds ?? item.end ?? item.actualEndSeconds);
  if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemEnd <= itemStart) return '';

  let bestRow = null;
  let bestScore = 0;
  for (const row of rows) {
    const rowId = String(row.id);
    const rowStart = Number(row.start) || 0;
    const rowEnd = Number(row.end) || rowStart;
    const score = overlapSeconds(itemStart, itemEnd, rowStart, rowEnd);
    if (claimedRowIds.has(rowId) && score <= bestScore) continue;
    if (score > bestScore) {
      bestRow = row;
      bestScore = score;
    }
  }
  return bestRow ? String(bestRow.id) : '';
}

function rowsWithTtsReport(rows, report) {
  const reportItems = Array.isArray(report?.segments) ? report.segments : [];
  if (!reportItems.length) {
    return rows.map((row) => ({ ...row, ttsSync: null }));
  }

  const byRowId = new Map();
  const claimedRowIds = new Set();
  for (const item of reportItems) {
    const metrics = ttsReportItemMetrics(item);
    if (!metrics.timingNotice) continue;
    const rowId = rowIdForTtsWarning(item, rows, claimedRowIds);
    if (!rowId) continue;
    claimedRowIds.add(rowId);
    byRowId.set(rowId, {
      status: metrics.timingWarning ? 'warn' : 'notice',
      ttsUnitId: String(item.id || ''),
      ttsUnitIndex: Number(item.index) || 0,
      sourceIds: ttsReportItemSourceIds(item),
      startDriftSeconds: metrics.actualDriftSeconds,
      unplannedStartDriftSeconds: metrics.unplannedStartDriftSeconds,
      voiceAlignApplied: metrics.alignedByPlanner,
      voiceAlignShiftSeconds: Number(item.voiceAlignShiftSeconds) || 0,
      ttsError: metrics.ttsError,
      errorMessage: String(item.errorMessage || item.error_reason || item.reason || '').trim(),
      errorCode: String(item.errorCode || '').trim(),
      cueEndOverflowSeconds: metrics.cueEndOverflowSeconds,
      endOverflowSeconds: metrics.endOverflowSeconds,
      overlapNextSeconds: metrics.overlapNextSeconds,
      maxOverflowSeconds: metrics.maxOverflowSeconds,
      overflowSeverity: metrics.overflowSeverity,
      speedFactor: Number(item.speedFactor) || 1,
      effectiveSpeedFactor: Number(item.effectiveSpeedFactor) || 1,
    });
  }

  return rows.map((row) => ({
    ...row,
    ttsSync: byRowId.get(String(row.id)) || null,
  }));
}

function ttsSyncWarningReasons(ttsSync) {
  if (!hasTtsSyncNotice(ttsSync)) return [];
  const reasons = [];
  if (ttsSync.ttsError) {
    reasons.push(ttsSync.errorMessage || 'lỗi TTS');
  }
  const drift = Number(ttsSync.unplannedStartDriftSeconds) || 0;
  const overflow = Number(ttsSync.endOverflowSeconds) || 0;
  const overlap = Number(ttsSync.overlapNextSeconds) || 0;
  if (Math.abs(drift) > TTS_TIMING_START_DRIFT_SECONDS) reasons.push(`lệch ${formatSignedSeconds(drift)}`);
  const maxOverflow = Math.max(overflow, overlap);
  if (maxOverflow > TTS_TIMING_TRACE_OVERFLOW_SECONDS) reasons.push(`tràn ${formatSecondsShort(maxOverflow)}`);
  return reasons;
}

function ttsSyncBadgeText(ttsSync) {
  if (ttsSync?.ttsError) return 'lỗi TTS';
  const reasons = ttsSyncWarningReasons(ttsSync);
  return reasons.length ? reasons[0] : '';
}

function translationTimingBadgeText(fit) {
  if (!fit || !['too_long', 'too_short'].includes(String(fit.status || ''))) return '';
  return fit.status === 'too_long' ? 'dịch dài' : 'dịch ngắn';
}

function translationTimingTitle(fit, probe) {
  if (!fit || !['too_long', 'too_short'].includes(String(fit.status || ''))) return '';
  const estimated = Number(fit.estimatedSeconds) || 0;
  const slot = Number(fit.slotSeconds) || 0;
  const rate = Number(fit.targetTtsRate) || 1;
  const actual = Number(probe?.actualSeconds) || 0;
  const timing = actual > 0
    ? `đo TTS ${formatSecondsShort(actual)}`
    : `ước lượng ${formatSecondsShort(estimated)}`;
  return `Cảnh báo dịch: ${timing} / slot ${formatSecondsShort(slot)} ở mục tiêu ${rate.toFixed(2)}x. TTS vẫn chạy bình thường.`;
}

function ttsRepairIssueForRow(row = {}, finalField = 'finalText') {
  const reasons = [];
  const text = rowText(row, finalField);
  const rowDuration = Math.max(0.1, Number(row.duration) || ((Number(row.end) || 0) - (Number(row.start) || 0)) || 0.1);
  let slotSeconds = rowDuration;
  let audioSeconds = 0;
  let overflowSeconds = 0;
  let fitRatio = 1;
  let severity = 'manual';

  if (hasTtsSyncNotice(row.ttsSync)) {
    const syncReasons = ttsSyncWarningReasons(row.ttsSync);
    reasons.push(syncReasons.join(', ') || 'TTS timing');
    const overflow = Math.max(
      0,
      Number(row.ttsSync.endOverflowSeconds) || 0,
      Number(row.ttsSync.overlapNextSeconds) || 0
    );
    overflowSeconds = Math.max(overflowSeconds, overflow);
    audioSeconds = Math.max(audioSeconds, rowDuration + overflow);
    fitRatio = Math.max(fitRatio, audioSeconds / Math.max(0.1, rowDuration));
    severity = hasTtsSyncWarning(row.ttsSync) ? 'major' : 'minor';
  }

  if (row.ttsTimingFit?.status === 'too_long') {
    const fit = row.ttsTimingFit;
    const fitSlot = Number(fit.slotSeconds || row.duration || rowDuration) || rowDuration;
    const estimated = Number(fit.estimatedSeconds || 0);
    const fitOverflow = Math.max(0, estimated - fitSlot);
    reasons.push(`dịch dài ${formatSecondsShort(fitOverflow)}`);
    slotSeconds = Math.max(0.1, fitSlot);
    audioSeconds = Math.max(audioSeconds, estimated || fitSlot + fitOverflow);
    overflowSeconds = Math.max(overflowSeconds, fitOverflow);
    fitRatio = Math.max(fitRatio, audioSeconds / Math.max(0.1, slotSeconds));
    severity = fitOverflow >= TTS_TIMING_MAJOR_OVERFLOW_SECONDS ? 'major' : (severity === 'major' ? 'major' : 'minor');
  }

  if (!reasons.length) return null;
  if (!audioSeconds) audioSeconds = slotSeconds + overflowSeconds;
  return {
    reason: Array.from(new Set(reasons.filter(Boolean))).join(' · '),
    slotSeconds: Number(slotSeconds.toFixed(3)),
    audioSeconds: Number(audioSeconds.toFixed(3)),
    overflowSeconds: Number(overflowSeconds.toFixed(3)),
    fitRatio: Number(fitRatio.toFixed(3)),
    severity,
    selectedByDefault: severity !== 'minor',
  };
}

function ttsRepairPayloadForRow(row = {}, rows = [], finalField = 'finalText', basketItem = null) {
  const issue = ttsRepairIssueForRow(row, finalField);
  const currentTranslation = rowText(row, finalField);
  const rowIndex = rows.findIndex((item) => item.id === row.id);
  const previous = rowIndex > 0 ? rows[rowIndex - 1] : null;
  const next = rowIndex >= 0 ? rows[rowIndex + 1] : null;
  const slotSeconds = Number(issue?.slotSeconds || row.duration || 0);
  const audioSeconds = Number(issue?.audioSeconds || slotSeconds);
  const overflowSeconds = Number(issue?.overflowSeconds || Math.max(0, audioSeconds - slotSeconds));
  const fitRatio = Number(issue?.fitRatio || (slotSeconds > 0 ? audioSeconds / slotSeconds : 1)) || 1;
  const canKeepDraft = basketItem?.currentTranslation === currentTranslation;
  return {
    rowId: row.id,
    row_id: row.id,
    source_text: String(row.sourceText || row.originalText || '').trim(),
    current_translation: currentTranslation,
    previous_translation: previous ? rowText(previous, finalField) : '',
    next_translation: next ? rowText(next, finalField) : '',
    slot_seconds: Number(slotSeconds.toFixed(3)),
    audio_seconds: Number(audioSeconds.toFixed(3)),
    overflow_seconds: Number(overflowSeconds.toFixed(3)),
    fit_ratio: Number(fitRatio.toFixed(3)),
    target_tts_rate: 1,
    error_reason: issue?.reason || basketItem?.reason || 'manual review',
    selected: basketItem ? basketItem.selected !== false : (issue ? issue.selectedByDefault !== false : false),
    reason: issue?.reason || basketItem?.reason || 'manual review',
    slotSeconds: Number(slotSeconds.toFixed(3)),
    audioSeconds: Number(audioSeconds.toFixed(3)),
    overflowSeconds: Number(overflowSeconds.toFixed(3)),
    fitRatio: Number(fitRatio.toFixed(3)),
    currentTranslation,
    repairedTranslation: canKeepDraft ? String(basketItem?.repairedTranslation || '').trim() : '',
    status: canKeepDraft ? String(basketItem?.status || '').trim() : '',
    manual: basketItem?.manual === true || !issue,
    severity: issue?.severity || basketItem?.severity || 'manual',
    applySelected: canKeepDraft && basketItem?.applySelected === true,
    repairPromptVersion: canKeepDraft ? String(basketItem?.repairPromptVersion || '').trim() : '',
    repairPromptStale: canKeepDraft ? basketItem?.repairPromptStale === true : false,
    ttsPreviewStatus: canKeepDraft ? String(basketItem?.ttsPreviewStatus || '').trim() : '',
    ttsPreviewSlotSeconds: canKeepDraft ? Number(basketItem?.ttsPreviewSlotSeconds) || 0 : 0,
    ttsPreviewAudioSeconds: canKeepDraft ? Number(basketItem?.ttsPreviewAudioSeconds) || 0 : 0,
    ttsPreviewDeltaSeconds: canKeepDraft ? Number(basketItem?.ttsPreviewDeltaSeconds) || 0 : 0,
    ttsPreviewOverflowSeconds: canKeepDraft ? Number(basketItem?.ttsPreviewOverflowSeconds) || 0 : 0,
    ttsPreviewSlackSeconds: canKeepDraft ? Number(basketItem?.ttsPreviewSlackSeconds) || 0 : 0,
    ttsPreviewCheckedAt: canKeepDraft ? String(basketItem?.ttsPreviewCheckedAt || '').trim() : '',
    ttsPreviewTranslation: canKeepDraft ? String(basketItem?.ttsPreviewTranslation || '').trim() : '',
    ttsPreviewId: canKeepDraft ? String(basketItem?.ttsPreviewId || '').trim() : '',
    aimaxBatchIndex: canKeepDraft ? basketItem?.aimaxBatchIndex ?? null : null,
    aimaxEntryIndex: canKeepDraft ? basketItem?.aimaxEntryIndex ?? null : null,
    aimaxSegmentFileName: canKeepDraft ? String(basketItem?.aimaxSegmentFileName || '').trim() : '',
  };
}

function mergeTtsReports(previousReport, nextReport, rowId) {
  const targetId = String(rowId || '');
  const previousSegments = Array.isArray(previousReport?.segments) ? previousReport.segments : [];
  const nextSegments = Array.isArray(nextReport?.segments) ? nextReport.segments : [];
  const segments = [
    ...previousSegments.filter((item) => !ttsReportItemSourceIds(item).includes(targetId)),
    ...nextSegments,
  ];
  const metrics = segments.map(ttsReportItemMetrics);
  const failedSegmentCount = metrics.filter((item) => item.timingWarning).length;
  const minorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'minor').length;
  const majorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'major').length;
  return {
    ...(previousReport || {}),
    ...(nextReport || {}),
    segments,
    failedSegmentCount,
    minorOverflowSegmentCount,
    majorOverflowSegmentCount,
    strictPass: failedSegmentCount === 0,
  };
}

function reportWithTimelineWarnings(report) {
  const segments = Array.isArray(report?.segments) ? report.segments : [];
  if (!report || !segments.length) return report || null;
  const metrics = segments.map(ttsReportItemMetrics);
  const failedSegmentCount = metrics.filter((item) => item.timingWarning).length;
  const minorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'minor').length;
  const majorOverflowSegmentCount = metrics.filter((item) => item.overflowSeverity === 'major').length;
  return {
    ...report,
    failedSegmentCount,
    minorOverflowSegmentCount,
    majorOverflowSegmentCount,
    strictPass: failedSegmentCount === 0,
  };
}

function rowsToTtsSegments(rows) {
  return rowsToSegments(
    rows.map((row) => ({
      ...row,
      ttsText: rowText(row, 'finalText'),
    })),
    'ttsText'
  );
}

function meaningUnitsStillMatchRows(meaningUnits = [], rows = []) {
  if (!Array.isArray(meaningUnits) || !meaningUnits.length || !Array.isArray(rows) || !rows.length) {
    return false;
  }
  if (rows.some((row) => row.dirty)) {
    return false;
  }
  const rowIds = rows.map((row) => String(row.id || '')).filter(Boolean);
  if (!rowIds.length) {
    return false;
  }
  const rowRefSet = new Set();
  const rowIdsByRef = new Map();
  rows.forEach((row) => {
    const rowId = String(row.id || '').trim();
    if (!rowId) return;
    rowTimelineReferenceIds(row).forEach((ref) => {
      rowRefSet.add(ref);
      const existing = rowIdsByRef.get(ref) || [];
      rowIdsByRef.set(ref, [...existing, rowId]);
    });
  });
  const covered = new Set();
  for (const unit of meaningUnits) {
    const sourceIds = unitTimelineReferenceIds(unit);
    if (!sourceIds.length) return false;
    if (sourceIds.some((sourceId) => !rowRefSet.has(sourceId))) return false;
    const matchedRowIds = new Set(sourceIds.flatMap((sourceId) => rowIdsByRef.get(sourceId) || []));
    if (!matchedRowIds.size) return false;
    matchedRowIds.forEach((rowId) => covered.add(rowId));
  }
  return rowIds.every((rowId) => covered.has(rowId));
}

function countWords(rows) {
  return rows.reduce((total, row) => {
    const text = String(row.finalText || row.translatedText || row.sourceText || '').trim();
    return total + (text ? text.split(/\s+/).length : 0);
  }, 0);
}

function inferVoiceFamily(voiceName = '') {
  const name = String(voiceName || '');
  const families = ['Chirp3-HD', 'Chirp-HD', 'Neural2', 'Wavenet', 'Studio', 'Standard', 'News', 'Polyglot', 'Journey', 'Casual', 'Custom'];
  const matched = families.find((family) => name.toLowerCase().includes(family.toLowerCase()));
  if (matched) return matched;
  const parts = name.split('-').filter(Boolean);
  if (parts.length >= 4) return parts.slice(2, -1).join('-') || 'Khác';
  return 'Khác';
}

function voiceSupportsRatePitch(voice = {}) {
  const family = String(voice.family || inferVoiceFamily(voice.value)).toLowerCase();
  return !family.includes('chirp3-hd') && !family.includes('chirp-hd');
}

function normalizeVoiceGender(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'MALE' || text === 'FEMALE' || text === 'NEUTRAL') return text;
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  if (text.startsWith('N')) return 'NEUTRAL';
  return '';
}

function selectedGenderFilter(config = {}) {
  const gender = normalizeVoiceGender(config.voiceGenderFilter);
  return gender || '';
}

function voiceMatchesLanguage(voice = {}, languageCode = '') {
  const requested = String(languageCode || '').trim().toLowerCase();
  if (!requested) return true;
  const aliases = {
    'zh-cn': ['cmn-cn'],
    'cmn-cn': ['zh-cn'],
    'vi-vn': ['vi', 'vietnamese'],
    vi: ['vi-vn', 'vietnamese'],
    vietnamese: ['vi-vn', 'vi'],
    'en-us': ['en', 'english'],
    en: ['en-us', 'english'],
    english: ['en-us', 'en'],
    'ja-jp': ['ja', 'japanese'],
    ja: ['ja-jp', 'japanese'],
    japanese: ['ja-jp', 'ja'],
    'ko-kr': ['ko', 'korean'],
    ko: ['ko-kr', 'korean'],
    korean: ['ko-kr', 'ko'],
    'th-th': ['th', 'thai'],
    th: ['th-th', 'thai'],
    thai: ['th-th', 'th'],
    'id-id': ['id', 'indonesian'],
    id: ['id-id', 'indonesian'],
    indonesian: ['id-id', 'id'],
    'fr-fr': ['fr', 'french'],
    fr: ['fr-fr', 'french'],
    french: ['fr-fr', 'fr'],
    'de-de': ['de', 'german'],
    de: ['de-de', 'german'],
    german: ['de-de', 'de'],
    'es-es': ['es', 'spanish'],
    es: ['es-es', 'spanish'],
    spanish: ['es-es', 'es'],
  };
  const codes = Array.isArray(voice.languageCodes) ? voice.languageCodes : [];
  if (!codes.length) return true;
  return codes.some((code) => {
    const value = String(code || '').trim().toLowerCase();
    return value === requested
      || value.startsWith(`${requested}-`)
      || requested.startsWith(`${value}-`)
      || (aliases[requested] || []).includes(value)
      || (aliases[value] || []).includes(requested);
  });
}

function voiceMatchesConfigFilters(voice = {}, config = {}) {
  const requestedGender = selectedGenderFilter(config);
  if (!voiceMatchesLanguage(voice, config.ttsLanguageCode)) return false;
  if (requestedGender && normalizeVoiceGender(voice.gender) !== requestedGender) return false;
  if (config.voiceFamilyFilter && config.voiceFamilyFilter !== 'all' && voice.family !== config.voiceFamilyFilter) return false;
  if (config.voiceSampleRateFilter && config.voiceSampleRateFilter !== 'all' && String(voice.sampleRate || '') !== String(config.voiceSampleRateFilter)) return false;
  if (config.voiceControlsFilter === 'rate_pitch' && !voice.supportsControls) return false;
  if (config.voiceControlsFilter === 'fixed' && voice.supportsControls) return false;
  return true;
}

function selectVoiceNameForConfig(voices = [], config = {}) {
  const visible = voices.filter((voice) => voiceMatchesConfigFilters(voice, config));
  return visible.some((voice) => voice.value === config.ttsVoiceName)
    ? config.ttsVoiceName
    : (visible[0]?.value || '');
}

function normalizeVoices(voices = []) {
  return voices
    .map((voice) => {
      if (typeof voice === 'string') {
        const family = inferVoiceFamily(voice);
        return { value: voice, label: voice, family, languageCodes: [], sampleRate: '' };
      }
      const value = String(voice.name || voice.voiceName || voice.ShortName || voice.displayName || '').trim();
      const gender = String(voice.ssmlGender || voice.gender || voice.SsmlGender || '').trim();
      const family = String(voice.family || '').trim() || inferVoiceFamily(value);
      const languageCodes = Array.isArray(voice.languageCodes) ? voice.languageCodes : [voice.Locale || voice.locale || voice.languageCode].filter(Boolean);
      const sampleRate = voice.naturalSampleRateHertz || voice.sampleRateHertz || '';
      const displayLabel = String(voice.label || voice.displayName || '').trim();
      const details = [
        gender || '',
        family && family !== 'Khác' ? family : '',
        sampleRate ? `${sampleRate}Hz` : '',
      ].filter(Boolean).join(' | ');
      return value ? {
        value,
        label: displayLabel ? `${displayLabel}${details ? ` (${details})` : ''}` : (details ? `${value} (${details})` : value),
        gender,
        family,
        languageCodes,
        sampleRate: sampleRate ? String(sampleRate) : '',
        supportsControls: voiceSupportsRatePitch({ value, family }),
      } : null;
    })
    .filter(Boolean);
}

function fallbackVoices(provider, languageCode) {
  if (provider === 'aimax_tts') return [];
  const source = provider === 'google_cloud_tts' ? GOOGLE_FALLBACK_VOICES : EDGE_FALLBACK_VOICES;
  return (source[languageCode] || []).map((voice) => {
    const lower = voice.toLowerCase();
    const gender = /(nam|minh|andrew|brian|guy|roger|steffan|yunjian|yunxi|yunyang|keita|daichi|naoki|hyunsu|injoon|niwat|ardi|henri|conrad|killian|alvaro|charon|fenrir|iapetus|puck)/i.test(lower)
      ? 'MALE'
      : /(hoaimy|aria|ava|emma|jenny|michelle|xiaoxiao|xiaoyi|yunxia|nanami|aoi|mayu|shiori|sunhi|premwadee|gadis|denise|eloise|vivienne|amala|katja|seraphina|elvira|ximena|achernar|aoede|gacrux)/i.test(lower)
        ? 'FEMALE'
        : '';
    const family = inferVoiceFamily(voice);
    return { value: voice, label: gender ? `${voice} (${gender} | ${family})` : `${voice} (${family})`, gender, family, languageCodes: [languageCode], sampleRate: '', supportsControls: voiceSupportsRatePitch({ value: voice, family }) };
  });
}

function filterVoices(voices, config = {}) {
  return voices.filter((voice) => voiceMatchesConfigFilters(voice, config));
}

function uniqueVoiceOptions(voices, field) {
  return Array.from(new Set(voices.map((voice) => String(voice[field] || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function contextMenuPosition(x, y) {
  if (typeof window === 'undefined') return { x, y };
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: clamp(x, CONTEXT_MENU_MARGIN, Math.max(CONTEXT_MENU_MARGIN, maxX)),
    y: clamp(y - CONTEXT_MENU_HEIGHT, CONTEXT_MENU_MARGIN, Math.max(CONTEXT_MENU_MARGIN, maxY)),
  };
}

function configFromGroqKeyLines(lines) {
  const keys = (Array.isArray(lines) ? lines : ['']).map((item) => String(item || '').trim());
  return { groqApiKey: keys[0] || '', groqBackupKeys: keys.slice(1).join('\n') };
}

function configFromAssemblyAiKeyLines(lines) {
  const keys = (Array.isArray(lines) ? lines : ['']).map((item) => String(item || '').trim());
  return { assemblyAiApiKey: keys[0] || '', assemblyAiBackupKeys: keys.slice(1).join('\n') };
}

function groqKeysText(config) {
  return [config.groqApiKey, config.groqBackupKeys].filter(Boolean).join('\n');
}

function assemblyAiKeysText(config) {
  return [config.assemblyAiApiKey, config.assemblyAiBackupKeys].filter(Boolean).join('\n');
}

function groqKeyLines(config) {
  const text = config.groqBackupKeys
    ? [config.groqApiKey || '', config.groqBackupKeys].join('\n')
    : (config.groqApiKey || '');
  const lines = String(text).split(/\r?\n/);
  return lines.length ? lines : [''];
}

function assemblyAiKeyLines(config) {
  const text = config.assemblyAiBackupKeys
    ? [config.assemblyAiApiKey || '', config.assemblyAiBackupKeys].join('\n')
    : (config.assemblyAiApiKey || '');
  const lines = String(text).split(/\r?\n/);
  return lines.length ? lines : [''];
}

function normalizeSttProvider(value) {
  const provider = value || DEFAULT_STATE.config.sttProvider;
  return STT_PROVIDERS.some((item) => item.value === provider) ? provider : DEFAULT_STATE.config.sttProvider;
}

function effectiveSubtitleGroupLanguage(config = {}) {
  const selected = String(config.subtitleGroupLanguage || DEFAULT_STATE.config.subtitleGroupLanguage).trim();
  if (!selected || selected === 'source') return config.sourceLanguage || DEFAULT_STATE.config.sourceLanguage;
  return selected;
}

function normalizeTranslationProvider(value) {
  const provider = value || DEFAULT_STATE.config.translationProvider;
  return TRANSLATION_PROVIDERS.some((item) => item.value === provider) ? provider : DEFAULT_STATE.config.translationProvider;
}

function normalizeSubtitleGroupProvider(value, fallback = '') {
  const provider = value || fallback || DEFAULT_STATE.config.subtitleGroupProvider || DEFAULT_STATE.config.translationProvider;
  return TRANSLATION_PROVIDERS.some((item) => item.value === provider) ? provider : DEFAULT_STATE.config.subtitleGroupProvider;
}

function normalizeOcrProvider(value) {
  return value === 'rapidocr' ? 'rapidocr' : DEFAULT_STATE.config.ocrProvider;
}

function normalizeTtsProvider(value) {
  return ['edge_tts', 'google_cloud_tts', 'aimax_tts'].includes(value) ? value : DEFAULT_STATE.config.ttsProvider;
}

function normalizeSubtitleCoverConfig(config = {}) {
  const oldDefaultCover = Number(config.subtitleCoverX) === 18
    && Number(config.subtitleCoverW) === 64
    && Number(config.subtitleCoverH) === 10;
  return oldDefaultCover
    ? { subtitleCoverX: 26, subtitleCoverW: 48, subtitleCoverH: 8 }
    : {};
}

function savedSettingsFromConfig(config = {}) {
  const sttProvider = normalizeSttProvider(config.sttProvider);
  const translationProvider = normalizeTranslationProvider(config.translationProvider);
  const subtitleGroupProvider = normalizeSubtitleGroupProvider(config.subtitleGroupProvider, translationProvider);
  const ttsProvider = normalizeTtsProvider(config.ttsProvider);
  return {
    googleApiKey: config.googleApiKey || '',
    googleProjectId: config.googleProjectId || '',
    googleServiceAccountPath: config.googleServiceAccountPath || '',
    googleSttLocation: config.googleSttLocation || DEFAULT_STATE.config.googleSttLocation,
    groqApiKey: config.groqApiKey || '',
    groqBackupKeys: config.groqBackupKeys || '',
    assemblyAiApiKey: config.assemblyAiApiKey || '',
    assemblyAiBackupKeys: config.assemblyAiBackupKeys || '',
    assemblyAiPrompt: config.assemblyAiPrompt || '',
    assemblyAiKeyterms: config.assemblyAiKeyterms || '',
    assemblyAiProcessingMode: config.assemblyAiProcessingMode || DEFAULT_STATE.config.assemblyAiProcessingMode,
    assemblyAiChunkSeconds: Number(config.assemblyAiChunkSeconds ?? DEFAULT_STATE.config.assemblyAiChunkSeconds),
    assemblyAiOverlapSeconds: Number(config.assemblyAiOverlapSeconds ?? DEFAULT_STATE.config.assemblyAiOverlapSeconds),
    assemblyAiConcurrency: Number(config.assemblyAiConcurrency ?? DEFAULT_STATE.config.assemblyAiConcurrency),
    translationProvider,
    subtitleGroupProvider,
    subtitleGroupModel: config.subtitleGroupModel || '',
    cliTranslationModel: config.cliTranslationModel || '',
    cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
    sttProvider,
    sttModel: STT_MODELS[sttProvider]?.includes(config.sttModel) ? config.sttModel : getDefaultSttModel(sttProvider),
    sttTimestampMode: config.sttTimestampMode || DEFAULT_STATE.config.sttTimestampMode,
    nlpSourceResegment: shouldUseSourceResegment(config),
    subtitleGroupSettingsVersion: 1,
    subtitleGroupEnabled: isSubtitleCueGroupingEnabled(config),
    subtitleGroupLanguage: config.subtitleGroupLanguage || DEFAULT_STATE.config.subtitleGroupLanguage,
    subtitleGroupBatchSize: Number(config.subtitleGroupBatchSize ?? DEFAULT_STATE.config.subtitleGroupBatchSize),
    subtitleGroupConcurrency: Number(config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.subtitleGroupConcurrency),
    subtitleGroupProvider,
    subtitleGroupModel: config.subtitleGroupModel || '',
    ocrProvider: normalizeOcrProvider(config.ocrProvider),
    ocrFps: Number(config.ocrFps ?? DEFAULT_STATE.config.ocrFps),
    ocrCropX: Number(config.ocrCropX ?? DEFAULT_STATE.config.ocrCropX),
    ocrCropY: Number(config.ocrCropY ?? DEFAULT_STATE.config.ocrCropY),
    ocrCropW: Number(config.ocrCropW ?? DEFAULT_STATE.config.ocrCropW),
    ocrCropH: Number(config.ocrCropH ?? DEFAULT_STATE.config.ocrCropH),
    ocrMergeSimilarity: Number(config.ocrMergeSimilarity ?? DEFAULT_STATE.config.ocrMergeSimilarity),
    ocrMaxEmptyGap: Number(config.ocrMaxEmptyGap ?? DEFAULT_STATE.config.ocrMaxEmptyGap),
    ocrMinDuration: Number(config.ocrMinDuration ?? DEFAULT_STATE.config.ocrMinDuration),
    ocrRequireCjk: config.ocrRequireCjk !== false,
    ocrSkipUnchanged: config.ocrSkipUnchanged !== false,
    ocrChangeThreshold: Number(config.ocrChangeThreshold ?? DEFAULT_STATE.config.ocrChangeThreshold),
    ocrConcurrency: Number(config.ocrConcurrency ?? DEFAULT_STATE.config.ocrConcurrency),
    ocrMaxKeyframeGap: Number(config.ocrMaxKeyframeGap ?? DEFAULT_STATE.config.ocrMaxKeyframeGap),
    ocrKeyframeProvider: normalizeOcrProvider(config.ocrKeyframeProvider),
    ocrKeyframeTimelineFps: Number(config.ocrKeyframeTimelineFps ?? DEFAULT_STATE.config.ocrKeyframeTimelineFps),
    ocrKeyframeBoundaryRefineWindow: Number(config.ocrKeyframeBoundaryRefineWindow ?? DEFAULT_STATE.config.ocrKeyframeBoundaryRefineWindow),
    ocrLanguageHints: config.ocrLanguageHints || DEFAULT_STATE.config.ocrLanguageHints,
    ttsProvider,
    ttsUnitMode: ['story_segments', 'meaning_units', 'post_translation'].includes(config.ttsUnitMode) ? config.ttsUnitMode : DEFAULT_STATE.config.ttsUnitMode,
    ttsLanguageCode: config.ttsLanguageCode || DEFAULT_STATE.config.ttsLanguageCode,
    ttsVoiceName: config.ttsVoiceName || '',
    ssmlGender: config.ssmlGender || DEFAULT_STATE.config.ssmlGender,
    aimaxApiKey: config.aimaxApiKey || '',
    aimaxBaseUrl: config.aimaxBaseUrl || DEFAULT_AIMAX_BASE_URL,
    aimaxProvider: config.aimaxProvider || DEFAULT_AIMAX_PROVIDER,
    aimaxModel: config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider),
    aimaxSrtBatchEnabled: config.aimaxSrtBatchEnabled === true,
    aimaxSrtBatchMode: normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode),
    aimaxSrtCuesPerRequest: normalizeConfiguredAimaxSrtCuesPerRequest(config.aimaxSrtCuesPerRequest ?? DEFAULT_STATE.config.aimaxSrtCuesPerRequest),
    aimaxSrtRequestCount: clampAimaxSrtRequestCount(config.aimaxSrtRequestCount ?? DEFAULT_STATE.config.aimaxSrtRequestCount),
    aimaxSrtBatchConcurrency: clampAimaxSrtBatchConcurrency(config.aimaxSrtBatchConcurrency ?? DEFAULT_STATE.config.aimaxSrtBatchConcurrency),
    voiceGenderFilter: config.voiceGenderFilter || 'all',
    voiceFamilyFilter: config.voiceFamilyFilter || 'all',
    voiceSampleRateFilter: config.voiceSampleRateFilter || 'all',
    voiceControlsFilter: config.voiceControlsFilter || 'all',
    speakingRate: normalizeSpeakingRate(config.speakingRate),
    ttsFitEnabled: config.ttsFitEnabled !== false,
    ttsFitMode: config.ttsFitMode || DEFAULT_STATE.config.ttsFitMode,
    ttsFitMaxRate: normalizeSpeakingRate(config.speakingRate),
    autoTtsRepairEnabled: config.autoTtsRepairEnabled === true,
    autoTtsRepairMaxPasses: Math.max(1, Math.min(3, Number(config.autoTtsRepairMaxPasses ?? DEFAULT_STATE.config.autoTtsRepairMaxPasses) || DEFAULT_STATE.config.autoTtsRepairMaxPasses)),
    autoTtsRepairMinOverflowSeconds: Number(config.autoTtsRepairMinOverflowSeconds ?? DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds),
    autoTtsRepairMaxRowsPerPass: Math.max(1, Math.min(50, Number(config.autoTtsRepairMaxRowsPerPass ?? DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass)),
    ttsTextCleanupMode: ['natural', 'fast', 'strict'].includes(config.ttsTextCleanupMode) ? config.ttsTextCleanupMode : DEFAULT_STATE.config.ttsTextCleanupMode,
    syncMode: config.syncMode || DEFAULT_STATE.config.syncMode,
    addSilenceGaps: config.addSilenceGaps === true,
    maxVoiceGapSeconds: Number(config.maxVoiceGapSeconds ?? DEFAULT_STATE.config.maxVoiceGapSeconds),
    voiceAlignShortClips: false,
    voiceAlignMode: 'start',
    voiceAlignMinSlackSeconds: Number(config.voiceAlignMinSlackSeconds ?? DEFAULT_STATE.config.voiceAlignMinSlackSeconds),
    voiceAlignMaxShiftSeconds: normalizeVoiceAlignMaxShift(config.voiceAlignMaxShiftSeconds),
    naturalPhraseSync: false,
    phraseLengthMode: config.phraseLengthMode || DEFAULT_STATE.config.phraseLengthMode,
    pauseStyle: config.pauseStyle || DEFAULT_STATE.config.pauseStyle,
    targetPhraseSeconds: Number(config.targetPhraseSeconds ?? DEFAULT_STATE.config.targetPhraseSeconds),
    maxPhraseSeconds: Number(config.maxPhraseSeconds ?? DEFAULT_STATE.config.maxPhraseSeconds),
    ttsConcurrency: Number(config.ttsConcurrency ?? DEFAULT_STATE.config.ttsConcurrency),
    ttsMaxAttempts: Number(config.ttsMaxAttempts ?? DEFAULT_STATE.config.ttsMaxAttempts),
    translationTargetTtsRate: normalizeTranslationTargetTtsRate(config.translationTargetTtsRate ?? DEFAULT_STATE.config.translationTargetTtsRate),
    translationTimingValidationMode: config.translationTimingValidationMode || DEFAULT_STATE.config.translationTimingValidationMode,
    translationTimingRewriteMaxPasses: Number(config.translationTimingRewriteMaxPasses ?? DEFAULT_STATE.config.translationTimingRewriteMaxPasses),
    normalizeTimelineBeforeTranslate: config.normalizeTimelineBeforeTranslate !== false,
    translationDisplayMode: ['source_timeline', 'meaning_timeline'].includes(config.translationDisplayMode)
      ? config.translationDisplayMode
      : DEFAULT_STATE.config.translationDisplayMode,
    timelineMergeGapSeconds: Number(config.timelineMergeGapSeconds ?? DEFAULT_STATE.config.timelineMergeGapSeconds),
    timelineBreakGapSeconds: Number(config.timelineBreakGapSeconds ?? DEFAULT_STATE.config.timelineBreakGapSeconds),
    timelineMaxUnitDuration: Number(config.timelineMaxUnitDuration ?? DEFAULT_STATE.config.timelineMaxUnitDuration),
    naturalDubTargetMinSeconds: Number(config.naturalDubTargetMinSeconds ?? DEFAULT_STATE.config.naturalDubTargetMinSeconds ?? 2.0),
    naturalDubTargetMaxSeconds: Number(config.naturalDubTargetMaxSeconds ?? DEFAULT_STATE.config.naturalDubTargetMaxSeconds ?? 4.2),
    maxMeaningUnitSourceRows: Number(config.maxMeaningUnitSourceRows ?? DEFAULT_STATE.config.maxMeaningUnitSourceRows ?? 3),
    timelineGuardSeconds: Number(config.timelineGuardSeconds ?? DEFAULT_STATE.config.timelineGuardSeconds),
    outputDirectory: config.outputDirectory || '',
    outputCreateFolder: config.outputCreateFolder !== false,
    outputFolderName: config.outputFolderName || '',
    outputAspectRatio: normalizeOutputAspectRatio(config.outputAspectRatio),
    subtitleCoverEnabled: config.subtitleCoverEnabled === true,
    subtitleCoverMode: 'blur',
    subtitleCoverBlur: Number(config.subtitleCoverBlur ?? DEFAULT_STATE.config.subtitleCoverBlur),
    subtitleCoverFeather: Number(config.subtitleCoverFeather ?? DEFAULT_STATE.config.subtitleCoverFeather),
    subtitleCoverColor: config.subtitleCoverColor || DEFAULT_STATE.config.subtitleCoverColor,
    subtitleCoverOpacity: Number(config.subtitleCoverOpacity ?? DEFAULT_STATE.config.subtitleCoverOpacity),
    subtitleCoverX: Number((normalizeSubtitleCoverConfig(config).subtitleCoverX ?? config.subtitleCoverX) ?? DEFAULT_STATE.config.subtitleCoverX),
    subtitleCoverY: Number(config.subtitleCoverY ?? DEFAULT_STATE.config.subtitleCoverY),
    subtitleCoverW: Number((normalizeSubtitleCoverConfig(config).subtitleCoverW ?? config.subtitleCoverW) ?? DEFAULT_STATE.config.subtitleCoverW),
    subtitleCoverH: Number((normalizeSubtitleCoverConfig(config).subtitleCoverH ?? config.subtitleCoverH) ?? DEFAULT_STATE.config.subtitleCoverH),
    musicEnabled: config.musicEnabled === true,
    musicPath: config.musicPath || '',
    musicVolume: Number(config.musicVolume ?? DEFAULT_STATE.config.musicVolume),
    musicFade: config.musicFade !== false,
    logoEnabled: config.logoEnabled === true,
    logoPath: config.logoPath || '',
    logoPosition: config.logoPosition || DEFAULT_STATE.config.logoPosition,
    logoX: Number(config.logoX ?? DEFAULT_STATE.config.logoX),
    logoY: Number(config.logoY ?? DEFAULT_STATE.config.logoY),
    logoSize: Number(config.logoSize ?? DEFAULT_STATE.config.logoSize),
    logoOpacity: Number(config.logoOpacity ?? DEFAULT_STATE.config.logoOpacity),
  };
}

const PROJECT_SAFE_GLOBAL_SETTINGS = new Set(Object.keys(savedSettingsFromConfig(DEFAULT_STATE.config)));

function mergeSettingsDefaults(config = {}, settings = {}, overrideExisting = false) {
  const next = { ...config };
  Object.entries(settings || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (overrideExisting || PROJECT_SAFE_GLOBAL_SETTINGS.has(key) || next[key] === undefined || next[key] === null || next[key] === '') {
      next[key] = value;
    }
  });
  next.sttProvider = normalizeSttProvider(next.sttProvider);
  next.translationProvider = normalizeTranslationProvider(next.translationProvider);
  next.subtitleGroupProvider = normalizeSubtitleGroupProvider(next.subtitleGroupProvider, next.translationProvider);
  next.ocrProvider = normalizeOcrProvider(next.ocrProvider);
  next.ocrKeyframeProvider = normalizeOcrProvider(next.ocrKeyframeProvider);
  next.ttsProvider = normalizeTtsProvider(next.ttsProvider);
  if (!STT_MODELS[next.sttProvider]?.includes(next.sttModel)) {
    next.sttModel = getDefaultSttModel(next.sttProvider);
  }
  return next;
}

function readSavedSettings() {
  if (typeof window === 'undefined') return {};
  return safeJsonParse(window.localStorage.getItem(SETTINGS_STORAGE_KEY), {});
}

function applyGlobalSettingsToState(nextState, overrideExisting = false) {
  const normalized = normalizeState(nextState);
  return {
    ...normalized,
    config: mergeSettingsDefaults(normalized.config, readSavedSettings(), overrideExisting),
  };
}

function createProjectSnapshot(state) {
  const projectId = state.projectId || `project-${Date.now()}`;
  const cleanState = {
    ...state,
    projectId,
    rows: Array.isArray(state.rows) ? ensureUniqueRowIds(state.rows) : [],
  };
  return {
    id: projectId,
    name: String(state.projectName || state.source?.title || fileNameFromPath(state.source?.videoPath) || 'New project').trim(),
    updatedAt: Date.now(),
    state: cleanState,
  };
}

function mergeProjectSnapshot(projects, snapshot) {
  return [snapshot, ...projects.filter((project) => project.id !== snapshot.id)].slice(0, 30);
}

function projectRecoveryScore(state = {}) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const outputs = state.outputs && typeof state.outputs === 'object' ? state.outputs : {};
  const ttsUnits = Array.isArray(state.ttsUnits) ? state.ttsUnits : [];
  const translatedRows = rows.filter((row) => String(row.finalText || row.translatedText || '').trim()).length;
  const ttsReportedRows = rows.filter((row) => row.ttsSync || row.ttsTimingFit || row.ttsTimingProbe).length;
  const warningRows = rows.filter((row) => hasTtsSyncWarning(row.ttsSync) || row.ttsTimingFit?.status === 'too_long').length;
  return (
    rows.length
    + translatedRows * 2
    + ttsUnits.length * 3
    + ttsReportedRows * 20
    + warningRows * 40
    + (outputs.audioPath || outputs.audioUrl ? 1200 : 0)
    + (outputs.ttsReport ? 800 : 0)
    + (outputs.srtPath || outputs.srtUrl ? 200 : 0)
  );
}

const RECOVERED_OUTPUT_ARTIFACT_KEYS = [
  'srtPath',
  'srtUrl',
  'rawSrtPath',
  'rawSrtUrl',
  'sourceSegmentedSrtPath',
  'sourceSegmentedSrtUrl',
  'audioPath',
  'audioUrl',
  'ttsReport',
  'ttsFitPlan',
  'ttsQcReportPath',
  'ttsQcReportUrl',
  'syncQcReportPath',
  'syncQcReportUrl',
  'autoTtsRepairReportPath',
  'autoTtsRepairReportUrl',
  'autoTtsRepairReport',
  'aimaxSrtBatchReportPath',
  'aimaxSrtBatchReportUrl',
  'aimaxSrtBatchReport',
  'translationQcReportPath',
  'translationQcReportUrl',
  'readabilityQcReportPath',
  'readabilityQcReportUrl',
];

function recoveredArtifactValuePresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

function ttsTimingSignalCount(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.ttsSync || row?.ttsTimingFit || row?.ttsTimingProbe).length;
}

function hasOutputAudio(state = {}) {
  const outputs = state.outputs && typeof state.outputs === 'object' ? state.outputs : {};
  return Boolean(outputs.audioPath || outputs.audioUrl);
}

function recoveredArtifactsShouldPatch(baseState = {}, recoveredState = {}) {
  const base = baseState && typeof baseState === 'object' ? baseState : {};
  const recovered = recoveredState && typeof recoveredState === 'object' ? recoveredState : {};
  const baseOutputs = base.outputs && typeof base.outputs === 'object' ? base.outputs : {};
  const recoveredOutputs = recovered.outputs && typeof recovered.outputs === 'object' ? recovered.outputs : {};
  return Boolean(
    ((recoveredOutputs.audioPath || recoveredOutputs.audioUrl) && !(baseOutputs.audioPath || baseOutputs.audioUrl))
    || (recoveredOutputs.ttsReport && !baseOutputs.ttsReport)
    || ttsTimingSignalCount(recovered.rows) > ttsTimingSignalCount(base.rows)
  );
}

function mergeRecoveredArtifactsIntoState(baseState = {}, recoveredState = {}) {
  const base = normalizeState(baseState);
  const recovered = normalizeState(recoveredState);
  const rawRecoveredOutputs = recovered.outputs && typeof recovered.outputs === 'object' ? recovered.outputs : {};
  const recoveredTtsReport = reportWithTimelineWarnings(rawRecoveredOutputs.ttsReport);
  const recoveredOutputs = {
    ...rawRecoveredOutputs,
    ...(recoveredTtsReport ? { ttsReport: recoveredTtsReport } : {}),
  };
  const recoveredRows = recoveredTtsReport ? rowsWithTtsReport(recovered.rows, recoveredTtsReport) : recovered.rows;
  const mergedOutputs = { ...base.outputs };

  RECOVERED_OUTPUT_ARTIFACT_KEYS.forEach((key) => {
    if (recoveredArtifactValuePresent(recoveredOutputs[key])) {
      mergedOutputs[key] = recoveredOutputs[key];
    }
  });

  const recoveredHasAudio = Boolean(recoveredOutputs.audioPath || recoveredOutputs.audioUrl);
  const recoveredForScore = { ...recovered, rows: recoveredRows, outputs: recoveredOutputs };
  const recoveredScore = projectRecoveryScore(recoveredForScore);
  const baseScore = projectRecoveryScore(base);
  const useRecoveredRows = Boolean(
    recoveredRows.length
    && (
      !base.rows.length
      || ttsTimingSignalCount(recoveredRows) > ttsTimingSignalCount(base.rows)
      || recoveredScore > baseScore
    )
  );
  const useRecoveredUnits = recoveredScore > baseScore;
  const nextConfig = {
    ...base.config,
    ...(recoveredHasAudio ? {
      dubbedAudioEnabled: true,
      dubbedPreviewVolume: Number(base.config?.dubbedPreviewVolume) > 0
        ? Number(base.config.dubbedPreviewVolume)
        : DEFAULT_STATE.config.dubbedPreviewVolume,
    } : {}),
  };

  return {
    ...base,
    source: recovered.source?.videoPath || recovered.source?.videoUrl ? { ...base.source, ...recovered.source } : base.source,
    job: recovered.job?.jobId ? { ...base.job, ...recovered.job } : base.job,
    rows: useRecoveredRows ? recoveredRows : base.rows,
    meaningUnits: useRecoveredUnits && recovered.meaningUnits.length ? recovered.meaningUnits : base.meaningUnits,
    ttsUnits: useRecoveredUnits && recovered.ttsUnits.length ? recovered.ttsUnits : base.ttsUnits,
    ttsRepairBasket: recovered.ttsRepairBasket.length ? recovered.ttsRepairBasket : base.ttsRepairBasket,
    storyTranslation: useRecoveredUnits && recovered.storyTranslation ? recovered.storyTranslation : base.storyTranslation,
    currentStage: recoveredHasAudio ? 'voice' : (recovered.currentStage || base.currentStage),
    outputs: mergedOutputs,
    config: nextConfig,
  };
}

function recoveredProjectKey(project = {}) {
  const jobId = projectJobId(project);
  return jobId ? `job:${jobId}` : `id:${String(project?.id || '')}`;
}

function isRecoveredJobProject(project = {}) {
  return String(project?.id || '').startsWith('job-');
}

function mergeRecoveredProjectPair(current, incoming) {
  const sameJob = Boolean(projectJobId(current) && projectJobId(current) === projectJobId(incoming));
  if (!sameJob) {
    const currentScore = projectRecoveryScore(current.state);
    const incomingScore = projectRecoveryScore(incoming.state);
    return (incomingScore > currentScore || (incomingScore === currentScore && Number(incoming.updatedAt || 0) > Number(current.updatedAt || 0)))
      ? incoming
      : current;
  }

  const currentState = mergeRecoveredArtifactsIntoState(current.state, incoming.state);
  const incomingState = mergeRecoveredArtifactsIntoState(incoming.state, current.state);
  let shell = current;
  let shellState = currentState;
  const currentRecovered = isRecoveredJobProject(current);
  const incomingRecovered = isRecoveredJobProject(incoming);

  if (currentRecovered && !incomingRecovered) {
    shell = incoming;
    shellState = incomingState;
  } else if (!currentRecovered && incomingRecovered) {
    shell = current;
    shellState = currentState;
  } else {
    const currentScore = projectRecoveryScore(currentState);
    const incomingScore = projectRecoveryScore(incomingState);
    if (incomingScore > currentScore || (incomingScore === currentScore && Number(incoming.updatedAt || 0) > Number(current.updatedAt || 0))) {
      shell = incoming;
      shellState = incomingState;
    }
  }

  return {
    ...shell,
    updatedAt: Math.max(Number(current.updatedAt || 0), Number(incoming.updatedAt || 0), Date.now()),
    state: {
      ...shellState,
      projectId: shell.id,
      projectName: shell.name || shellState.projectName,
    },
  };
}

function mergeRecoveredProjectSnapshots(existingProjects = [], recoveredProjects = []) {
  const byKey = new Map();
  [...existingProjects, ...recoveredProjects].forEach((project) => {
    if (!project?.id) return;
    const key = recoveredProjectKey(project);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, project);
      return;
    }
    byKey.set(key, mergeRecoveredProjectPair(current, project));
  });
  return Array.from(byKey.values())
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 30);
}

function normalizeDeletedProjectRefs(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    projectIds: Array.from(new Set((Array.isArray(source.projectIds) ? source.projectIds : []).map(String).filter(Boolean))).slice(-200),
    jobIds: Array.from(new Set((Array.isArray(source.jobIds) ? source.jobIds : []).map(String).filter(Boolean))).slice(-200),
  };
}

function deletedProjectRefsFromStorage() {
  if (typeof window === 'undefined') return normalizeDeletedProjectRefs({});
  return normalizeDeletedProjectRefs(safeJsonParse(window.localStorage.getItem(DELETED_PROJECTS_STORAGE_KEY), {}));
}

function saveDeletedProjectRefs(refs) {
  const normalized = normalizeDeletedProjectRefs(refs);
  if (typeof window !== 'undefined') {
    safeLocalStorageSet(DELETED_PROJECTS_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function projectJobId(projectOrState = {}) {
  return String(projectOrState?.state?.job?.jobId || projectOrState?.job?.jobId || '').trim();
}

function isDeletedProjectRef(projectOrState = {}, refs = normalizeDeletedProjectRefs({})) {
  const projectId = String(projectOrState?.id || projectOrState?.projectId || projectOrState?.state?.projectId || '').trim();
  const jobId = projectJobId(projectOrState);
  return Boolean(
    (projectId && refs.projectIds.includes(projectId))
    || (jobId && refs.jobIds.includes(jobId))
  );
}

function filterDeletedProjects(projects = [], refs = normalizeDeletedProjectRefs({})) {
  return (projects || []).filter((project) => !isDeletedProjectRef(project, refs));
}

function rememberDeletedProject(projectId, jobId) {
  const refs = deletedProjectRefsFromStorage();
  return saveDeletedProjectRefs({
    projectIds: [...refs.projectIds, String(projectId || '').trim()].filter(Boolean),
    jobIds: [...refs.jobIds, String(jobId || '').trim()].filter(Boolean),
  });
}

function normalizeProjects(value) {
  return Array.isArray(value)
    ? value
      .map((project) => {
        const id = String(project?.id || '').trim();
        if (!id || !project?.state) return null;
        return {
          id,
          name: String(project.name || project.state.projectName || 'New project'),
          updatedAt: Number(project.updatedAt) || 0,
          state: normalizeState({ ...project.state, projectId: id }),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
    : [];
}

function hasProjectPayload(state) {
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const source = state?.source && typeof state.source === 'object' ? state.source : {};
  const job = state?.job && typeof state.job === 'object' ? state.job : {};
  const outputs = state?.outputs && typeof state.outputs === 'object' ? state.outputs : {};
  return Boolean(
    rows.length
    || job.jobId
    || source.videoPath
    || source.videoUrl
    || source.title
    || outputs.videoPath
    || outputs.audioPath
    || outputs.srtPath
    || outputs.rawSrtPath
    || outputs.sourceSegmentedSrtPath
  );
}

function recoverProjectsFromStorage(savedState, storedProjects, savedSettings = {}) {
  const normalizedProjects = normalizeProjects(storedProjects);
  if (!savedState || !hasProjectPayload(savedState)) return normalizedProjects;
  const normalizedState = normalizeState(savedState);
  const snapshot = createProjectSnapshot({
    ...normalizedState,
    projectName: String(normalizedState.projectName || '').trim()
      || normalizedState.source?.title
      || fileNameFromPath(normalizedState.source?.videoPath)
      || 'Recovered project',
    config: mergeSettingsDefaults(normalizedState.config, savedSettings),
  });
  return mergeProjectSnapshot(normalizedProjects, snapshot);
}

function normalizeRow(row, index) {
  const start = Number(row?.start) || 0;
  const end = Number(row?.end) || start + Math.max(0.1, Number(row?.duration) || 1);
  return {
    id: String(row?.id || `row-${index + 1}`),
    index: index + 1,
    start,
    end,
    duration: Math.max(0.1, end - start),
    sourceText: String(row?.sourceText || row?.originalText || row?.text || '').trim(),
    translatedText: String(row?.translatedText || '').trim(),
    finalText: String(row?.finalText || row?.translatedText || row?.text || '').trim(),
    ttsText: String(row?.ttsText || '').trim(),
    sourceIds: Array.isArray(row?.sourceIds) ? row.sourceIds.map(String).filter(Boolean) : [],
    sourceRowIds: Array.isArray(row?.sourceRowIds) ? row.sourceRowIds.map(String).filter(Boolean) : [],
    words: Array.isArray(row?.words) ? row.words : [],
    atomIds: Array.isArray(row?.atomIds) ? row.atomIds.map(String).filter(Boolean) : [],
    validationStatus: String(row?.validationStatus || '').trim(),
    meaningUnitId: String(row?.meaningUnitId || '').trim(),
    audioPath: String(row?.audioPath || '').trim(),
    status: row?.status || 'pending',
    dirty: Boolean(row?.dirty),
    errorMsg: String(row?.errorMsg || '').trim(),
    ttsSync: row?.ttsSync && typeof row.ttsSync === 'object' ? row.ttsSync : null,
    ttsTimingFit: row?.ttsTimingFit && typeof row.ttsTimingFit === 'object' ? row.ttsTimingFit : null,
    ttsTimingProbe: row?.ttsTimingProbe && typeof row.ttsTimingProbe === 'object' ? row.ttsTimingProbe : null,
    style: row?.style && typeof row.style === 'object' ? row.style : {},
  };
}

function normalizeMeaningUnit(unit, index) {
  const start = Number(unit?.start) || 0;
  const end = Number(unit?.end) || start + Math.max(0.1, Number(unit?.duration) || 1);
  const sourceRowIds = Array.isArray(unit?.sourceRowIds)
    ? unit.sourceRowIds.map(String).filter(Boolean)
    : Array.isArray(unit?.sourceIds) ? unit.sourceIds.map(String).filter(Boolean) : [];
  const translatedText = String(unit?.translatedText || unit?.finalText || unit?.text || '').trim();
  return {
    id: String(unit?.id || `meaning-${index + 1}`),
    index,
    start,
    end,
    duration: Math.max(0.1, end - start),
    sourceRowIds,
    sourceIds: sourceRowIds,
    sourceText: String(unit?.sourceText || unit?.originalText || '').trim(),
    translatedText,
    finalText: translatedText,
    text: translatedText,
    ttsText: String(unit?.ttsText || translatedText).trim(),
    prosodyText: String(unit?.prosodyText || unit?.ttsText || translatedText).trim(),
    wordCount: Number(unit?.wordCount) || 0,
    estimatedWordsPerSecond: Number(unit?.estimatedWordsPerSecond) || 0,
  };
}

function normalizeTtsRepairBasketItem(item = {}) {
  const rowId = String(item.rowId || item.row_id || '').trim();
  if (!rowId) return null;
  const ttsPreviewStatus = ['overflow', 'fit', 'slack'].includes(String(item.ttsPreviewStatus || item.tts_preview_status || ''))
    ? String(item.ttsPreviewStatus || item.tts_preview_status)
    : '';
  const repairedTranslation = String(item.repairedTranslation || item.repaired_translation || '').trim();
  const status = String(item.status || '').trim();
  const repairPromptVersion = String(item.repairPromptVersion || item.repair_prompt_version || '').trim();
  // A saved repair remains usable even after the repair prompt/skill changes.
  // Prompt versions are metadata, not a reason to make the user translate again.
  const repairPromptStale = false;
  return {
    rowId,
    selected: item.selected !== false,
    applySelected: item.applySelected === true || item.apply_selected === true,
    severity: ['major', 'minor', 'manual'].includes(String(item.severity || '')) ? String(item.severity) : '',
    reason: String(item.reason || '').trim(),
    slotSeconds: Number(item.slotSeconds ?? item.slot_seconds) || 0,
    audioSeconds: Number(item.audioSeconds ?? item.audio_seconds) || 0,
    overflowSeconds: Number(item.overflowSeconds ?? item.overflow_seconds) || 0,
    fitRatio: Number(item.fitRatio ?? item.fit_ratio) || 0,
    currentTranslation: String(item.currentTranslation || item.current_translation || '').trim(),
    repairedTranslation,
    status,
    manual: item.manual === true,
    repairPromptVersion,
    repairPromptStale,
    ttsPreviewStatus,
    ttsPreviewSlotSeconds: Number(item.ttsPreviewSlotSeconds ?? item.tts_preview_slot_seconds) || 0,
    ttsPreviewAudioSeconds: Number(item.ttsPreviewAudioSeconds ?? item.tts_preview_audio_seconds) || 0,
    ttsPreviewDeltaSeconds: Number(item.ttsPreviewDeltaSeconds ?? item.tts_preview_delta_seconds) || 0,
    ttsPreviewOverflowSeconds: Number(item.ttsPreviewOverflowSeconds ?? item.tts_preview_overflow_seconds) || 0,
    ttsPreviewSlackSeconds: Number(item.ttsPreviewSlackSeconds ?? item.tts_preview_slack_seconds) || 0,
    ttsPreviewCheckedAt: String(item.ttsPreviewCheckedAt || item.tts_preview_checked_at || '').trim(),
    ttsPreviewTranslation: String(item.ttsPreviewTranslation || item.tts_preview_translation || '').trim(),
    ttsPreviewId: String(item.ttsPreviewId || item.tts_preview_id || item.previewId || item.preview_id || '').trim(),
    aimaxBatchIndex: Number.isFinite(Number(item.aimaxBatchIndex ?? item.aimax_batch_index)) ? Number(item.aimaxBatchIndex ?? item.aimax_batch_index) : null,
    aimaxEntryIndex: Number.isFinite(Number(item.aimaxEntryIndex ?? item.aimax_entry_index)) ? Number(item.aimaxEntryIndex ?? item.aimax_entry_index) : null,
    aimaxSegmentFileName: String(item.aimaxSegmentFileName || item.aimax_segment_file_name || '').trim(),
  };
}

function normalizeTtsRepairBasket(items = []) {
  const byId = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = normalizeTtsRepairBasketItem(item);
    if (normalized) byId.set(normalized.rowId, normalized);
  });
  return Array.from(byId.values());
}

function isStaleTtsRepairItem(item = {}) {
  return false;
}

function canApplyTtsRepairPreview(item = {}) {
  return Boolean(
    String(item.repairedTranslation || '').trim()
    && String(item.ttsPreviewId || '').trim()
    && ['fit', 'slack'].includes(String(item.ttsPreviewStatus || ''))
  );
}

function ttsRepairBasketAfterTts(previousBasket = [], reportedRows = [], finalField = 'finalText') {
  const rowById = new Map((Array.isArray(reportedRows) ? reportedRows : []).map((row) => [String(row.id), row]));
  const previousItems = normalizeTtsRepairBasket(previousBasket);
  const removedIds = new Set(previousItems
    .filter((item) => item.selected === false && item.status === 'removed')
    .map((item) => String(item.rowId)));
  const seenIds = new Set();
  const next = [];
  for (const item of previousItems) {
    const row = rowById.get(String(item.rowId));
    if (!row) continue;
    seenIds.add(String(item.rowId));
    const issue = ttsRepairIssueForRow(row, finalField);
    if (issue) {
      next.push({
        ...ttsRepairPayloadForRow(row, reportedRows, finalField, item),
        selected: issue.selectedByDefault !== false && item.selected !== false,
        manual: item.manual,
        status: issue.severity === 'minor'
          ? 'notice'
          : (['removed', 'selected', 'notice'].includes(item.status) ? 'failed' : item.status || 'failed'),
      });
    } else if (item.selected !== false && ['applied', 'rerun'].includes(item.status)) {
      next.push({
        ...item,
        status: 'passed',
        reason: item.reason || '',
      });
    } else if (item.manual && item.selected !== false && !['passed', 'failed'].includes(item.status)) {
      next.push(item);
    }
  }
  for (const row of Array.isArray(reportedRows) ? reportedRows : []) {
    const rowId = String(row.id || '');
    if (!rowId || seenIds.has(rowId) || removedIds.has(rowId)) continue;
    const issue = ttsRepairIssueForRow(row, finalField);
    if (issue) {
      next.push(ttsRepairPayloadForRow(row, reportedRows, finalField, null));
    }
  }
  return normalizeTtsRepairBasket(next);
}

function stripTtsRuntimeFromRow(row = {}) {
  return {
    ...row,
    audioPath: '',
    ttsSync: null,
    ttsTimingFit: null,
    ttsTimingProbe: null,
  };
}

function normalizeLogForMatch(line = '') {
  return String(line || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isTtsRuntimeLog(line = '') {
  const text = normalizeLogForMatch(line);
  return [
    'tts',
    'long tieng',
    'chong tran',
    'timeline',
    'sync',
    'dubbed audio',
    'google cloud tts',
    '/api/manual/generate-tts',
    '/api/manual/rerun-tts-row',
    '/api/manual/retranslate-tts-errors',
    '/api/manual/preview-tts-repair-srt',
    '/api/manual/apply-tts-repair-srt',
  ].some((token) => text.includes(token));
}

function removeTtsRuntimeLogs(logs = []) {
  return (Array.isArray(logs) ? logs : []).filter((line) => !isTtsRuntimeLog(line));
}

function normalizeState(value) {
  const saved = value && typeof value === 'object' ? value : {};
  const config = saved.config && typeof saved.config === 'object' ? saved.config : {};
  const subtitleCoverConfig = normalizeSubtitleCoverConfig(config);
  const source = saved.source && typeof saved.source === 'object' ? saved.source : {};
  const job = saved.job && typeof saved.job === 'object' ? saved.job : {};
  const outputs = saved.outputs && typeof saved.outputs === 'object' ? saved.outputs : {};
  const rows = Array.isArray(saved.rows) ? ensureUniqueRowIds(saved.rows.map(normalizeRow)) : [];
  const meaningUnits = Array.isArray(saved.meaningUnits) ? saved.meaningUnits.map(normalizeMeaningUnit) : [];
  const ttsUnits = Array.isArray(saved.ttsUnits) ? saved.ttsUnits.map(normalizeMeaningUnit) : [];
  const ttsRepairBasket = normalizeTtsRepairBasket(saved.ttsRepairBasket);
  const storyTranslation = saved.storyTranslation && typeof saved.storyTranslation === 'object' ? saved.storyTranslation : null;
  const voices = Array.isArray(saved.voices) ? normalizeVoices(saved.voices) : [];
  const logs = Array.isArray(saved.logs) ? saved.logs.map((line) => String(line || '')).filter(Boolean).slice(0, 100) : [];

  return {
    ...DEFAULT_STATE,
    projectId: typeof saved.projectId === 'string' && saved.projectId ? saved.projectId : `project-${Date.now()}`,
    projectName: typeof saved.projectName === 'string' && saved.projectName.trim() ? saved.projectName.trim() : DEFAULT_STATE.projectName,
    source: { ...DEFAULT_STATE.source, ...source },
    job: { ...DEFAULT_STATE.job, ...job },
    rows,
    meaningUnits,
    ttsUnits,
    ttsRepairBasket,
    storyTranslation,
    selectedRowId: rows.some((row) => row.id === saved.selectedRowId) ? String(saved.selectedRowId) : rows[0]?.id || '',
    currentTime: parseDecimal(saved.currentTime, 0),
    currentStage: typeof saved.currentStage === 'string' ? saved.currentStage : DEFAULT_STATE.currentStage,
    busy: false,
    logs,
    error: '',
    outputs: { ...DEFAULT_STATE.outputs, ...outputs },
    config: {
      ...DEFAULT_STATE.config,
      ...config,
      sttProvider: normalizeSttProvider(config.sttProvider),
      // The old UI always saved this setting as true even though it had no toggle.
      // Treat those projects as ungrouped on first load; new explicit choices use version 1.
      subtitleGroupSettingsVersion: 1,
      subtitleGroupEnabled: config.subtitleGroupSettingsVersion === 1 && config.subtitleGroupEnabled === true,
      subtitleGroupLanguage: config.subtitleGroupLanguage || DEFAULT_STATE.config.subtitleGroupLanguage,
      subtitleGroupBatchSize: Number(config.subtitleGroupBatchSize ?? DEFAULT_STATE.config.subtitleGroupBatchSize),
      subtitleGroupConcurrency: Number(config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.subtitleGroupConcurrency),
      translationProvider: normalizeTranslationProvider(config.translationProvider),
      subtitleGroupProvider: normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider),
      subtitleGroupModel: config.subtitleGroupModel || '',
      cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
      translationMode: ['story_v2', 'legacy'].includes(config.translationMode) ? config.translationMode : DEFAULT_STATE.config.translationMode,
      ocrProvider: normalizeOcrProvider(config.ocrProvider),
      ocrKeyframeProvider: normalizeOcrProvider(config.ocrKeyframeProvider),
      ttsProvider: normalizeTtsProvider(config.ttsProvider),
      sttModel: STT_MODELS[normalizeSttProvider(config.sttProvider)]?.includes(config.sttModel) ? config.sttModel : getDefaultSttModel(normalizeSttProvider(config.sttProvider)),
      ttsUnitMode: ['story_segments', 'meaning_units', 'post_translation'].includes(config.ttsUnitMode) ? config.ttsUnitMode : DEFAULT_STATE.config.ttsUnitMode,
      speakingRate: normalizeSpeakingRate(config.speakingRate ?? DEFAULT_STATE.config.speakingRate),
      ttsFitEnabled: config.ttsFitEnabled !== false,
      ttsFitMode: config.ttsFitMode || DEFAULT_STATE.config.ttsFitMode,
      ttsFitMaxRate: normalizeSpeakingRate(config.speakingRate),
      autoTtsRepairEnabled: config.autoTtsRepairEnabled === true,
      autoTtsRepairMaxPasses: Math.max(1, Math.min(3, Number(config.autoTtsRepairMaxPasses ?? DEFAULT_STATE.config.autoTtsRepairMaxPasses) || DEFAULT_STATE.config.autoTtsRepairMaxPasses)),
      autoTtsRepairMinOverflowSeconds: Math.max(0, Number(config.autoTtsRepairMinOverflowSeconds ?? DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds) || DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds),
      autoTtsRepairMaxRowsPerPass: Math.max(1, Math.min(50, Number(config.autoTtsRepairMaxRowsPerPass ?? DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass)),
      ttsTextCleanupMode: ['natural', 'fast', 'strict'].includes(config.ttsTextCleanupMode) ? config.ttsTextCleanupMode : DEFAULT_STATE.config.ttsTextCleanupMode,
      voiceAlignShortClips: false,
      voiceAlignMode: 'start',
      voiceAlignMinSlackSeconds: Number(config.voiceAlignMinSlackSeconds ?? DEFAULT_STATE.config.voiceAlignMinSlackSeconds),
      voiceAlignMaxShiftSeconds: normalizeVoiceAlignMaxShift(config.voiceAlignMaxShiftSeconds),
      ssmlGender: config.ssmlGender || DEFAULT_STATE.config.ssmlGender,
      voiceGenderFilter: config.voiceGenderFilter || DEFAULT_STATE.config.voiceGenderFilter,
      voiceFamilyFilter: config.voiceFamilyFilter || DEFAULT_STATE.config.voiceFamilyFilter,
      voiceSampleRateFilter: config.voiceSampleRateFilter || DEFAULT_STATE.config.voiceSampleRateFilter,
      voiceControlsFilter: config.voiceControlsFilter || DEFAULT_STATE.config.voiceControlsFilter,
      aimaxSrtBatchEnabled: config.aimaxSrtBatchEnabled === true,
      aimaxSrtBatchMode: normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode),
      aimaxSrtCuesPerRequest: normalizeConfiguredAimaxSrtCuesPerRequest(config.aimaxSrtCuesPerRequest ?? DEFAULT_STATE.config.aimaxSrtCuesPerRequest),
      aimaxSrtRequestCount: clampAimaxSrtRequestCount(config.aimaxSrtRequestCount ?? DEFAULT_STATE.config.aimaxSrtRequestCount),
      aimaxSrtBatchConcurrency: clampAimaxSrtBatchConcurrency(config.aimaxSrtBatchConcurrency ?? DEFAULT_STATE.config.aimaxSrtBatchConcurrency),
      translationTargetTtsRate: normalizeTranslationTargetTtsRate(config.translationTargetTtsRate ?? DEFAULT_STATE.config.translationTargetTtsRate),
      translationTimingValidationMode: config.translationTimingValidationMode || DEFAULT_STATE.config.translationTimingValidationMode,
      translationTimingRewriteMaxPasses: Number(config.translationTimingRewriteMaxPasses ?? DEFAULT_STATE.config.translationTimingRewriteMaxPasses),
      normalizeTimelineBeforeTranslate: config.normalizeTimelineBeforeTranslate !== false,
      translationDisplayMode: ['source_timeline', 'meaning_timeline'].includes(config.translationDisplayMode)
        ? config.translationDisplayMode
        : DEFAULT_STATE.config.translationDisplayMode,
      timelineMergeGapSeconds: Number(config.timelineMergeGapSeconds ?? DEFAULT_STATE.config.timelineMergeGapSeconds),
      timelineBreakGapSeconds: Number(config.timelineBreakGapSeconds ?? DEFAULT_STATE.config.timelineBreakGapSeconds),
      timelineMaxUnitDuration: Number(config.timelineMaxUnitDuration ?? DEFAULT_STATE.config.timelineMaxUnitDuration),
      naturalDubTargetMinSeconds: Number(config.naturalDubTargetMinSeconds ?? DEFAULT_STATE.config.naturalDubTargetMinSeconds ?? 2.0),
      naturalDubTargetMaxSeconds: Number(config.naturalDubTargetMaxSeconds ?? DEFAULT_STATE.config.naturalDubTargetMaxSeconds ?? 4.2),
      maxMeaningUnitSourceRows: Number(config.maxMeaningUnitSourceRows ?? DEFAULT_STATE.config.maxMeaningUnitSourceRows ?? 3),
      timelineGuardSeconds: Number(config.timelineGuardSeconds ?? DEFAULT_STATE.config.timelineGuardSeconds),
      naturalPhraseSync: config.naturalPhraseSync === true,
      phraseLengthMode: config.phraseLengthMode || DEFAULT_STATE.config.phraseLengthMode,
      pauseStyle: config.pauseStyle || DEFAULT_STATE.config.pauseStyle,
      targetPhraseSeconds: Number(config.targetPhraseSeconds ?? DEFAULT_STATE.config.targetPhraseSeconds),
      maxPhraseSeconds: Number(config.maxPhraseSeconds ?? DEFAULT_STATE.config.maxPhraseSeconds),
      subtitleOutlineEnabled: false,
      subtitleFontSize: normalizeLoadedSubtitleFontSize(config.subtitleFontSize ?? DEFAULT_STATE.config.subtitleFontSize),
      subtitleCoverEnabled: config.subtitleCoverEnabled === true,
      subtitleCoverMode: 'blur',
      subtitleCoverBlur: Number(config.subtitleCoverBlur ?? DEFAULT_STATE.config.subtitleCoverBlur),
      subtitleCoverFeather: Number(config.subtitleCoverFeather ?? DEFAULT_STATE.config.subtitleCoverFeather),
      subtitleCoverOpacity: Number(config.subtitleCoverOpacity ?? DEFAULT_STATE.config.subtitleCoverOpacity),
      subtitleCoverX: Number((subtitleCoverConfig.subtitleCoverX ?? config.subtitleCoverX) ?? DEFAULT_STATE.config.subtitleCoverX),
      subtitleCoverY: Number(config.subtitleCoverY ?? DEFAULT_STATE.config.subtitleCoverY),
      subtitleCoverW: Number((subtitleCoverConfig.subtitleCoverW ?? config.subtitleCoverW) ?? DEFAULT_STATE.config.subtitleCoverW),
      subtitleCoverH: Number((subtitleCoverConfig.subtitleCoverH ?? config.subtitleCoverH) ?? DEFAULT_STATE.config.subtitleCoverH),
      overlayEnabled: config.overlayEnabled === true,
      musicEnabled: config.musicEnabled === true,
      musicVolume: Number(config.musicVolume ?? DEFAULT_STATE.config.musicVolume),
      musicFade: config.musicFade !== false,
      logoEnabled: config.logoEnabled === true,
      logoPosition: config.logoPosition || DEFAULT_STATE.config.logoPosition,
      logoX: Number(config.logoX ?? DEFAULT_STATE.config.logoX),
      logoY: Number(config.logoY ?? DEFAULT_STATE.config.logoY),
      logoSize: Number(config.logoSize ?? DEFAULT_STATE.config.logoSize),
      logoOpacity: Number(config.logoOpacity ?? DEFAULT_STATE.config.logoOpacity),
    },
    health: saved.health || null,
    voices,
    voicePreviewAudio: typeof saved.voicePreviewAudio === 'string' ? saved.voicePreviewAudio : '',
  };
}

function Button({ tone = 'dark', disabled, children, className = '', ...props }) {
  const tones = {
    green: 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-900/20',
    blue: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-900/20',
    red: 'bg-rose-600 text-white hover:bg-rose-500 shadow-rose-900/20',
    yellow: 'bg-amber-500 text-slate-950 font-bold hover:bg-amber-400 shadow-amber-900/20',
    purple: 'bg-purple-600 text-white hover:bg-purple-500 shadow-purple-900/20',
    dark: 'bg-slate-800/90 text-slate-200 hover:bg-slate-700/90 hover:text-white border border-slate-700/60',
  };

  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold tracking-tight shadow-md transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone] || tones.dark} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1.5 text-xs text-slate-200">
      <span className="font-semibold text-slate-300 tracking-tight">{label}</span>
      {children}
    </label>
  );
}

function Input(props) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-lg border border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-100 placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${props.className || ''}`}
    />
  );
}

function Toggle({ checked, onChange, label, offLabel = 'Tắt', onLabel = 'Bật' }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex min-h-[36px] w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-xs font-semibold transition-all ${
        checked
          ? 'border-indigo-500/50 bg-indigo-950/40 text-indigo-200 shadow-sm'
          : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700'
      }`}
    >
      <span>{label}</span>
      <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold transition-all ${checked ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-800 text-slate-400'}`}>
        {checked ? onLabel : offLabel}
      </span>
    </button>
  );
}

function normalizeHexColor(value, fallback = '#ffffff') {
  const text = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return fallback;
}

function ColorPicker({ value, onChange, disabled = false, swatches = COLOR_SWATCHES }) {
  const color = normalizeHexColor(value);
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/80 p-2.5 backdrop-blur-md ${disabled ? 'opacity-40' : ''}`}>
      <div className="grid grid-cols-8 gap-1.5">
        {swatches.map((item) => {
          const active = normalizeHexColor(item) === color;
          return (
            <button
              key={item}
              type="button"
              disabled={disabled}
              title={item}
              aria-label={`Chọn màu ${item}`}
              onClick={() => onChange(normalizeHexColor(item))}
              className={`h-6 rounded-md transition-transform ${active ? 'scale-110 ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-900' : 'ring-1 ring-white/10 hover:scale-105 hover:ring-white/30'}`}
              style={{ backgroundColor: item }}
            />
          );
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-[32px_1fr] items-center gap-2">
        <span className="h-7 rounded-md ring-1 ring-white/20 shadow-inner" style={{ backgroundColor: color }} />
        <Input
          value={color}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(normalizeHexColor(event.target.value, color))}
          className="h-7 font-mono text-[11px]"
        />
      </div>
    </div>
  );
}

function TextArea(props) {
  return (
    <textarea
      {...props}
      className={`min-h-[82px] w-full resize-y rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2.5 text-xs text-slate-100 placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${props.className || ''}`}
    />
  );
}

function GroqKeyManager({ config, onChange, placeholder = 'Khóa Groq' }) {
  const storedLines = groqKeyLines(config);
  const [lineCount, setLineCount] = useState(Math.max(1, storedLines.length));
  useEffect(() => {
    setLineCount((current) => Math.max(current, storedLines.length, 1));
  }, [config.groqApiKey, config.groqBackupKeys, storedLines.length]);
  const lines = Array.from(
    { length: Math.max(lineCount, storedLines.length, 1) },
    (_, index) => storedLines[index] || ''
  );
  const activeCount = lines.filter((line) => String(line || '').trim()).length;

  const updateLine = (index, value) => {
    const next = [...lines];
    next[index] = value;
    setLineCount(Math.max(next.length, index + 1, 1));
    onChange(configFromGroqKeyLines(next));
  };

  const removeLine = (index) => {
    const next = lines.filter((_, lineIndex) => lineIndex !== index);
    setLineCount(Math.max(next.length, 1));
    onChange(configFromGroqKeyLines(next.length ? next : ['']));
  };

  const addLine = () => {
    setLineCount((current) => Math.max(current + 1, lines.length + 1));
  };

  return (
    <div className="grid gap-2">
      <div className="grid gap-2">
        {lines.map((line, index) => (
          <div key={`groq-key-${index}`} className="grid grid-cols-[1fr_34px] items-center gap-2">
            <Input
              type="password"
              value={line}
              placeholder={`${placeholder} ${index + 1}`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => updateLine(index, event.target.value)}
            />
            <button
              type="button"
              title="Xóa khóa"
              aria-label="Xóa khóa"
              className="flex h-9 w-[34px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400"
              onClick={() => removeLine(index)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 text-xs font-semibold text-indigo-300 transition-all hover:bg-indigo-500/20"
          onClick={addLine}
        >
          <Plus className="h-4 w-4" />
          Thêm khóa
        </button>
        <span className="text-xs font-medium text-slate-400">{activeCount} khóa</span>
      </div>
    </div>
  );
}

function AssemblyAiKeyManager({ config, onChange, placeholder = 'Khóa AssemblyAI' }) {
  const storedLines = assemblyAiKeyLines(config);
  const [lineCount, setLineCount] = useState(Math.max(1, storedLines.length));
  useEffect(() => {
    setLineCount((current) => Math.max(current, storedLines.length, 1));
  }, [config.assemblyAiApiKey, config.assemblyAiBackupKeys, storedLines.length]);
  const lines = Array.from(
    { length: Math.max(lineCount, storedLines.length, 1) },
    (_, index) => storedLines[index] || ''
  );
  const activeCount = lines.filter((line) => String(line || '').trim()).length;

  const updateLine = (index, value) => {
    const next = [...lines];
    next[index] = value;
    setLineCount(Math.max(next.length, index + 1, 1));
    onChange(configFromAssemblyAiKeyLines(next));
  };

  const removeLine = (index) => {
    const next = lines.filter((_, lineIndex) => lineIndex !== index);
    setLineCount(Math.max(next.length, 1));
    onChange(configFromAssemblyAiKeyLines(next.length ? next : ['']));
  };

  const addLine = () => {
    setLineCount((current) => Math.max(current + 1, lines.length + 1));
  };

  return (
    <div className="grid gap-2">
      <div className="grid gap-2">
        {lines.map((line, index) => (
          <div key={`assemblyai-key-${index}`} className="grid grid-cols-[1fr_34px] items-center gap-2">
            <Input
              type="password"
              value={line}
              placeholder={`${placeholder} ${index + 1}`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => updateLine(index, event.target.value)}
            />
            <button
              type="button"
              title="Xóa khóa"
              aria-label="Xóa khóa"
              className="flex h-9 w-[34px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400"
              onClick={() => removeLine(index)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 text-xs font-semibold text-indigo-300 transition-all hover:bg-indigo-500/20"
          onClick={addLine}
        >
          <Plus className="h-4 w-4" />
          Thêm khóa
        </button>
        <span className="text-xs font-medium text-slate-400">{activeCount} khóa</span>
      </div>
    </div>
  );
}

function Select(props) {
  return (
    <select
      {...props}
      className={`h-9 w-full rounded-lg border border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-100 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${props.className || ''}`}
    />
  );
}

function Panel({ title, children }) {
  return (
    <details className="group rounded-xl border border-slate-800/80 bg-slate-900/50 backdrop-blur-md transition-all">
      <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-2 px-3 text-xs font-bold text-slate-200 transition-colors hover:text-white">
        <ChevronRight className="h-4 w-4 text-indigo-400 transition-transform duration-200 group-open:rotate-90" />
        {title}
      </summary>
      <div className="grid gap-3 border-t border-slate-800/60 p-3 animate-fade-in">{children}</div>
    </details>
  );
}

function Modal({ title, children, footer, onClose, className = '' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-md px-4 animate-fade-in">
      <div
        className={`flex max-h-[85vh] w-full max-w-[640px] flex-col rounded-2xl border border-slate-800 bg-slate-900/95 shadow-2xl shadow-black/80 ${className}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 items-center justify-between border-b border-slate-800/80 px-5">
          <h3 className="text-base font-bold text-slate-100 tracking-tight">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid gap-4 overflow-auto p-5">{children}</div>
        <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 px-5 py-3.5 bg-slate-950/40 rounded-b-2xl">
          <Button onClick={onClose} tone="dark">Hủy</Button>
          {footer}
        </div>
      </div>
    </div>
  );
}

function estimateTaskSeconds(label, rows = [], wordCount = 0) {
  const normalized = String(label || '').toLowerCase();
  const rowCount = Math.max(1, rows.length || 1);
  if (normalized.includes('auto')) return [Math.max(90, rowCount * 0.85), Math.max(150, rowCount * 1.8)];
  if (normalized.includes('dịch')) return [Math.max(20, rowCount * 0.28), Math.max(45, rowCount * 0.62)];
  if (normalized.includes('lồng') || normalized.includes('tts')) return [Math.max(45, wordCount * 0.08), Math.max(90, wordCount * 0.17)];
  if (normalized.includes('phụ đề') || normalized.includes('stt')) return [45, 180];
  if (normalized.includes('xuất')) return [30, 120];
  return [20, 90];
}

function AppDialog({ dialog, onResult }) {
  if (!dialog) return null;
  const isAlert = dialog.type === 'alert';
  const destructive = dialog.tone === 'red';
  const dangerItems = Array.isArray(dialog.items) ? dialog.items.filter(Boolean) : [];

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-4 backdrop-blur-[2px]"
      onClick={() => onResult(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onResult(false);
      }}
    >
      <div
        role={isAlert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className={`w-full max-w-[500px] overflow-hidden rounded-[12px] border ${destructive ? 'border-red-500/55 bg-[#12070b]' : 'border-[#31517d] bg-[#081326]'} shadow-[0_28px_100px_rgba(0,0,0,0.7)]`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`flex items-center gap-3 border-b px-4 py-3.5 ${destructive ? 'border-red-500/35 bg-red-950/35' : 'border-[#243b60] bg-[#0c1a30]'}`}>
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${destructive ? 'bg-red-500/15 text-red-300' : 'bg-[#f1cc00]/15 text-[#f1cc00]'}`}>
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="app-dialog-title" className="text-[15px] font-black text-white">{dialog.title}</h3>
            {dialog.subtitle ? <div className="mt-0.5 text-[10px] text-slate-400">{dialog.subtitle}</div> : null}
          </div>
          <button type="button" onClick={() => onResult(false)} className="rounded-[6px] p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid gap-3 px-4 py-5 text-sm leading-6 text-slate-200">
          <div className="whitespace-pre-line break-words">{dialog.message}</div>
          {dangerItems.length ? (
            <div className="rounded-[8px] border border-red-500/35 bg-red-950/30 p-3">
              <div className="mb-2 text-xs font-black uppercase text-red-200">Se xoa vinh vien</div>
              <div className="grid gap-1.5 text-xs font-semibold text-red-50">
                {dangerItems.map((item) => (
                  <div key={item} className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-300" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#243b60] bg-[#071020] px-4 py-3">
          {!isAlert ? <Button className="h-9 px-4" onClick={() => onResult(false)}>Hủy</Button> : null}
          <Button
            autoFocus
            tone={destructive ? 'red' : 'yellow'}
            className="h-9 px-4"
            onClick={() => onResult(true)}
          >
            {dialog.confirmLabel || (isAlert ? 'Đóng' : 'Xác nhận')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function cleanTaskLogLine(line = '') {
  return String(line || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim();
}

function parseActivityLogLine(line = '') {
  const text = String(line || '').trim();
  const match = text.match(/^\[([^\]]+)\]\s*(.*)$/);
  return {
    time: match?.[1] || '--:--:--',
    message: match?.[2] || text || 'Chưa có hoạt động.',
  };
}

function activityLogTone(message = '') {
  const text = String(message || '').toLowerCase();
  if (/❌|\blỗi\b|\bloi\b|failed|error|invalid/.test(text)) {
    return { dot: 'bg-red-400', text: 'text-red-200', row: 'border-red-400/15 bg-red-400/[0.04]' };
  }
  if (/⚠|cảnh báo|warning|fallback|thiếu|missing|trùng|duplicate/.test(text)) {
    return { dot: 'bg-amber-300', text: 'text-amber-100', row: 'border-amber-300/15 bg-amber-300/[0.04]' };
  }
  if (/✅|\bxong\b|đã lưu|sẵn sàng|\bok\b|hoàn tất/.test(text)) {
    return { dot: 'bg-emerald-400', text: 'text-emerald-100', row: 'border-emerald-400/15 bg-emerald-400/[0.04]' };
  }
  if (/⏳|đang|bắt đầu|\[api\] post/.test(text)) {
    return { dot: 'bg-sky-400', text: 'text-sky-100', row: 'border-sky-400/15 bg-sky-400/[0.04]' };
  }
  return { dot: 'bg-slate-500', text: 'text-slate-200', row: 'border-slate-700/70 bg-white/[0.015]' };
}

function taskStepFromLog(logs = []) {
  const meaningful = (logs || [])
    .map(cleanTaskLogLine)
    .filter((line) => line && !line.includes('[API] OK'));
  return meaningful[0] || cleanTaskLogLine((logs || [])[0]) || 'Đang chuẩn bị...';
}

function FloatingTaskPanel({ task, rows, wordCount, logs, onCancel }) {
  const [position, setPosition] = useState({ x: 700, y: 360 });
  const [now, setNow] = useState(Date.now());
  const dragRef = useRef(null);

  useEffect(() => {
    if (!task?.active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [task?.active]);

  useEffect(() => {
    const handleMove = (event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const nextX = Math.min(Math.max(12, event.clientX - drag.offsetX), Math.max(12, window.innerWidth - 360));
      const nextY = Math.min(Math.max(42, event.clientY - drag.offsetY), Math.max(42, window.innerHeight - 230));
      setPosition({ x: nextX, y: nextY });
    };
    const handleUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.userSelect = '';
    };
  }, []);

  if (!task?.active) return null;

  const startedAt = Number(task.startedAt || Date.now());
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const [minSeconds, maxSeconds] = estimateTaskSeconds(task.label, rows, wordCount);
  const cleanLog = taskStepFromLog(logs).slice(0, 120);

  return (
    <div
      className="fixed z-[70] w-[420px] max-w-[calc(100vw-24px)] rounded-[10px] border border-[#28436d] bg-[#071020]/95 p-4 text-sm text-white shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur"
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="mb-3 cursor-move rounded bg-[#0b1426] px-3 py-2 text-base text-white"
        onMouseDown={(event) => {
          dragRef.current = { offsetX: event.clientX - position.x, offsetY: event.clientY - position.y };
          document.body.style.userSelect = 'none';
        }}
      >
        {task.label || 'Đang chạy'}
      </div>
      <div className="grid gap-2 text-xs">
        <div className="rounded bg-[#0b1426] px-3 py-2 text-slate-300">
          Ước tính: {formatDurationRange(minSeconds)} - {formatDurationRange(maxSeconds)}
        </div>
        <div className="rounded bg-[#0b1426] px-3 py-2 text-slate-300">
          Thực tế: {formatDurationRange(elapsedSeconds)}
        </div>
        <div className="rounded bg-[#0b1426] px-3 py-2 font-semibold text-[#f1cc00]">
          {cleanLog || 'Đang chuẩn bị...'}
        </div>
        <div className="flex items-center gap-2 rounded bg-[#0b1426] px-3 py-2 text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-[#f1cc00]" />
          <span>Đang xử lý, vui lòng chờ kết quả thật từ backend...</span>
        </div>
        <Button tone="red" className="mt-2 h-10 w-full text-sm" onClick={onCancel}>
          Hủy
        </Button>
      </div>
    </div>
  );
}

function RunningTaskBar({ task, rows, wordCount, logs, onCancel, modalOpen = false }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!task?.active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [task?.active]);

  if (!task?.active) return null;

  const elapsedSeconds = Math.max(0, Math.round((now - Number(task.startedAt || now)) / 1000));
  const [minSeconds, maxSeconds] = estimateTaskSeconds(task.label, rows, wordCount);
  const step = taskStepFromLog(logs).slice(0, 150);
  const panelClassName = modalOpen
    ? 'fixed bottom-[92px] left-6 z-[75] w-[min(560px,calc(100vw-48px))] rounded-[8px] border border-[#31537f] bg-[#071020]/95 px-3 py-2 text-xs text-white shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur'
    : 'fixed bottom-4 left-1/2 z-[75] w-[min(880px,calc(100vw-24px))] -translate-x-1/2 rounded-[8px] border border-[#31537f] bg-[#071020]/95 px-3 py-2 text-xs text-white shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur';

  return (
    <div className={panelClassName}>
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#f1cc00]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-black text-[#f1cc00]">{task.label || 'Đang chạy'}</span>
            <span className="text-slate-400">Thực tế {formatDurationRange(elapsedSeconds)}</span>
            <span className="text-slate-500">ước tính {formatDurationRange(minSeconds)} - {formatDurationRange(maxSeconds)}</span>
          </div>
          <div className="truncate text-slate-300">{step}</div>
        </div>
        <Button tone="red" className="h-8 px-3 text-xs" onClick={onCancel}>Hủy</Button>
      </div>
    </div>
  );
}

function SidebarButton({ active, icon: Icon, label }) {
  return (
    <button
      type="button"
      title={label}
      className={`flex h-12 w-12 items-center justify-center rounded-xl text-lg transition ${
        active ? 'bg-[#f1cc00] text-black shadow-[0_8px_20px_rgba(241,204,0,0.25)]' : 'bg-[#0b1628] text-slate-300 hover:bg-[#101e34]'
      }`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

export default function WorkflowStudio() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [workspaceMode, setWorkspaceMode] = useState('project');
  const [hydrated, setHydrated] = useState(false);
  const [seekToken, setSeekToken] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeModal, setActiveModal] = useState(null);
  const [skillDoc, setSkillDoc] = useState({ loading: false, name: '', content: '', path: '', error: '' });
  const [appDialog, setAppDialog] = useState(null);
  const [sttToolTab, setSttToolTab] = useState('stt');
  const [subtitleToolTab, setSubtitleToolTab] = useState('translate');
  const [exportTab, setExportTab] = useState('srt');
  const [exportAction, setExportAction] = useState('video');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMenuPosition, setHistoryMenuPosition] = useState({ top: 60, left: 500, width: 320 });
  const [timelineTab, setTimelineTab] = useState('all');
  const [ttsRepairSelectedRowId, setTtsRepairSelectedRowId] = useState('');
  const [editingCliTranslationModel, setEditingCliTranslationModel] = useState(false);
  const [editingSubtitleGroupModel, setEditingSubtitleGroupModel] = useState(false);
  const [currentTask, setCurrentTask] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const contextMenuRef = useRef(null);
  const historyButtonRef = useRef(null);
  const [ttsRepairPreviewAudio, setTtsRepairPreviewAudio] = useState('');
  const [editingRowId, setEditingRowId] = useState('');
  const [editDraft, setEditDraft] = useState('');
  const [timingDraft, setTimingDraft] = useState(null);
  const [timingSearch, setTimingSearch] = useState('');
  const [timingReplace, setTimingReplace] = useState('');
  const [timingFrom, setTimingFrom] = useState('');
  const [timingTo, setTimingTo] = useState('');
  const [bulkEditMode, setBulkEditMode] = useState('all');
  const [bulkEditDraft, setBulkEditDraft] = useState('');
  const [bulkEditSelectedId, setBulkEditSelectedId] = useState('');
  const [bulkEditSelectedText, setBulkEditSelectedText] = useState('');
  const [youtubeDraft, setYoutubeDraft] = useState('');
  const [newProjectNameDraft, setNewProjectNameDraft] = useState('New project');
  const [srtImportType, setSrtImportType] = useState('source');
  const [ttsRepairSeverityFilter, setTtsRepairSeverityFilter] = useState('all');
  const [draggingRowId, setDraggingRowId] = useState('');
  const [videoSourceIndex, setVideoSourceIndex] = useState(0);
  const [ttsRepairTableColumns, setTtsRepairTableColumns] = useState(TTS_REPAIR_TABLE_COLUMN_DEFAULTS);
  const [projects, setProjects] = useState([]);
  const [settingsSavedAt, setSettingsSavedAt] = useState('');
  const [googleTtsUsage, setGoogleTtsUsage] = useState({});
  const [ttsProviderTestResult, setTtsProviderTestResult] = useState(null);
  const [ocrTestResult, setOcrTestResult] = useState(null);
  const [ocrFramePicker, setOcrFramePicker] = useState(null);
  const [ocrCropDrag, setOcrCropDrag] = useState(null);
  const [subtitleDrag, setSubtitleDrag] = useState(null);
  const mediaRef = useRef(null);
  const subtitleCoverCanvasRef = useRef(null);
  const subtitleCoverLowerCanvasRef = useRef(null);
  const dubbedAudioRef = useRef(null);
  const newProjectNameInputRef = useRef(null);
  const playRequestRef = useRef(0);
  const logListRef = useRef(null);
  const abortRef = useRef(null);
  const undoRowsRef = useRef([]);
  const recoveredJobsRef = useRef(false);
  const ttsAudioRecoveryRef = useRef('');
  const backendLogSeenRef = useRef(new Set());
  const appDialogResolveRef = useRef(null);
  const ttsRepairPreviewAudioRef = useRef(null);
  const [ttsRepairPreviewAudioRowIds, setTtsRepairPreviewAudioRowIds] = useState([]);
  const [ttsRepairPreviewAudioByRowId, setTtsRepairPreviewAudioByRowId] = useState({});

  const rows = Array.isArray(state.rows) ? state.rows : [];
  const ttsRepairBasket = Array.isArray(state.ttsRepairBasket) ? state.ttsRepairBasket : [];
  const meaningUnits = Array.isArray(state.meaningUnits) ? state.meaningUnits : [];
  const ttsUnits = Array.isArray(state.ttsUnits) ? state.ttsUnits : [];
  const voices = Array.isArray(state.voices) ? state.voices : [];
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const source = state.source && typeof state.source === 'object' ? state.source : DEFAULT_STATE.source;
  const job = state.job && typeof state.job === 'object' ? state.job : DEFAULT_STATE.job;
  const outputs = state.outputs && typeof state.outputs === 'object' ? state.outputs : DEFAULT_STATE.outputs;
  const config = state.config && typeof state.config === 'object' ? state.config : DEFAULT_STATE.config;
  const ttsReport = outputs.ttsReport && typeof outputs.ttsReport === 'object' ? outputs.ttsReport : null;

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === state.selectedRowId) || rows[0] || null,
    [rows, state.selectedRowId]
  );
  const wordCount = useMemo(() => countWords(rows), [rows]);
  const effectiveVoices = voices.length ? voices : fallbackVoices(config.ttsProvider, config.ttsLanguageCode);
  const voiceSelectionConfig = config.ttsProvider === 'google_cloud_tts'
    ? { ...config, voiceControlsFilter: 'all' }
    : config;
  const visibleVoices = filterVoices(effectiveVoices, voiceSelectionConfig);
  const voiceFamilyOptions = uniqueVoiceOptions(effectiveVoices, 'family');
  const voiceSampleRateOptions = uniqueVoiceOptions(effectiveVoices, 'sampleRate');
  const selectedTtsVoiceName = selectVoiceNameForConfig(effectiveVoices, voiceSelectionConfig);
  const googleTtsBilling = googleTtsBillingTier(selectedTtsVoiceName);
  const googleTtsUsageMonthKey = googleTtsUsageMonth();
  const googleTtsUsageKey = `${googleTtsUsageMonthKey}:${googleTtsBilling.id}`;
  const googleTtsUsedChars = Number(googleTtsUsage[googleTtsUsageKey]) || 0;
  const googleTtsAllUsedChars = Object.entries(googleTtsUsage).reduce((sum, [key, value]) => (
    String(key).startsWith(`${googleTtsUsageMonthKey}:`) ? sum + (Number(value) || 0) : sum
  ), 0);
  const googleTtsEstimatedChars = useMemo(
    () => rowsToTtsSegments(rowsWithFinalText(rows)).reduce((sum, segment) => sum + countGoogleTtsBillableChars(segment.text), 0),
    [rows]
  );
  const googleTtsRemainingAfterEstimate = Math.max(0, googleTtsBilling.freeChars - googleTtsUsedChars - googleTtsEstimatedChars);
  const googleTtsBillableBeforeEstimate = Math.max(0, googleTtsUsedChars - googleTtsBilling.freeChars);
  const googleTtsBillableAfterEstimate = Math.max(0, googleTtsUsedChars + googleTtsEstimatedChars - googleTtsBilling.freeChars);
  const googleTtsNewBillableChars = Math.max(0, googleTtsBillableAfterEstimate - googleTtsBillableBeforeEstimate);
  const googleTtsEstimatedCostUsd = (googleTtsNewBillableChars / 1000000) * (Number(googleTtsBilling.usdPerMillion) || 0);
  const inferredPreviewUrl = inferPreviewUrlFromSource(job.sourceVideoUrl || job.videoUrl);
  const manualSourceVideoUrl = job.jobId ? `/api/manual/video/${job.jobId}` : '';
  const manualPreviewVideoUrl = job.jobId ? `/api/manual/preview-video/${job.jobId}` : '';
  const exportedVideoUrl = state.currentStage === 'video' ? outputs.videoUrl : '';
  const savedPreviewVideoUrl = isManualStreamUrl(job.previewVideoUrl) ? '' : job.previewVideoUrl;
  // The editor always previews the clean source.  An exported movie already has
  // the subtitle burned into its pixels; using it here and then drawing the
  // editable subtitle again produces two Vietnamese subtitle layers.
  const sourcePreviewCandidates = [
    savedPreviewVideoUrl,
    manualPreviewVideoUrl,
    inferredPreviewUrl,
    manualSourceVideoUrl,
    job.sourceVideoUrl,
    job.videoUrl,
  ].filter((value) => toPlayableMediaSrc(value));
  const mediaCandidates = Array.from(new Set([
    ...sourcePreviewCandidates,
    // Only fall back to a previous export when the source preview is genuinely
    // unavailable. This keeps the preview and the next export independent.
    ...(sourcePreviewCandidates.length ? [] : [exportedVideoUrl]),
  ].filter((value) => toPlayableMediaSrc(value))));
  const mediaCandidateKey = mediaCandidates.join('|');
  const safeVideoSourceIndex = Math.max(0, Math.min(videoSourceIndex, Math.max(0, mediaCandidates.length - 1)));
  const mediaUrl = mediaCandidates[safeVideoSourceIndex] || '';
  const mediaSrc = toPlayableMediaSrc(mediaUrl);
  const renderedMediaSrc = mediaSrc;
  const dubbedAudioSrc = toPlayableMediaSrc(outputs.audioUrl);
  const finalField = state.currentStage === 'source' ? 'sourceText' : 'finalText';
  const previewMedia = mediaRef.current;
  const previewVideoAspectRatio = previewMedia?.videoWidth && previewMedia?.videoHeight
    ? previewMedia.videoWidth / Math.max(1, previewMedia.videoHeight)
    : aspectRatioNumber(normalizeOutputAspectRatio(config.outputAspectRatio));
  const activePreviewRow = rows.find((row) => state.currentTime >= row.start && state.currentTime < row.end)
    || rows.find((row) => state.currentTime >= row.start && state.currentTime <= row.end)
    || selectedRow;
  const activeSubtitleText = rowText(activePreviewRow || {}, finalField) || rowText(activePreviewRow || {}, 'sourceText');
  const cleanActiveText = normalizeSubtitleDisplayText(activeSubtitleText);
  const previewSubtitleText = config.subtitlePreviewEnabled !== false ? cleanActiveText : '';
  const previewSubtitleLines = previewSubtitleText
    ? (cleanActiveText.includes('\n')
        ? cleanActiveText.split('\n')
        : formatSubtitleMaxWordsPerLine(cleanActiveText, 15))
    : [];
  const previewSubtitleLineCount = Math.max(1, previewSubtitleLines.length);
  const previewSubtitleBaseFontSize = Math.max(
    10,
    normalizeSubtitleFontSize(config.subtitleFontSize) * (previewSubtitleLineCount > 3 ? 0.74 : previewSubtitleLineCount > 2 ? 0.86 : 1)
  );
  const previewSubtitleFontSize = fitSubtitlePreviewFontSize(
    previewSubtitleLines,
    previewSubtitleBaseFontSize,
    subtitlePreviewVideoContentWidth(previewMedia),
    config.subtitleBoxEnabled !== false
  );
  const overlayPreviewText = String(config.overlayText || '').trim();
  const overlayPreviewStart = Math.max(0, Number(config.overlayStart) || 0);
  const overlayPreviewEnd = Math.max(overlayPreviewStart + 0.8, Number(config.overlayEnd) || overlayPreviewStart + 5);
  const showOverlayPreview = Boolean(
    config.overlayEnabled === true
    &&
    overlayPreviewText
    && state.currentTime >= overlayPreviewStart
    && state.currentTime <= overlayPreviewEnd
  );
  const logoPreviewSrc = config.logoEnabled && config.logoPath ? localFilePreviewSrc(config.logoPath) : '';
  const ttsWarningRows = rows.filter((row) => hasTtsSyncWarning(row.ttsSync)).length;
  const ttsRepairById = useMemo(
    () => new Map(ttsRepairBasket.map((item) => [String(item.rowId), item])),
    [ttsRepairBasket]
  );
  const ttsRepairRows = useMemo(() => rows
    .map((row) => {
      const issue = ttsRepairIssueForRow(row, finalField);
      const basketItem = ttsRepairById.get(String(row.id));
      const removed = basketItem?.selected === false && basketItem?.status === 'removed' && !basketItem?.repairedTranslation;
      if (removed) return null;
      if (!issue && basketItem?.manual !== true && !basketItem?.repairedTranslation) return null;
      return ttsRepairPayloadForRow(row, rows, finalField, basketItem);
    })
    .filter(Boolean), [rows, finalField, ttsRepairById]);
  const ttsRepairMajorRows = ttsRepairRows.filter((item) => item.severity === 'major').length;
  const ttsRepairMinorRows = ttsRepairRows.filter((item) => item.severity === 'minor').length;
  const visibleTtsRepairRows = useMemo(() => (
    ttsRepairSeverityFilter === 'major'
      ? ttsRepairRows.filter((item) => item.severity === 'major')
      : ttsRepairSeverityFilter === 'minor'
        ? ttsRepairRows.filter((item) => item.severity === 'minor')
        : ttsRepairRows
  ), [ttsRepairRows, ttsRepairSeverityFilter]);
  const selectedTtsRepairItem = useMemo(
    () => visibleTtsRepairRows.find((item) => String(item.rowId) === String(ttsRepairSelectedRowId)) || visibleTtsRepairRows[0] || null,
    [visibleTtsRepairRows, ttsRepairSelectedRowId]
  );
  const selectedTtsRepairIndex = useMemo(
    () => visibleTtsRepairRows.findIndex((item) => String(item.rowId) === String(selectedTtsRepairItem?.rowId)),
    [visibleTtsRepairRows, selectedTtsRepairItem]
  );
  const selectedTtsRepairRow = useMemo(
    () => selectedTtsRepairItem ? rows.find((row) => String(row.id) === String(selectedTtsRepairItem.rowId)) || null : null,
    [rows, selectedTtsRepairItem]
  );
  const ttsRepairRowsWithDraft = useMemo(
    () => ttsRepairRows.filter((item) => String(item.repairedTranslation || '').trim()),
    [ttsRepairRows]
  );
  const ttsRepairApplyRows = useMemo(
    () => ttsRepairRowsWithDraft.filter((item) => item.applySelected === true && canApplyTtsRepairPreview(item)),
    [ttsRepairRowsWithDraft]
  );
  const ttsRepairTextApplyRows = useMemo(
    () => ttsRepairRowsWithDraft.filter((item) => item.applySelected === true),
    [ttsRepairRowsWithDraft]
  );
  const ttsRepairPreviewAudioRowIdSet = useMemo(
    () => new Set(ttsRepairPreviewAudioRowIds.map(String)),
    [ttsRepairPreviewAudioRowIds]
  );
  const ttsRepairPreviewAudioForRow = (rowId) => {
    const key = String(rowId);
    if (ttsRepairPreviewAudioByRowId[key]) return ttsRepairPreviewAudioByRowId[key];
    const item = ttsRepairRows.find((candidate) => String(candidate.rowId) === key);
    const previewId = String(item?.ttsPreviewId || '').trim();
    const segmentFileName = String(item?.aimaxSegmentFileName || '').trim();
    const batchIndex = Number(item?.aimaxBatchIndex);
    if (job.jobId && previewId && segmentFileName && Number.isInteger(batchIndex) && batchIndex >= 0) {
      const batchName = `batch_${String(batchIndex + 1).padStart(3, '0')}_segments`;
      return `${API_BASE}/jobs/${encodeURIComponent(job.jobId)}/tts/repair_preview/${encodeURIComponent(previewId)}/aimax_srt_batches/${batchName}/${encodeURIComponent(segmentFileName)}`;
    }
    if (ttsRepairPreviewAudio && ttsRepairPreviewAudioRowIds.length === 1 && ttsRepairPreviewAudioRowIdSet.has(key)) {
      return ttsRepairPreviewAudio;
    }
    return '';
  };
  const hasTtsRepairPreviewAudioForRow = (rowId) => Boolean(ttsRepairPreviewAudioForRow(rowId));
  const clearActiveTtsRepairPreviewAudio = () => {
    setTtsRepairPreviewAudio('');
    setTtsRepairPreviewAudioRowIds([]);
  };
  const clearTtsRepairPreviewAudioForRows = (rowIds) => {
    const targetIds = new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).map(String));
    if (ttsRepairPreviewAudioRowIds.some((rowId) => targetIds.has(String(rowId)))) {
      clearActiveTtsRepairPreviewAudio();
    }
    setTtsRepairPreviewAudioByRowId((current) => {
      const keys = Object.keys(current);
      if (!keys.some((key) => targetIds.has(key))) return current;
      const next = { ...current };
      for (const key of keys) {
        if (targetIds.has(key)) delete next[key];
      }
      return next;
    });
  };
  const replayTtsRepairPreviewAudio = (rowId = null) => {
    const audioUrl = rowId == null ? ttsRepairPreviewAudio : ttsRepairPreviewAudioForRow(rowId);
    if (!audioUrl) return;
    const player = ttsRepairPreviewAudioRef.current;
    if (player && player.getAttribute('src') === audioUrl) {
      player.currentTime = 0;
      const playPromise = player.play();
      if (playPromise?.catch) playPromise.catch(() => {});
      return;
    }
    const audio = new Audio(audioUrl);
    const playPromise = audio.play();
    if (playPromise?.catch) playPromise.catch(() => {});
  };
  const ttsRepairTableGridTemplate = useMemo(() => [
    `${clamp(ttsRepairTableColumns.apply, TTS_REPAIR_TABLE_COLUMN_MIN.apply, TTS_REPAIR_TABLE_COLUMN_MAX.apply)}px`,
    `${clamp(ttsRepairTableColumns.index, TTS_REPAIR_TABLE_COLUMN_MIN.index, TTS_REPAIR_TABLE_COLUMN_MAX.index)}px`,
    `${clamp(ttsRepairTableColumns.start, TTS_REPAIR_TABLE_COLUMN_MIN.start, TTS_REPAIR_TABLE_COLUMN_MAX.start)}px`,
    `${clamp(ttsRepairTableColumns.end, TTS_REPAIR_TABLE_COLUMN_MIN.end, TTS_REPAIR_TABLE_COLUMN_MAX.end)}px`,
    `${clamp(ttsRepairTableColumns.text, TTS_REPAIR_TABLE_COLUMN_MIN.text, TTS_REPAIR_TABLE_COLUMN_MAX.text)}px`,
    `${clamp(ttsRepairTableColumns.repair, TTS_REPAIR_TABLE_COLUMN_MIN.repair, TTS_REPAIR_TABLE_COLUMN_MAX.repair)}px`,
    `${clamp(ttsRepairTableColumns.error, TTS_REPAIR_TABLE_COLUMN_MIN.error, TTS_REPAIR_TABLE_COLUMN_MAX.error)}px`,
  ].join(' '), [ttsRepairTableColumns]);

  useEffect(() => {
    if (!visibleTtsRepairRows.length) {
      if (ttsRepairSelectedRowId) setTtsRepairSelectedRowId('');
      return;
    }
    const selectedVisible = visibleTtsRepairRows.some((item) => String(item.rowId) === String(ttsRepairSelectedRowId));
    if (!selectedVisible) {
      setTtsRepairSelectedRowId(visibleTtsRepairRows[0].rowId);
    }
  }, [visibleTtsRepairRows, ttsRepairSelectedRowId]);

  const openOutput = outputs.videoUrl || outputs.audioUrl || outputs.srtUrl;
  const hasVideo = Boolean(source.videoPath || source.videoUrl || mediaUrl);
  const hasTranslationCredential = CLI_TRANSLATION_PROVIDERS.has(config.translationProvider) || Boolean(state.health?.backend);
  const translationUsesPromptSkill = rowsAreTemplateGroups(rows);
  const activeTranslationProviderLabel = translationProviderLabel(config.translationProvider);
  const activeTranslationModelLabel = translationModelLabel(config.translationProvider, config.cliTranslationModel);
  const activeTtsProviderLabel = ttsProviderLabel(config.ttsProvider);
  const activeTtsModelLabel = ttsModelLabel(config);

  useEffect(() => {
    setVideoSourceIndex(0);
  }, [mediaCandidateKey]);

  const patchState = (patch) => setState((previous) => ({
    ...previous,
    ...patch,
    ...(Array.isArray(patch?.rows) ? { rows: ensureUniqueRowIds(patch.rows) } : {}),
    ...(Array.isArray(patch?.ttsRepairBasket) ? { ttsRepairBasket: normalizeTtsRepairBasket(patch.ttsRepairBasket) } : {}),
  }));
  const patchConfig = (patch) => setState((previous) => ({ ...previous, config: { ...previous.config, ...patch } }));
  const patchSource = (patch) => setState((previous) => ({ ...previous, source: { ...previous.source, ...patch } }));

  const showConfirm = (options) => new Promise((resolve) => {
    if (appDialogResolveRef.current) appDialogResolveRef.current(false);
    appDialogResolveRef.current = resolve;
    setAppDialog({ type: 'confirm', tone: 'yellow', ...options });
  });

  const showAlert = (title, message) => {
    if (appDialogResolveRef.current) {
      appDialogResolveRef.current(false);
      appDialogResolveRef.current = null;
    }
    setAppDialog({ type: 'alert', title, message, confirmLabel: 'Đóng' });
  };

  const resolveAppDialog = (confirmed) => {
    const resolve = appDialogResolveRef.current;
    appDialogResolveRef.current = null;
    setAppDialog(null);
    resolve?.(Boolean(confirmed));
  };

  const addLog = (message) => {
    const time = logTime();
    setState((previous) => ({
      ...previous,
      logs: [`[${time}] ${message}`, ...(Array.isArray(previous.logs) ? previous.logs : [])].slice(0, 500),
      error: '',
    }));
  };

  const startTtsRepairColumnResize = (event, column) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = clamp(
      ttsRepairTableColumns[column] ?? TTS_REPAIR_TABLE_COLUMN_DEFAULTS[column],
      TTS_REPAIR_TABLE_COLUMN_MIN[column],
      TTS_REPAIR_TABLE_COLUMN_MAX[column]
    );
    const onPointerMove = (moveEvent) => {
      const nextWidth = clamp(
        startWidth + moveEvent.clientX - startX,
        TTS_REPAIR_TABLE_COLUMN_MIN[column],
        TTS_REPAIR_TABLE_COLUMN_MAX[column]
      );
      setTtsRepairTableColumns((previous) => ({ ...previous, [column]: nextWidth }));
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  useEffect(() => {
    if (activeModal !== 'bulkEditV2' || bulkEditMode !== 'ttsRepair') return;
    if (!ttsRepairRows.length) {
      if (ttsRepairSelectedRowId) setTtsRepairSelectedRowId('');
      return;
    }
    if (!ttsRepairRows.some((item) => String(item.rowId) === String(ttsRepairSelectedRowId))) {
      setTtsRepairSelectedRowId(ttsRepairRows[0].rowId);
    }
  }, [activeModal, bulkEditMode, ttsRepairRows, ttsRepairSelectedRowId]);

  useEffect(() => {
    const normalizedFontSize = normalizeLoadedSubtitleFontSize(config.subtitleFontSize);
    if (Number(config.subtitleFontSize) !== normalizedFontSize) {
      patchConfig({ subtitleFontSize: normalizedFontSize });
    }
  }, [config.subtitleFontSize]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeWhenOutside = (event) => {
      if (contextMenuRef.current?.contains(event.target)) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', closeWhenOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeWhenOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  const setBusy = (busy, message = '') => {
    setState((previous) => ({
      ...previous,
      busy,
      error: busy ? '' : previous.error,
      logs: message ? [`[${logTime()}] ⏳ ${message}`, ...(Array.isArray(previous.logs) ? previous.logs : [])].slice(0, 500) : previous.logs,
    }));
  };

  useEffect(() => {
    if (!hydrated || !hasDuplicateRowIds(rows)) return;
    const nextRows = ensureUniqueRowIds(rows);
    patchState({
      rows: nextRows,
      selectedRowId: nextRows.some((row) => row.id === state.selectedRowId)
        ? state.selectedRowId
        : nextRows[0]?.id || '',
    });
  }, [hydrated, rows, state.selectedRowId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = safeJsonParse(window.localStorage.getItem(STORAGE_KEY), null);
    const savedSettings = safeJsonParse(window.localStorage.getItem(SETTINGS_STORAGE_KEY), {});
    const storedProjects = safeJsonParse(window.localStorage.getItem(PROJECTS_STORAGE_KEY), []);
    const storedGoogleTtsUsage = safeJsonParse(window.localStorage.getItem(GOOGLE_TTS_USAGE_STORAGE_KEY), {});
    const deletedRefs = deletedProjectRefsFromStorage();
    const recoveredProjects = filterDeletedProjects(recoverProjectsFromStorage(saved, storedProjects, savedSettings), deletedRefs);
    if (saved) {
      const normalized = normalizeState(saved);
      setState({ ...normalized, config: mergeSettingsDefaults(normalized.config, savedSettings) });
    } else {
      setState((previous) => ({ ...previous, config: mergeSettingsDefaults(previous.config, savedSettings, true) }));
    }
    setProjects(recoveredProjects);
    setGoogleTtsUsage(storedGoogleTtsUsage && typeof storedGoogleTtsUsage === 'object' ? storedGoogleTtsUsage : {});
    safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(recoveredProjects));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!currentTask?.active || !job.jobId) return undefined;
    let stopped = false;

    const pullBackendLogs = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/job-status/${job.jobId}`);
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const backendLogs = Array.isArray(data?.logs) ? data.logs.slice(-18) : [];
        const nextLines = [];
        for (const entry of backendLogs) {
          const message = String(entry?.message || entry?.detail || '').trim();
          if (!message) continue;
          const key = `${entry?.time || ''}|${entry?.level || ''}|${message}`;
          if (backendLogSeenRef.current.has(key)) continue;
          backendLogSeenRef.current.add(key);
          nextLines.push(`[${logTime()}] ${message}`);
        }
        if (!nextLines.length || stopped) return;
        setState((previous) => ({
          ...previous,
          logs: [...nextLines.reverse(), ...(Array.isArray(previous.logs) ? previous.logs : [])].slice(0, 500),
        }));
      } catch {
        // The main request is still authoritative; polling only improves visibility.
      }
    };

    pullBackendLogs();
    const timer = window.setInterval(pullBackendLogs, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [currentTask?.active, job.jobId]);

  useEffect(() => {
    if (!hydrated || !job.jobId) return;
    if (outputs.audioPath || outputs.audioUrl) {
      ttsAudioRecoveryRef.current = '';
      return;
    }
    const recoveryKey = `${job.jobId}:${rows.length}:${state.currentStage}`;
    if (ttsAudioRecoveryRef.current === recoveryKey) return;
    ttsAudioRecoveryRef.current = recoveryKey;
    let canceled = false;

    const recoverMissingTtsAudio = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/job-status/${job.jobId}`);
        if (!response.ok || canceled) return;
        const data = await response.json().catch(() => null);
        const result = data?.result && typeof data.result === 'object' ? data.result : {};
        const audioPath = String(result.manualDubbedAudioPath || '').trim();
        const audioUrl = String(result.manualDubbedAudioUrl || '').trim();
        if ((!audioPath && !audioUrl) || canceled) return;
        setState((previous) => {
          if (String(previous.job?.jobId || '') !== String(job.jobId)) return previous;
          const previousOutputs = previous.outputs && typeof previous.outputs === 'object' ? previous.outputs : {};
          if (previousOutputs.audioPath || previousOutputs.audioUrl) return previous;
          const previousConfig = previous.config && typeof previous.config === 'object' ? previous.config : {};
          return {
            ...previous,
            outputs: {
              ...previousOutputs,
              audioPath,
              audioUrl: cacheBustUrl(audioUrl),
              ttsQcReportPath: result.ttsReportPath || previousOutputs.ttsQcReportPath || '',
              ttsQcReportUrl: result.ttsReportUrl || previousOutputs.ttsQcReportUrl || '',
            },
            config: {
              ...previousConfig,
              dubbedAudioEnabled: true,
              sourceAudioEnabled: false,
              dubbedPreviewVolume: Number(previousConfig.dubbedPreviewVolume) > 0
                ? previousConfig.dubbedPreviewVolume
                : DEFAULT_STATE.config.dubbedPreviewVolume,
            },
            currentStage: ['idle', 'final', 'recovered'].includes(previous.currentStage)
              ? 'voice'
              : previous.currentStage,
            logs: [
              `[${logTime()}] Đã khôi phục audio TTS từ job ${job.jobId}.`,
              ...(Array.isArray(previous.logs) ? previous.logs : []),
            ].slice(0, 500),
          };
        });
      } catch {
        // Best-effort recovery only; explicit TTS actions still report errors.
      }
    };

    recoverMissingTtsAudio();
    return () => {
      canceled = true;
    };
  }, [hydrated, job.jobId, outputs.audioPath, outputs.audioUrl, rows.length, state.currentStage]);

  useEffect(() => {
    if (!hydrated || !(outputs.audioPath || outputs.audioUrl)) return;
    if (config.dubbedAudioEnabled === false || Number(config.dubbedPreviewVolume) > 0) return;
    setState((previous) => ({
      ...previous,
      config: {
        ...(previous.config || {}),
        dubbedPreviewVolume: DEFAULT_STATE.config.dubbedPreviewVolume,
      },
    }));
  }, [hydrated, outputs.audioPath, outputs.audioUrl, config.dubbedAudioEnabled, config.dubbedPreviewVolume]);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
    if (!hasProjectPayload(state)) return;
    const deletedRefs = deletedProjectRefsFromStorage();
    if (isDeletedProjectRef(state, deletedRefs)) return;
    const snapshot = createProjectSnapshot({
      ...state,
      projectName: String(state.projectName || '').trim() || state.source?.title || fileNameFromPath(state.source?.videoPath) || 'New project',
      config: { ...state.config, speakingRate: normalizeSpeakingRate(state.config?.speakingRate) },
    });
    const savedProjects = filterDeletedProjects(normalizeProjects(safeJsonParse(window.localStorage.getItem(PROJECTS_STORAGE_KEY), [])), deletedRefs);
    const nextProjects = [snapshot, ...savedProjects.filter((project) => project.id !== snapshot.id)].slice(0, 30);
    safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    setProjects((previous) => {
      const merged = [snapshot, ...previous.filter((project) => project.id !== snapshot.id)].slice(0, 30);
      return JSON.stringify(merged.map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))) === JSON.stringify(previous.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })))
        ? previous
        : merged;
    });
  }, [state, hydrated]);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    if (!projects.some((project) => hasProjectPayload(project.state))) {
      const savedProjects = normalizeProjects(safeJsonParse(window.localStorage.getItem(PROJECTS_STORAGE_KEY), []));
      if (savedProjects.some((project) => hasProjectPayload(project.state))) return;
    }
    safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  }, [projects, hydrated]);

  useEffect(() => {
    if (!hydrated || recoveredJobsRef.current || typeof window === 'undefined') return;
    recoveredJobsRef.current = true;
    fetch(`${API_BASE}/api/manual/recover-projects`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const deletedRefs = deletedProjectRefsFromStorage();
        const recovered = filterDeletedProjects(normalizeProjects(data?.projects || []), deletedRefs);
        if (!recovered.length) return;
        const merged = filterDeletedProjects(mergeRecoveredProjectSnapshots(projects, recovered), deletedRefs);
        setProjects(merged);
        safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(merged));
        const currentJobId = projectJobId(state);
        const recoveredCurrent = merged.find((project) => (
          project.id === state.projectId
          || (currentJobId && projectJobId(project) === currentJobId)
        ));
        const enrichedCurrentState = recoveredCurrent?.state
          ? mergeRecoveredArtifactsIntoState(state, recoveredCurrent.state)
          : null;
        const shouldPatchCurrent = Boolean(
          enrichedCurrentState
          && (
            projectRecoveryScore(enrichedCurrentState) > projectRecoveryScore(state)
            || recoveredArtifactsShouldPatch(state, recoveredCurrent.state)
          )
        );
        if ((!hasProjectPayload(state) && merged[0]?.state) || shouldPatchCurrent) {
          const nextState = shouldPatchCurrent ? {
            ...enrichedCurrentState,
            projectId: state.projectId || recoveredCurrent.id,
            projectName: state.projectName || recoveredCurrent.name || enrichedCurrentState.projectName,
          } : merged[0].state;
          setState(applyGlobalSettingsToState(nextState));
        }
        addLog(`Đã khôi phục ${recovered.length} project từ thư mục jobs.`);
      })
      .catch(() => {});
  }, [hydrated, projects, state]);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    safeLocalStorageSet(SETTINGS_STORAGE_KEY, JSON.stringify(savedSettingsFromConfig(state.config)));
  }, [state.config, hydrated]);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((response) => response.json())
      .then((data) => patchState({ health: data }))
      .catch(() => addLog('Backend chưa kết nối.'));
  }, []);

  useEffect(() => {
    if (!seekToken || !mediaRef.current) return;
    const row = rows.find((item) => item.id === state.selectedRowId);
    if (!row) return;
    mediaRef.current.currentTime = row.start;
    if (dubbedAudioRef.current) dubbedAudioRef.current.currentTime = row.start;
  }, [seekToken]);

  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = config.sourceAudioEnabled ? clamp(Number(config.originalPreviewVolume) || 0, 0, 100) / 100 : 0;
      mediaRef.current.muted = !config.sourceAudioEnabled;
    }
    if (dubbedAudioRef.current) {
      dubbedAudioRef.current.volume = config.dubbedAudioEnabled ? clamp(Number(config.dubbedPreviewVolume) || 0, 0, 100) / 100 : 0;
      dubbedAudioRef.current.muted = !config.dubbedAudioEnabled;
    }
  }, [config.sourceAudioEnabled, config.dubbedAudioEnabled, config.originalPreviewVolume, config.dubbedPreviewVolume]);

  useEffect(() => {
    playRequestRef.current += 1;
    setPlaying(false);
  }, [mediaSrc, dubbedAudioSrc]);

  useEffect(() => {
    if (logListRef.current) logListRef.current.scrollTop = 0;
  }, [logs.length]);

  useEffect(() => {
    if (config.subtitleCoverEnabled !== true) return undefined;
    const video = mediaRef.current;
    const canvas = subtitleCoverCanvasRef.current;
    if (!video || !canvas) return undefined;

    let animationId = 0;
    let videoFrameId = 0;
    let stopped = false;

    const drawSmartCover = () => {
      if (stopped || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      const widthRatio = clamp(Number(config.subtitleCoverW ?? 48) / 100, 0.02, 1);
      const heightRatio = clamp(Number(config.subtitleCoverH ?? 8) / 100, 0.02, 1);
      const xRatio = clamp(Number(config.subtitleCoverX ?? 26) / 100, 0, 1 - widthRatio);
      const yRatio = clamp(Number(config.subtitleCoverY ?? 82) / 100, 0, 1 - heightRatio);
      const canSampleAbove = yRatio >= heightRatio * 1.05;
      const canSampleBelow = yRatio + heightRatio * 2.05 <= 1;
      const fallbackYRatio = clamp(yRatio, 0, 1 - heightRatio);
      const upperSourceYRatio = canSampleAbove
        ? yRatio - heightRatio * 1.05
        : canSampleBelow
          ? yRatio + heightRatio * 1.05
          : fallbackYRatio;
      const lowerSourceYRatio = canSampleBelow
        ? yRatio + heightRatio * 1.05
        : upperSourceYRatio;
      const sourceX = xRatio * video.videoWidth;
      const upperSourceY = upperSourceYRatio * video.videoHeight;
      const lowerSourceY = lowerSourceYRatio * video.videoHeight;
      const sourceWidth = Math.max(2, widthRatio * video.videoWidth);
      const sourceHeight = Math.max(2, heightRatio * video.videoHeight);
      const canvasWidth = Math.max(2, Math.round(sourceWidth));
      const canvasHeight = Math.max(2, Math.round(sourceHeight));

      if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
      if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      try {
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1;
        context.drawImage(video, sourceX, upperSourceY, sourceWidth, sourceHeight, 0, 0, canvasWidth, canvasHeight);

        if (!subtitleCoverLowerCanvasRef.current) subtitleCoverLowerCanvasRef.current = document.createElement('canvas');
        const lowerPatch = subtitleCoverLowerCanvasRef.current;
        if (lowerPatch.width !== canvasWidth) lowerPatch.width = canvasWidth;
        if (lowerPatch.height !== canvasHeight) lowerPatch.height = canvasHeight;
        const lowerContext = lowerPatch.getContext('2d');
        if (lowerContext) {
          lowerContext.drawImage(video, sourceX, lowerSourceY, sourceWidth, sourceHeight, 0, 0, canvasWidth, canvasHeight);
          lowerContext.globalCompositeOperation = 'destination-in';
          const blendGradient = lowerContext.createLinearGradient(0, 0, 0, canvasHeight);
          blendGradient.addColorStop(0, 'rgba(0,0,0,0)');
          blendGradient.addColorStop(1, 'rgba(0,0,0,1)');
          lowerContext.fillStyle = blendGradient;
          lowerContext.fillRect(0, 0, canvasWidth, canvasHeight);
          context.drawImage(lowerPatch, 0, 0);
        }
      } catch {
        // The CSS blur underneath remains as a safe fallback while video loads.
      }
    };

    const scheduleFrame = () => {
      drawSmartCover();
      if (!playing || stopped) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        videoFrameId = video.requestVideoFrameCallback(scheduleFrame);
      } else {
        animationId = window.requestAnimationFrame(scheduleFrame);
      }
    };

    video.addEventListener('loadeddata', drawSmartCover);
    video.addEventListener('seeked', drawSmartCover);
    video.addEventListener('timeupdate', drawSmartCover);
    scheduleFrame();

    return () => {
      stopped = true;
      video.removeEventListener('loadeddata', drawSmartCover);
      video.removeEventListener('seeked', drawSmartCover);
      video.removeEventListener('timeupdate', drawSmartCover);
      if (animationId) window.cancelAnimationFrame(animationId);
      if (videoFrameId && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(videoFrameId);
    };
  }, [
    config.subtitleCoverEnabled,
    config.subtitleCoverX,
    config.subtitleCoverY,
    config.subtitleCoverW,
    config.subtitleCoverH,
    playing,
    renderedMediaSrc,
  ]);

  useEffect(() => {
    if (!state.selectedRowId) return;
    const rowElement = document.querySelector(`[data-row-id="${state.selectedRowId}"]`);
    rowElement?.scrollIntoView({ block: 'nearest' });
  }, [state.selectedRowId]);

  useEffect(() => {
    if (activeModal !== 'newProject') return undefined;
    const timer = window.setTimeout(() => {
      newProjectNameInputRef.current?.focus();
      newProjectNameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeModal]);

  useEffect(() => {
    const handleUndoShortcut = (event) => {
      const activeTag = document.activeElement?.tagName;
      const isTextInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && !isTextInput) {
        event.preventDefault();
        undoRowsChange();
      }
    };
    window.addEventListener('keydown', handleUndoShortcut);
    return () => window.removeEventListener('keydown', handleUndoShortcut);
  }, [rows, state.selectedRowId, state.currentStage, state.currentTime, outputs]);

  const callApi = async (path, payload) => {
    addLog(`[API] POST ${path}`);
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortRef.current?.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      throw new Error(`Không kết nối được backend tại ${API_BASE}. Hãy kiểm tra app backend đã chạy chưa và port 3001 có bị chặn không.`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const detail = [data.message, data.detail, data.suggestion].filter(Boolean).join(' | ');
      const error = new Error(detail || data.error || `Request failed: ${path}`);
      error.data = data;
      throw error;
    }
    addLog(`[API] OK ${path}`);
    return data;
  };

  const openSkill = async (skillName) => {
    setSkillDoc({ loading: true, name: skillName, content: '', path: '', error: '' });
    setActiveModal('translationSkill');
    try {
      const response = await fetch(`${API_BASE}/api/skills/${skillName}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.detail || data.message || 'Cannot load skill.');
      }
      setSkillDoc({
        loading: false,
        name: String(data.name || skillName),
        content: String(data.content || ''),
        path: String(data.path || ''),
        error: '',
      });
    } catch (error) {
      playErrorSound();
      setSkillDoc({
        loading: false,
        name: skillName,
        content: '',
        path: '',
        error: error.message || 'Cannot load skill.',
      });
    }
  };

  const googleCloudConfig = () => {
    return ({
    apiKey: config.googleApiKey,
    projectId: config.googleProjectId,
    serviceAccountPath: config.googleApiKey ? '' : config.googleServiceAccountPath,
    credentialsMode: config.googleApiKey ? 'api_key' : (config.googleServiceAccountPath ? 'service_account' : 'backend_env'),
    googleSttLocation: config.googleSttLocation,
    groqApiKey: config.groqApiKey,
    groqApiKeys: groqKeysText(config),
    assemblyAiApiKey: config.assemblyAiApiKey,
    assemblyAiApiKeys: assemblyAiKeysText(config),
    assemblyAiPrompt: config.assemblyAiPrompt,
    assemblyAiKeyterms: config.assemblyAiKeyterms,
    assemblyAiProcessingMode: config.assemblyAiProcessingMode,
    assemblyAiChunkSeconds: Number(config.assemblyAiChunkSeconds ?? DEFAULT_STATE.config.assemblyAiChunkSeconds),
    assemblyAiOverlapSeconds: Number(config.assemblyAiOverlapSeconds ?? DEFAULT_STATE.config.assemblyAiOverlapSeconds),
    assemblyAiConcurrency: Number(config.assemblyAiConcurrency ?? DEFAULT_STATE.config.assemblyAiConcurrency),
    sttProvider: config.sttProvider,
    sttModel: config.sttModel,
    sttTimestampMode: config.sttTimestampMode,
    nlpSourceResegment: shouldUseSourceResegment(config),
    subtitleGroupSettingsVersion: 1,
    subtitleGroupEnabled: isSubtitleCueGroupingEnabled(config),
    subtitleGroupLanguage: config.subtitleGroupLanguage || DEFAULT_STATE.config.subtitleGroupLanguage,
    subtitleGroupBatchSize: Number(config.subtitleGroupBatchSize ?? DEFAULT_STATE.config.subtitleGroupBatchSize),
    subtitleGroupConcurrency: Number(config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.subtitleGroupConcurrency),
    subtitleGroupProvider: normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider),
    subtitleGroupModel: config.subtitleGroupModel || '',
    ocrSkipUnchanged: config.ocrSkipUnchanged !== false,
    ocrRequireCjk: config.ocrRequireCjk !== false,
    ocrChangeThreshold: Number(config.ocrChangeThreshold ?? DEFAULT_STATE.config.ocrChangeThreshold),
    ocrConcurrency: Number(config.ocrConcurrency ?? DEFAULT_STATE.config.ocrConcurrency),
    ocrMaxKeyframeGap: Number(config.ocrMaxKeyframeGap ?? DEFAULT_STATE.config.ocrMaxKeyframeGap),
    ocrKeyframeTimelineFps: Number(config.ocrKeyframeTimelineFps ?? DEFAULT_STATE.config.ocrKeyframeTimelineFps),
    enableWordTimestamps: config.sttProvider === 'assemblyai_speech_to_text' || ['word_timestamps', 'word_level'].includes(config.sttTimestampMode),
    sourceLanguage: config.sourceLanguage,
    translationProvider: config.translationProvider,
    translationMode: config.translationMode || DEFAULT_STATE.config.translationMode,
    cliTranslationModel: config.cliTranslationModel,
    cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
    targetLanguage: config.targetLanguage,
    userContext: config.videoContext,
    customGlossary: '',
    translationTargetTtsRate: normalizeTranslationTargetTtsRate(config.translationTargetTtsRate ?? DEFAULT_STATE.config.translationTargetTtsRate),
    translationTimingValidationMode: config.translationTimingValidationMode || DEFAULT_STATE.config.translationTimingValidationMode,
    translationTimingRewriteMaxPasses: Number(config.translationTimingRewriteMaxPasses ?? DEFAULT_STATE.config.translationTimingRewriteMaxPasses),
    normalizeTimelineBeforeTranslate: config.normalizeTimelineBeforeTranslate !== false,
    translationDisplayMode: ['source_timeline', 'meaning_timeline'].includes(config.translationDisplayMode)
      ? config.translationDisplayMode
      : DEFAULT_STATE.config.translationDisplayMode,
    storyContextTargetSeconds: 22,
    storyContextMaxSeconds: 30,
    storyHardBreakGapSeconds: 1.2,
    storyTargetMinSeconds: 4,
    storyTargetMaxSeconds: 8,
    storyAbsoluteMaxSegmentSeconds: 10,
    storyBoundaryMaxShiftSeconds: 0.35,
    storyVerifierEnabled: true,
    storyRepairMaxAttempts: 2,
    timelineMergeGapSeconds: Number(config.timelineMergeGapSeconds ?? DEFAULT_STATE.config.timelineMergeGapSeconds),
    timelineBreakGapSeconds: Number(config.timelineBreakGapSeconds ?? DEFAULT_STATE.config.timelineBreakGapSeconds),
    timelineMaxUnitDuration: Number(config.timelineMaxUnitDuration ?? DEFAULT_STATE.config.timelineMaxUnitDuration),
    timelineGuardSeconds: Number(config.timelineGuardSeconds ?? DEFAULT_STATE.config.timelineGuardSeconds),
    naturalDubTargetMinSeconds: Number(config.naturalDubTargetMinSeconds ?? DEFAULT_STATE.config.naturalDubTargetMinSeconds),
    naturalDubTargetMaxSeconds: Number(config.naturalDubTargetMaxSeconds ?? DEFAULT_STATE.config.naturalDubTargetMaxSeconds),
    maxMeaningUnitSourceRows: Number(config.maxMeaningUnitSourceRows ?? DEFAULT_STATE.config.maxMeaningUnitSourceRows),
    ttsProvider: config.ttsProvider,
    ttsUnitMode: config.ttsUnitMode || DEFAULT_STATE.config.ttsUnitMode,
    ttsLanguageCode: config.ttsLanguageCode,
    ttsVoiceName: selectedTtsVoiceName,
    voiceGenderFilter: config.voiceGenderFilter,
    ssmlGender: selectedGenderFilter(config) || 'NEUTRAL',
    aimaxApiKey: config.aimaxApiKey,
    aimaxBaseUrl: config.aimaxBaseUrl,
    aimaxProvider: config.aimaxProvider || DEFAULT_AIMAX_PROVIDER,
    aimaxModel: config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider),
    aimaxSrtBatchEnabled: config.aimaxSrtBatchEnabled === true,
    aimaxSrtBatchMode: normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode),
    aimaxSrtCuesPerRequest: normalizeConfiguredAimaxSrtCuesPerRequest(config.aimaxSrtCuesPerRequest ?? DEFAULT_STATE.config.aimaxSrtCuesPerRequest),
    aimaxSrtRequestCount: clampAimaxSrtRequestCount(config.aimaxSrtRequestCount ?? DEFAULT_STATE.config.aimaxSrtRequestCount),
    aimaxSrtBatchConcurrency: clampAimaxSrtBatchConcurrency(config.aimaxSrtBatchConcurrency ?? DEFAULT_STATE.config.aimaxSrtBatchConcurrency),
    speakingRate: normalizeSpeakingRate(config.speakingRate),
    minSpeakingRate: normalizeSpeakingRate(config.speakingRate),
    maxSpeakingRate: normalizeSpeakingRate(config.speakingRate),
    maxEffectiveSpeakingRate: normalizeSpeakingRate(config.speakingRate),
    ttsFitEnabled: config.ttsFitEnabled !== false,
    ttsFitMode: config.ttsFitMode || DEFAULT_STATE.config.ttsFitMode,
    ttsFitMaxRate: normalizeSpeakingRate(config.speakingRate),
    autoTtsRepairEnabled: config.autoTtsRepairEnabled === true,
    autoTtsRepairMaxPasses: Math.max(1, Math.min(3, Number(config.autoTtsRepairMaxPasses ?? DEFAULT_STATE.config.autoTtsRepairMaxPasses) || DEFAULT_STATE.config.autoTtsRepairMaxPasses)),
    autoTtsRepairMinOverflowSeconds: Number(config.autoTtsRepairMinOverflowSeconds ?? DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds),
    autoTtsRepairMaxRowsPerPass: Math.max(1, Math.min(50, Number(config.autoTtsRepairMaxRowsPerPass ?? DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass)),
    ttsTextCleanupMode: ['natural', 'fast', 'strict'].includes(config.ttsTextCleanupMode) ? config.ttsTextCleanupMode : DEFAULT_STATE.config.ttsTextCleanupMode,
    voiceAlignShortClips: false,
    voiceAlignMode: 'start',
    voiceAlignMinSlackSeconds: Number(config.voiceAlignMinSlackSeconds ?? DEFAULT_STATE.config.voiceAlignMinSlackSeconds),
    voiceAlignMaxShiftSeconds: normalizeVoiceAlignMaxShift(config.voiceAlignMaxShiftSeconds),
    ...(config.ttsProvider === 'aimax_tts' ? {} : { pitch: config.pitch }),
    syncMode: 'natural',
    addSilenceGaps: false,
    maxVoiceGapSeconds: 0.12,
    naturalPhraseSync: config.naturalPhraseSync === true,
    phraseLengthMode: config.phraseLengthMode || DEFAULT_STATE.config.phraseLengthMode,
    pauseStyle: config.pauseStyle || DEFAULT_STATE.config.pauseStyle,
    targetPhraseSeconds: Number(config.targetPhraseSeconds ?? DEFAULT_STATE.config.targetPhraseSeconds),
    maxPhraseSeconds: Number(config.maxPhraseSeconds ?? DEFAULT_STATE.config.maxPhraseSeconds),
    acceptOverflowSeconds: 0,
    retryOverflowSeconds: 0.35,
    hardTrimOverflow: false,
    speedUpLongSegments: true,
    ttsDurationControl: false,
    preserveTtsAudio: true,
    normalizeLoudness: false,
    audioSampleRate: 32000,
    ttsConcurrency: Number(config.ttsConcurrency ?? DEFAULT_STATE.config.ttsConcurrency),
    ttsMaxAttempts: Number(config.ttsMaxAttempts ?? DEFAULT_STATE.config.ttsMaxAttempts),
    });
  };

  const pushRowsUndo = () => {
    undoRowsRef.current = [{
      rows: rows.map((row) => ({ ...row, style: { ...(row.style || {}) } })),
      selectedRowId: state.selectedRowId,
      currentStage: state.currentStage,
      currentTime: state.currentTime,
      outputs: { ...outputs },
    }, ...undoRowsRef.current].slice(0, 50);
  };

  const undoRowsChange = () => {
    const snapshot = undoRowsRef.current.shift();
    if (!snapshot) {
      addLog('Không có thay đổi nội dung để hoàn tác.');
      return;
    }
    patchState({
      rows: snapshot.rows,
      selectedRowId: snapshot.selectedRowId,
      currentStage: snapshot.currentStage,
      currentTime: snapshot.currentTime,
      outputs: snapshot.outputs,
    });
    setEditingRowId('');
    setEditDraft('');
    addLog('Đã hoàn tác thay đổi nội dung.');
  };

  const confirmRerun = async (label, hasExisting, deletedItems) => {
    if (!hasExisting) return true;
    const confirmed = await showConfirm({
      title: `Chạy lại ${label}?`,
      subtitle: 'Nội dung cũ sẽ được thay thế',
      message: `Bạn đã chạy ${label} trước đó.\nChạy lại sẽ xóa ${deletedItems} cũ và tạo nội dung mới.`,
      confirmLabel: 'Xóa và chạy lại',
    });
    if (!confirmed) addLog(`Đã hủy chạy lại: ${label}`);
    return confirmed;
  };

  const unloadDubbedAudio = () => {
    setPlaying(false);
    if (!dubbedAudioRef.current) return;
    dubbedAudioRef.current.pause();
    dubbedAudioRef.current.removeAttribute('src');
    dubbedAudioRef.current.load();
  };

  const clearGeneratedState = (scope) => {
    unloadDubbedAudio();
    setState((previous) => {
      const nextOutputs = { ...previous.outputs };
      let nextRows = previous.rows;
      let nextMeaningUnits = previous.meaningUnits || [];
      let nextTtsUnits = previous.ttsUnits || [];
      let nextTtsRepairBasket = previous.ttsRepairBasket || [];
      let nextLogs = previous.logs || [];
      let nextSelectedRowId = previous.selectedRowId;
      let nextStage = previous.currentStage;
      let nextConfig = previous.config;

      if (scope === 'source') {
        nextRows = [];
        nextMeaningUnits = [];
        nextTtsUnits = [];
        nextTtsRepairBasket = [];
        nextSelectedRowId = '';
        nextStage = previous.job?.audioPath ? 'audio' : 'idle';
        Object.assign(nextOutputs, {
          srtPath: '',
          srtUrl: '',
          rawSrtPath: '',
          rawSrtUrl: '',
          wordLevelSrtPath: '',
          wordLevelSrtUrl: '',
          sourceSegmentedSrtPath: '',
          sourceSegmentedSrtUrl: '',
          sourceTemplateGroupJsonPath: '',
          sourceTemplateGroupJsonUrl: '',
          sourceTemplateGroupSrtPath: '',
          sourceTemplateGroupSrtUrl: '',
          sourceQcReportPath: '',
          sourceQcReportUrl: '',
          sourceCoverageReportPath: '',
          sourceCoverageReportUrl: '',
          translationQcReportPath: '',
          translationQcReportUrl: '',
          readabilityQcReportPath: '',
          readabilityQcReportUrl: '',
          ...CLEARED_TTS_OUTPUTS,
        });
        nextConfig = { ...previous.config, dubbedAudioEnabled: false };
      }

      if (scope === 'translation') {
        nextMeaningUnits = [];
        nextTtsUnits = [];
        nextTtsRepairBasket = [];
        nextRows = previous.rows.map((row) => ({
          ...row,
          translatedText: '',
          finalText: '',
          audioPath: '',
          status: 'pending',
          dirty: false,
        }));
        nextSelectedRowId = nextRows[0]?.id || '';
        nextStage = 'source';
        Object.assign(nextOutputs, {
          srtPath: previous.outputs.sourceSegmentedSrtPath || previous.outputs.rawSrtPath || '',
          srtUrl: previous.outputs.sourceSegmentedSrtUrl || previous.outputs.rawSrtUrl || '',
          sourceCoverageReportPath: '',
          sourceCoverageReportUrl: '',
          translationQcReportPath: '',
          translationQcReportUrl: '',
          readabilityQcReportPath: '',
          readabilityQcReportUrl: '',
          ...CLEARED_TTS_OUTPUTS,
        });
        nextTtsRepairBasket = [];
        nextConfig = { ...previous.config, dubbedAudioEnabled: false };
      }

      if (scope === 'voice') {
        nextRows = previous.rows.map((row) => ({
          ...stripTtsRuntimeFromRow(row),
          audioPath: '',
          status: row.status === 'voiced' ? 'translated' : row.status,
        }));
        nextTtsRepairBasket = [];
        nextLogs = removeTtsRuntimeLogs(nextLogs);
        nextStage = previous.currentStage === 'voice' || previous.currentStage === 'video' ? 'final' : previous.currentStage;
        Object.assign(nextOutputs, {
          ...CLEARED_TTS_OUTPUTS,
        });
        nextConfig = { ...previous.config, dubbedAudioEnabled: false };
      }

      if (scope === 'video') {
        Object.assign(nextOutputs, {
          videoPath: '',
          videoUrl: '',
          ttsReport: null,
          ttsFitPlan: null,
        });
      }

      return {
        ...previous,
        rows: nextRows,
        meaningUnits: nextMeaningUnits,
        ttsUnits: nextTtsUnits,
        ttsRepairBasket: nextTtsRepairBasket,
        logs: nextLogs,
        selectedRowId: nextSelectedRowId,
        currentStage: nextStage,
        outputs: nextOutputs,
        config: nextConfig,
      };
    });
  };

  const notifyTaskAlreadyRunning = (nextLabel = '') => {
    const runningLabel = currentTask?.label || 'tác vụ hiện tại';
    const message = `Đang chạy: ${runningLabel}. Vui lòng chờ xong rồi mới chạy${nextLabel ? ` ${nextLabel}` : ''}. Nếu muốn hủy tác vụ hiện tại, bấm Dừng ở bảng tiến trình.`;
    playErrorSound();
    addLog(message);
    showAlert('Đang có tác vụ chạy', message);
  };

  const runTask = async (label, task) => {
    if (state.busy || currentTask?.active || abortRef.current) {
      const message = 'Đang có tác vụ đang chạy, vui lòng đợi xong rồi mới chạy tiếp.';
      notifyTaskAlreadyRunning(label);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    primeTaskDoneSound();
    setCurrentTask({ active: true, label, startedAt: Date.now() });
    setBusy(true, `Bắt đầu: ${label}`);
    try {
      await task();
      addLog(`Xong: ${label}`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        addLog(`Đã dừng: ${label}`);
        return;
      }
      const errorMessage = error.message || 'Unknown error';
      if (errorMessage.includes('already running')) {
        const message = 'Backend đang xử lý tác vụ khác cho job này. Vui lòng chờ tác vụ hiện tại xong rồi chạy lại.';
        playErrorSound();
        addLog(message);
        showAlert('Đang có tác vụ chạy', message);
        return;
      }
      if (errorMessage.includes('TTS is already running') || errorMessage.includes('already running TTS generation')) {
        addLog('TTS đang chạy nên app không gửi lệnh trùng. Bấm Hủy, đợi backend dừng xong rồi chạy lại từ đầu.');
        return;
      }
      playErrorSound();
      setState((previous) => ({
        ...previous,
        error: errorMessage || 'Có lỗi xảy ra.',
        logs: [`[${logTime()}] Lỗi: ${errorMessage}`, ...(Array.isArray(previous.logs) ? previous.logs : [])].slice(0, 500),
      }));
    } finally {
      playTaskDoneSound();
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setCurrentTask(null);
    }
  };

  const startModalTask = (action) => {
    if (state.busy || currentTask?.active || abortRef.current) {
      notifyTaskAlreadyRunning();
      return;
    }
    setActiveModal(null);
    action();
  };

  const stopCurrentTask = async () => {
    if (!abortRef.current) {
      addLog('Không có tác vụ đang chạy để dừng.');
      return;
    }
    const runningJobId = job.jobId;
    if (runningJobId) {
      try {
        await fetch(`${API_BASE}/api/manual/cancel-operation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: runningJobId }),
        });
      } catch {
        addLog('Không gọi được backend cancel, sẽ ngắt UI trước.');
      }
    }
    abortRef.current.abort();
    addLog('Đã gửi lệnh dừng. Nếu muốn chạy lại, app sẽ xóa output cũ và tạo lại từ đầu.');
  };

  const loadPickedVideo = async (videoPath, fileName = '') => {
    if (!videoPath) return;
    patchState({
      source: { mode: 'local', videoPath, videoUrl: '', title: fileName || fileNameFromPath(videoPath) },
      outputs: { ...outputs, videoUrl: '', videoPath: '', audioUrl: '', audioPath: '' },
      rows: [],
      selectedRowId: '',
      currentStage: 'idle',
      currentTime: 0,
    });
    addLog('⏳ Đang tạo preview video...');
    const data = await callApi('/api/manual/prepare-source', {
      sourceType: 'local',
      videoPath,
      videoUrl: '',
    });
    patchState({
      source: { mode: 'local', videoPath, videoUrl: '', title: fileName || fileNameFromPath(videoPath) },
      job: {
        ...job,
        ...data,
        sourceVideoUrl: data.sourceVideoUrl || data.videoUrl || '',
        previewVideoUrl: data.previewVideoUrl || data.sourceVideoUrl || data.videoUrl || '',
        audioUrl: data.audioUrl || '',
        audioPath: data.audioPath || '',
        durationSeconds: data.durationSeconds || 0,
      },
      outputs: { ...outputs, videoUrl: '', videoPath: '', audioUrl: '', audioPath: '' },
      currentStage: 'source_ready',
      currentTime: 0,
    });
  };

  const pickVideo = () => runTask('chọn video', async () => {
    const desktopPicker = getDesktopPicker();
    const data = desktopPicker?.pickVideo
      ? await desktopPicker.pickVideo()
      : await callApi('/api/pick-video', {});
    if (data.cancelled) {
      addLog('Đã hủy chọn video.');
      return;
    }
    await loadPickedVideo(data.videoPath || '', data.fileName || fileNameFromPath(data.videoPath));
  });

  const patchOutputFolderConfig = (patch) => {
    const nextConfig = { ...config, ...patch };
    patchConfig(patch);
    if (typeof window !== 'undefined') {
      safeLocalStorageSet(SETTINGS_STORAGE_KEY, JSON.stringify(savedSettingsFromConfig(nextConfig)));
    }
  };

  const pickOutputFolder = () => runTask('chọn nơi lưu', async () => {
    const desktopPicker = getDesktopPicker();
    const data = desktopPicker?.pickOutputFolder
      ? await desktopPicker.pickOutputFolder()
      : await callApi('/api/pick-output-folder', {});
    if (data.cancelled) {
      addLog('Đã hủy chọn nơi lưu.');
      return;
    }
    if (!data.folderPath) throw new Error('Không nhận được đường dẫn folder.');
    patchOutputFolderConfig({ outputDirectory: data.folderPath, outputCreateFolder: false, outputFolderName: '' });
    addLog(`Đã chọn nơi lưu: ${data.folderPath}`);
  });

  const clearOutputFolder = () => {
    patchOutputFolderConfig({ outputDirectory: '', outputCreateFolder: true, outputFolderName: '' });
    addLog('Đã đặt nơi lưu về thư mục job hiện tại.');
  };

  const pickMusicFile = () => runTask('chọn nhạc nền', async () => {
    const desktopPicker = getDesktopPicker();
    const data = desktopPicker?.pickAudio
      ? await desktopPicker.pickAudio()
      : await callApi('/api/pick-audio', {});
    if (data.cancelled) {
      addLog('Đã hủy chọn nhạc nền.');
      return;
    }
    const filePath = data.filePath || data.audioPath || '';
    if (!filePath) throw new Error('Không nhận được đường dẫn nhạc nền.');
    patchConfig({ musicPath: filePath, musicEnabled: true });
    addLog(`Đã chọn nhạc nền: ${filePath}`);
  });

  const pickLogoFile = () => runTask('chọn logo', async () => {
    const desktopPicker = getDesktopPicker();
    const data = desktopPicker?.pickLogo
      ? await desktopPicker.pickLogo()
      : await callApi('/api/pick-logo', {});
    if (data.cancelled) {
      addLog('Đã hủy chọn logo.');
      return;
    }
    const filePath = data.filePath || data.logoPath || '';
    if (!filePath) throw new Error('Không nhận được đường dẫn logo.');
    patchConfig({ logoPath: filePath, logoEnabled: true, logoPosition: 'custom' });
    addLog(`Đã chọn logo: ${filePath}`);
  });

  const loadYoutubeVideo = (videoUrl) => runTask('thêm YouTube', async () => {
    const url = String(videoUrl || '').trim();
    if (!url) throw new Error('Nhập YouTube URL trước.');
    patchState({
      source: { mode: 'youtube', videoPath: '', videoUrl: url, title: url },
      outputs: { ...outputs, videoUrl: '', videoPath: '', audioUrl: '', audioPath: '' },
      rows: [],
      selectedRowId: '',
      currentStage: 'idle',
      currentTime: 0,
    });
    const data = await callApi('/api/manual/prepare-source', {
      sourceType: 'youtube',
      videoPath: '',
      videoUrl: url,
    });
    patchState({
      source: { mode: 'youtube', videoPath: '', videoUrl: url, title: data.title || url },
      job: {
        ...job,
        ...data,
        sourceVideoUrl: data.sourceVideoUrl || data.videoUrl || '',
        previewVideoUrl: data.previewVideoUrl || data.sourceVideoUrl || data.videoUrl || '',
        durationSeconds: data.durationSeconds || 0,
      },
      outputs: { ...outputs, videoUrl: '', videoPath: '', audioUrl: '', audioPath: '' },
      currentStage: 'source_ready',
      currentTime: 0,
    });
  });

  const handleDroppedFiles = (fileList) => {
    const files = Array.from(fileList || []);
    const video = files.find((file) => file.type.startsWith('video/')) || files[0];
    if (!video) return;
    const browserUrl = URL.createObjectURL(video);
    const realPath = video.path || '';
    patchState({
      source: {
        mode: 'local',
        videoPath: realPath,
        videoUrl: '',
        title: video.name,
      },
      job: {
        ...job,
        previewVideoUrl: '',
        sourceVideoUrl: '',
        durationSeconds: 0,
      },
      outputs: { ...outputs, videoUrl: browserUrl },
    });
    addLog(realPath
      ? `💾 Đã nạp file kéo thả: ${video.name}`
      : `💾 Đã nạp preview kéo thả: ${video.name}. Nếu chạy backend, hãy nhập đường dẫn local hoặc dùng nút Thêm.`);
  };

  const importSrtText = (text, type, fileName = '') => {
    const segments = parseSrtText(text);
    if (!segments.length) throw new Error('File SRT không đọc được timeline/nội dung.');
    pushRowsUndo();
    const field = type === 'source' ? 'sourceText' : type === 'translated' ? 'translatedText' : 'finalText';
    const stage = type === 'source' ? 'source' : type === 'translated' ? 'translated' : 'final';
    const makeRow = (segment, index) => ({
      id: segment.id,
      index: index + 1,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      sourceText: type === 'source' ? segment.text : '',
      translatedText: type === 'translated' || type === 'final' ? segment.text : '',
      finalText: type === 'final' || type === 'translated' ? segment.text : '',
      audioPath: '',
      status: type === 'source' ? 'pending' : 'translated',
      dirty: true,
      errorMsg: '',
      style: {},
    });
    const nextRows = type === 'source' || !rows.length
      ? segments.map(makeRow)
      : Array.from({ length: Math.max(rows.length, segments.length) }, (_, index) => {
        const row = rows[index];
        const segment = segments[index];
        if (!segment && row) return row;
        if (!row && segment) return makeRow(segment, index);
        const patch = {
          start: segment.start,
          end: segment.end,
          duration: segment.duration,
          [field]: segment.text,
          dirty: true,
        };
        if (type === 'translated') patch.finalText = segment.text;
        if (type === 'final') patch.translatedText = segment.text;
        return { ...row, ...patch };
      });
    patchState({
      rows: ensureUniqueRowIds(nextRows.map((row, index) => ({ ...row, index: index + 1 }))),
      selectedRowId: nextRows[0]?.id || '',
      currentStage: stage,
      outputs: { ...outputs, srtPath: '', srtUrl: '', rawSrtPath: '', rawSrtUrl: '', wordLevelSrtPath: '', wordLevelSrtUrl: '', sourceSegmentedSrtPath: '', sourceSegmentedSrtUrl: '' },
    });
    addLog(`Đã thêm ${SRT_IMPORT_TYPES.find((item) => item.value === type)?.label || 'SRT'}${fileName ? `: ${fileName}` : ''}.`);
  };

  const handleSrtFile = async (file, type = srtImportType) => {
    if (!file) return;
    try {
      importSrtText(await file.text(), type, file.name);
      setActiveModal(null);
    } catch (error) {
      playErrorSound();
      addLog(`Lỗi thêm SRT: ${error.message || 'không đọc được file'}`);
      showAlert('Không thể thêm SRT', error.message || 'Không đọc được file SRT.');
    }
  };

  const envFileInputRef = useRef(null);

  const exportEnvConfig = () => {
    try {
      const exportPayload = {
        app: 'DubFlow Studio',
        dubflow_config_version: '1.0',
        exported_at: new Date().toISOString(),
        config: config || {},
      };
      const jsonString = JSON.stringify(exportPayload, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const dateStr = new Date().toISOString().slice(0, 10);
      link.download = `dubflow-config-env-${dateStr}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(jsonString).catch(() => {});
      }

      addLog('💾 Đã trích xuất toàn bộ cấu hình môi trường & API Keys ra file JSON.');
      showAlert('Trích xuất thành công', `Đã xuất toàn bộ biến môi trường & API Keys ra file dubflow-config-env-${dateStr}.json và sao chép vào bộ nhớ tạm!`);
    } catch (err) {
      playErrorSound();
      showAlert('Lỗi trích xuất', `Không thể xuất file cấu hình: ${err.message}`);
    }
  };

  const handleImportEnvConfigFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result;
        if (typeof content !== 'string') return;
        const parsed = JSON.parse(content);
        const importedConfig = parsed.config || parsed;

        if (typeof importedConfig !== 'object' || importedConfig === null) {
          throw new Error('Cấu trúc file JSON không hợp lệ.');
        }

        const nextConfig = { ...config, ...importedConfig };
        patchConfig(importedConfig);
        if (typeof window !== 'undefined') {
          safeLocalStorageSet(SETTINGS_STORAGE_KEY, JSON.stringify(savedSettingsFromConfig(nextConfig)));
        }

        addLog('✅ Đã nạp thành công toàn bộ biến môi trường, API keys và cấu hình ứng dụng!');
        showAlert('Nhập cấu hình thành công', 'Đã nạp toàn bộ biến môi trường, API keys và cấu hình từ file JSON!');
      } catch (err) {
        playErrorSound();
        showAlert('Lỗi nhập cấu hình', `File JSON không hợp lệ: ${err.message}`);
      } finally {
        if (event.target) event.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const saveProject = () => {
    if (typeof window !== 'undefined') safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
    addLog('💾 Đã lưu dự án.');
  };

  const saveCurrentProjectSnapshot = () => {
    const snapshot = createProjectSnapshot({
      ...state,
      projectName: String(state.projectName || '').trim() || source.title || fileNameFromPath(source.videoPath) || 'New project',
      config: { ...state.config, speakingRate: normalizeSpeakingRate(state.config?.speakingRate) },
    });
    const currentProjects = typeof window !== 'undefined'
      ? normalizeProjects(safeJsonParse(window.localStorage.getItem(PROJECTS_STORAGE_KEY), []))
      : projects;
    const nextProjects = mergeProjectSnapshot(currentProjects, snapshot);
    setProjects(nextProjects);
    if (typeof window !== 'undefined') {
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(snapshot.state));
      safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    }
    return snapshot;
  };

  const resetProject = () => {
    const nextState = applyGlobalSettingsToState(DEFAULT_STATE, true);
    setState(nextState);
    if (typeof window !== 'undefined') safeLocalStorageSet(STORAGE_KEY, JSON.stringify(nextState));
  };

  const saveProjectWithHistory = () => {
    const snapshot = saveCurrentProjectSnapshot();
    patchState({ projectId: snapshot.id, projectName: snapshot.name, config: snapshot.state.config });
    addLog('Đã lưu dự án.');
  };

  const deleteProjectById = async (projectId) => {
    if (!projectId) return;
    setHistoryOpen(false);
    const project = projects.find((item) => item.id === projectId);
    const isCurrentProject = projectId === state.projectId;
    const projectName = project?.name || (isCurrentProject ? state.projectName : '') || 'project';
    const projectJobId = project?.state?.job?.jobId || (isCurrentProject ? state.job?.jobId : '');
    const confirmed = await showConfirm({
      title: 'Xóa vĩnh viễn project?',
      subtitle: projectName,
      message: `Bạn đang xóa project: ${projectName}.\nHãy chắc chắn vì thao tác này không thể hoàn tác trong app.`,
      items: [
        'Mục project trong History',
        'Dữ liệu frontend/localStorage của project',
        projectJobId ? `Thư mục Backend/jobs/${projectJobId}` : '',
        projectJobId ? `Thư mục Backend/downloads/${projectJobId}` : '',
      ],
      confirmLabel: 'Xóa vĩnh viễn',
      tone: 'red',
    });
    if (!confirmed) return;

    const deletedRefs = rememberDeletedProject(projectId, projectJobId);

    if (projectJobId) {
      try {
        await callApi('/api/manual/delete-project-job', { jobId: projectJobId });
      } catch (error) {
        addLog(`Không xóa được folder job ${projectJobId}: ${error.message || 'lỗi không xác định'}. Project vẫn được ẩn khỏi History.`);
      }
    }

    const nextProjects = filterDeletedProjects(projects.filter((project) => project.id !== projectId), deletedRefs);
    setProjects(nextProjects);
    setHistoryOpen(false);
    if (typeof window !== 'undefined') {
      safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    }

    if (isCurrentProject) {
      const nextState = nextProjects[0]?.state ? applyGlobalSettingsToState(nextProjects[0].state) : applyGlobalSettingsToState({
        ...DEFAULT_STATE,
        projectId: `project-${Date.now()}`,
        projectName: 'New project',
        config,
        logs: [],
      }, true);

      setState(nextState);
      setVideoSourceIndex(0);
      if (typeof window !== 'undefined') safeLocalStorageSet(STORAGE_KEY, JSON.stringify(nextState));
    }
    addLog('Đã xóa dự án và dữ liệu job liên quan.');
  };

  const deleteCurrentProject = async () => {
    await deleteProjectById(state.projectId);
  };
  const saveGlobalSettings = () => {
    const settings = savedSettingsFromConfig(config);
    if (typeof window !== 'undefined') {
      safeLocalStorageSet(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
    patchConfig(settings);
    setSettingsSavedAt(logTime());
    addLog('Đã lưu cấu hình provider/API/voice.');
  };

  const SettingsSaveStatus = () => settingsSavedAt ? (
    <span className="rounded-[5px] border border-emerald-400/35 bg-emerald-400/10 px-2.5 py-1 text-xs font-bold text-emerald-200">
      Đã lưu lúc {settingsSavedAt}
    </span>
  ) : null;

  const openNewProjectModal = () => {
    setNewProjectNameDraft('');
    setActiveModal('newProject');
  };

  const createNewProject = () => {
    saveCurrentProjectSnapshot();
    const name = String(newProjectNameDraft || '').trim() || 'New project';
    const nextState = {
      ...DEFAULT_STATE,
      projectId: `project-${Date.now()}`,
      projectName: name,
      logs: [],
      config: mergeSettingsDefaults(DEFAULT_STATE.config, readSavedSettings(), true),
    };
    const snapshot = createProjectSnapshot(nextState);
    setState(snapshot.state);
    const currentProjects = typeof window !== 'undefined'
      ? normalizeProjects(safeJsonParse(window.localStorage.getItem(PROJECTS_STORAGE_KEY), []))
      : projects;
    const nextProjects = mergeProjectSnapshot(currentProjects, snapshot);
    setProjects(nextProjects);
    if (typeof window !== 'undefined') {
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(snapshot.state));
      safeLocalStorageSet(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    }
    setVideoSourceIndex(0);
    setActiveModal(null);
    addLog('Đã tạo project mới.');
  };

  const loadProject = (projectId) => {
    saveCurrentProjectSnapshot();
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    setState(applyGlobalSettingsToState(project.state));
    setVideoSourceIndex(0);
    addLog(`Đã mở project: ${project.name}`);
  };

  const clearRows = () => runTask('don timeline', async () => {
    if (config.sttProvider === 'assemblyai_speech_to_text' && !String(assemblyAiKeysText(config) || '').trim()) {
      throw new Error('Nhập ít nhất một khóa API AssemblyAI trong cửa sổ Tạo phụ đề gốc trước khi chạy AssemblyAI.');
    }
    clearGeneratedState('source');
    if (job.jobId) {
      await callApi('/api/manual/clear-artifacts', {
        jobId: job.jobId,
        scope: 'source',
      });
    }
    addLog('Đã dọn timeline.');
  });

  const deleteVideo = () => {
    patchState({
      source: DEFAULT_STATE.source,
      job: DEFAULT_STATE.job,
      rows: [],
      selectedRowId: '',
      outputs: DEFAULT_STATE.outputs,
      currentStage: 'idle',
    });
    addLog('Đã xóa video khỏi phiên làm việc.');
  };

  const extractAudio = async () => {
    if (source.mode === 'local' && !source.videoPath) throw new Error('Chọn video local trước.');
    if (source.mode === 'youtube' && !source.videoUrl) throw new Error('Nhập URL YouTube trước.');
    const data = await callApi('/api/manual/extract-audio', {
      jobId: job.jobId,
      sourceType: source.mode,
      videoPath: source.videoPath,
      videoUrl: source.videoUrl,
    });
    patchState({
      job: {
        ...job,
        ...data,
        sourceVideoUrl: data.sourceVideoUrl || data.videoUrl || job.sourceVideoUrl || '',
        previewVideoUrl: data.previewVideoUrl || data.sourceVideoUrl || data.videoUrl || job.previewVideoUrl || job.sourceVideoUrl || '',
        audioUrl: data.audioUrl || '',
        audioPath: data.audioPath || '',
        durationSeconds: data.durationSeconds || 0,
      },
      currentStage: 'audio',
    });
    return data;
  };

  const generateSourceSubtitle = async () => {
    const hasExisting = rows.some((row) => String(row.sourceText || '').trim())
      || Boolean(outputs.rawSrtPath || outputs.rawSrtUrl || outputs.wordLevelSrtPath || outputs.wordLevelSrtUrl || outputs.sourceSegmentedSrtPath || outputs.sourceSegmentedSrtUrl);
    if (!(await confirmRerun('phụ đề gốc', hasExisting, 'phụ đề gốc'))) return false;
    return runTask('tạo phụ đề gốc', async () => {
    let jobId = job.jobId;
    if (!job.audioPath) {
      const extracted = await extractAudio();
      jobId = extracted.jobId;
    }
    if (config.sttProvider === 'groq_speech_to_text' && !String(groqKeysText(config) || '').trim()) {
      throw new Error('Nhập ít nhất một khóa API Groq trong cửa sổ Tạo phụ đề gốc trước khi chạy Groq Whisper.');
    }
    clearGeneratedState('source');
    const data = await callApi('/api/manual/stt', {
      jobId,
      sourceLanguage: config.sourceLanguage,
      sttProvider: config.sttProvider,
      sttModel: config.sttModel,
      sttTimestampMode: config.sttTimestampMode,
      nlpSourceResegment: shouldUseSourceResegment(config),
      userHint: '',
      googleCloudConfig: googleCloudConfig(),
    });
    let sourceData = data;
    if (isSubtitleCueGroupingEnabled(config)) {
      addLog('AI gộp cụm ý: đang tạo template group từ STT thô.');
      const grouped = await callApi('/api/manual/subtitle-template-groups', {
        jobId,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        subtitleGroupLanguage: effectiveSubtitleGroupLanguage(config),
        subtitleGroupBatchSize: Number(config.subtitleGroupBatchSize ?? DEFAULT_STATE.config.subtitleGroupBatchSize),
        subtitleGroupConcurrency: Number(config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.subtitleGroupConcurrency),
        cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
        translationProvider: config.translationProvider,
        cliTranslationModel: config.cliTranslationModel,
        subtitleGroupProvider: normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider),
        subtitleGroupModel: config.subtitleGroupModel || '',
        segments: data.segments || [],
        googleCloudConfig: googleCloudConfig(),
      });
      sourceData = {
        ...data,
        ...grouped,
        segments: grouped.segments || data.segments || [],
        sourceSegmentedSrtPath: grouped.sourceTemplateGroupSrtPath || data.sourceSegmentedSrtPath || data.srtPath || '',
        sourceSegmentedSrtUrl: grouped.sourceTemplateGroupSrtUrl || data.sourceSegmentedSrtUrl || data.srtUrl || '',
        sourceTemplateGroupJsonPath: grouped.sourceTemplateGroupJsonPath || '',
        sourceTemplateGroupJsonUrl: grouped.sourceTemplateGroupJsonUrl || '',
        sourceTemplateGroupSrtPath: grouped.sourceTemplateGroupSrtPath || '',
        sourceTemplateGroupSrtUrl: grouped.sourceTemplateGroupSrtUrl || '',
      };
      addLog(`AI gộp cụm ý: ${grouped.sourceCount || data.count || 0} cue -> ${grouped.count || 0} group.`);
      if (Array.isArray(grouped.warnings) && grouped.warnings.length) {
        addLog(`AI gộp cụm ý cần xem lại: ${grouped.warnings.join('; ')}`);
      }
    }
    const rows = mapSourceRows(sourceData.segments || []);
    patchState({
      rows,
      selectedRowId: rows[0]?.id || '',
      currentStage: 'source',
      outputs: {
        ...outputs,
        srtPath: sourceData.srtPath || '',
        srtUrl: sourceData.srtUrl || '',
        rawSrtPath: data.rawSrtPath || '',
        rawSrtUrl: data.rawSrtUrl || '',
        wordLevelSrtPath: data.wordLevelSrtPath || '',
        wordLevelSrtUrl: data.wordLevelSrtUrl || '',
        sourceSegmentedSrtPath: sourceData.sourceSegmentedSrtPath || sourceData.srtPath || '',
        sourceSegmentedSrtUrl: sourceData.sourceSegmentedSrtUrl || sourceData.srtUrl || '',
        sourceTemplateGroupJsonPath: sourceData.sourceTemplateGroupJsonPath || '',
        sourceTemplateGroupJsonUrl: sourceData.sourceTemplateGroupJsonUrl || '',
        sourceTemplateGroupSrtPath: sourceData.sourceTemplateGroupSrtPath || '',
        sourceTemplateGroupSrtUrl: sourceData.sourceTemplateGroupSrtUrl || '',
        sourceQcReportPath: data.sourceQcReportPath || '',
        sourceQcReportUrl: data.sourceQcReportUrl || '',
        audioPath: '',
        audioUrl: '',
        videoPath: '',
        videoUrl: '',
      },
    });
    if (data.rawCount && data.count) {
      addLog(`Phụ đề gốc: ${data.rawCount} đoạn thô, ${data.wordLevelCount || 0} mốc từng từ, ${data.count} đoạn cuối, kiểu mốc ${data.sttTimestampMode || config.sttTimestampMode}, chia lại ${data.nlpSourceResegment === false ? 'tắt' : 'bật'}.`);
      if ((data.sttTimestampMode || config.sttTimestampMode) === 'word_level' && !data.wordLevelCount) {
        addLog('Provider không trả word timestamps, đã fallback về Word timestamps.');
      }
    }
    if (isSubtitleCueGroupingEnabled(config)) {
      setSubtitleToolTab('translate');
      setActiveModal('subtitleTools');
    }
    });
  };

  const generateBurnedSubtitleKeyframeOcr = async () => {
    const hasExisting = rows.some((row) => String(row.sourceText || '').trim())
      || Boolean(outputs.sourceSegmentedSrtPath || outputs.sourceSegmentedSrtUrl || outputs.srtPath || outputs.srtUrl);
    if (!(await confirmRerun('OCR phụ đề cháy', hasExisting, 'phụ đề OCR'))) return false;
    return runTask('OCR keyframe phụ đề cháy', async () => {
      let jobId = job.jobId;
      if (!jobId) {
        if (source.mode === 'local' && !source.videoPath) throw new Error('Chọn video local trước.');
        if (source.mode === 'youtube' && !source.videoUrl) throw new Error('Nhập URL YouTube trước.');
        const prepared = await callApi('/api/manual/prepare-source', {
          sourceType: source.mode,
          videoPath: source.videoPath,
          videoUrl: source.videoUrl,
        });
        jobId = prepared.jobId;
        patchState({
          job: {
            ...job,
            ...prepared,
            sourceVideoUrl: prepared.sourceVideoUrl || prepared.videoUrl || '',
            previewVideoUrl: prepared.previewVideoUrl || prepared.sourceVideoUrl || prepared.videoUrl || '',
            durationSeconds: prepared.durationSeconds || 0,
          },
          currentStage: 'source_ready',
        });
      }

      const keyframeProvider = 'rapidocr';

      clearGeneratedState('source');
      const data = await callApi('/api/manual/ocr-burned-subtitles-keyframe', {
        jobId,
        provider: keyframeProvider,
        ocrKeyframeProvider: keyframeProvider,
        sourceLanguage: config.sourceLanguage,
        timelineFps: Number(config.ocrKeyframeTimelineFps ?? 30) || 30,
        crop: {
          x: Number(config.ocrCropX ?? 0) || 0,
          y: Number(config.ocrCropY ?? 0.72) || 0.72,
          w: Number(config.ocrCropW ?? 1) || 1,
          h: Number(config.ocrCropH ?? 0.24) || 0.24,
        },
        languageHints: String(config.ocrLanguageHints || 'zh,zh-Hans').split(',').map((item) => item.trim()).filter(Boolean),
        ocrMergeSimilarity: Number(config.ocrMergeSimilarity ?? 0.86),
        ocrMaxEmptyGap: Number(config.ocrMaxEmptyGap ?? 0.35),
        ocrMinDuration: Number(config.ocrMinDuration ?? 0.12),
        ocrRequireCjk: config.ocrRequireCjk !== false,
        ocrConcurrency: Number(config.ocrConcurrency ?? 8),
        ocrKeyframeBoundaryRefineWindow: Number(config.ocrKeyframeBoundaryRefineWindow ?? 0.16),
        googleCloudConfig: googleCloudConfig(),
      });
      const nextRows = mapSourceRows(data.segments || []);
      patchState({
        rows: nextRows,
        selectedRowId: nextRows[0]?.id || '',
        currentStage: 'source',
        outputs: {
          ...outputs,
          srtPath: data.srtPath || '',
          srtUrl: data.srtUrl || '',
          rawSrtPath: '',
          rawSrtUrl: '',
          wordLevelSrtPath: '',
          wordLevelSrtUrl: '',
          sourceSegmentedSrtPath: data.sourceSegmentedSrtPath || data.srtPath || '',
          sourceSegmentedSrtUrl: data.sourceSegmentedSrtUrl || data.srtUrl || '',
          sourceQcReportPath: data.sourceQcReportPath || '',
          sourceQcReportUrl: data.sourceQcReportUrl || '',
          audioPath: '',
          audioUrl: '',
          videoPath: '',
          videoUrl: '',
        },
      });
      const ocrTiming = data.scanSeconds || data.ocrSeconds
        ? ` Scan ${data.scanSeconds || 0}s, OCR ${data.ocrSeconds || 0}s (${data.ocrWorkers || 1} workers).`
        : '';
      addLog(`OCR keyframe: ${data.count || nextRows.length} cues, local ${data.localFramesScanned || data.framesScanned || 0} frames @ ${data.timelineFps || config.ocrKeyframeTimelineFps || 30} fps, RapidOCR ${data.ocrRequests || data.rapidOcrRequests || 0} requests, ${data.elapsedSeconds ? `${data.elapsedSeconds}s` : 'done'}.${ocrTiming}`);
    });
  };

  const testBurnedSubtitleOcrCrop = () => runTask('test OCR crop', async () => {
    let jobId = job.jobId;
    if (!jobId) {
      if (source.mode === 'local' && !source.videoPath) throw new Error('Chọn video local trước.');
      if (source.mode === 'youtube' && !source.videoUrl) throw new Error('Nhập URL YouTube trước.');
      const prepared = await callApi('/api/manual/prepare-source', {
        sourceType: source.mode,
        videoPath: source.videoPath,
        videoUrl: source.videoUrl,
      });
      jobId = prepared.jobId;
      patchState({
        job: {
          ...job,
          ...prepared,
          sourceVideoUrl: prepared.sourceVideoUrl || prepared.videoUrl || '',
          previewVideoUrl: prepared.previewVideoUrl || prepared.sourceVideoUrl || prepared.videoUrl || '',
          durationSeconds: prepared.durationSeconds || 0,
        },
        currentStage: 'source_ready',
      });
    }

    const ocrProvider = 'rapidocr';

    const time = Number(mediaRef.current?.currentTime ?? state.currentTime ?? 0) || 0;
    const data = await callApi('/api/manual/ocr-test-frame', {
      jobId,
      provider: ocrProvider,
      sourceLanguage: config.sourceLanguage,
      time,
      crop: {
        x: Number(config.ocrCropX ?? 0) || 0,
        y: Number(config.ocrCropY ?? 0.72) || 0.72,
        w: Number(config.ocrCropW ?? 1) || 1,
        h: Number(config.ocrCropH ?? 0.24) || 0.24,
      },
      languageHints: String(config.ocrLanguageHints || 'zh,zh-Hans').split(',').map((item) => item.trim()).filter(Boolean),
      googleCloudConfig: googleCloudConfig(),
    });
    setOcrTestResult(data);
    addLog(`Test crop OCR ${formatClock(time)}: ${data.textOneLine || '(không thấy chữ)'}`);
  });

  const loadOcrFramePicker = () => runTask('lấy frame crop picker', async () => {
    let jobId = job.jobId;
    if (!jobId) {
      if (source.mode === 'local' && !source.videoPath) throw new Error('Chọn video local trước.');
      if (source.mode === 'youtube' && !source.videoUrl) throw new Error('Nhập URL YouTube trước.');
      const prepared = await callApi('/api/manual/prepare-source', {
        sourceType: source.mode,
        videoPath: source.videoPath,
        videoUrl: source.videoUrl,
      });
      jobId = prepared.jobId;
      patchState({
        job: {
          ...job,
          ...prepared,
          sourceVideoUrl: prepared.sourceVideoUrl || prepared.videoUrl || '',
          previewVideoUrl: prepared.previewVideoUrl || prepared.sourceVideoUrl || prepared.videoUrl || '',
          durationSeconds: prepared.durationSeconds || 0,
        },
        currentStage: 'source_ready',
      });
    }

    const time = Number(mediaRef.current?.currentTime ?? state.currentTime ?? 0) || 0;
    const data = await callApi('/api/manual/ocr-frame-preview', { jobId, time });
    setOcrFramePicker({ ...data, cacheBust: Date.now() });
    setOcrCropDrag(null);
    addLog(`Đã lấy frame crop picker tại ${formatClock(time)}.`);
  });

  const pointInCropImage = (event) => {
    const target = event.currentTarget;
    const rect = target?.getBoundingClientRect?.();
    if (!rect) return { x: 0, y: 0 };
    const clientX = Number(event.clientX ?? event.touches?.[0]?.clientX ?? 0);
    const clientY = Number(event.clientY ?? event.touches?.[0]?.clientY ?? 0);
    const x = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const y = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    return { x, y };
  };

  const cropRectFromPoints = (start, end) => {
    const x1 = clamp(Math.min(start.x, end.x), 0, 1);
    const y1 = clamp(Math.min(start.y, end.y), 0, 1);
    const x2 = clamp(Math.max(start.x, end.x), 0, 1);
    const y2 = clamp(Math.max(start.y, end.y), 0, 1);
    return {
      x: Number(x1.toFixed(4)),
      y: Number(y1.toFixed(4)),
      w: Number(Math.max(0.01, x2 - x1).toFixed(4)),
      h: Number(Math.max(0.01, y2 - y1).toFixed(4)),
    };
  };

  const beginOcrCropDrag = (event) => {
    try {
      event.preventDefault();
      const point = pointInCropImage(event);
      setOcrCropDrag({ start: point, current: point });
    } catch (error) {
      setOcrCropDrag(null);
      playErrorSound();
      addLog(`Crop picker lỗi khi bắt đầu kéo: ${error.message || error}`);
    }
  };

  const moveOcrCropDrag = (event) => {
    if (!ocrCropDrag) return;
    try {
      event.preventDefault();
      const point = pointInCropImage(event);
      setOcrCropDrag((previous) => previous ? { ...previous, current: point } : previous);
    } catch (error) {
      setOcrCropDrag(null);
      playErrorSound();
      addLog(`Crop picker lỗi khi kéo: ${error.message || error}`);
    }
  };

  const finishOcrCropDrag = (event) => {
    if (!ocrCropDrag) return;
    try {
      event.preventDefault();
      const end = pointInCropImage(event);
      const rect = cropRectFromPoints(ocrCropDrag.start, end);
      if (rect.w < 0.02 || rect.h < 0.02) {
        setOcrCropDrag(null);
        return;
      }
      patchConfig({
        ocrCropX: rect.x,
        ocrCropY: rect.y,
        ocrCropW: rect.w,
        ocrCropH: rect.h,
      });
      setOcrCropDrag(null);
      setOcrTestResult(null);
      addLog(`Đã chọn crop OCR: X ${rect.x}, Y ${rect.y}, W ${rect.w}, H ${rect.h}.`);
    } catch (error) {
      setOcrCropDrag(null);
      playErrorSound();
      addLog(`Crop picker lỗi khi thả chuột: ${error.message || error}`);
    }
  };

  const translateSubtitle = async () => {
    const hasExisting = rows.some((row) => String(row.translatedText || row.finalText || '').trim())
      || Boolean(outputs.audioPath || outputs.audioUrl || outputs.videoPath || outputs.videoUrl)
      || ['translated', 'final', 'voice', 'video'].includes(state.currentStage);
    if (!(await confirmRerun('dịch phụ đề', hasExisting, 'bản dịch'))) return false;
    return runTask('dịch phụ đề', async () => {
    if (!job.jobId || !rows.length) throw new Error('Tạo phụ đề gốc trước.');
    const sourceSegments = rowsToSegments(rows, 'sourceText');
    if (!sourceSegments.length) {
      throw new Error('Timeline hiện không có phụ đề gốc để dịch. Nếu bạn đã nạp SRT dịch hoặc SRT hoàn chỉnh thì dùng luôn để lồng tiếng.');
    }
    const sourceRows = rows.map((row) => ({
      ...row,
      translatedText: '',
      finalText: '',
      audioPath: '',
      status: 'pending',
      dirty: false,
    }));
    clearGeneratedState('translation');
    const data = await callApi('/api/manual/translate', {
      jobId: job.jobId,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      templateGroupTranslation: config.translationMode !== 'story_v2'
        && sourceSegments.length > 0
        && sourceSegments.every((segment) => segment.templateGroupCreatedBy === 'ai_grouping' || String(segment.id || '').startsWith('template-')),
      translationProvider: config.translationProvider,
      cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
      translationMode: config.translationMode || DEFAULT_STATE.config.translationMode,
      videoContext: config.videoContext,
      customGlossary: '',
      translationTargetTtsRate: normalizeTranslationTargetTtsRate(config.translationTargetTtsRate ?? DEFAULT_STATE.config.translationTargetTtsRate),
      translationTimingValidationMode: config.translationTimingValidationMode || DEFAULT_STATE.config.translationTimingValidationMode,
      translationTimingRewriteMaxPasses: Number(config.translationTimingRewriteMaxPasses ?? DEFAULT_STATE.config.translationTimingRewriteMaxPasses),
      translationDisplayMode: config.translationDisplayMode || DEFAULT_STATE.config.translationDisplayMode,
      segments: sourceSegments,
      useStoredSource: false,
      googleCloudConfig: googleCloudConfig(),
    });
    const cleanedSourceRows = data.sourceSegments?.length ? mapSourceRows(data.sourceSegments) : sourceRows;
    const translatedRows = mergeTranslatedRows(data.segments || [], cleanedSourceRows);
    const nextMeaningUnits = Array.isArray(data.meaningUnits) ? data.meaningUnits.map(normalizeMeaningUnit) : [];
    const nextTtsUnits = Array.isArray(data.ttsUnits) ? data.ttsUnits.map(normalizeMeaningUnit) : [];
    patchState({
      rows: translatedRows,
      meaningUnits: nextMeaningUnits,
      ttsUnits: nextTtsUnits,
      storyTranslation: data.schemaVersion === 'story_translation_v2' ? {
        schemaVersion: data.schemaVersion,
        storyText: data.storyText || '',
        sourceCues: Array.isArray(data.sourceCues) ? data.sourceCues : [],
        meaningAtoms: Array.isArray(data.meaningAtoms) ? data.meaningAtoms : [],
        omissions: Array.isArray(data.omissions) ? data.omissions : [],
        validation: data.validation || null,
      } : null,
      selectedRowId: translatedRows[0]?.id || '',
      currentStage: 'translated',
      outputs: {
        ...outputs,
        srtPath: data.srtPath || '',
        srtUrl: data.srtUrl || '',
        sourceCoverageReportPath: data.sourceCoverageReportPath || '',
        sourceCoverageReportUrl: data.sourceCoverageReportUrl || '',
        translationQcReportPath: data.translationQcReportPath || '',
        translationQcReportUrl: data.translationQcReportUrl || '',
        readabilityQcReportPath: data.readabilityQcReportPath || '',
        readabilityQcReportUrl: data.readabilityQcReportUrl || '',
        ttsQcReportPath: data.ttsQcReportPath || '',
        ttsQcReportUrl: data.ttsQcReportUrl || '',
        audioPath: '',
        audioUrl: '',
        videoPath: '',
        videoUrl: '',
      },
    });
    if (data.sourceCoverageReport) {
      addLog(
        `Coverage cụm nguồn: ${data.sourceCoverageReport.uniqueCoveredCount || 0}/${data.sourceCoverageReport.sourceCount || 0}, thiếu ${(data.sourceCoverageReport.missingIds || []).length}, trùng ${(data.sourceCoverageReport.duplicateIds || []).length}, thứ tự ${data.sourceCoverageReport.orderValid ? 'đúng' : 'sai'}.`
      );
    }
    });
  };

  const exportSrt = () => runTask('xuất SRT', async () => {
    if (!job.jobId || !rows.length) throw new Error('Chưa có subtitle để xuất.');
    const displayMaxLineLength = subtitleLineLengthForConfig(config, previewVideoAspectRatio);
    const data = await callApi('/api/manual/export-srt', {
      jobId: job.jobId,
      fileName: 'final_review.srt',
      outputDirectory: config.outputDirectory,
      outputCreateFolder: config.outputCreateFolder,
      outputFolderName: config.outputFolderName,
      segments: rowsToSegments(rows, state.currentStage === 'source' ? 'sourceText' : 'finalText').map((segment) => ({
        ...segment,
        start: segment.start + (Number(config.subtitleOffsetMs) || 0) / 1000,
        end: segment.end + (Number(config.subtitleOffsetMs) || 0) / 1000,
      })),
      // Match the preview: split a long row into sequential one-line cues.
      maxChars: Math.max(18, displayMaxLineLength),
      maxLineLength: displayMaxLineLength,
      displayOptimized: true,
    });
    patchState({
      outputs: {
        ...outputs,
        srtPath: data.outputPath || '',
        srtUrl: data.outputUrl || '',
        readabilityQcReportPath: data.readabilityQcReportPath || outputs.readabilityQcReportPath || '',
        readabilityQcReportUrl: data.readabilityQcReportUrl || outputs.readabilityQcReportUrl || '',
      },
      currentStage: 'final',
    });
    if (data.savedOutputPath || data.outputPath) addLog(`Đã lưu SRT: ${data.savedOutputPath || data.outputPath}`);
  });

  const exportSourceSrt = () => runTask('xuất SRT gốc', async () => {
    if (!job.jobId || !rows.length) throw new Error('Chưa có phụ đề gốc để xuất.');
    const sourceSegments = rowsToSegments(rows, 'sourceText').map((segment) => ({
      ...segment,
      start: segment.start + (Number(config.subtitleOffsetMs) || 0) / 1000,
      end: segment.end + (Number(config.subtitleOffsetMs) || 0) / 1000,
    }));
    if (!sourceSegments.length) throw new Error('Timeline hiện không có nội dung phụ đề gốc.');
    const displayMaxLineLength = subtitleLineLengthForConfig(config, previewVideoAspectRatio);
    const data = await callApi('/api/manual/export-srt', {
      jobId: job.jobId,
      fileName: 'source_original.srt',
      outputDirectory: config.outputDirectory,
      outputCreateFolder: config.outputCreateFolder,
      outputFolderName: config.outputFolderName,
      segments: sourceSegments,
      maxChars: Math.max(18, displayMaxLineLength),
      maxLineLength: displayMaxLineLength,
      displayOptimized: true,
    });
    patchState({
      outputs: {
        ...outputs,
        sourceSrtPath: data.outputPath || '',
        sourceSrtUrl: data.outputUrl || '',
      },
    });
    if (data.savedOutputPath || data.outputPath) addLog(`Đã lưu SRT gốc: ${data.savedOutputPath || data.outputPath}`);
  });

  const pickGoogleCredentialsFile = () => runTask('chọn Google credentials', async () => {
    const desktopPicker = getDesktopPicker();
    const data = desktopPicker?.pickGoogleCredentials
      ? await desktopPicker.pickGoogleCredentials()
      : await callApi('/api/pick-google-credentials', {});
    if (data.cancelled) {
      addLog('Đã hủy chọn Google credentials.');
      return;
    }
    const filePath = data.filePath || '';
    if (!filePath) throw new Error('Không nhận được đường dẫn Google service account JSON.');
    patchState({ voices: [] });
    patchConfig({ googleServiceAccountPath: filePath, ttsVoiceName: '' });
    addLog(`Đã chọn Google credentials: ${filePath}`);
  });

  const loadVoices = () => runTask('tải giọng đọc', async () => {
    const data = await callApi('/api/tts-voices', {
      languageCode: config.ttsLanguageCode,
      targetLanguage: config.targetLanguage,
      googleCloudConfig: googleCloudConfig(),
    });
    const voices = normalizeVoices(data.voices || []);
    patchState({ voices });
    const nextVoiceName = selectVoiceNameForConfig(voices, voiceSelectionConfig);
    if (nextVoiceName !== config.ttsVoiceName) {
      patchConfig({ ttsVoiceName: nextVoiceName });
    }
  });

  useEffect(() => {
    // Voice list loading is manual; translation/editing must not call TTS endpoints.
    if (!hydrated || activeModal !== '__manual_tts_voice_preload__') return;
    let cancelled = false;
    patchState({ voices: [] });
    Promise.resolve({ voices: [] })
      .then((data) => {
        if (cancelled) return;
        const nextVoices = normalizeVoices(data.voices || []);
        patchState({ voices: nextVoices });
        const nextVoiceName = selectVoiceNameForConfig(nextVoices, voiceSelectionConfig);
        if (nextVoiceName !== config.ttsVoiceName) {
          patchConfig({ ttsVoiceName: nextVoiceName });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          playErrorSound();
          addLog(`Không tải được danh sách giọng: ${error.message || 'lỗi không rõ'}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeModal, config.ttsProvider, config.ttsLanguageCode, config.aimaxApiKey, config.aimaxBaseUrl, config.googleApiKey, config.googleServiceAccountPath, hydrated]);

  const previewVoice = () => runTask('nghe thử giọng', async () => {
    const data = await callApi('/api/preview-voice', {
      text: 'Đây là câu nghe thử giọng đọc cho video lồng tiếng.',
      targetLanguage: config.targetLanguage,
      googleCloudConfig: googleCloudConfig(),
    });
    patchState({
      voicePreviewAudio: `data:${data.mimeType || 'audio/mpeg'};base64,${data.audioContent}`,
    });
  });

  const ttsRequestConfig = () => ({
    targetLanguage: config.targetLanguage,
    googleCloudConfig: googleCloudConfig(),
    translationProvider: config.translationProvider,
    ttsProvider: config.ttsProvider,
    ttsLanguageCode: config.ttsLanguageCode,
    ttsVoiceName: selectedTtsVoiceName,
    voiceGenderFilter: config.voiceGenderFilter,
    ssmlGender: selectedGenderFilter(config) || 'NEUTRAL',
    aimaxProvider: config.aimaxProvider || DEFAULT_AIMAX_PROVIDER,
    aimaxModel: config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider),
    aimaxSrtBatchEnabled: config.aimaxSrtBatchEnabled === true,
    aimaxSrtBatchMode: normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode),
    aimaxSrtCuesPerRequest: normalizeConfiguredAimaxSrtCuesPerRequest(config.aimaxSrtCuesPerRequest ?? DEFAULT_STATE.config.aimaxSrtCuesPerRequest),
    aimaxSrtRequestCount: clampAimaxSrtRequestCount(config.aimaxSrtRequestCount ?? DEFAULT_STATE.config.aimaxSrtRequestCount),
    aimaxSrtBatchConcurrency: clampAimaxSrtBatchConcurrency(config.aimaxSrtBatchConcurrency ?? DEFAULT_STATE.config.aimaxSrtBatchConcurrency),
    ttsConcurrency: Number(config.ttsConcurrency ?? DEFAULT_STATE.config.ttsConcurrency),
    ttsMaxAttempts: Number(config.ttsMaxAttempts ?? DEFAULT_STATE.config.ttsMaxAttempts),
    speakingRate: normalizeSpeakingRate(config.speakingRate),
    ttsFitEnabled: config.ttsFitEnabled !== false,
    ttsFitMode: config.ttsFitMode || DEFAULT_STATE.config.ttsFitMode,
    ttsFitMaxRate: normalizeSpeakingRate(config.speakingRate),
    autoTtsRepairEnabled: config.autoTtsRepairEnabled === true,
    autoTtsRepairMaxPasses: Math.max(1, Math.min(3, Number(config.autoTtsRepairMaxPasses ?? DEFAULT_STATE.config.autoTtsRepairMaxPasses) || DEFAULT_STATE.config.autoTtsRepairMaxPasses)),
    autoTtsRepairMinOverflowSeconds: Math.max(0, Number(config.autoTtsRepairMinOverflowSeconds ?? DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds) || DEFAULT_STATE.config.autoTtsRepairMinOverflowSeconds),
    autoTtsRepairMaxRowsPerPass: Math.max(1, Math.min(50, Number(config.autoTtsRepairMaxRowsPerPass ?? DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass)),
    ttsTextCleanupMode: ['natural', 'fast', 'strict'].includes(config.ttsTextCleanupMode) ? config.ttsTextCleanupMode : DEFAULT_STATE.config.ttsTextCleanupMode,
    voiceAlignShortClips: false,
    voiceAlignMode: 'start',
    voiceAlignMinSlackSeconds: Number(config.voiceAlignMinSlackSeconds ?? DEFAULT_STATE.config.voiceAlignMinSlackSeconds),
    voiceAlignMaxShiftSeconds: normalizeVoiceAlignMaxShift(config.voiceAlignMaxShiftSeconds),
    ...(config.ttsProvider === 'aimax_tts' ? {} : { pitch: config.pitch }),
  });

  const buildTtsProviderTestSegments = () => {
    const ttsRows = rowsWithFinalText(rows).map(stripTtsRuntimeFromRow);
    const ttsSegments = rowsToTtsSegments(ttsRows);
    const effectiveTtsUnitMode = effectiveTtsUnitModeForRows(config.ttsUnitMode, ttsRows);
    const currentTtsUnits = effectiveTtsUnitMode !== 'meaning_units' && meaningUnitsStillMatchRows(ttsUnits, ttsRows) ? ttsUnits : [];
    const ttsMeaningUnits = effectiveTtsUnitMode === 'meaning_units' && meaningUnitsStillMatchRows(meaningUnits, ttsRows) ? meaningUnits : [];
    const sourceSegments = currentTtsUnits.length ? currentTtsUnits : (ttsMeaningUnits.length ? ttsMeaningUnits : ttsSegments);

    return sourceSegments
      .map((segment, index) => {
        const start = Number(segment.start) || 0;
        const end = Number(segment.end) || start + Math.max(0.1, Number(segment.duration) || 1);
        const text = String(segment.ttsText || segment.prosodyText || segment.finalText || segment.translatedText || segment.text || '').trim();
        return {
          ...segment,
          id: String(segment.id || `tts-test-${index + 1}`),
          index: Number(segment.index ?? index),
          start,
          end,
          duration: Math.max(0.1, end - start),
          text,
          ttsText: text,
          finalText: String(segment.finalText || segment.translatedText || text).trim(),
          translatedText: String(segment.translatedText || segment.finalText || text).trim(),
        };
      })
      .filter((segment) => segment.text)
      .slice(0, 2);
  };

  const testTtsProviders = () => runTask('test provider TTS đang chọn', async () => {
    const testSegments = buildTtsProviderTestSegments();
    if (!testSegments.length) {
      throw new Error('Chưa có nội dung final để test TTS. Hãy chạy dịch phụ đề hoặc nạp SRT final trước.');
    }

    const selectedProvider = config.ttsProvider || DEFAULT_STATE.config.ttsProvider;
    setTtsProviderTestResult({ running: true, providers: [], segments: testSegments });
    try {
      const data = await callApi('/api/manual/test-tts-providers', {
        jobId: job.jobId,
        segments: testSegments,
        providers: [selectedProvider],
        ...ttsRequestConfig(),
      });
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const failedProviders = providers.filter((provider) => !provider.ok);
      setTtsProviderTestResult({
        ...data,
        running: false,
        checkedAt: new Date().toLocaleTimeString(),
        providers,
        segments: Array.isArray(data.segments) ? data.segments : testSegments,
      });
      addLog(
        failedProviders.length
          ? `Test TTS provider: ${providers.length - failedProviders.length}/${providers.length} provider pass, lỗi ${failedProviders.map((provider) => provider.label || provider.provider).join(', ')}.`
          : `Test TTS provider: provider đang chọn pass với ${testSegments.length} đoạn đầu.`
      );
      if (failedProviders.length) playErrorSound();
    } catch (error) {
      setTtsProviderTestResult({
        running: false,
        error: error.message || String(error),
        providers: [],
        segments: testSegments,
        checkedAt: new Date().toLocaleTimeString(),
      });
      throw error;
    }
  });

  const generateTts = async (rerunRowIds = []) => {
    if (!job.jobId || !rows.length) throw new Error('Chưa có subtitle final.');
    const ttsRows = rowsWithFinalText(rows).map(stripTtsRuntimeFromRow);
    const ttsSegments = rowsToTtsSegments(ttsRows);
    const effectiveTtsUnitMode = effectiveTtsUnitModeForRows(config.ttsUnitMode, ttsRows);
    const usePostTranslationUnits = effectiveTtsUnitMode !== 'meaning_units';
    const currentTtsUnits = usePostTranslationUnits && meaningUnitsStillMatchRows(ttsUnits, ttsRows) ? ttsUnits : [];
    const ttsMeaningUnits = !usePostTranslationUnits && meaningUnitsStillMatchRows(meaningUnits, ttsRows) ? meaningUnits : [];
    if (!ttsSegments.length) {
      throw new Error('Không có nội dung phụ đề để lồng tiếng. Hãy chạy Dịch phụ đề hoặc nhập/nạp phụ đề final trước.');
    }
    clearGeneratedState('voice');
    addLog('Đã xóa log TTS cũ và cảnh báo tràn timeline trước khi TTS lại.');
    const requestTts = () => callApi('/api/manual/generate-tts', {
      jobId: job.jobId,
      segments: ttsSegments,
      ttsUnitMode: effectiveTtsUnitMode,
      ttsUnits: currentTtsUnits,
      meaningUnits: ttsMeaningUnits,
      rerunRowIds,
      ...ttsRequestConfig(),
    });
    let data;
    try {
      data = await requestTts();
    } catch (error) {
      let handledError = error;
      const alreadyRunningTts = error.data?.code === 'TTS_ALREADY_RUNNING'
        || /already running TTS generation|TTS is already running/i.test(error.message || '');
      if (alreadyRunningTts) {
        addLog('TTS đang chạy nên app không gửi lệnh trùng. Với AIMAX, hãy đợi job hiện tại xong hoặc bấm Hủy rồi chạy lại để resume job đã tạo.');
        throw handledError;
      }
      if (handledError.data?.report) {
        const errorReport = reportWithTimelineWarnings(handledError.data.report);
        const errorRows = rowsWithTtsReport(ttsRows, errorReport);
        patchState({
          rows: errorRows,
          ttsRepairBasket: ttsRepairBasketAfterTts([], errorRows, finalField),
          outputs: {
            ...outputs,
            audioPath: '',
            audioUrl: '',
            videoPath: '',
            videoUrl: '',
            ttsReport: errorReport,
          },
          config: {
            ...config,
            dubbedAudioEnabled: false,
          },
        });
      }
      throw handledError;
    }
    const responseRows = Array.isArray(data.rows) && data.rows.length
      ? data.rows.map((row, index) => ({
        ...row,
        id: String(row.id || `row-${index + 1}`),
        index: index + 1,
        sourceText: String(row.sourceText || row.originalText || '').trim(),
        translatedText: String(row.translatedText || row.finalText || row.text || '').trim(),
        finalText: String(row.finalText || row.translatedText || row.text || '').trim(),
        ttsText: String(row.ttsText || row.finalText || row.translatedText || row.text || '').trim(),
      }))
      : ttsRows;
    const timelineReport = reportWithTimelineWarnings(data.report);
    const reportedRows = rowsWithTtsReport(responseRows, timelineReport);
    const nextTtsRepairBasket = ttsRepairBasketAfterTts([], reportedRows, finalField);
    const audioAccepted = data.accepted !== false;
    const previewAudioPath = audioAccepted ? (data.audioPath || '') : (data.unsafeAudioPath || '');
    const previewAudioUrl = audioAccepted ? (data.audioUrl || '') : (data.unsafeAudioUrl || '');
    patchState({
      rows: reportedRows,
      meaningUnits: Array.isArray(data.meaningUnits) && data.meaningUnits.length ? data.meaningUnits : state.meaningUnits,
      ttsUnits: Array.isArray(data.ttsUnits) && data.ttsUnits.length ? data.ttsUnits : state.ttsUnits,
      ttsRepairBasket: nextTtsRepairBasket,
      outputs: {
        ...outputs,
        audioPath: previewAudioPath,
        audioUrl: cacheBustUrl(previewAudioUrl),
        srtPath: data.srtPath || outputs.srtPath || '',
        srtUrl: data.srtUrl ? cacheBustUrl(data.srtUrl) : (outputs.srtUrl || ''),
        videoPath: '',
        videoUrl: '',
        translationQcReportPath: data.translationQcReportPath || outputs.translationQcReportPath || '',
        translationQcReportUrl: data.translationQcReportUrl || outputs.translationQcReportUrl || '',
        readabilityQcReportPath: data.readabilityQcReportPath || outputs.readabilityQcReportPath || '',
        readabilityQcReportUrl: data.readabilityQcReportUrl || outputs.readabilityQcReportUrl || '',
        ttsQcReportPath: data.ttsQcReportPath || outputs.ttsQcReportPath || '',
        ttsQcReportUrl: data.ttsQcReportUrl || outputs.ttsQcReportUrl || '',
        syncQcReportPath: data.syncQcReportPath || outputs.syncQcReportPath || '',
        syncQcReportUrl: data.syncQcReportUrl || outputs.syncQcReportUrl || '',
        autoTtsRepairReportPath: data.autoTtsRepairReportPath || outputs.autoTtsRepairReportPath || '',
        autoTtsRepairReportUrl: data.autoTtsRepairReportUrl || outputs.autoTtsRepairReportUrl || '',
        autoTtsRepairReport: data.autoTtsRepairReport || outputs.autoTtsRepairReport || null,
        aimaxSrtBatchReportPath: data.aimaxSrtBatchReportPath || outputs.aimaxSrtBatchReportPath || '',
        aimaxSrtBatchReportUrl: data.aimaxSrtBatchReportUrl || outputs.aimaxSrtBatchReportUrl || '',
        aimaxSrtBatchReport: data.aimaxSrtBatchReport || outputs.aimaxSrtBatchReport || null,
        qcSummary: null,
        ttsReport: timelineReport,
        ttsFitPlan: data.ttsFitPlan || null,
      },
      config: {
        ...config,
        dubbedAudioEnabled: Boolean(previewAudioUrl),
        dubbedPreviewVolume: Number(config.dubbedPreviewVolume) > 0 ? Number(config.dubbedPreviewVolume) : DEFAULT_STATE.config.dubbedPreviewVolume,
        sourceAudioEnabled: false,
      },
      currentStage: 'voice',
    });
    if (!audioAccepted) {
      playErrorSound();
      addLog(`TTS chưa tạo được audio để preview/xuất.`);
      if (data.unsafeAudioPath) {
        addLog(`Audio lỗi chỉ để debug: ${data.unsafeAudioPath}`);
      }
    }
    if (data.ttsFitPlan?.summary) {
      const summary = data.ttsFitPlan.summary;
      addLog(`Chống tràn TTS: ${summary.speed_up || 0} tăng tốc, ${summary.manual_review || 0} cần sửa tay, max ratio ${Number(summary.maxFitRatio || 0).toFixed(2)}.`);
    }
    if (data.autoTtsRepairReport?.changedRows?.length) {
      addLog(`Auto repair TTS: ${data.autoTtsRepairReport.changedRows.length} row(s), ${data.autoTtsRepairReport.passes?.length || 0} pass(es), status ${data.autoTtsRepairReport.finalStatus || 'repaired'}.`);
    }
    if (config.ttsProvider === 'google_cloud_tts' && audioAccepted) {
      const usedThisRun = googleTtsEstimatedChars;
      const usageKey = googleTtsUsageKey;
      const nextUsage = {
        ...googleTtsUsage,
        [usageKey]: (Number(googleTtsUsage[usageKey]) || 0) + usedThisRun,
      };
      setGoogleTtsUsage(nextUsage);
      if (typeof window !== 'undefined') {
        safeLocalStorageSet(GOOGLE_TTS_USAGE_STORAGE_KEY, JSON.stringify(nextUsage));
      }
      addLog(`Google Cloud TTS đã dùng ước tính ${formatInteger(usedThisRun)} ký tự cho dòng ${googleTtsBilling.label}. Còn lại free tier riêng dòng này: ${formatInteger(Math.max(0, googleTtsBilling.freeChars - nextUsage[usageKey]))} ký tự.`);
    }
    if (dubbedAudioRef.current) {
      dubbedAudioRef.current.currentTime = mediaRef.current?.currentTime || 0;
      dubbedAudioRef.current.load();
    }
    return { data, timelineReport, reportedRows };
  };

  const runTts = async () => {
    const hasExisting = Boolean(outputs.audioPath || outputs.audioUrl || outputs.videoPath || outputs.videoUrl)
      || ['voice', 'video'].includes(state.currentStage);
    if (!(await confirmRerun('lồng tiếng', hasExisting, 'dữ liệu lồng tiếng'))) return false;
    return runTask('lồng tiếng', generateTts);
  };

  const rerunTtsForRow = (rowId) => {
    const row = rows.find((item) => item.id === rowId);
    setContextMenu(null);
    if (!row) {
      addLog('Không tìm thấy dòng để TTS lại.');
      return;
    }
    if (!outputs.audioPath && !outputs.audioUrl) {
      addLog('Hãy chạy Lồng tiếng một lần trước khi TTS lại riêng một dòng.');
      return;
    }
    return runTask(`TTS lại dòng ${row.index || ''}`.trim(), async () => {
      const finalText = rowText(row, finalField);
      if (!finalText.trim()) {
        throw new Error('Dòng này chưa có nội dung final để TTS.');
      }
      const data = await callApi('/api/manual/rerun-tts-row', {
        jobId: job.jobId,
        row: {
          ...row,
          text: finalText,
          finalText,
          translatedText: row.translatedText || finalText,
          end: row.end || (row.start + row.duration),
        },
        ...ttsRequestConfig(),
      });
      const nextTtsReport = reportWithTimelineWarnings(mergeTtsReports(outputs.ttsReport, data.report, row.id));
      const reportedRows = rowsWithTtsReport(rowsWithFinalText(rows), nextTtsReport);
      const nextTtsRepairBasket = ttsRepairBasketAfterTts(ttsRepairBasket, reportedRows, finalField);
      const reportedRow = reportedRows.find((item) => String(item.id) === String(row.id));
      const warningReasons = ttsSyncWarningReasons(reportedRow?.ttsSync);
      patchState({
        rows: reportedRows,
        ttsRepairBasket: nextTtsRepairBasket,
        outputs: {
          ...outputs,
          audioPath: data.audioPath || outputs.audioPath || '',
          audioUrl: cacheBustUrl(data.audioUrl || outputs.audioUrl || ''),
          videoPath: '',
          videoUrl: '',
          ttsReport: nextTtsReport,
          ttsFitPlan: outputs.ttsFitPlan || data.ttsFitPlan || null,
        },
        config: {
          ...config,
          dubbedAudioEnabled: true,
          sourceAudioEnabled: false,
          dubbedPreviewVolume: Number(config.dubbedPreviewVolume) > 0
            ? config.dubbedPreviewVolume
            : DEFAULT_STATE.config.dubbedPreviewVolume,
        },
        currentStage: 'voice',
      });
      if (dubbedAudioRef.current) {
        dubbedAudioRef.current.currentTime = mediaRef.current?.currentTime || row.start || 0;
        dubbedAudioRef.current.load();
      }
      if (warningReasons.length) {
        addLog(`TTS lại dòng ${row.index || row.id} vẫn lỗi timeline: ${warningReasons.join(', ')}. Đã giữ để sửa tiếp.`);
      } else {
        addLog(`Đã TTS lại đúng dòng ${row.index || row.id}; audio đã khớp timeline.`);
      }
    });
  };

  const setTtsRepairBasketItem = (rowId, patch) => {
    const row = rows.find((item) => item.id === rowId);
    const existing = ttsRepairById.get(String(rowId));
    const base = row
      ? ttsRepairPayloadForRow(row, rows, finalField, existing)
      : { rowId, selected: true, currentTranslation: '', repairedTranslation: '', status: '', manual: true };
    const nextItem = normalizeTtsRepairBasketItem({
      ...base,
      ...existing,
      ...patch,
      rowId,
    });
    const next = [
      ...ttsRepairBasket.filter((item) => item.rowId !== rowId),
      nextItem,
    ].filter(Boolean);
    patchState({ ttsRepairBasket: next });
  };

  const toggleTtsRepairRow = (rowId, checked) => {
    const row = rows.find((item) => item.id === rowId);
    if (!row) return;
    const issue = ttsRepairIssueForRow(row, finalField);
    setTtsRepairBasketItem(rowId, {
      selected: checked,
      manual: !issue || checked,
      status: checked ? (ttsRepairById.get(String(rowId))?.status || 'selected') : 'removed',
    });
  };

  const openTtsRepairEditor = () => {
    setTimelineTab('all');
    openBulkEditor('ttsRepair');
  };

  const selectTtsRepairItem = (rowId) => {
    const item = visibleTtsRepairRows.find((candidate) => String(candidate.rowId) === String(rowId))
      || ttsRepairRows.find((candidate) => String(candidate.rowId) === String(rowId));
    if (!item) return;
    setTtsRepairSelectedRowId(item.rowId);
    const row = rows.find((candidate) => String(candidate.id) === String(item.rowId));
    if (row) selectRow(row);
  };

  const moveTtsRepairSelection = (offset) => {
    if (!visibleTtsRepairRows.length) return;
    const currentIndex = selectedTtsRepairIndex >= 0 ? selectedTtsRepairIndex : 0;
    const nextIndex = Math.max(0, Math.min(visibleTtsRepairRows.length - 1, currentIndex + offset));
    selectTtsRepairItem(visibleTtsRepairRows[nextIndex].rowId);
  };

  const removeTtsRepairRow = (rowId) => {
    clearTtsRepairPreviewAudioForRows([rowId]);
    setTtsRepairBasketItem(rowId, { selected: false, status: 'removed' });
  };

  const toggleTtsRepairApplyRow = (rowId, checked) => {
    setTtsRepairBasketItem(rowId, { applySelected: checked });
  };

  const updateTtsRepairDraft = (rowId, repairedTranslation) => {
    clearTtsRepairPreviewAudioForRows([rowId]);
    setTtsRepairBasketItem(rowId, {
      repairedTranslation,
      status: repairedTranslation.trim() ? 'edited' : 'selected',
      applySelected: false,
      repairPromptVersion: repairedTranslation.trim() ? TTS_REPAIR_PROMPT_VERSION : '',
      repairPromptStale: false,
      ttsPreviewStatus: '',
      ttsPreviewSlotSeconds: 0,
      ttsPreviewAudioSeconds: 0,
      ttsPreviewDeltaSeconds: 0,
      ttsPreviewOverflowSeconds: 0,
      ttsPreviewSlackSeconds: 0,
      ttsPreviewCheckedAt: '',
      ttsPreviewTranslation: '',
      ttsPreviewId: '',
      aimaxBatchIndex: null,
      aimaxEntryIndex: null,
      aimaxSegmentFileName: '',
    });
  };

  const repairSelectedTtsErrors = (rowIds = null) => runTask('dịch gọn lỗi TTS', async () => {
    const rowIdFilter = Array.isArray(rowIds) && rowIds.length
      ? new Set(rowIds.map(String))
      : null;
    const selected = ttsRepairRows.filter((item) => (
      rowIdFilter
        ? rowIdFilter.has(String(item.rowId))
        : item.selected !== false
    ));
    if (!selected.length) throw new Error('Chưa có dòng lỗi TTS nào được chọn.');
    const data = await callApi('/api/manual/retranslate-tts-errors', {
      jobId: job.jobId,
      items: selected.map((item) => ({
        row_id: item.row_id,
        source_text: item.source_text,
        current_translation: item.current_translation,
        previous_translation: item.previous_translation,
        next_translation: item.next_translation,
        slot_seconds: item.slot_seconds,
        audio_seconds: item.audio_seconds,
        overflow_seconds: item.overflow_seconds,
        fit_ratio: item.fit_ratio,
        target_tts_rate: item.target_tts_rate,
        error_reason: item.error_reason,
      })),
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      translationProvider: config.translationProvider,
      cliTranslationModel: config.cliTranslationModel,
      cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
      googleCloudConfig: googleCloudConfig(),
    });
    const repairById = new Map((data.repairs || []).map((item) => [String(item.row_id), String(item.repaired_translation || '').trim()]));
    const repairPromptVersion = String(data.repairPromptVersion || TTS_REPAIR_PROMPT_VERSION).trim();
    const nextBasket = normalizeTtsRepairBasket([
      ...ttsRepairBasket,
      ...selected.map((item) => ({
        ...item,
        rowId: item.rowId,
        selected: true,
        repairedTranslation: repairById.get(String(item.rowId)) || item.repairedTranslation || '',
        status: repairById.has(String(item.rowId)) ? 'repaired' : item.status,
        applySelected: false,
        repairPromptVersion: repairById.has(String(item.rowId)) ? repairPromptVersion : item.repairPromptVersion,
        repairPromptStale: repairById.has(String(item.rowId)) ? false : item.repairPromptStale === true,
        ttsPreviewStatus: '',
        ttsPreviewSlotSeconds: 0,
        ttsPreviewAudioSeconds: 0,
        ttsPreviewDeltaSeconds: 0,
        ttsPreviewOverflowSeconds: 0,
        ttsPreviewSlackSeconds: 0,
        ttsPreviewCheckedAt: '',
        ttsPreviewTranslation: '',
        ttsPreviewId: '',
        aimaxBatchIndex: null,
        aimaxEntryIndex: null,
        aimaxSegmentFileName: '',
      })),
    ]);
    patchState({ ttsRepairBasket: nextBasket });
    clearTtsRepairPreviewAudioForRows(selected.map((item) => item.rowId));
    setTimelineTab('all');
    setTtsRepairSelectedRowId(selected[0]?.rowId || ttsRepairSelectedRowId);
    setBulkEditMode('ttsRepair');
    setActiveModal('bulkEditV2');
    addLog(`Đã dịch gọn ${repairById.size} dòng lỗi TTS.`);
  });

  const previewSelectedTtsRepairSrt = (rowIds = null) => runTask('TTS bản sửa', async () => {
    if (config.ttsProvider !== 'aimax_tts') {
      throw new Error('TTS bản sửa chỉ hỗ trợ AIMAX Clone.');
    }
    const rowIdFilter = Array.isArray(rowIds) && rowIds.length
      ? new Set(rowIds.map(String))
      : null;
    const selected = ttsRepairRows.filter((item) => (
      rowIdFilter
        ? rowIdFilter.has(String(item.rowId))
        : item.selected !== false
    ))
      .filter((item) => String(item.repairedTranslation || '').trim());
    if (!selected.length) {
      throw new Error('Chưa có bản sửa để TTS. Hãy nhập bản sửa hoặc bấm Dịch dòng này.');
    }
    clearActiveTtsRepairPreviewAudio();
    const data = await callApi('/api/manual/preview-tts-repair-srt', {
      jobId: job.jobId,
      items: selected.map((item) => {
        const row = rows.find((candidate) => String(candidate.id) === String(item.rowId));
        const start = Number(row?.start) || 0;
        const end = Number(row?.end) || (start + Math.max(0.1, Number(row?.duration) || 1));
        return {
          row_id: item.rowId,
          index: row?.index || item.rowId,
          start,
          end,
          repaired_translation: item.repairedTranslation,
        };
      }),
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      ...ttsRequestConfig(),
      ttsProvider: 'aimax_tts',
      aimaxSrtBatchEnabled: true,
      aimaxSrtBatchMode: 'request_count',
      aimaxSrtRequestCount: 1,
      aimaxSrtBatchConcurrency: 1,
      googleCloudConfig: {
        ...googleCloudConfig(),
        ttsProvider: 'aimax_tts',
        aimaxSrtBatchEnabled: true,
        aimaxSrtBatchMode: 'request_count',
        aimaxSrtRequestCount: 1,
        aimaxSrtBatchConcurrency: 1,
      },
    });
    const previewById = new Map((data.rows || []).map((item) => [String(item.row_id), item]));
    const checkedAt = new Date().toISOString();
    const nextBasket = normalizeTtsRepairBasket([
      ...ttsRepairBasket,
      ...selected.map((item) => {
        const preview = previewById.get(String(item.rowId));
        if (!preview) return item;
        const canApply = preview.status !== 'overflow';
        return {
          ...item,
          selected: true,
          status: canApply ? 'passed' : 'failed',
          // Keep a user's tick even when the preview still overflows: they can
          // safely apply the subtitle text and regenerate the full TTS later.
          applySelected: canApply || item.applySelected === true,
          ttsPreviewStatus: preview.status,
          ttsPreviewSlotSeconds: Number(preview.slot_seconds) || 0,
          ttsPreviewAudioSeconds: Number(preview.audio_seconds) || 0,
          ttsPreviewDeltaSeconds: Number(preview.delta_seconds) || 0,
          ttsPreviewOverflowSeconds: Number(preview.overflow_seconds) || 0,
          ttsPreviewSlackSeconds: Number(preview.slack_seconds) || 0,
          ttsPreviewCheckedAt: checkedAt,
          ttsPreviewTranslation: preview.repaired_translation || item.repairedTranslation || '',
          ttsPreviewId: preview.preview_id || data.previewId || '',
          aimaxBatchIndex: Number.isFinite(Number(preview.aimax_batch_index)) ? Number(preview.aimax_batch_index) : null,
          aimaxEntryIndex: Number.isFinite(Number(preview.aimax_entry_index)) ? Number(preview.aimax_entry_index) : null,
          aimaxSegmentFileName: preview.aimax_segment_file_name || '',
        };
      }),
    ]);
    patchState({ ttsRepairBasket: nextBasket });
    if (data.audioUrl) {
      const previewAudioUrl = cacheBustUrl(data.audioUrl);
      const previewRowIds = selected.map((item) => String(item.rowId));
      setTtsRepairPreviewAudio(previewAudioUrl);
      setTtsRepairPreviewAudioRowIds(previewRowIds);
      if (previewRowIds.length === 1) {
        setTtsRepairPreviewAudioByRowId((current) => ({
          ...current,
          [previewRowIds[0]]: previewAudioUrl,
        }));
      }
    } else {
      clearActiveTtsRepairPreviewAudio();
    }
    const overflowCount = Number(data.overflowCount) || 0;
    const slackCount = Number(data.slackCount) || 0;
    const fitCount = Number(data.fitCount) || 0;
    addLog(`TTS bản sửa: ${fitCount} khớp, ${slackCount} dư, ${overflowCount} tràn.`);
  });

  const applyTtsRepairRows = (rowIds) => runTask('ap dung TTS ban sua', async () => {
    const targetIds = new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).map((value) => String(value || '')).filter(Boolean));
    const repairs = new Map(ttsRepairRows.map((item) => [String(item.rowId), item]));
    const candidates = Array.from(targetIds)
      .map((rowId) => repairs.get(rowId))
      .filter((item) => item?.repairedTranslation?.trim());
    if (!candidates.length) {
      throw new Error('Chua co ban sua de ap dung.');
    }
    if (!outputs.audioPath && !outputs.audioUrl) {
      throw new Error('Hay chay TTS goc mot lan truoc khi ap dung audio ban sua.');
    }
    const missingPreview = candidates.filter((item) => (
      !item.ttsPreviewId
      || !['fit', 'slack'].includes(String(item.ttsPreviewStatus || ''))
    ));
    if (missingPreview.length) {
      throw new Error(`Co ${missingPreview.length} dong chua TTS ban sua dat. Bam TTS cho cac dong do truoc khi ap dung.`);
    }

    const applyItems = candidates.map((item) => {
      const row = rows.find((candidate) => String(candidate.id) === String(item.rowId));
      const start = Number(row?.start) || 0;
      const end = Number(row?.end) || (start + Math.max(0.1, Number(row?.duration) || 1));
      return {
        row_id: item.rowId,
        index: row?.index || item.rowId,
        start,
        end,
        repaired_translation: item.repairedTranslation,
        preview_id: item.ttsPreviewId,
        tts_preview_status: item.ttsPreviewStatus,
      };
    });

    const data = await callApi('/api/manual/apply-tts-repair-srt', {
      jobId: job.jobId,
      items: applyItems,
      previousReport: outputs.ttsReport || null,
    });

    pushRowsUndo();
    const appliedIds = new Set(candidates.map((item) => String(item.rowId)));
    const nextRowsWithText = rows.map((row) => {
      if (!appliedIds.has(String(row.id))) return row;
      const repair = repairs.get(String(row.id));
      const text = String(repair?.repairedTranslation || '').trim();
      if (!text) return row;
      return {
        ...row,
        translatedText: text,
        finalText: text,
        ttsText: text,
        dirty: true,
        status: row.atomIds?.length ? 'needs_review' : 'translated',
        validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus,
        ttsSync: null,
        ttsTimingFit: null,
        ttsTimingProbe: null,
      };
    });
    const timelineReport = reportWithTimelineWarnings(data.report || outputs.ttsReport);
    const nextRows = timelineReport ? rowsWithTtsReport(nextRowsWithText, timelineReport) : nextRowsWithText;
    const nextMeaningUnits = updateUnitsForAppliedRows(state.meaningUnits, nextRows, appliedIds, finalField);
    const nextTtsUnits = updateUnitsForAppliedRows(state.ttsUnits, nextRows, appliedIds, finalField);
    const nextBasket = normalizeTtsRepairBasket(ttsRepairBasket.filter((item) => !appliedIds.has(String(item.rowId))));
    patchState({
      rows: nextRows,
      meaningUnits: nextMeaningUnits,
      ttsUnits: nextTtsUnits,
      ttsRepairBasket: nextBasket,
      outputs: {
        ...outputs,
        audioPath: data.audioPath || outputs.audioPath || '',
        audioUrl: cacheBustUrl(data.audioUrl || outputs.audioUrl || ''),
        videoPath: '',
        videoUrl: '',
        ttsQcReportPath: data.ttsQcReportPath || outputs.ttsQcReportPath || '',
        ttsQcReportUrl: data.ttsQcReportUrl || outputs.ttsQcReportUrl || '',
        qcSummary: null,
        ttsReport: timelineReport,
      },
      config: {
        ...config,
        dubbedAudioEnabled: true,
        sourceAudioEnabled: false,
      },
      currentStage: 'voice',
    });
    if (dubbedAudioRef.current) {
      dubbedAudioRef.current.currentTime = mediaRef.current?.currentTime || 0;
      dubbedAudioRef.current.load();
    }
    clearTtsRepairPreviewAudioForRows(candidates.map((item) => item.rowId));
    addLog(`Da ap dung ${candidates.length} ban sua TTS vao audio hien tai; cac cue khac duoc giu nguyen.`);
  });

  const applyTtsRepairRowsLegacy = (rowIds) => {
    const targetIds = new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).map(String));
    const repairs = new Map(ttsRepairRows.map((item) => [String(item.rowId), item]));
    const applicable = Array.from(targetIds).filter((rowId) => repairs.get(rowId)?.repairedTranslation?.trim());
    if (!applicable.length) {
      addLog('Chưa có bản sửa để áp dụng.');
      return;
    }
    pushRowsUndo();
    const nextRows = rows.map((row) => {
      if (!targetIds.has(String(row.id))) return row;
      const repair = repairs.get(String(row.id));
      const text = String(repair?.repairedTranslation || '').trim();
      if (!text) return row;
      return {
        ...row,
        translatedText: text,
        finalText: text,
        ttsText: text,
        dirty: true,
        status: row.atomIds?.length ? 'needs_review' : 'translated',
        validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus,
        ttsSync: null,
        ttsTimingFit: null,
        ttsTimingProbe: null,
      };
    });
    const nextMeaningUnits = updateUnitsForAppliedRows(state.meaningUnits, nextRows, targetIds, finalField);
    const nextTtsUnits = updateUnitsForAppliedRows(state.ttsUnits, nextRows, targetIds, finalField);
    const nextBasket = normalizeTtsRepairBasket(ttsRepairBasket.filter((item) => (
      !(targetIds.has(String(item.rowId)) && repairs.get(String(item.rowId))?.repairedTranslation?.trim())
    )));
    patchState({
      rows: nextRows,
      meaningUnits: nextMeaningUnits,
      ttsUnits: nextTtsUnits,
      ttsRepairBasket: nextBasket,
      outputs: {
        ...outputs,
        audioPath: '',
        audioUrl: '',
        videoPath: '',
        videoUrl: '',
        readabilityQcReportPath: '',
        readabilityQcReportUrl: '',
        ttsQcReportPath: '',
        ttsQcReportUrl: '',
        syncQcReportPath: '',
        syncQcReportUrl: '',
        autoTtsRepairReportPath: '',
        autoTtsRepairReportUrl: '',
        autoTtsRepairReport: null,
        aimaxSrtBatchReportPath: '',
        aimaxSrtBatchReportUrl: '',
        aimaxSrtBatchReport: null,
        qcSummary: null,
        ttsReport: null,
        ttsFitPlan: null,
      },
      config: {
        ...config,
        dubbedAudioEnabled: false,
      },
      currentStage: state.currentStage === 'voice' || state.currentStage === 'video' ? 'final' : state.currentStage,
    });
    clearTtsRepairPreviewAudioForRows(applicable);
    addLog(`Đã áp dụng ${applicable.length} bản sửa lỗi TTS vào timeline.`);
  };

  const applyCheckedTtsRepairRows = () => {
    const rowIds = ttsRepairApplyRows.map((item) => item.rowId);
    if (!rowIds.length) {
      addLog('Chưa tick dòng nào để áp dụng.');
      return;
    }
    applyTtsRepairRows(rowIds);
  };

  const applyCheckedTtsRepairTextRows = () => {
    const rowIds = ttsRepairTextApplyRows.map((item) => item.rowId);
    if (!rowIds.length) {
      addLog('Chưa tick dòng nào để áp dụng chữ.');
      return;
    }
    applyTtsRepairRowsLegacy(rowIds);
  };

  const rerunAppliedTtsRepairs = () => {
    const appliedRowIds = ttsRepairRows
      .filter((item) => item.status === 'applied')
      .map((item) => item.rowId);
    if (!appliedRowIds.length) {
      addLog('Hãy áp dụng bản sửa vào timeline trước khi TTS tất cả.');
      return;
    }
    if (false && !outputs.audioPath && !outputs.audioUrl) {
      addLog('Hãy chạy Lồng tiếng một lần trước khi TTS tất cả.');
      return;
    }
    return runTask(`TTS lại ${appliedRowIds.length} dòng lỗi`, async () => {
      const result = await generateTts(appliedRowIds);
      const reportedRows = result?.reportedRows || rowsWithFinalText(rows);
      const appliedIdSet = new Set(appliedRowIds.map(String));
      const stillIssueIds = new Set(reportedRows
        .filter((row) => appliedIdSet.has(String(row.id)) && ttsRepairIssueForRow(row, finalField))
        .map((row) => String(row.id)));
      const fixedCount = appliedRowIds.length - stillIssueIds.size;
      const rerunBasketSeed = ttsRepairBasket
        .filter((item) => appliedIdSet.has(String(item.rowId)))
        .map((item) => ({ ...item, status: 'rerun' }));
      patchState({
        ttsRepairBasket: ttsRepairBasketAfterTts(
          rerunBasketSeed,
          reportedRows,
          finalField
        ),
      });
      addLog(`Đã TTS lại ${appliedRowIds.length} dòng lỗi: ${fixedCount} dòng đã hết lỗi, ${stillIssueIds.size} dòng còn tràn để sửa tiếp.`);
    });
  };

  const rowForQcIssue = (issue = {}) => {
    const rowId = String(issue.rowId || issue.row_id || '').trim();
    if (rowId) {
      const byId = rows.find((row) => String(row.id) === rowId);
      if (byId) return byId;
    }
    const index = Number(issue.index);
    if (Number.isFinite(index) && rows[index]) return rows[index];
    const start = Number(issue.start);
    const end = Number(issue.end);
    if (Number.isFinite(start)) {
      return rows.find((row) => start >= Number(row.start || 0) && start <= Number(row.end || row.start || 0))
        || (Number.isFinite(end)
          ? rows.find((row) => Math.max(0, Math.min(Number(row.end) || 0, end) - Math.max(Number(row.start) || 0, start)) > 0.001)
          : null)
        || null;
    }
    return null;
  };

  const selectQcIssue = (issue = {}) => {
    const row = rowForQcIssue(issue);
    if (!row) {
      addLog('QC issue is not mapped to a visible row.');
      return;
    }
    selectRow(row);
    setTimelineTab('all');
  };

  const repairQcTtsIssue = (issue = {}) => {
    const row = rowForQcIssue(issue);
    if (!row) {
      addLog('QC issue is not mapped to a visible row.');
      return;
    }
    selectRow(row);
    toggleTtsRepairRow(row.id, true);
    setTtsRepairSelectedRowId(row.id);
    setTimelineTab('all');
    setBulkEditMode('ttsRepair');
    setActiveModal('bulkEditV2');
  };

  const rerunQcTtsIssue = (issue = {}) => {
    const row = rowForQcIssue(issue);
    if (!row) {
      addLog('QC issue is not mapped to a visible row.');
      return;
    }
    rerunTtsForRow(row.id);
  };

  const muxVideo = async () => {
    const includeDubbedAudio = config.includeDubbedAudio !== false;
    if (includeDubbedAudio && !outputs.audioPath) throw new Error('Chạy lồng tiếng trước hoặc tắt Dubbed audio khi xuất.');
    clearGeneratedState('video');
    const exportAspectRatio = aspectRatioNumber(normalizeOutputAspectRatio(config.outputAspectRatio)) || previewVideoAspectRatio;
    const displayMaxLineLength = subtitleLineLengthForConfig(config, exportAspectRatio);
    const previewRect = videoContentRect?.();
    const subtitleRenderScale = Number((1920 / Math.max(320, Number(previewRect?.width) || 600)).toFixed(4));
    // The rows currently visible in the timeline are the single source of truth
    // for a burn-in. Never let an older generated SRT replace the user's edits.
    const exportSubtitleSegments = rowsToSegments(rows, state.currentStage === 'source' ? 'sourceText' : 'finalText').map((segment) => ({
      ...segment,
      start: segment.start + (Number(config.subtitleOffsetMs) || 0) / 1000,
      end: segment.end + (Number(config.subtitleOffsetMs) || 0) / 1000,
    }));
    const data = await callApi('/api/manual/mux-video', {
      jobId: job.jobId,
      audioPath: includeDubbedAudio ? outputs.audioPath : '',
      includeDubbedAudio,
      subtitlePath: exportSubtitleSegments.length ? '' : outputs.srtPath,
      subtitleSegments: exportSubtitleSegments,
      fileName: config.outputFileName,
      outputDirectory: config.outputDirectory,
      outputCreateFolder: config.outputCreateFolder,
      outputFolderName: config.outputFolderName,
      outputFormat: config.outputFormat,
      outputAspectRatio: normalizeOutputAspectRatio(config.outputAspectRatio),
      keepBackgroundMusic: config.keepBackgroundMusic,
      originalAudioVolume: config.originalAudioVolume,
      softSubtitles: subtitleExportMode === 'soft',
      softSubtitleLanguage: config.targetLanguage || 'und',
      softSubtitleTitle: 'DubFlow subtitles',
      burnSubtitles: subtitleExportMode === 'burn',
      subtitleStyle: {
        fontFamily: config.subtitleFontFamily,
        fontSize: normalizeSubtitleFontSize(config.subtitleFontSize),
        textColor: config.subtitleTextColor,
        outlineEnabled: false,
        outlineColor: config.subtitleOutlineColor,
        position: 'custom',
        positionX: config.subtitlePositionX,
        positionY: config.subtitlePositionY,
        renderScale: subtitleRenderScale,
        boxEnabled: config.subtitleBoxEnabled !== false,
        backgroundColor: config.subtitleBoxEnabled !== false ? config.subtitleBoxColor : '#000000',
        backgroundOpacity: config.subtitleBoxEnabled !== false ? config.subtitleBoxOpacity : 0,
        backgroundRadius: config.subtitleBoxEnabled !== false ? config.subtitleBoxRadius : 0,
        // Match the tight per-line subtitle preview box.
        boxPaddingX: config.subtitleBoxEnabled !== false ? 7 : 0,
        boxPaddingY: config.subtitleBoxEnabled !== false ? 3 : 0,
        coverEnabled: config.subtitleCoverEnabled === true,
        coverMode: 'blur',
        coverBlur: config.subtitleCoverBlur,
        coverFeather: config.subtitleCoverFeather,
        coverColor: config.subtitleCoverColor,
        coverOpacity: config.subtitleCoverOpacity,
        coverX: config.subtitleCoverX,
        coverY: config.subtitleCoverY,
        coverW: config.subtitleCoverW,
        coverH: config.subtitleCoverH,
        maxCharsPerLine: displayMaxLineLength,
      },
      textOverlay: config.overlayEnabled === true ? {
        text: config.overlayText,
        x: config.overlayX,
        y: config.overlayY,
        start: config.overlayStart,
        end: config.overlayEnd,
        fontFamily: config.subtitleFontFamily,
        fontSize: normalizeSubtitleFontSize(config.subtitleFontSize),
        textColor: config.subtitleTextColor,
        outlineEnabled: false,
        outlineColor: config.subtitleOutlineColor,
        backgroundColor: config.subtitleBoxEnabled ? config.subtitleBoxColor : '#000000',
        backgroundOpacity: config.subtitleBoxEnabled ? config.subtitleBoxOpacity : 0,
      } : null,
      musicEnabled: config.musicEnabled === true,
      musicPath: config.musicPath,
      musicVolume: config.musicVolume,
      musicFade: config.musicFade,
      logoEnabled: config.logoEnabled === true,
      logoPath: config.logoPath,
      logoPosition: config.logoPosition,
      logoX: config.logoX,
      logoY: config.logoY,
      logoSize: config.logoSize,
      logoOpacity: config.logoOpacity,
      randomLogoText: false,
      randomLogoPaths: '',
      randomIntervalSeconds: config.randomIntervalSeconds,
      subtitleBoxEnabled: config.subtitleBoxEnabled,
      subtitleBoxColor: config.subtitleBoxColor,
      subtitleBoxOpacity: config.subtitleBoxOpacity,
      subtitleBoxRadius: config.subtitleBoxRadius,
      subtitleOutlineEnabled: false,
      subtitleCoverEnabled: config.subtitleCoverEnabled === true,
      subtitleCoverMode: 'blur',
      subtitleCoverBlur: config.subtitleCoverBlur,
      subtitleCoverFeather: config.subtitleCoverFeather,
      subtitleCoverColor: config.subtitleCoverColor,
      subtitleCoverOpacity: config.subtitleCoverOpacity,
      subtitleCoverX: config.subtitleCoverX,
      subtitleCoverY: config.subtitleCoverY,
      subtitleCoverW: config.subtitleCoverW,
      subtitleCoverH: config.subtitleCoverH,
      backgroundColor: config.backgroundColor,
      backgroundOpacity: config.backgroundOpacity,
      outputQuality: config.outputQuality,
    });
    const nextOutputs = {
      ...outputs,
      videoPath: data.savedOutputPath || data.outputPath || '',
      videoUrl: cacheBustUrl(data.outputUrl || ''),
    };
    if (data.softSubtitlePath || data.softSubtitleUrl) {
      nextOutputs.softSubtitlePath = data.softSubtitlePath || '';
      nextOutputs.softSubtitleUrl = cacheBustUrl(data.softSubtitleUrl || '');
      nextOutputs.srtPath = data.softSubtitlePath || nextOutputs.srtPath || '';
      nextOutputs.srtUrl = cacheBustUrl(data.softSubtitleUrl || nextOutputs.srtUrl || '');
    } else if (config.softSubtitles === false) {
      nextOutputs.softSubtitlePath = '';
      nextOutputs.softSubtitleUrl = '';
    }
    patchState({ outputs: nextOutputs, currentStage: 'video' });
    if (data.softSubtitlePath) addLog(`Đã lưu sub mềm: ${data.savedSoftSubtitlePath || data.softSubtitlePath}`);
    if (data.savedOutputPath || data.outputPath) addLog(`Đã lưu video: ${data.savedOutputPath || data.outputPath}`);
  };

  const runMux = () => runTask('xuất video', muxVideo);
  const splitSelected = () => {
    if (!selectedRow) return;
    const text = rowText(selectedRow, finalField);
    if (text.length < 8) return;
    const storySplit = Array.isArray(selectedRow.atomIds) && selectedRow.atomIds.length > 0;
    if (storySplit && (selectedRow.atomIds.length < 2 || selectedRow.sourceIds.length < 2)) {
      addLog('Câu story này chỉ có một atom/cue nên không thể tách mapping an toàn. Hãy dịch lại đoạn.');
      return;
    }
    pushRowsUndo();
    const mid = Math.floor(text.length / 2);
    const splitAt = Math.max(text.lastIndexOf(' ', mid), 1);
    const leftText = text.slice(0, splitAt).trim();
    const rightText = text.slice(splitAt).trim();
    const sourceSplitIndex = storySplit ? Math.ceil(selectedRow.sourceIds.length / 2) : 0;
    const atomSplitIndex = storySplit ? Math.ceil(selectedRow.atomIds.length / 2) : 0;
    const rightSourceCue = storySplit
      ? state.storyTranslation?.sourceCues?.find((cue) => cue.id === selectedRow.sourceIds[sourceSplitIndex])
      : null;
    const splitTime = rightSourceCue?.start ?? (selectedRow.start + selectedRow.duration * clamp(leftText.length / text.length, 0.25, 0.75));
    const nextRows = [];
    rows.forEach((row) => {
      if (row.id !== selectedRow.id) {
        nextRows.push(row);
        return;
      }
      nextRows.push({ ...row, end: splitTime, duration: splitTime - row.start, [finalField]: leftText, sourceIds: storySplit ? row.sourceIds.slice(0, sourceSplitIndex) : row.sourceIds, sourceRowIds: storySplit ? row.sourceIds.slice(0, sourceSplitIndex) : row.sourceRowIds, atomIds: storySplit ? row.atomIds.slice(0, atomSplitIndex) : row.atomIds, status: storySplit ? 'needs_review' : row.status, validationStatus: storySplit ? 'needs_review' : row.validationStatus, dirty: true });
      nextRows.push({ ...row, id: `${row.id}-b`, start: splitTime, duration: row.end - splitTime, [finalField]: rightText, sourceIds: storySplit ? row.sourceIds.slice(sourceSplitIndex) : row.sourceIds, sourceRowIds: storySplit ? row.sourceIds.slice(sourceSplitIndex) : row.sourceRowIds, atomIds: storySplit ? row.atomIds.slice(atomSplitIndex) : row.atomIds, status: storySplit ? 'needs_review' : row.status, validationStatus: storySplit ? 'needs_review' : row.validationStatus, dirty: true });
    });
    patchState({
      rows: nextRows.map((row, index) => ({ ...row, index: index + 1 })),
      storyTranslation: storySplit && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_split_requires_revalidation'] },
      } : state.storyTranslation,
    });
  };

  const splitRow = (rowId) => {
    const rowToSplit = rows.find((row) => row.id === rowId);
    if (!rowToSplit) return;
    const text = rowText(rowToSplit, finalField);
    if (text.length < 8) return;
    const storySplit = Array.isArray(rowToSplit.atomIds) && rowToSplit.atomIds.length > 0;
    if (storySplit && (rowToSplit.atomIds.length < 2 || rowToSplit.sourceIds.length < 2)) {
      addLog('Câu story này chỉ có một atom/cue nên không thể tách mapping an toàn. Hãy dịch lại đoạn.');
      setContextMenu(null);
      return;
    }
    pushRowsUndo();
    const mid = Math.floor(text.length / 2);
    const splitAt = Math.max(text.lastIndexOf(' ', mid), 1);
    const leftText = text.slice(0, splitAt).trim();
    const rightText = text.slice(splitAt).trim();
    const sourceSplitIndex = storySplit ? Math.ceil(rowToSplit.sourceIds.length / 2) : 0;
    const atomSplitIndex = storySplit ? Math.ceil(rowToSplit.atomIds.length / 2) : 0;
    const rightSourceCue = storySplit
      ? state.storyTranslation?.sourceCues?.find((cue) => cue.id === rowToSplit.sourceIds[sourceSplitIndex])
      : null;
    const splitTime = rightSourceCue?.start ?? (rowToSplit.start + rowToSplit.duration * clamp(leftText.length / text.length, 0.25, 0.75));
    const nextRows = [];
    rows.forEach((row) => {
      if (row.id !== rowToSplit.id) {
        nextRows.push(row);
        return;
      }
      nextRows.push({ ...row, end: splitTime, duration: splitTime - row.start, [finalField]: leftText, sourceIds: storySplit ? row.sourceIds.slice(0, sourceSplitIndex) : row.sourceIds, sourceRowIds: storySplit ? row.sourceIds.slice(0, sourceSplitIndex) : row.sourceRowIds, atomIds: storySplit ? row.atomIds.slice(0, atomSplitIndex) : row.atomIds, status: storySplit ? 'needs_review' : row.status, validationStatus: storySplit ? 'needs_review' : row.validationStatus, dirty: true });
      nextRows.push({ ...row, id: `${row.id}-b`, start: splitTime, duration: row.end - splitTime, [finalField]: rightText, sourceIds: storySplit ? row.sourceIds.slice(sourceSplitIndex) : row.sourceIds, sourceRowIds: storySplit ? row.sourceIds.slice(sourceSplitIndex) : row.sourceRowIds, atomIds: storySplit ? row.atomIds.slice(atomSplitIndex) : row.atomIds, status: storySplit ? 'needs_review' : row.status, validationStatus: storySplit ? 'needs_review' : row.validationStatus, dirty: true });
    });
    patchState({
      rows: nextRows.map((row, index) => ({ ...row, index: index + 1 })),
      storyTranslation: storySplit && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_split_requires_revalidation'] },
      } : state.storyTranslation,
    });
    setContextMenu(null);
  };

  const mergeWithNext = () => {
    if (!selectedRow) return;
    const index = rows.findIndex((row) => row.id === selectedRow.id);
    const next = rows[index + 1];
    if (!next) return;
    pushRowsUndo();
    const merged = {
      ...selectedRow,
      end: next.end,
      duration: next.end - selectedRow.start,
      [finalField]: [rowText(selectedRow, finalField), rowText(next, finalField)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      sourceIds: Array.from(new Set([...(selectedRow.sourceIds || []), ...(next.sourceIds || [])])),
      sourceRowIds: Array.from(new Set([...(selectedRow.sourceRowIds || selectedRow.sourceIds || []), ...(next.sourceRowIds || next.sourceIds || [])])),
      atomIds: Array.from(new Set([...(selectedRow.atomIds || []), ...(next.atomIds || [])])),
      status: selectedRow.atomIds?.length || next.atomIds?.length ? 'needs_review' : selectedRow.status,
      validationStatus: selectedRow.atomIds?.length || next.atomIds?.length ? 'needs_review' : selectedRow.validationStatus,
      dirty: true,
    };
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index && rowIndex !== index + 1);
    nextRows.splice(index, 0, merged);
    patchState({
      rows: nextRows.map((row, rowIndex) => ({ ...row, index: rowIndex + 1 })),
      storyTranslation: merged.atomIds.length && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_merge_requires_revalidation'] },
      } : state.storyTranslation,
    });
  };

  const updateRowText = (rowId, value) => {
    pushRowsUndo();
    patchState({
      rows: rows.map((row) => (row.id === rowId ? {
        ...row,
        [finalField]: value,
        dirty: true,
        status: row.atomIds?.length ? 'needs_review' : row.status,
        validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus,
      } : row)),
      storyTranslation: state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_edit_requires_revalidation'] },
      } : null,
    });
  };

  const seekTo = (time) => {
    const nextTime = clamp(Number(time) || 0, 0, Math.max(1, Number(job.durationSeconds) || 1));
    const activeRow = rows.find((row) => nextTime >= row.start && nextTime <= row.end);
    patchState({ currentTime: nextTime, selectedRowId: activeRow?.id || state.selectedRowId });
    if (mediaRef.current) mediaRef.current.currentTime = nextTime;
    if (dubbedAudioRef.current) dubbedAudioRef.current.currentTime = nextTime;
  };

  const selectRow = (row) => {
    const nextTime = clamp(Number(row.start) || 0, 0, Math.max(1, Number(job.durationSeconds) || 1));
    const rowIndex = rows.findIndex((item) => item === row);
    const nextRows = hasDuplicateRowIds(rows) ? ensureUniqueRowIds(rows) : rows;
    const selected = rowIndex >= 0 ? nextRows[rowIndex] : row;
    patchState({
      ...(nextRows !== rows ? { rows: nextRows } : {}),
      selectedRowId: selected?.id || row.id,
      currentTime: nextTime,
    });
    if (mediaRef.current) mediaRef.current.currentTime = nextTime;
    if (dubbedAudioRef.current) dubbedAudioRef.current.currentTime = nextTime;
    setSeekToken(Date.now());
  };

  const goToNeighborRow = (direction) => {
    if (!rows.length) return;
    let currentIndex = rows.findIndex((row) => row.id === state.selectedRowId);
    if (currentIndex < 0) {
      currentIndex = rows.findIndex((row) => (Number(state.currentTime) || 0) < row.end);
    }
    currentIndex = clamp(currentIndex, 0, rows.length - 1);
    const nextIndex = clamp(currentIndex + direction, 0, rows.length - 1);
    selectRow(rows[nextIndex]);
  };

  const beginEdit = (row) => {
    setEditingRowId(row.id);
    setEditDraft(rowText(row, finalField));
  };

  const openTimingEditor = (row) => {
    setTimingDraft({
      id: row.id,
      start: Number(row.start || 0).toFixed(3),
      end: Number(row.end || 0).toFixed(3),
      text: rowText(row, finalField),
    });
    setTimingFrom('');
    setTimingTo('');
    setActiveModal('rowTiming');
  };

  const selectTimingEditorRow = (row) => {
    setTimingDraft({
      id: row.id,
      start: Number(row.start || 0).toFixed(3),
      end: Number(row.end || 0).toFixed(3),
      text: rowText(row, finalField),
    });
    selectRow(row);
  };

  const saveTimingEditor = (closeModal = true) => {
    if (!timingDraft?.id) return;
    pushRowsUndo();
    const start = Math.max(0, parseDecimal(timingDraft.start, 0));
    const end = Math.max(start + 0.1, parseDecimal(timingDraft.end, start + 1));
    const nextRows = rows.map((row) => (
      row.id === timingDraft.id
        ? { ...row, start, end, duration: end - start, [finalField]: timingDraft.text, dirty: true, status: row.atomIds?.length ? 'needs_review' : row.status, validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus }
        : row
    ));
    const editedStoryTiming = nextRows.find((row) => row.id === timingDraft.id)?.atomIds?.length;
    patchState({
      rows: nextRows,
      selectedRowId: timingDraft.id,
      currentTime: start,
      storyTranslation: editedStoryTiming && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_timing_requires_revalidation'] },
      } : state.storyTranslation,
    });
    if (mediaRef.current) mediaRef.current.currentTime = start;
    if (dubbedAudioRef.current) dubbedAudioRef.current.currentTime = start;
    setTimingDraft((draft) => (draft ? { ...draft, start: start.toFixed(3), end: end.toFixed(3) } : draft));
    if (closeModal) {
      setTimingDraft(null);
      setActiveModal(null);
    }
  };

  const replaceTimingText = (replaceAll = false) => {
    const search = String(timingSearch || '');
    if (!search) return;
    const replacement = String(timingReplace || '');

    if (!replaceAll) {
      setTimingDraft((draft) => (
        draft ? { ...draft, text: String(draft.text || '').replace(search, replacement) } : draft
      ));
      return;
    }

    const fromIndex = Math.max(1, parseInt(timingFrom, 10) || 1);
    const toIndex = Math.min(rows.length, parseInt(timingTo, 10) || rows.length);
    pushRowsUndo();
    const nextRows = rows.map((row) => {
      if (row.index < fromIndex || row.index > toIndex) return row;
      return {
        ...row,
        [finalField]: rowText(row, finalField).split(search).join(replacement),
        dirty: true,
      };
    });
    patchState({ rows: nextRows });
    const selected = nextRows.find((row) => row.id === timingDraft?.id);
    if (selected) {
      setTimingDraft((draft) => (draft ? { ...draft, text: rowText(selected, finalField) } : draft));
    }
  };

  const cancelEdit = () => {
    setEditingRowId('');
    setEditDraft('');
  };

  const commitEdit = (moveNext = false) => {
    if (!editingRowId) return;
    updateRowText(editingRowId, editDraft);
    const rowIndex = rows.findIndex((row) => row.id === editingRowId);
    cancelEdit();
    if (moveNext && rows[rowIndex + 1]) {
      selectRow(rows[rowIndex + 1]);
      beginEdit(rows[rowIndex + 1]);
    }
  };

  const openBulkEditor = (mode = 'all') => {
    setBulkEditMode(mode);
    if (mode === 'ttsRepair') {
      const firstRepair = ttsRepairRows.find((item) => String(item.rowId) === String(state.selectedRowId)) || ttsRepairRows[0] || null;
      setTtsRepairSelectedRowId(firstRepair?.rowId || '');
      const repairRow = firstRepair ? rows.find((row) => String(row.id) === String(firstRepair.rowId)) : null;
      if (repairRow) selectRow(repairRow);
    } else {
      setBulkEditDraft(rows.map((row) => rowText(row, finalField)).join('\n'));
      const firstRow = rows.find((row) => row.id === state.selectedRowId) || rows[0] || null;
      setBulkEditSelectedId(firstRow?.id || '');
      setBulkEditSelectedText(firstRow ? rowText(firstRow, finalField) : '');
    }
    setActiveModal('bulkEditV2');
  };

  const applyBulkEdit = () => {
    pushRowsUndo();
    const lines = String(bulkEditDraft || '').split(/\r?\n/);
    const nextRows = rows.map((row, index) => ({
      ...row,
      [finalField]: lines[index] ?? '',
      dirty: true,
      status: row.atomIds?.length ? 'needs_review' : row.status,
      validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus,
    }));
    patchState({
      rows: nextRows,
      storyTranslation: state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_edit_requires_revalidation'] },
      } : null,
    });
    setActiveModal(null);
    addLog('Đã cập nhật nội dung hàng loạt.');
  };

  const bulkEditRows = () => String(bulkEditDraft || '').split(/\r?\n/);

  const updateBulkEditLine = (row, value) => {
    const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
    if (rowIndex < 0) return;
    const lines = bulkEditRows();
    while (lines.length < rows.length) {
      const nextRow = rows[lines.length];
      lines.push(nextRow ? rowText(nextRow, finalField) : '');
    }
    const nextValue = String(value || '').replace(/\r?\n/g, ' ');
    lines[rowIndex] = nextValue;
    setBulkEditDraft(lines.join('\n'));
    setBulkEditSelectedId(row.id);
    setBulkEditSelectedText(nextValue);
    selectRow(row);
  };

  const selectBulkEditRow = (row) => {
    const lines = bulkEditRows();
    setBulkEditSelectedId(row.id);
    setBulkEditSelectedText(lines[row.index - 1] ?? rowText(row, finalField));
    selectRow(row);
  };

  const applyBulkEditSelectedRow = () => {
    if (!bulkEditSelectedId) return;
    const index = rows.findIndex((row) => row.id === bulkEditSelectedId);
    if (index < 0) return;
    const lines = bulkEditRows();
    lines[index] = bulkEditSelectedText;
    setBulkEditDraft(lines.join('\n'));
  };

  const deleteRow = (rowId) => {
    const deletedRow = rows.find((row) => row.id === rowId);
    if (!deletedRow) return;
    pushRowsUndo();
    const deletedIndex = rows.findIndex((row) => row.id === rowId);
    const hadGeneratedVoice = hasGeneratedTtsOutput(outputs) || ['voice', 'video'].includes(state.currentStage);
    const nextRows = rows
      .filter((row) => row.id !== rowId)
      .map((row, index) => ({ ...stripTtsRuntimeFromRow(row), index: index + 1 }));
    const nextRowIds = new Set(nextRows.map((row) => String(row.id)));
    const nextSelectedRow = nextRows[Math.min(Math.max(deletedIndex, 0), Math.max(nextRows.length - 1, 0))] || nextRows[0] || null;
    const patch = {
      rows: nextRows,
      meaningUnits: [],
      ttsUnits: [],
      ttsRepairBasket: hadGeneratedVoice
        ? []
        : ttsRepairBasket.filter((item) => nextRowIds.has(String(item.rowId || item.row_id || ''))),
      selectedRowId: nextSelectedRow?.id || '',
      currentTime: Number(nextSelectedRow?.start ?? state.currentTime) || 0,
      currentStage: ['voice', 'video'].includes(state.currentStage) ? 'final' : state.currentStage,
      storyTranslation: deletedRow.atomIds?.length && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_delete_requires_revalidation'] },
      } : state.storyTranslation,
    };
    if (hadGeneratedVoice) {
      unloadDubbedAudio();
      setTtsRepairPreviewAudio('');
      setTtsRepairPreviewAudioRowIds([]);
      setTtsRepairPreviewAudioByRowId({});
      setTtsRepairSelectedRowId('');
      patch.outputs = { ...outputs, ...CLEARED_TTS_OUTPUTS };
      patch.config = { ...config, dubbedAudioEnabled: false };
    } else {
      clearTtsRepairPreviewAudioForRows([rowId]);
    }
    patchState(patch);
    if (hadGeneratedVoice) {
      addLog(`Da xoa audio TTS cu vi dong ${deletedRow.index || deletedRow.id} da bi xoa. Hay chay Long tieng lai de tao audio moi.`);
    }
    setContextMenu(null);
  };

  const mergeRowWithPrevious = (rowId) => {
    const index = rows.findIndex((row) => row.id === rowId);
    if (index <= 0) return;
    pushRowsUndo();
    patchState({
      rows: rows
        .map((row, rowIndex) => {
          if (rowIndex !== index - 1) return row;
          const next = rows[index];
          return {
            ...row,
            end: next.end,
            duration: next.end - row.start,
            [finalField]: [rowText(row, finalField), rowText(next, finalField)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
            sourceIds: Array.from(new Set([...(row.sourceIds || []), ...(next.sourceIds || [])])),
            sourceRowIds: Array.from(new Set([...(row.sourceRowIds || row.sourceIds || []), ...(next.sourceRowIds || next.sourceIds || [])])),
            atomIds: Array.from(new Set([...(row.atomIds || []), ...(next.atomIds || [])])),
            status: row.atomIds?.length || next.atomIds?.length ? 'needs_review' : row.status,
            validationStatus: row.atomIds?.length || next.atomIds?.length ? 'needs_review' : row.validationStatus,
            dirty: true,
          };
        })
        .filter((_, rowIndex) => rowIndex !== index)
        .map((row, rowIndex) => ({ ...row, index: rowIndex + 1 })),
    });
    setContextMenu(null);
  };

  const mergeRowWithNext = (rowId) => {
    const index = rows.findIndex((row) => row.id === rowId);
    const next = rows[index + 1];
    if (index < 0 || !next) return;
    pushRowsUndo();
    const current = rows[index];
    const merged = {
      ...current,
      end: next.end,
      duration: next.end - current.start,
      [finalField]: [rowText(current, finalField), rowText(next, finalField)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      sourceIds: Array.from(new Set([...(current.sourceIds || []), ...(next.sourceIds || [])])),
      sourceRowIds: Array.from(new Set([...(current.sourceRowIds || current.sourceIds || []), ...(next.sourceRowIds || next.sourceIds || [])])),
      atomIds: Array.from(new Set([...(current.atomIds || []), ...(next.atomIds || [])])),
      status: current.atomIds?.length || next.atomIds?.length ? 'needs_review' : current.status,
      validationStatus: current.atomIds?.length || next.atomIds?.length ? 'needs_review' : current.validationStatus,
      dirty: true,
    };
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index && rowIndex !== index + 1);
    nextRows.splice(index, 0, merged);
    patchState({ rows: nextRows.map((row, rowIndex) => ({ ...row, index: rowIndex + 1 })) });
    setContextMenu(null);
  };

  const retranslateRow = (rowId) => runTask('dịch lại dòng', async () => {
    const row = rows.find((item) => item.id === rowId);
    if (!row) return;
    const sourceText = String(row.sourceText || row.originalText || '').trim();
    const lineText = sourceText || rowText(row, 'sourceText') || rowText(row, finalField);
    if (!lineText.trim()) throw new Error('Dòng này chưa có text nguồn để dịch.');
    const data = await callApi('/api/manual/translate-line', {
      jobId: job.jobId,
      segment: {
        id: row.id,
        start: row.start,
        end: row.end,
        duration: row.duration,
        text: lineText,
        sourceText: lineText,
        originalText: sourceText || lineText,
        sourceIds: row.sourceIds || [],
        sourceRowIds: row.sourceRowIds || row.sourceIds || [],
        originalCues: row.originalCues || [],
        templateGroupCreatedBy: row.templateGroupCreatedBy,
        templateGroupReason: row.templateGroupReason,
        templateGroupConfidence: row.templateGroupConfidence,
      },
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      translationProvider: config.translationProvider,
      cliTranslationModel: config.cliTranslationModel,
      cliTranslationConcurrency: Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency),
      translationMode: config.translationMode || DEFAULT_STATE.config.translationMode,
      templateGroupTranslation: rowsAreTemplateGroups([row]),
      videoContext: config.videoContext,
      customGlossary: '',
      googleCloudConfig: googleCloudConfig(),
    });
    const text = String(data.segment?.text || '').trim();
    if (text) {
      patchState({
        rows: rows.map((item) => item.id === rowId ? { ...item, translatedText: text, finalText: text, ttsText: text, status: 'translated', dirty: true } : item),
        currentStage: 'final',
        outputs: { ...outputs, audioPath: '', audioUrl: '', videoPath: '', videoUrl: '' },
      });
      addLog(`Đã dịch lại đúng dòng ${row.index || row.id}.`);
    }
  });

  const reorderRows = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const fromIndex = rows.findIndex((row) => row.id === fromId);
    const toIndex = rows.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextRows = [...rows];
    const [moved] = nextRows.splice(fromIndex, 1);
    nextRows.splice(toIndex, 0, moved);
    const reordersStory = nextRows.some((row) => row.atomIds?.length);
    patchState({
      rows: nextRows.map((row, index) => ({ ...row, index: index + 1, dirty: true, status: row.atomIds?.length ? 'needs_review' : row.status, validationStatus: row.atomIds?.length ? 'needs_review' : row.validationStatus })),
      storyTranslation: reordersStory && state.storyTranslation ? {
        ...state.storyTranslation,
        validation: { ...(state.storyTranslation.validation || {}), valid: false, status: 'needs_review', errors: ['manual_reorder_requires_revalidation'] },
      } : state.storyTranslation,
    });
    setDraggingRowId('');
  };
  const applyOverlayTextToVideo = () => {
    const text = String(config.overlayText || '').trim();
    if (!text) return;
    const defaultWindow = Number(config.overlayStart) === 0 && Number(config.overlayEnd) === 5;
    const currentTime = Math.max(0, Number(state.currentTime) || 0);
    const start = defaultWindow && currentTime > 0.1 ? currentTime : Number(config.overlayStart) || 0;
    const end = defaultWindow && currentTime > 0.1
      ? start + 5
      : Math.max(start + 0.8, Number(config.overlayEnd) || start + 5);
    patchConfig({ overlayEnabled: true, overlayText: text, overlayStart: start, overlayEnd: end });
    addLog('✅ Đã thêm văn bản vào video. Khi xuất, chữ này sẽ được render trực tiếp lên video.');
  };

  const applyBackgroundToTimeline = () => {
    if (!rows.length) return;
    const targetSelected = config.backgroundApplyTo === 'selected' && state.selectedRowId;
    const nextRows = rows.map((row) => {
      if (targetSelected && row.id !== state.selectedRowId) return row;
      return {
        ...row,
        style: {
          ...(row.style || {}),
          backgroundColor: config.backgroundColor,
          backgroundOpacity: config.backgroundOpacity,
        },
        dirty: true,
      };
    });
    patchState({ rows: nextRows });
    addLog(`✅ Đã áp dụng nền màu cho ${targetSelected ? 'dòng đang chọn' : 'toàn bộ timeline'}.`);
  };

  const clearSubtitleStyle = () => {
    patchConfig({
      subtitleFontFamily: DEFAULT_STATE.config.subtitleFontFamily,
      subtitleFontSize: DEFAULT_STATE.config.subtitleFontSize,
      maxCharsPerLine: DEFAULT_STATE.config.maxCharsPerLine,
      subtitlePreviewEnabled: DEFAULT_STATE.config.subtitlePreviewEnabled,
      subtitleTextColor: DEFAULT_STATE.config.subtitleTextColor,
      subtitleOutlineEnabled: DEFAULT_STATE.config.subtitleOutlineEnabled,
      subtitleOutlineColor: DEFAULT_STATE.config.subtitleOutlineColor,
      subtitlePosition: DEFAULT_STATE.config.subtitlePosition,
      subtitlePositionX: DEFAULT_STATE.config.subtitlePositionX,
      subtitlePositionY: DEFAULT_STATE.config.subtitlePositionY,
      subtitleBoxEnabled: DEFAULT_STATE.config.subtitleBoxEnabled,
      subtitleBoxColor: DEFAULT_STATE.config.subtitleBoxColor,
      subtitleBoxOpacity: DEFAULT_STATE.config.subtitleBoxOpacity,
      subtitleBoxRadius: DEFAULT_STATE.config.subtitleBoxRadius,
      subtitleCoverEnabled: DEFAULT_STATE.config.subtitleCoverEnabled,
      subtitleCoverMode: DEFAULT_STATE.config.subtitleCoverMode,
      subtitleCoverBlur: DEFAULT_STATE.config.subtitleCoverBlur,
      subtitleCoverFeather: DEFAULT_STATE.config.subtitleCoverFeather,
      subtitleCoverColor: DEFAULT_STATE.config.subtitleCoverColor,
      subtitleCoverOpacity: DEFAULT_STATE.config.subtitleCoverOpacity,
      subtitleCoverX: DEFAULT_STATE.config.subtitleCoverX,
      subtitleCoverY: DEFAULT_STATE.config.subtitleCoverY,
      subtitleCoverW: DEFAULT_STATE.config.subtitleCoverW,
      subtitleCoverH: DEFAULT_STATE.config.subtitleCoverH,
    });
    addLog('✅ Đã reset mẫu phụ đề.');
  };

  const logoPresetPosition = (value) => {
    const preset = String(value || 'custom');
    const coordinates = {
      'top-left': { logoX: 12, logoY: 12 },
      'top-center': { logoX: 50, logoY: 12 },
      'top-right': { logoX: 88, logoY: 12 },
      'middle-left': { logoX: 12, logoY: 50 },
      center: { logoX: 50, logoY: 50 },
      'middle-right': { logoX: 88, logoY: 50 },
      'bottom-left': { logoX: 12, logoY: 88 },
      'bottom-center': { logoX: 50, logoY: 88 },
      'bottom-right': { logoX: 88, logoY: 88 },
    }[preset] || {
      logoX: Number(config.logoX ?? 88) || 88,
      logoY: Number(config.logoY ?? 12) || 12,
    };
    patchConfig({ logoEnabled: true, logoPosition: preset, ...coordinates });
  };

  const videoContentRect = () => {
    const video = mediaRef.current;
    const rect = video?.getBoundingClientRect?.();
    if (!video || !rect) return null;
    const naturalRatio = (Number(video.videoWidth) || 16) / Math.max(1, Number(video.videoHeight) || 9);
    const boxRatio = rect.width / Math.max(1, rect.height);
    let width = rect.width;
    let height = rect.height;
    let left = rect.left;
    let top = rect.top;
    if (boxRatio > naturalRatio) {
      width = rect.height * naturalRatio;
      left = rect.left + (rect.width - width) / 2;
    } else {
      height = rect.width / naturalRatio;
      top = rect.top + (rect.height - height) / 2;
    }
    return { left, top, width, height };
  };

  const pointInVideoPercent = (event) => {
    const rect = videoContentRect();
    if (!rect) return null;
    const clientX = Number(event.clientX ?? event.touches?.[0]?.clientX ?? 0);
    const clientY = Number(event.clientY ?? event.touches?.[0]?.clientY ?? 0);
    return {
      x: clamp(((clientX - rect.left) / Math.max(1, rect.width)) * 100, 0, 100),
      y: clamp(((clientY - rect.top) / Math.max(1, rect.height)) * 100, 0, 100),
    };
  };

  const subtitleCoverRect = () => {
    const rawX = Number(config.subtitleCoverX);
    const rawY = Number(config.subtitleCoverY);
    const rawWidth = Number(config.subtitleCoverW);
    const rawHeight = Number(config.subtitleCoverH);
    const width = clamp(Number.isFinite(rawWidth) ? rawWidth : 64, 2, 100);
    const height = clamp(Number.isFinite(rawHeight) ? rawHeight : 10, 2, 100);
    return {
      x: clamp(Number.isFinite(rawX) ? rawX : 18, 0, Math.max(0, 100 - width)),
      y: clamp(Number.isFinite(rawY) ? rawY : 82, 0, Math.max(0, 100 - height)),
      width,
      height,
    };
  };

  const startSubtitleDrag = (event, type, corner = '') => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    const point = pointInVideoPercent(event);
    if (!point) return;
    if (type === 'subtitleResize') {
      const centerX = clamp(Number(config.subtitlePositionX ?? 50) || 50, 3, 97);
      const centerY = clamp(Number(config.subtitlePositionY ?? 88) || 88, 5, 95);
      setSubtitleDrag({
        type,
        corner,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        centerX,
        centerY,
        startDistance: Math.hypot(point.x - centerX, point.y - centerY),
        startFontSize: normalizeSubtitleFontSize(config.subtitleFontSize),
      });
      return;
    }
    if (type === 'coverResize') {
      const rect = subtitleCoverRect();
      setSubtitleDrag({
        type,
        corner,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: rect.x,
        startY: rect.y,
        startW: rect.width,
        startH: rect.height,
      });
      return;
    }
    if (type === 'logoResize') {
      const centerX = clamp(Number(config.logoX ?? 88), 0, 100);
      const centerY = clamp(Number(config.logoY ?? 12), 0, 100);
      setSubtitleDrag({
        type,
        corner,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        centerX,
        centerY,
        startDistance: Math.hypot(point.x - centerX, point.y - centerY),
        startSize: Number(config.logoSize ?? 18),
      });
      return;
    }
    const base = type === 'cover'
      ? subtitleCoverRect()
      : type === 'overlayText'
        ? { x: Number(config.overlayX ?? 50), y: Number(config.overlayY ?? 50) }
        : type === 'logo'
          ? { x: Number(config.logoX ?? 88), y: Number(config.logoY ?? 12) }
        : { x: Number(config.subtitlePositionX ?? 50), y: Number(config.subtitlePositionY ?? 88) };
    setSubtitleDrag({ type, pointerId: event.pointerId, pointerType: event.pointerType, offsetX: point.x - base.x, offsetY: point.y - base.y });
  };

  const applySubtitleDragPoint = (event, dragState = subtitleDrag) => {
    if (!dragState) return;
    const point = pointInVideoPercent(event);
    if (!point) return;
    if (dragState.type === 'subtitleResize') {
      const distance = Math.hypot(point.x - Number(dragState.centerX ?? 50), point.y - Number(dragState.centerY ?? 88));
      const delta = (distance - Number(dragState.startDistance ?? distance)) * 1.4;
      patchConfig({
        subtitleFontSize: Number(clamp(Number(dragState.startFontSize ?? 32) + delta, SUBTITLE_FONT_SIZE_MIN, SUBTITLE_FONT_SIZE_MAX).toFixed(0)),
      });
      return;
    }
    if (dragState.type === 'coverResize') {
      const minSize = 2;
      let left = Number(dragState.startX ?? 18);
      let top = Number(dragState.startY ?? 82);
      let right = left + Number(dragState.startW ?? 64);
      let bottom = top + Number(dragState.startH ?? 10);

      if (dragState.corner.includes('w')) left = clamp(point.x, 0, right - minSize);
      if (dragState.corner.includes('e')) right = clamp(point.x, left + minSize, 100);
      if (dragState.corner.includes('n')) top = clamp(point.y, 0, bottom - minSize);
      if (dragState.corner.includes('s')) bottom = clamp(point.y, top + minSize, 100);

      patchConfig({
        subtitleCoverEnabled: true,
        subtitleCoverX: Number(left.toFixed(1)),
        subtitleCoverY: Number(top.toFixed(1)),
        subtitleCoverW: Number((right - left).toFixed(1)),
        subtitleCoverH: Number((bottom - top).toFixed(1)),
      });
      return;
    }
    if (dragState.type === 'logoResize') {
      const distance = Math.hypot(point.x - Number(dragState.centerX ?? 88), point.y - Number(dragState.centerY ?? 12));
      const delta = (distance - Number(dragState.startDistance ?? distance)) * 1.25;
      patchConfig({
        logoEnabled: true,
        logoPosition: 'custom',
        logoSize: Number(clamp(Number(dragState.startSize ?? 18) + delta, 0, 80).toFixed(1)),
      });
      return;
    }
    const x = Number(clamp(point.x - dragState.offsetX, 0, 100).toFixed(1));
    const y = Number(clamp(point.y - dragState.offsetY, 0, 100).toFixed(1));
    if (dragState.type === 'cover') {
      const rect = subtitleCoverRect();
      patchConfig({
        subtitleCoverEnabled: true,
        subtitleCoverX: Number(clamp(x, 0, Math.max(0, 100 - rect.width)).toFixed(1)),
        subtitleCoverY: Number(clamp(y, 0, Math.max(0, 100 - rect.height)).toFixed(1)),
      });
    } else if (dragState.type === 'overlayText') {
      patchConfig({ overlayX: x, overlayY: y });
    } else if (dragState.type === 'logo') {
      patchConfig({ logoPosition: 'custom', logoX: x, logoY: y });
    } else {
      patchConfig({ subtitlePosition: 'custom', subtitlePositionX: clamp(x, 3, 97), subtitlePositionY: clamp(y, 5, 95) });
    }
  };

  const moveSubtitleDrag = (event) => {
    if (!subtitleDrag) return;
    if (subtitleDrag.pointerId != null && event.pointerId != null && event.pointerId !== subtitleDrag.pointerId) return;
    if ((subtitleDrag.pointerType === 'mouse' || event.pointerType === 'mouse') && (event.buttons & 1) !== 1) {
      setSubtitleDrag(null);
      return;
    }
    event.preventDefault();
    applySubtitleDragPoint(event);
  };

  const stopSubtitleDrag = (event) => {
    if (subtitleDrag?.pointerId != null && event?.pointerId != null && event.pointerId !== subtitleDrag.pointerId) return;
    setSubtitleDrag(null);
  };

  const subtitleVideoStyle = (x, y, extra = {}) => {
    const rect = videoContentRect();
    const video = mediaRef.current;
    const outer = video?.getBoundingClientRect?.();
    if (!rect || !outer) {
      return { left: `${x}%`, top: `${y}%`, ...extra };
    }
    return {
      left: `${((rect.left - outer.left) / Math.max(1, outer.width)) * 100 + (x / 100) * (rect.width / Math.max(1, outer.width)) * 100}%`,
      top: `${((rect.top - outer.top) / Math.max(1, outer.height)) * 100 + (y / 100) * (rect.height / Math.max(1, outer.height)) * 100}%`,
      ...extra,
    };
  };

  const subtitleVideoBoxStyle = (x, y, width, height, extra = {}) => {
    const rect = videoContentRect();
    const video = mediaRef.current;
    const outer = video?.getBoundingClientRect?.();
    if (!rect || !outer) {
      return { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%`, ...extra };
    }
    return {
      left: `${((rect.left - outer.left) / Math.max(1, outer.width)) * 100 + (x / 100) * (rect.width / Math.max(1, outer.width)) * 100}%`,
      top: `${((rect.top - outer.top) / Math.max(1, outer.height)) * 100 + (y / 100) * (rect.height / Math.max(1, outer.height)) * 100}%`,
      width: `${(width / 100) * (rect.width / Math.max(1, outer.width)) * 100}%`,
      height: `${(height / 100) * (rect.height / Math.max(1, outer.height)) * 100}%`,
      ...extra,
    };
  };

  const subtitleVideoContentWidth = (width = 94) => {
    const rect = videoContentRect();
    const video = mediaRef.current;
    const outer = video?.getBoundingClientRect?.();
    if (!rect || !outer) return `${width}%`;
    return `${(clamp(Number(width) || 0, 0, 100) / 100) * (rect.width / Math.max(1, outer.width)) * 100}%`;
  };

  const exportPlainText = (kind) => runTask(kind === 'source' ? 'xuất Text gốc' : 'xuất Text dịch', async () => {
    const isSource = kind === 'source';
    const text = rows
      .map((row) => (isSource ? row.sourceText : (row.finalText || row.translatedText || row.sourceText)))
      .filter(Boolean)
      .join('\n');
    if (!text) throw new Error(isSource ? 'Chưa có Text gốc để xuất.' : 'Chưa có Text dịch để xuất.');

    const fileName = isSource ? 'source_original.txt' : 'translated_review.txt';
    if (!job.jobId) {
      downloadTextFile(text, fileName, isSource ? 'Đã xuất TXT phụ đề gốc.' : 'Đã xuất TXT bản dịch.');
      return;
    }

    const data = await callApi('/api/manual/export-text', {
      jobId: job.jobId,
      fileName,
      outputDirectory: config.outputDirectory,
      outputCreateFolder: config.outputCreateFolder,
      outputFolderName: config.outputFolderName,
      text,
    });
    if (data.savedOutputPath || data.outputPath) addLog(`Đã lưu TXT: ${data.savedOutputPath || data.outputPath}`);
  });

  const exportTxt = () => exportPlainText('translation');

  const exportSourceTxt = () => exportPlainText('source');

  const downloadTextFile = (text, fileName, message) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    addLog(`💾 ${message}`);
  };

  const copySubtitleText = async (kind) => {
    const isSource = kind === 'source';
    const text = rows
      .map((row) => (isSource ? row.sourceText : (row.finalText || row.translatedText || row.sourceText)))
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    addLog(`📋 Đã sao chép văn bản ${isSource ? 'STT gốc' : 'bản dịch'}.`);
  };

  const subtitleExportMode = config.burnSubtitles === true ? 'burn' : 'soft';
  const setSubtitleExportMode = (mode) => {
    const burn = mode === 'burn';
    patchConfig({
      burnSubtitles: burn,
      softSubtitles: !burn,
    });
  };

  const buildVideoExportChecks = () => {
    const subtitleSegments = rowsToSegments(rows, state.currentStage === 'source' ? 'sourceText' : 'finalText');
    const hasSubtitle = Boolean(subtitleSegments.length || outputs.srtPath);
    const logoPath = String(config.logoPath || '').trim();
    const musicPath = String(config.musicPath || '').trim();
    const overlayText = String(config.overlayText || '').trim();
    const logoSize = Number(config.logoSize ?? DEFAULT_STATE.config.logoSize);
    return [
      {
        key: 'source',
        label: 'Video nguồn',
        ok: Boolean(job.jobId),
        blocking: true,
        detail: job.jobId ? `Job ${job.jobId}` : 'Chưa chọn hoặc chuẩn bị video nguồn.',
      },
      {
        key: 'audio',
        label: 'Giọng đọc',
        ok: config.includeDubbedAudio === false || Boolean(outputs.audioPath),
        blocking: config.includeDubbedAudio !== false,
        detail: config.includeDubbedAudio === false
          ? 'Đã tắt giọng đọc khi xuất.'
          : (outputs.audioPath ? fileNameFromPath(outputs.audioPath) : 'Bật giọng đọc nhưng chưa có audio TTS.'),
      },
      {
        key: 'subtitle',
        label: 'Phụ đề',
        ok: true,
        blocking: false,
        present: hasSubtitle,
        detail: hasSubtitle
          ? `${subtitleSegments.length || 'file'} dòng, kiểu ${subtitleExportMode === 'burn' ? 'burn' : 'sub mềm'}`
          : 'Không có phụ đề, video sẽ xuất không kèm sub.',
      },
      {
        key: 'logo',
        label: 'Logo',
        ok: config.logoEnabled !== true || (Boolean(logoPath) && Number.isFinite(logoSize) && logoSize > 0),
        blocking: config.logoEnabled === true,
        present: Boolean(logoPath),
        detail: config.logoEnabled === true
          ? (logoPath ? `${fileNameFromPath(logoPath)} - ${logoSize}%` : 'Đã bật logo nhưng chưa chọn file.')
          : 'Đang tắt.',
      },
      {
        key: 'music',
        label: 'Nhạc nền',
        ok: config.musicEnabled !== true || Boolean(musicPath),
        blocking: config.musicEnabled === true,
        present: Boolean(musicPath),
        detail: config.musicEnabled === true
          ? (musicPath ? `${fileNameFromPath(musicPath)} - ${config.musicVolume}%` : 'Đã bật nhạc nền nhưng chưa chọn file.')
          : 'Đang tắt.',
      },
      {
        key: 'overlay',
        label: 'Chữ phủ',
        ok: config.overlayEnabled !== true || Boolean(overlayText),
        blocking: config.overlayEnabled === true,
        present: Boolean(overlayText),
        detail: config.overlayEnabled === true
          ? (overlayText ? overlayText.slice(0, 80) : 'Đã bật chữ phủ nhưng nội dung đang trống.')
          : 'Đang tắt.',
      },
    ];
  };
  const videoExportChecks = buildVideoExportChecks();
  const videoExportBlockingChecks = videoExportChecks.filter((item) => item.blocking && !item.ok);
  const canRunSelectedExport = exportAction === 'video'
    ? videoExportBlockingChecks.length === 0
    : rows.length > 0;

  const selectedExportLabel = () => {
    if (exportAction === 'srt_source') return 'Xuất SRT gốc';
    if (exportAction === 'srt_translation') return 'Xuất SRT dịch';
    if (exportAction === 'text_source') return 'Xuất Text gốc';
    if (exportAction === 'text_translation') return 'Xuất Text dịch';
    return 'Xuất video';
  };

  const runSelectedExport = () => {
    if (exportAction === 'srt_source') return exportSourceSrt();
    if (exportAction === 'srt_translation') return exportSrt();
    if (exportAction === 'text_source') return exportSourceTxt();
    if (exportAction === 'text_translation') return exportTxt();
    if (videoExportBlockingChecks.length) {
      const message = videoExportBlockingChecks.map((item) => `${item.label}: ${item.detail}`).join('\n');
      playErrorSound();
      addLog(`Không xuất video: ${videoExportBlockingChecks.map((item) => item.label).join(', ')} thiếu cấu hình.`);
      showAlert('Thiếu cấu hình xuất', message);
      return false;
    }
    return startModalTask(runMux);
  };

  const clearLogs = () => patchState({ logs: [] });

  const copyLogs = async () => {
    await navigator.clipboard?.writeText(logs.join('\n'));
    addLog('💾 Đã sao chép nhật ký.');
  };

  const togglePlay = async () => {
    const media = mediaRef.current;
    if (!media) return;
    const dubbed = dubbedAudioRef.current;
    const playId = playRequestRef.current + 1;
    playRequestRef.current = playId;
    try {
      if (media.paused) {
        // A completed preview stays at its final timestamp.  Restart both
        // tracks so pressing Play always produces audible dubbed audio.
        const atEnd = Number.isFinite(media.duration)
          && media.duration > 0
          && media.currentTime >= media.duration - 0.05;
        if (atEnd) {
          media.currentTime = 0;
          if (dubbed) dubbed.currentTime = 0;
        }
        if (dubbed) {
          dubbed.currentTime = media.currentTime;
          dubbed.volume = config.dubbedAudioEnabled ? clamp(Number(config.dubbedPreviewVolume) || 0, 0, 100) / 100 : 0;
          dubbed.muted = !config.dubbedAudioEnabled;
        }
        media.volume = config.sourceAudioEnabled ? clamp(Number(config.originalPreviewVolume) || 0, 0, 100) / 100 : 0;
        media.muted = !config.sourceAudioEnabled;
        await media.play();
        if (playRequestRef.current !== playId || media.paused) return;
        if (dubbed && config.dubbedAudioEnabled) {
          dubbed.currentTime = media.currentTime;
          await dubbed.play().catch(() => {});
        }
        setPlaying(true);
      } else {
        playRequestRef.current += 1;
        media.pause();
        if (dubbed) dubbed.pause();
        setPlaying(false);
      }
    } catch (error) {
      if (playRequestRef.current !== playId || isPlayInterruptedError(error)) {
        setPlaying(false);
        return;
      }
      const nextSourceIndex = safeVideoSourceIndex + 1;
      if (nextSourceIndex < mediaCandidates.length) {
        setVideoSourceIndex(nextSourceIndex);
        setPlaying(false);
        addLog('⏳ Preview nguồn hiện tại lỗi khi phát, thử nguồn video dự phòng.');
        return;
      }
      playErrorSound();
      addLog('❌ Không phát được preview: video không có nguồn phát hợp lệ. Bấm Thêm để backend tạo preview mới hoặc đổi file nguồn.');
    }
  };

  const ttsReportPass = Boolean(ttsReport?.strictPass)
    || (ttsReport?.placementMode === 'continuous_voice' && Number(ttsReport?.failedSegmentCount || 0) === 0);

  return (
    <div className="h-screen min-h-[760px] overflow-hidden bg-slate-950 text-slate-100 font-sans" onClick={() => { setContextMenu(null); setHistoryOpen(false); }}>
      <main className="flex h-full min-w-0 flex-col bg-slate-950/80 backdrop-blur-xl">
        <header className="relative shrink-0 border-b border-slate-800/80 bg-slate-900/70 px-4 pb-3.5 pt-2.5 backdrop-blur-md 2xl:px-5">
          <div className="grid gap-2">
            <div className="flex min-h-[34px] items-center gap-2 overflow-x-auto overflow-y-hidden pr-2">
            <Button tone={workspaceMode === 'project' ? 'yellow' : 'dark'} onClick={() => setWorkspaceMode('project')}>
              <Clapperboard className="h-4 w-4" />Dự án
            </Button>
            <Button tone={workspaceMode === 'standalone_tts' ? 'yellow' : 'dark'} onClick={() => setWorkspaceMode('standalone_tts')}>
              <Mic2 className="h-4 w-4" />TTS riêng lẻ
            </Button>
            <div className="mx-1 h-8 w-px shrink-0 bg-slate-800" />
            {workspaceMode === 'project' ? (
              <>
            <Button tone="yellow" onClick={openNewProjectModal}>New</Button>
            <input
              value={state.projectName || ''}
              onChange={(event) => patchState({ projectName: event.target.value })}
              className="h-8 w-[100px] shrink-0 rounded-lg border border-slate-800 bg-slate-900/90 px-2.5 text-xs font-semibold text-slate-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Project name"
            />
            <div className="relative shrink-0">
              <button
                ref={historyButtonRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const menuWidth = 320;
                  setHistoryMenuPosition({
                    top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 360)),
                    left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
                    width: menuWidth,
                  });
                  setHistoryOpen((open) => !open);
                }}
                className="flex h-8 w-[152px] items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/90 px-2.5 text-left text-xs font-semibold text-slate-200 outline-none hover:border-slate-700 transition-all"
                title="History"
              >
                <span className="truncate">{state.projectName || 'History'}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              </button>
              {historyOpen ? (
                <div
                  className="fixed z-[100] overflow-hidden rounded-xl border border-slate-800 bg-slate-900/95 shadow-2xl backdrop-blur-md"
                  style={{ top: historyMenuPosition.top, left: historyMenuPosition.left, width: historyMenuPosition.width }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="border-b border-slate-800 px-3 py-2 text-xs font-bold uppercase tracking-wider text-indigo-400">History</div>
                  <div className="max-h-[330px] overflow-y-auto p-1">
                    {projects.length ? projects.map((project) => (
                      <div key={project.id} className={`group flex items-center gap-1 rounded-lg ${project.id === state.projectId ? 'bg-indigo-600/20 text-indigo-200' : 'hover:bg-slate-800/50'}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setHistoryOpen(false);
                            if (project.id !== state.projectId) loadProject(project.id);
                          }}
                          className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-xs font-semibold text-slate-200"
                          title={project.name}
                        >
                          {project.name}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteProjectById(project.id);
                          }}
                          className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-rose-400 opacity-80 hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
                          title="Xóa dự án"
                          aria-label="Xóa dự án"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )) : (
                      <div className="px-3 py-3 text-xs text-slate-400">Chưa có project nào.</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <Button tone="green" onClick={() => setActiveModal('source')}><Upload className="h-4 w-4" />Thêm</Button>
            <Button onClick={clearRows}>Reset</Button>
            <Button tone="red" onClick={deleteVideo} disabled={!hasVideo}>Xóa video</Button>

            <div className="mx-1 h-8 w-px shrink-0 bg-slate-800" />
            <div className="flex shrink-0 items-center gap-2">
            <Button tone="dark" title="Xuất toàn bộ API Keys & biến môi trường ra file JSON" onClick={exportEnvConfig}>
              <Download className="h-4 w-4 text-indigo-400" />Xuất Config
            </Button>
            <Button tone="dark" title="Nhập API Keys & biến môi trường từ file JSON" onClick={() => envFileInputRef.current?.click()}>
              <Upload className="h-4 w-4 text-emerald-400" />Nhập Config
            </Button>
            <input ref={envFileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportEnvConfigFile} />
            </div>

            <div className="mx-1 h-8 w-px shrink-0 bg-slate-800" />
            <div className="flex shrink-0 items-center gap-2">
            <Button onClick={() => { setSttToolTab('stt'); setActiveModal('stt'); }}>Tạo phụ đề gốc</Button>
            <Button onClick={() => { setSubtitleToolTab('translate'); setActiveModal('subtitleTools'); }}>OCR / Dịch</Button>
            <Button onClick={() => setActiveModal('tts')}>Lồng tiếng</Button>
            <Button tone="blue" onClick={() => setActiveModal('export')}>Xuất</Button>
            </div>
              </>
            ) : (
              <div className="text-xs font-semibold text-slate-400">Công cụ tạo giọng nói độc lập với project và timeline</div>
            )}
            {false && state.busy ? (
              <>
                <Button tone="red" onClick={stopCurrentTask}><Square className="h-3.5 w-3.5" />Dừng</Button>
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-indigo-400" />
              </>
            ) : null}
            </div>
            <div className="hidden">
              <Button className="min-w-[128px]" onClick={() => setActiveModal('stt')}>Tạo phụ đề gốc</Button>
              <Button className="min-w-[128px]" onClick={() => { setSubtitleToolTab('translate'); setActiveModal('subtitleTools'); }}>OCR / Dịch</Button>
              <Button className="min-w-[108px]" onClick={() => setActiveModal('tts')}>Lồng tiếng</Button>
              <Button className="min-w-[74px]" onClick={() => setActiveModal('export')}>Xuất</Button>
            </div>
          </div>
          {false && state.busy ? (
            <div className="absolute bottom-1 right-4 flex h-6 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-2">
              <Button className="h-5 px-2 text-[11px]" tone="red" onClick={stopCurrentTask}><Square className="h-3 w-3" />Dừng</Button>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-400" />
            </div>
          ) : null}
        </header>

        {workspaceMode === 'standalone_tts' ? (
          <StandaloneTtsWorkspace
            apiBase={API_BASE}
            config={config}
            onConfigChange={patchConfig}
            googleCloudConfig={googleCloudConfig()}
          />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(640px,1fr)_minmax(318px,23vw)] gap-3.5 px-3.5 pb-3.5 pt-3.5 xl:px-4.5 2xl:grid-cols-[minmax(760px,1fr)_380px] 2xl:px-5">
            <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(280px,1fr)_minmax(230px,36vh)] gap-3">
              <button
                type="button"
                onClick={() => {
                  const value = source.mode === 'local' ? source.videoPath : source.videoUrl;
                  if (value) showAlert('Đường dẫn video', value);
                }}
                className="h-6 truncate text-center text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 via-purple-300 to-amber-300 outline-none hover:underline"
              >
                {source.title || fileNameFromPath(source.videoPath) || fileNameFromPath(source.videoUrl) || ''}
              </button>
              <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-3.5 shadow-2xl shadow-black/40 backdrop-blur-md">
                <div
                  className="relative flex min-h-0 flex-1 items-center justify-center rounded-xl border border-slate-800/80 bg-slate-950/80 shadow-inner"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDroppedFiles(event.dataTransfer.files);
                  }}
                >
                  {renderedMediaSrc ? (
                    <>
                      <video
                        key={renderedMediaSrc}
                        ref={mediaRef}
                        src={renderedMediaSrc}
                        preload="auto"
                        playsInline
                        className="h-full max-h-[56vh] w-full object-contain"
                        onPlay={() => setPlaying(true)}
                        onPause={() => {
                          dubbedAudioRef.current?.pause();
                          setPlaying(false);
                        }}
                        onLoadedMetadata={(event) => {
                          event.currentTarget.volume = config.sourceAudioEnabled ? clamp(Number(config.originalPreviewVolume) || 0, 0, 100) / 100 : 0;
                          event.currentTarget.muted = !config.sourceAudioEnabled;
                          patchState({ job: { ...job, durationSeconds: job.durationSeconds || event.currentTarget.duration || 0 } });
                        }}
                        onLoadedData={() => {
                          addLog('Preview video nguồn sẵn sàng.');
                        }}
                        onTimeUpdate={(event) => {
                          const time = event.currentTarget.currentTime;
                          const activeRow = rows.find((row) => time >= row.start && time < row.end) || rows.find((row) => time >= row.start && time <= row.end);
                          patchState({ currentTime: time, selectedRowId: activeRow?.id || state.selectedRowId });
                          if (dubbedAudioRef.current && Math.abs(dubbedAudioRef.current.currentTime - time) > 0.35) {
                            dubbedAudioRef.current.currentTime = time;
                          }
                        }}
                        onError={() => {
                          const nextSourceIndex = safeVideoSourceIndex + 1;
                          if (nextSourceIndex < mediaCandidates.length) {
                            setVideoSourceIndex(nextSourceIndex);
                            addLog('⏳ Preview nguồn hiện tại lỗi, thử nguồn video dự phòng.');
                          } else {
                            playErrorSound();
                            addLog('❌ Không phát được preview: video không có nguồn phát hợp lệ. Bấm Thêm để backend tạo preview mới hoặc đổi file nguồn.');
                          }
                        }}
                      />
                      {config.subtitleCoverEnabled === true ? (() => {
                        const cover = subtitleCoverRect();
                        return (
                          <div
                            role="button"
                            tabIndex={0}
                            title="Kéo để đặt vùng che phụ đề gốc. Kéo 4 cạnh để đổi kích thước, kéo cạnh trái/phải để chỉnh ngang."
                            onPointerDown={(event) => startSubtitleDrag(event, 'cover')}
                            onPointerMove={moveSubtitleDrag}
                            onPointerUp={stopSubtitleDrag}
                            onPointerCancel={stopSubtitleDrag}
                            onLostPointerCapture={stopSubtitleDrag}
                            className="group absolute cursor-move select-none"
                            style={{
                              ...subtitleVideoBoxStyle(cover.x, cover.y, cover.width, cover.height),
                              transform: 'none',
                              border: 'none',
                              zIndex: 2,
                            }}
                          >
                            {(() => {
                              const strength = Math.max(1, Math.min(60, Number(config.subtitleCoverBlur || 18)));
                              const edgeSoftness = Math.max(1, Math.min(40, Number(config.subtitleCoverFeather || 12)));
                              const fallbackBlur = Math.max(2, Math.min(7, Math.sqrt(strength) * 1.25));
                              const patchSoftness = Math.max(0.6, Math.min(2.2, strength / 24));
                              const maskBlur = Math.max(1.5, Math.min(12, edgeSoftness * 0.35));
                              const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${maskBlur.toFixed(2)}"/></filter><rect x="0" y="0" width="100" height="100" rx="0" ry="0" fill="black" filter="url(#soft)"/></svg>`;
                              const featherMask = `url("data:image/svg+xml,${encodeURIComponent(maskSvg)}")`;
                              const maskStyle = {
                                maskImage: featherMask,
                                maskRepeat: 'no-repeat',
                                maskSize: '100% 100%',
                                WebkitMaskImage: featherMask,
                                WebkitMaskRepeat: 'no-repeat',
                                WebkitMaskSize: '100% 100%',
                              };
                              return (
                                <>
                                  <div
                                    className="pointer-events-none absolute inset-0"
                                    style={{
                                      backdropFilter: `blur(${fallbackBlur}px) saturate(0.98)`,
                                      WebkitBackdropFilter: `blur(${fallbackBlur}px) saturate(0.98)`,
                                      ...maskStyle,
                                    }}
                                  />
                                  <canvas
                                    ref={subtitleCoverCanvasRef}
                                    className="pointer-events-none absolute inset-0 h-full w-full"
                                    style={{
                                      filter: `blur(${patchSoftness}px) saturate(0.98)`,
                                      ...maskStyle,
                                    }}
                                  />
                                </>
                              );
                            })()}
                            {false && [ 
                              ['nw', '-left-1.5 -top-1.5 cursor-nwse-resize', false],
                              ['ne', '-right-1.5 -top-1.5 cursor-nesw-resize', false],
                              ['sw', '-bottom-1.5 -left-1.5 cursor-nesw-resize', false],
                              ['se', '-bottom-1.5 -right-1.5 cursor-nwse-resize', false],
                              ['w', '-left-1 top-1/2 -translate-y-1/2 cursor-ew-resize', true],
                              ['e', '-right-1 top-1/2 -translate-y-1/2 cursor-ew-resize', true],
                            ].map(([corner, classes, horizontal]) => (
                              <span
                                key={corner}
                                role="presentation"
                                title={horizontal ? 'Kéo để thu nhỏ hoặc mở rộng vùng blur' : 'Kéo để đổi kích thước vùng blur'}
                                onPointerDown={(event) => startSubtitleDrag(event, 'coverResize', corner)}
                                className={`absolute border shadow-[0_1px_5px_rgba(0,0,0,0.55)] opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 ${horizontal ? 'h-7 w-2.5 rounded-full border-sky-300 bg-white/95 hover:scale-110' : 'h-2.5 w-2.5 rounded-full border-yellow-200 bg-[#f1cc00]'} ${classes}`}
                              />
                            ))}
                          </div>
                        );
                      })() : null}
                      {logoPreviewSrc ? (
                        <div
                          role="button"
                          tabIndex={0}
                          title="Kéo để đặt logo. Kéo 4 góc để phóng to thu nhỏ."
                          onPointerDown={(event) => startSubtitleDrag(event, 'logo')}
                          onPointerMove={moveSubtitleDrag}
                          onPointerUp={stopSubtitleDrag}
                          onPointerCancel={stopSubtitleDrag}
                          onLostPointerCapture={stopSubtitleDrag}
                          className="absolute cursor-move select-none"
                          style={{
                            ...subtitleVideoStyle(
                              clamp(Number(config.logoX ?? 88), 0, 100),
                              clamp(Number(config.logoY ?? 12), 0, 100),
                              { width: `${Math.max(0, Math.min(80, Number(config.logoSize ?? 18)))}%` }
                            ),
                            transform: 'translate(-50%, -50%)',
                            opacity: Math.max(0, Math.min(100, Number(config.logoOpacity ?? 90))) / 100,
                            zIndex: 4,
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={logoPreviewSrc}
                            alt="Logo preview"
                            draggable={false}
                            className="block h-auto w-full select-none object-contain"
                          />
                          {[
                            ['nw', '-left-1.5 -top-1.5 cursor-nwse-resize'],
                            ['ne', '-right-1.5 -top-1.5 cursor-nesw-resize'],
                            ['sw', '-bottom-1.5 -left-1.5 cursor-nesw-resize'],
                            ['se', '-bottom-1.5 -right-1.5 cursor-nwse-resize'],
                          ].map(([corner, classes]) => (
                            <span
                              key={corner}
                              role="presentation"
                              onPointerDown={(event) => startSubtitleDrag(event, 'logoResize', corner)}
                              className={`absolute h-2.5 w-2.5 rounded-[2px] bg-white shadow ${classes}`}
                            />
                          ))}
                        </div>
                      ) : null}
                      {previewSubtitleText ? (
                        <div
                          role="button"
                          tabIndex={0}
                          title="Kéo để đặt vị trí phụ đề mới. Kéo 4 góc để phóng to thu nhỏ chữ."
                          onPointerDown={(event) => startSubtitleDrag(event, 'subtitle')}
                          onPointerMove={moveSubtitleDrag}
                          onPointerUp={stopSubtitleDrag}
                          onPointerCancel={stopSubtitleDrag}
                          onLostPointerCapture={stopSubtitleDrag}
                          className="absolute cursor-move select-none text-center leading-normal"
                          style={{
                            ...subtitleVideoStyle(
                              clamp(Number(config.subtitlePositionX ?? 50) || 50, 3, 97),
                              clamp(Number(config.subtitlePositionY ?? 88) || 88, 5, 95),
                              { width: 'max-content', maxWidth: subtitleVideoContentWidth(92), minWidth: 0 }
                            ),
                            transform: 'translate(-50%, -50%)',
                            boxSizing: 'border-box',
                            display: 'inline-block',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'break-word',
                            wordBreak: 'break-word',
                            textAlign: 'center',
                            color: config.subtitleTextColor,
                            backgroundColor: 'transparent',
                            border: 'none',
                            borderRadius: 0,
                            padding: 0,
                            fontFamily: cssFontFamily(config.subtitleFontFamily),
                            fontWeight: 700,
                            fontSize: `${previewSubtitleFontSize}px`,
                            WebkitTextStroke: '0 transparent',
                            textShadow: 'none',
                            zIndex: 6,
                          }}
                        >
                          <span
                            className="pointer-events-none inline-block text-center"
                            style={{
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'break-word',
                              wordBreak: 'break-word',
                              textAlign: 'center',
                              lineHeight: 1.25,
                              backgroundColor: config.subtitleBoxEnabled ? hexToRgba(config.subtitleBoxColor, config.subtitleBoxOpacity) : 'transparent',
                              borderRadius: `${Math.max(0, Math.min(32, Number(config.subtitleBoxRadius ?? DEFAULT_STATE.config.subtitleBoxRadius) || 0))}px`,
                              padding: config.subtitleBoxEnabled ? '5px 12px 6px' : '0',
                              boxDecorationBreak: 'clone',
                              WebkitBoxDecorationBreak: 'clone',
                            }}
                          >
                            {previewSubtitleLines.join('\n')}
                          </span>
                          {[
                            ['nw', '-left-1.5 -top-1.5 cursor-nwse-resize'],
                            ['ne', '-right-1.5 -top-1.5 cursor-nesw-resize'],
                            ['sw', '-bottom-1.5 -left-1.5 cursor-nesw-resize'],
                            ['se', '-bottom-1.5 -right-1.5 cursor-nwse-resize'],
                          ].map(([corner, classes]) => (
                            <span
                              key={corner}
                              role="presentation"
                              onPointerDown={(event) => startSubtitleDrag(event, 'subtitleResize', corner)}
                              className={`absolute h-2.5 w-2.5 rounded-[2px] bg-white shadow ${classes}`}
                            />
                          ))}
                        </div>
                      ) : null}
                      {showOverlayPreview ? (
                        <div
                          role="button"
                          tabIndex={0}
                          title="Kéo để đặt vị trí chữ chèn vào video."
                          onPointerDown={(event) => startSubtitleDrag(event, 'overlayText')}
                          onPointerMove={moveSubtitleDrag}
                          onPointerUp={stopSubtitleDrag}
                          onPointerCancel={stopSubtitleDrag}
                          onLostPointerCapture={stopSubtitleDrag}
                          className="absolute cursor-move select-none whitespace-pre-wrap break-words text-center leading-tight"
                          style={{
                            ...subtitleVideoStyle(
                              clamp(Number(config.overlayX ?? 50) || 50, 0, 100),
                              clamp(Number(config.overlayY ?? 50) || 50, 0, 100),
                              { maxWidth: subtitleVideoContentWidth(88) }
                            ),
                            transform: 'translate(-50%, -50%)',
                            color: config.subtitleTextColor,
                            backgroundColor: config.subtitleBoxEnabled ? hexToRgba(config.subtitleBoxColor, config.subtitleBoxOpacity) : 'transparent',
                            border: 'none',
                            borderRadius: `${Math.max(0, Math.min(32, Number(config.subtitleBoxRadius ?? DEFAULT_STATE.config.subtitleBoxRadius) || 0))}px`,
                            padding: config.subtitleBoxEnabled ? '1px 8px 2px' : '0',
                            fontFamily: cssFontFamily(config.subtitleFontFamily),
                            fontWeight: 700,
                            fontSize: `${normalizeSubtitleFontSize(config.subtitleFontSize)}px`,
                            WebkitTextStroke: '0 transparent',
                            textShadow: 'none',
                            zIndex: 5,
                          }}
                        >
                          <span className="pointer-events-none px-1">{overlayPreviewText}</span>
                        </div>
                      ) : null}
                      {dubbedAudioSrc ? <audio ref={dubbedAudioRef} src={dubbedAudioSrc} preload="auto" /> : null}
                    </>
                  ) : (
                    <div className="text-[14px] text-slate-500">Ấn vào &quot;Thêm&quot; hoặc kéo thả video và voice trực tiếp vào đây</div>
                  )}
                </div>

                <div className="mt-3 grid shrink-0 grid-cols-[64px_1fr_64px] items-center gap-4 text-slate-300">
                  <span className="font-mono text-xs">{formatClock(state.currentTime)}</span>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(1, Number(job.durationSeconds) || 1)}
                    value={Math.min(Number(state.currentTime) || 0, Math.max(1, Number(job.durationSeconds) || 1))}
                    onChange={(event) => {
                      const time = Number(event.target.value);
                      seekTo(time);
                    }}
                    className="h-2 accent-indigo-500 cursor-pointer"
                  />
                  <span className="text-right font-mono text-xs">{formatClock(job.durationSeconds)}</span>
                </div>

                <div className="mt-3 flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 overflow-hidden bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80">
                  <Button className="h-8 rounded-full px-4 text-xs" onClick={() => seekTo((state.currentTime || 0) - 5)} disabled={!renderedMediaSrc}>{'<<'}</Button>
                  <Button
                    className="h-7 rounded-full px-3 text-xs"
                    tone={config.sourceAudioEnabled ? 'blue' : 'dark'}
                    onClick={() => patchConfig({ sourceAudioEnabled: !config.sourceAudioEnabled })}
                  >
                    {config.sourceAudioEnabled ? 'Tắt âm gốc' : 'Bật âm gốc'}
                  </Button>
                  <div className="flex items-center gap-2 text-xs text-slate-300 font-medium">
                    <span>Âm gốc:</span>
                    <input type="range" min="0" max="100" value={config.originalPreviewVolume} onChange={(event) => patchConfig({ originalPreviewVolume: Number(event.target.value), sourceAudioEnabled: Number(event.target.value) > 0 })} className="w-20 accent-indigo-500" />
                    <span className="w-8 font-mono text-slate-400">{config.sourceAudioEnabled ? config.originalPreviewVolume : 0}%</span>
                  </div>
                  <button
                    type="button"
                    onClick={togglePlay}
                    disabled={!renderedMediaSrc}
                    className="flex h-10 min-w-[104px] items-center justify-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 px-6 font-bold text-white shadow-lg shadow-emerald-950/50 transition-all active:scale-95 disabled:opacity-40"
                  >
                    {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <Button className="h-8 rounded-full px-4 text-xs" onClick={() => seekTo((state.currentTime || 0) + 5)} disabled={!renderedMediaSrc}>{'>>'}</Button>
                  <div className="flex items-center gap-2 text-xs text-slate-300 font-medium">
                    <span>Giọng đọc:</span>
                    <input type="range" min="0" max="100" value={config.dubbedAudioEnabled ? config.dubbedPreviewVolume : 0} onChange={(event) => patchConfig({ dubbedPreviewVolume: Number(event.target.value), dubbedAudioEnabled: Number(event.target.value) > 0 })} className="w-20 accent-indigo-500" />
                    <span className="w-8 font-mono text-slate-400">{config.dubbedAudioEnabled && dubbedAudioSrc ? config.dubbedPreviewVolume : 0}%</span>
                  </div>
                  <Button
                    className="h-7 rounded-full px-3 text-xs"
                    tone={config.keepBackgroundMusic ? 'green' : 'dark'}
                    onClick={() => patchConfig({ keepBackgroundMusic: !config.keepBackgroundMusic, keepOriginalAudioTrack: !config.keepBackgroundMusic })}
                  >
                    {config.keepBackgroundMusic ? 'Giữ âm gốc khi xuất' : 'Không giữ âm gốc'}
                  </Button>
                </div>
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 shadow-2xl shadow-black/40 backdrop-blur-md">
                <div className="grid grid-cols-[64px_minmax(176px,230px)_1fr] border-b border-slate-800 bg-slate-900/90 text-center text-xs font-bold text-slate-200">
                  <div className="border-r border-slate-800 py-2">#</div>
                  <div className="border-r border-slate-800 py-2">Timeline</div>
                  <div className="flex items-center justify-between px-3 py-1.5">
                    {ttsReport ? (
                      <span className={`rounded-md px-2.5 py-0.5 text-[11px] font-bold ${ttsReportPass ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'}`}>
                        TTS timing: {ttsReportPass ? 'OK' : `${ttsReport.failedSegmentCount || 0} cảnh báo, đã đánh dấu ${ttsWarningRows}`}
                      </span>
                    ) : <span />}
                    <div className="flex rounded-lg border border-slate-800 bg-slate-950/60 p-0.5 text-[11px]">
                      <button type="button" className={`rounded-md px-2.5 py-1 font-semibold transition-all ${timelineTab === 'all' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`} onClick={() => setTimelineTab('all')}>Tất cả</button>
                      <button type="button" className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition-all ${activeModal === 'bulkEditV2' && bulkEditMode === 'ttsRepair' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`} onClick={openTtsRepairEditor}>
                        <Pencil className="h-3 w-3" />
                        Chỉnh sửa {ttsRepairRows.length ? `(${ttsRepairRows.length})` : ''}
                      </button>
                    </div>
                  </div>
                </div>
                {state.storyTranslation ? (
                  <details className="border-b border-[#20385f] bg-[#081222] px-3 py-1.5 text-[11px] text-slate-300">
                    <summary className="cursor-pointer select-none font-bold">
                      Story v2: {state.storyTranslation.validation?.status || 'needs_review'} · {state.storyTranslation.meaningAtoms?.length || 0} atom · {state.storyTranslation.omissions?.length || 0} phần lược
                    </summary>
                    {state.storyTranslation.omissions?.map((item, index) => (
                      <div key={`${item.reason}-${index}`} className="mt-1">
                        {item.reason}: {(item.sourceIds || []).join(', ')} — {item.sourceText || item.note || ''}
                      </div>
                    ))}
                    {state.storyTranslation.validation?.errors?.length ? (
                      <div className="mt-1 text-red-300">{state.storyTranslation.validation.errors.join('; ')}</div>
                    ) : null}
                  </details>
                ) : null}
                <div className="min-h-0 flex-1 overflow-auto">
                  {timelineTab === 'ttsRepair' ? (
                    visibleTtsRepairRows.length ? (
                      <>
                        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-[#20385f] bg-[#081222] px-3 py-2 text-[12px] text-slate-200">
                          <div>
                            <span className="font-black text-[#f1cc00]">{visibleTtsRepairRows.length}</span> dòng đang chờ chỉnh sửa
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex rounded-[5px] border border-[#28436d] bg-[#071020] p-0.5 text-[11px]">
                              {[
                                ['all', `Tất cả ${ttsRepairRows.length}`],
                                ['major', `>=1s ${ttsRepairMajorRows}`],
                                ['minor', `<1s ${ttsRepairMinorRows}`],
                              ].map(([value, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  className={`rounded px-2 py-0.5 font-bold ${ttsRepairSeverityFilter === value ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
                                  onClick={() => setTtsRepairSeverityFilter(value)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            <Button className="h-7 px-2 text-[11px]" tone="yellow" onClick={repairSelectedTtsErrors} disabled={!ttsRepairRows.some((item) => item.selected !== false)}>Dịch đã chọn</Button>
                            <Button className="h-7 px-2 text-[11px]" tone="blue" onClick={() => previewSelectedTtsRepairSrt()} disabled={!ttsRepairRowsWithDraft.some((item) => item.selected !== false)}>TTS đã chọn</Button>
                            <Button className="h-7 px-2 text-[11px]" tone="green" onClick={applyCheckedTtsRepairRows} disabled={!ttsRepairApplyRows.length}>Áp dụng đã tick</Button>
                          </div>
                        </div>
                        {visibleTtsRepairRows.map((item) => {
                          const row = rows.find((candidate) => candidate.id === item.rowId);
                          const statusLabel = item.status === 'applied'
                            ? 'Đã áp dụng'
                            : item.status === 'repaired' || item.status === 'edited'
                              ? 'Có bản sửa'
                              : item.status === 'rerun'
                                ? 'Đã TTS lại'
                                : item.status === 'notice' || item.selected === false
                                  ? 'Theo dõi'
                                  : 'Đang chọn';
                          const overflowSeconds = Math.max(
                            0,
                            Number(item.overflowSeconds ?? item.overflow_seconds) || 0,
                            Number(row?.ttsSync?.endOverflowSeconds) || 0,
                            Number(row?.ttsSync?.overlapNextSeconds) || 0
                          );
                          const severityLabel = overflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS ? 'Tràn' : '';
                          const displayedErrorReason = overflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS
                            ? `Tràn ${formatSecondsShort(overflowSeconds)}`
                            : (item.error_reason || '');
                          return (
                            <div key={item.rowId} className="grid grid-cols-[64px_minmax(176px,230px)_1fr] border-b border-[#162949] bg-[#0c1629] text-[13px] text-white">
                              <div className="flex flex-col items-center justify-center gap-1 border-r border-[#20385f] px-2 py-2 text-center">
                                <span className="font-black">{row?.index || item.rowId}</span>
                                <input
                                  type="checkbox"
                                  checked={item.selected !== false}
                                  title="Giữ trong danh sách chỉnh sửa"
                                  onChange={(event) => toggleTtsRepairRow(item.rowId, event.target.checked)}
                                  className="h-3.5 w-3.5 accent-[#f1cc00]"
                                />
                              </div>
                              <div className="border-r border-[#20385f] px-2 py-2 font-mono text-[12px] text-slate-200">
                                {row ? `${formatSrtTime(row.start)} --> ${formatSrtTime(row.end)}` : item.rowId}
                                <div className="mt-1 font-sans text-[11px] text-slate-400">{statusLabel}</div>
                              </div>
                              <div className="grid gap-2 p-2 md:grid-cols-2">
                                <div className="min-w-0 rounded-[6px] border border-red-500/35 bg-red-950/25 p-2">
                                  <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px] font-bold text-red-200">
                                    <span>Bản lỗi</span>
                                    {severityLabel ? <span className={`rounded px-1.5 py-0.5 text-white ${item.severity === 'major' ? 'bg-red-500' : 'bg-amber-500/85'}`}>{severityLabel}</span> : null}
                                    {displayedErrorReason ? <span className="rounded bg-red-500 px-1.5 py-0.5 text-white">{displayedErrorReason}</span> : null}
                                  </div>
                                  <div className="mb-2 flex flex-wrap gap-1 text-[10px] text-slate-300">
                                    {Number.isFinite(item.slotSeconds) ? <span>Slot {formatSecondsShort(item.slotSeconds)}</span> : null}
                                    {Number.isFinite(item.audioSeconds) ? <span>Audio {formatSecondsShort(item.audioSeconds)}</span> : null}
                                    {Number.isFinite(overflowSeconds) && overflowSeconds > 0 ? <span>Tràn {formatSecondsShort(overflowSeconds)}</span> : null}
                                    {Number.isFinite(item.fitRatio) && item.fitRatio > 0 ? <span>Fit {item.fitRatio.toFixed(2)}x</span> : null}
                                  </div>
                                  <div className="whitespace-pre-wrap text-slate-100">{item.currentTranslation || rowText(row, finalField) || <span className="text-slate-500">(trống)</span>}</div>
                                  {item.source_text ? (
                                    <details className="mt-2 border-t border-white/10 pt-1 text-[11px] text-slate-300">
                                      <summary className="cursor-pointer select-none">STT gốc</summary>
                                      <div className="mt-1 whitespace-pre-wrap">{item.source_text}</div>
                                    </details>
                                  ) : null}
                                </div>
                                <div className="min-w-0 rounded-[6px] border border-emerald-500/35 bg-emerald-950/20 p-2">
                                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-emerald-200">
                                    <span>Bản sửa</span>
                                    <span className="text-slate-400">{String(item.repairedTranslation || '').length} ký tự</span>
                                  </div>
                                  <textarea
                                    value={item.repairedTranslation || ''}
                                    placeholder="Bấm Dịch đã chọn để tạo bản sửa, hoặc nhập tay tại đây."
                                    onChange={(event) => updateTtsRepairDraft(item.rowId, event.target.value)}
                                    className="min-h-[86px] w-full resize-y rounded-[4px] border border-[#28436d] bg-[#071020] px-2 py-1.5 text-slate-100 outline-none focus:border-[#f1cc00]"
                                  />
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <label className="inline-flex h-7 items-center gap-1 rounded border border-[#28436d] bg-[#071020] px-2 text-[11px] font-bold text-slate-200">
                                      <input
                                        type="checkbox"
                                        checked={item.applySelected === true}
                                        disabled={!canApplyTtsRepairPreview(item)}
                                        onChange={(event) => toggleTtsRepairApplyRow(item.rowId, event.target.checked)}
                                        className="h-3.5 w-3.5 accent-[#22c55e]"
                                      />
                                      Áp dụng
                                    </label>
                                    <Button className="h-7 px-2 text-[11px]" tone="blue" onClick={() => previewSelectedTtsRepairSrt([item.rowId])} disabled={!item.repairedTranslation?.trim()}>TTS</Button>
                                    <Button
                                      className="h-7 px-2 text-[11px]"
                                      tone="dark"
                                      title={hasTtsRepairPreviewAudioForRow(item.rowId) ? 'Nghe lại audio TTS của cue này' : 'Bấm TTS cue này trước để có audio nghe lại'}
                                      onClick={() => replayTtsRepairPreviewAudio(item.rowId)}
                                      disabled={!hasTtsRepairPreviewAudioForRow(item.rowId)}
                                    >
                                      <Volume2 className="h-3 w-3" />
                                      Nghe lại
                                    </Button>
                                    <Button className="h-7 px-2 text-[11px]" tone="green" onClick={() => applyTtsRepairRows([item.rowId])} disabled={!canApplyTtsRepairPreview(item)}>Áp dụng dòng</Button>
                                    <Button className="h-7 px-2 text-[11px]" tone="dark" onClick={() => removeTtsRepairRow(item.rowId)}>Xóa khỏi lỗi</Button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="flex h-full items-center justify-center text-slate-500">Chưa có dòng cần chỉnh sửa.</div>
                    )
                  ) : rows.length ? rows.map((row) => {
                    const active = state.currentTime >= row.start && state.currentTime <= row.end;
                    const selected = state.selectedRowId === row.id;
                    const invalid = row.duration < 0.8 || row.end <= row.start;
                    const ttsBad = hasTtsSyncWarning(row.ttsSync);
                    const ttsBadge = ttsBad ? ttsSyncBadgeText(row.ttsSync) : '';
                    const ttsReasons = ttsBad ? ttsSyncWarningReasons(row.ttsSync) : [];
                    const translationBadge = translationTimingBadgeText(row.ttsTimingFit);
                    const translationTitle = translationTimingTitle(row.ttsTimingFit, row.ttsTimingProbe);
                    const repairIssue = ttsRepairIssueForRow(row, finalField);
                    const repairBasketItem = ttsRepairById.get(String(row.id));
                    const repairChecked = repairBasketItem ? repairBasketItem.selected !== false : (repairIssue ? repairIssue.selectedByDefault !== false : false);
                    const rowTone = invalid
                      ? 'bg-rose-900/60 text-white border-rose-700/50'
                      : ttsBad
                        ? (selected ? 'bg-rose-600 text-white ring-2 ring-rose-400 ring-inset shadow-lg' : 'bg-rose-950/70 text-rose-100 border-rose-900/40')
                        : selected
                          ? 'bg-indigo-600/90 text-white font-semibold ring-2 ring-indigo-400/80 shadow-lg shadow-indigo-950/60 border-indigo-500'
                          : active
                            ? 'bg-indigo-950/60 text-indigo-100 border-indigo-500/30'
                            : 'bg-slate-900/50 text-slate-100 hover:bg-slate-800/60 border-slate-800/80';
                    return (
                      <div
                        key={row.id}
                        data-row-id={row.id}
                        draggable
                        onDragStart={() => setDraggingRowId(row.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => reorderRows(draggingRowId, row.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          selectRow(row);
                          setContextMenu({ rowId: row.id, ...contextMenuPosition(event.clientX, event.clientY) });
                        }}
                        className={`grid grid-cols-[64px_minmax(176px,230px)_1fr] border-b border-slate-800/80 text-[13px] transition-all duration-150 ${rowTone}`}
                        style={row.style?.backgroundOpacity ? { backgroundColor: hexToRgba(row.style.backgroundColor, row.style.backgroundOpacity) } : undefined}
                        onClick={() => {
                          selectRow(row);
                        }}
                      >
                        <div className="flex cursor-grab flex-col items-center justify-center gap-1 border-r border-slate-800/80 px-2 py-1.5 text-center">
                          <span className="font-mono text-xs">{row.index}</span>
                          <input
                            type="checkbox"
                            checked={repairChecked}
                            title={repairIssue ? repairIssue.reason : 'Đưa vào danh sách chỉnh sửa'}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleTtsRepairRow(row.id, event.target.checked)}
                            className="h-3.5 w-3.5 accent-indigo-500"
                          />
                        </div>
                        <div className="border-r border-slate-800/80 px-2.5 py-2 font-mono text-[12px] text-slate-300">
                          {formatSrtTime(row.start)} --&gt; {formatSrtTime(row.end)}
                        </div>
                        {editingRowId === row.id ? (
                          <textarea
                            autoFocus
                            value={editDraft}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setEditDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
                                event.preventDefault();
                                undoRowsChange();
                                return;
                              }
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                commitEdit(true);
                              }
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelEdit();
                              }
                              if (event.key === 'Tab') {
                                event.preventDefault();
                                commitEdit(true);
                              }
                            }}
                            onBlur={() => commitEdit(false)}
                            className="min-h-[34px] w-full resize-none bg-slate-950/80 px-2.5 py-2 outline-none text-white border border-indigo-500 rounded-md"
                          />
                        ) : (
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                selectRow(row);
                                beginEdit(row);
                              }}
                              title={
                                ttsReasons.length
                                  ? `Cảnh báo TTS: ${ttsReasons.join(', ') || 'kiểm tra sync'}. Unit ${row.ttsSync?.ttsUnitId || row.ttsSync?.ttsUnitIndex}.`
                                  : translationTitle || undefined
                              }
                              className="min-h-[34px] w-full px-2.5 py-2 text-left outline-none"
                            >
                              <span className="leading-relaxed">{rowText(row, finalField) || <span className="text-slate-500 font-italic">(trống)</span>}</span>
                              {row.validationStatus || row.status === 'verified' || row.status === 'needs_review' ? (
                                <span className={`ml-2 rounded-md px-2 py-0.5 text-[10px] font-bold ${row.status === 'verified' ? 'bg-emerald-500 text-slate-950' : 'bg-rose-500 text-white'}`}>
                                  {row.status === 'verified' ? 'verified' : 'needs review'}
                                </span>
                              ) : null}
                              {ttsBadge ? (
                                <span className={`ml-2 rounded-md px-2 py-0.5 text-[10px] font-bold ${ttsBad ? 'bg-rose-500 text-white' : 'bg-amber-500 text-slate-950'}`}>
                                  {ttsBadge}
                                </span>
                              ) : null}
                              {translationBadge ? (
                                <span className="ml-2 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-slate-950" title={translationTitle}>
                                  {translationBadge}
                                </span>
                              ) : null}
                            </button>
                            {Array.isArray(row.sourceIds) && row.sourceIds.length ? (
                              <details className="border-t border-slate-800/50 px-2.5 py-1 text-[11px] text-slate-400 opacity-85" onClick={(event) => event.stopPropagation()}>
                                <summary className="cursor-pointer select-none font-medium">Nguồn: {row.sourceIds.join(', ')}</summary>
                                {Array.isArray(row.atomIds) && row.atomIds.length ? <div>Atom: {row.atomIds.join(', ')}</div> : null}
                                {row.sourceText ? <div className="mt-1 whitespace-normal text-slate-300">{row.sourceText}</div> : null}
                                {row.errorMsg ? <div className="mt-1 text-rose-400 font-medium">{row.errorMsg}</div> : null}
                              </details>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  }) : (
                    <div className="flex h-full items-center justify-center text-slate-500">Chưa có phụ đề.</div>
                  )}
                </div>
              </div>
            </section>

            <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)_188px] gap-3">
              <div className="min-h-0 overflow-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-3 shadow-2xl shadow-black/40 backdrop-blur-md">
                <h2 className="mb-3 py-1 text-center text-xs font-bold uppercase tracking-wider text-indigo-400">CẤU HÌNH XỬ LÝ</h2>
                <div className="grid gap-2.5">

                  <Panel title="Cấu hình & Keys (Import / Export)">
                    <div className="grid gap-2">
                      <Button tone="blue" className="w-full justify-center gap-2" onClick={exportEnvConfig}>
                        <Download className="h-4 w-4" /> Trích xuất Config & Keys (.json)
                      </Button>
                      <Button tone="green" className="w-full justify-center gap-2" onClick={() => envFileInputRef.current?.click()}>
                        <Upload className="h-4 w-4" /> Nhập Config & Keys (.json)
                      </Button>
                    </div>
                  </Panel>

                  <Panel title="Che phụ đề gốc">
                    <Toggle
                      checked={config.subtitleCoverEnabled === true}
                      label="Bật vùng che/blur phụ đề cháy"
                      onChange={(checked) => patchConfig({ subtitleCoverEnabled: checked, subtitleCoverMode: 'blur' })}
                    />
                    <Field label={`Độ blur: ${config.subtitleCoverBlur ?? 18}`}>
                      <input type="range" min="1" max="60" value={config.subtitleCoverBlur ?? 18} onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverMode: 'blur', subtitleCoverBlur: Number(event.target.value) })} className="accent-[#f1cc00]" />
                    </Field>
                    <Field label={`Độ mềm 4 viền: ${config.subtitleCoverFeather ?? 12}`}>
                      <input type="range" min="1" max="40" value={config.subtitleCoverFeather ?? 12} onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverMode: 'blur', subtitleCoverFeather: Number(event.target.value) })} className="accent-[#f1cc00]" />
                    </Field>
                    {(() => {
                      const cover = subtitleCoverRect();
                      return (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-[6px] border border-[#263a5d] bg-black/15 p-2.5">
                          <Field label={`Ngang: ${cover.x.toFixed(1)}%`}>
                            <input
                              type="range"
                              min="0"
                              max={Math.max(0, 100 - cover.width)}
                              step="0.1"
                              value={cover.x}
                              onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverX: Number(event.target.value) })}
                              className="accent-[#f1cc00]"
                            />
                          </Field>
                          <Field label={`Dọc: ${cover.y.toFixed(1)}%`}>
                            <input
                              type="range"
                              min="0"
                              max={Math.max(0, 100 - cover.height)}
                              step="0.1"
                              value={cover.y}
                              onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverY: Number(event.target.value) })}
                              className="accent-[#f1cc00]"
                            />
                          </Field>
                          <Field label={`Rộng: ${cover.width.toFixed(1)}%`}>
                            <input
                              type="range"
                              min="2"
                              max={Math.max(2, 100 - cover.x)}
                              step="0.1"
                              value={cover.width}
                              onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverW: Number(event.target.value) })}
                              className="accent-[#f1cc00]"
                            />
                          </Field>
                          <Field label={`Cao: ${cover.height.toFixed(1)}%`}>
                            <input
                              type="range"
                              min="2"
                              max={Math.max(2, 100 - cover.y)}
                              step="0.1"
                              value={cover.height}
                              onChange={(event) => patchConfig({ subtitleCoverEnabled: true, subtitleCoverH: Number(event.target.value) })}
                              className="accent-[#f1cc00]"
                            />
                          </Field>
                        </div>
                      );
                    })()}
                    <Button
                      className="w-full"
                      onClick={() => patchConfig({
                        subtitleCoverEnabled: true,
                        subtitleCoverMode: 'blur',
                        subtitleCoverX: DEFAULT_STATE.config.subtitleCoverX,
                        subtitleCoverY: DEFAULT_STATE.config.subtitleCoverY,
                        subtitleCoverW: DEFAULT_STATE.config.subtitleCoverW,
                        subtitleCoverH: DEFAULT_STATE.config.subtitleCoverH,
                      })}
                    >
                      Đặt lại vị trí và kích thước
                    </Button>
                  </Panel>

                  <Panel title="Mẫu phụ đề">
                    <div className="flex items-center justify-between gap-3 rounded-[6px] border border-[#263a5d] bg-black/20 px-2.5 py-2">
                      <div>
                        <div className="text-xs font-bold text-white">Xem trước trên video</div>
                        <div className="text-[10px] text-slate-400">Kéo phụ đề trực tiếp để đổi vị trí</div>
                      </div>
                      <Button tone={config.subtitlePreviewEnabled !== false ? 'yellow' : 'dark'} onClick={() => patchConfig({ subtitlePreviewEnabled: config.subtitlePreviewEnabled === false })}>
                        {config.subtitlePreviewEnabled !== false ? 'Đang bật' : 'Đang tắt'}
                      </Button>
                    </div>

                    <div className="grid gap-2 rounded-[6px] border border-[#263a5d] bg-black/15 p-2.5">
                      <div className="text-[11px] font-black uppercase tracking-wide text-[#f1cc00]">Kiểu chữ</div>
                      <Field label="Phông chữ">
                        <Select value={config.subtitleFontFamily} onChange={(event) => patchConfig({ subtitleFontFamily: event.target.value })}>
                          <option>Arial</option>
                          <option>Inter</option>
                          <option>Tahoma</option>
                          <option>Times New Roman</option>
                        </Select>
                      </Field>
                      <Field label={`Cỡ chữ: ${normalizeSubtitleFontSize(config.subtitleFontSize)}px`}>
                        <input
                          type="range"
                          min={SUBTITLE_FONT_SIZE_MIN}
                          max={SUBTITLE_FONT_SIZE_MAX}
                          value={normalizeSubtitleFontSize(config.subtitleFontSize)}
                          onChange={(event) => patchConfig({ subtitleFontSize: normalizeSubtitleFontSize(event.target.value) })}
                          className="accent-[#f1cc00]"
                        />
                      </Field>
                      <Field label={`Ký tự mỗi dòng: ${subtitleLineLengthForConfig(config)}`}>
                        <input type="range" min="18" max="32" value={subtitleLineLengthForConfig(config)} onChange={(event) => patchConfig({ maxCharsPerLine: Number(event.target.value) })} className="accent-[#f1cc00]" />
                      </Field>
                      <Field label="Màu chữ">
                        <ColorPicker value={config.subtitleTextColor} onChange={(value) => patchConfig({ subtitleTextColor: value })} />
                      </Field>
                    </div>

                    <div className="grid gap-2 rounded-[6px] border border-[#263a5d] bg-black/15 p-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-black uppercase tracking-wide text-[#f1cc00]">Nền phụ đề</div>
                          <div className="mt-0.5 text-[10px] text-slate-400">Không dùng viền chữ</div>
                        </div>
                        <Button tone={config.subtitleBoxEnabled !== false ? 'yellow' : 'dark'} onClick={() => patchConfig({ subtitleBoxEnabled: config.subtitleBoxEnabled === false })}>
                          {config.subtitleBoxEnabled !== false ? 'Đang bật' : 'Đang tắt'}
                        </Button>
                      </div>
                      {config.subtitleBoxEnabled !== false ? (
                        <>
                          <Field label="Màu nền">
                            <ColorPicker value={config.subtitleBoxColor || '#111111'} onChange={(value) => patchConfig({ subtitleBoxColor: value })} />
                          </Field>
                          <Field label={`Độ mờ nền: ${config.subtitleBoxOpacity ?? 82}%`}>
                            <input type="range" min="0" max="100" value={config.subtitleBoxOpacity ?? 82} onChange={(event) => patchConfig({ subtitleBoxOpacity: Number(event.target.value) })} className="accent-[#f1cc00]" />
                          </Field>
                          <Field label={`Bo góc nền: ${config.subtitleBoxRadius ?? DEFAULT_STATE.config.subtitleBoxRadius}px`}>
                            <input type="range" min="0" max="32" value={config.subtitleBoxRadius ?? DEFAULT_STATE.config.subtitleBoxRadius} onChange={(event) => patchConfig({ subtitleBoxRadius: Number(event.target.value) })} className="accent-[#f1cc00]" />
                          </Field>
                        </>
                      ) : null}
                    </div>
                    {config.subtitlePreviewEnabled !== false ? (
                      <div
                        className="rounded-[6px] border border-[#263a5d] bg-[#071020] p-4 text-center"
                        style={{
                          color: config.subtitleTextColor,
                          backgroundColor: config.subtitleBoxEnabled !== false ? hexToRgba(config.subtitleBoxColor, config.subtitleBoxOpacity) : 'transparent',
                          borderRadius: config.subtitleBoxEnabled !== false ? Math.max(0, Math.min(32, Number(config.subtitleBoxRadius ?? DEFAULT_STATE.config.subtitleBoxRadius) || 0)) : 4,
                          fontFamily: cssFontFamily(config.subtitleFontFamily),
                          fontWeight: 700,
                          fontSize: Math.min(28, normalizeSubtitleFontSize(config.subtitleFontSize)),
                          WebkitTextStroke: '0 transparent',
                          textShadow: 'none',
                        }}
                      >
                        <span className="whitespace-pre-wrap">{wrapSubtitleForPreview(SUBTITLE_SAMPLE_TEXT, subtitleLineLengthForConfig(config))}</span>
                      </div>
                    ) : null}
                    <Button className="w-full" onClick={clearSubtitleStyle}>Khôi phục mẫu mặc định</Button>
                  </Panel>

                  <Panel title="Thêm văn bản">
                    <Toggle
                      checked={config.overlayEnabled === true}
                      label="Bật chữ chèn trực tiếp lên video"
                      onChange={(checked) => patchConfig({ overlayEnabled: checked })}
                    />
                    <Field label="Text">
                      <Input value={config.overlayText} onChange={(event) => patchConfig({ overlayText: event.target.value, overlayEnabled: Boolean(event.target.value.trim()) })} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Position X">
                        <Input type="number" value={config.overlayX} onChange={(event) => patchConfig({ overlayX: Number(event.target.value) })} />
                      </Field>
                      <Field label="Position Y">
                        <Input type="number" value={config.overlayY} onChange={(event) => patchConfig({ overlayY: Number(event.target.value) })} />
                      </Field>
                      <Field label="Start">
                        <Input type="number" value={config.overlayStart} onChange={(event) => patchConfig({ overlayStart: Number(event.target.value) })} />
                      </Field>
                      <Field label="End">
                        <Input type="number" value={config.overlayEnd} onChange={(event) => patchConfig({ overlayEnd: Number(event.target.value) })} />
                      </Field>
                    </div>
                <Button tone="yellow" onClick={applyOverlayTextToVideo}>Áp dụng chữ lên video</Button>
                  </Panel>

                  <Panel title="Thêm nhạc nền">
                    <Toggle
                      checked={config.musicEnabled === true}
                      label="Bật nhạc nền khi xuất"
                      onChange={(checked) => patchConfig({ musicEnabled: checked })}
                    />
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <Input value={config.musicPath} placeholder="Chọn hoặc dán đường dẫn audio..." onChange={(event) => patchConfig({ musicPath: event.target.value, musicEnabled: Boolean(event.target.value.trim()) })} />
                      <Button tone="blue" onClick={pickMusicFile}><Upload className="h-4 w-4" />Chọn</Button>
                    </div>
                    <div className="rounded-[6px] border border-[#263a5d] bg-black/20 px-2.5 py-2 text-xs text-slate-300">
                      {config.musicPath ? fileNameFromPath(config.musicPath) : 'Chưa chọn nhạc nền'}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={`Nhạc nền: ${config.musicVolume}%`}>
                        <input type="range" min="0" max="100" value={config.musicVolume} onChange={(event) => patchConfig({ musicVolume: Number(event.target.value), musicEnabled: true })} className="accent-[#f1cc00]" />
                      </Field>
                      <Field label={`Âm gốc: ${Math.round(Number(config.originalAudioVolume ?? 0.18) * 100)}%`}>
                        <input type="range" min="0" max="1" step="0.01" value={config.originalAudioVolume} onChange={(event) => patchConfig({ originalAudioVolume: Number(event.target.value) })} className="accent-[#f1cc00]" />
                      </Field>
                    </div>
                    <Toggle
                      checked={config.musicFade !== false}
                      label="Fade in nhẹ cho nhạc nền"
                      onChange={(checked) => patchConfig({ musicFade: checked })}
                    />
                  </Panel>

                  <Panel title="Chèn logo">
                    <Toggle
                      checked={config.logoEnabled === true}
                      label="Hiển thị logo khi xuất video"
                      onChange={(checked) => patchConfig({ logoEnabled: checked })}
                    />
                    <Button tone="blue" className="h-10 w-full" onClick={pickLogoFile}>
                      <Upload className="h-4 w-4" />
                      {config.logoPath ? 'Đổi logo' : 'Chọn logo từ máy'}
                    </Button>
                    {config.logoPath ? (
                      <div className="grid grid-cols-[64px_1fr] gap-3 rounded-[6px] border border-[#263a5d] bg-black/20 p-2">
                        <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[5px] bg-[#111c2f]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={localFilePreviewSrc(config.logoPath)} alt="" className="max-h-full max-w-full object-contain" />
                        </div>
                        <div className="min-w-0 self-center text-xs text-slate-300">
                          <div className="truncate font-bold text-white">{fileNameFromPath(config.logoPath)}</div>
                          <div>Kéo trực tiếp trên video để đổi vị trí.</div>
                        </div>
                      </div>
                    ) : null}
                    <Field label="Vị trí nhanh">
                      <Select value={config.logoPosition} onChange={(event) => logoPresetPosition(event.target.value)}>
                        {LOGO_POSITION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </Select>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={`Ngang: ${Number(config.logoX ?? 88).toFixed(1)}%`}>
                        <input type="range" min="0" max="100" step="0.1" value={config.logoX ?? 88} onChange={(event) => patchConfig({ logoPosition: 'custom', logoX: Number(event.target.value), logoEnabled: true })} className="accent-[#f1cc00]" />
                      </Field>
                      <Field label={`Dọc: ${Number(config.logoY ?? 12).toFixed(1)}%`}>
                        <input type="range" min="0" max="100" step="0.1" value={config.logoY ?? 12} onChange={(event) => patchConfig({ logoPosition: 'custom', logoY: Number(event.target.value), logoEnabled: true })} className="accent-[#f1cc00]" />
                      </Field>
                      <Field label={`Kích thước: ${config.logoSize}%`}>
                        <input type="range" min="0" max="80" step="0.1" value={config.logoSize} onChange={(event) => patchConfig({ logoSize: Number(event.target.value), logoEnabled: true })} className="accent-[#f1cc00]" />
                      </Field>
                      <Field label={`Độ rõ: ${config.logoOpacity}%`}>
                        <input type="range" min="0" max="100" value={config.logoOpacity} onChange={(event) => patchConfig({ logoOpacity: Number(event.target.value), logoEnabled: true })} className="accent-[#f1cc00]" />
                      </Field>
                    </div>
                  </Panel>

                  {false ? <Panel title="Thông số video">
                    <div className="grid grid-cols-2 gap-2 rounded border border-[#263a5d] bg-black/20 p-3 text-xs text-slate-300">
                      <span>Độ phân giải</span><span className="text-right">Tự động theo video gốc</span>
                      <span>Tốc độ khung hình</span><span className="text-right">Tự động</span>
                      <span>Thời lượng</span><span className="text-right">{formatClock(job.durationSeconds)}</span>
                      <span>Bộ mã hóa</span><span className="text-right">{job.format || 'MP4/WAV'}</span>
                    </div>
                    <Field label="Định dạng xuất">
                      <Select value={config.outputFormat} onChange={(event) => patchConfig({ outputFormat: event.target.value, outputFileName: `final_dubbed.${event.target.value}` })}>
                        <option value="mp4">MP4</option>
                        <option value="mkv">MKV</option>
                        <option value="avi">AVI</option>
                      </Select>
                    </Field>
                    <Field label={`Chất lượng xuất: ${config.outputQuality}%`}>
                      <input type="range" min="30" max="100" value={config.outputQuality} onChange={(event) => patchConfig({ outputQuality: Number(event.target.value) })} className="accent-[#f1cc00]" />
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={config.burnSubtitles} onChange={(event) => patchConfig({ burnSubtitles: event.target.checked })} />
                      Gắn phụ đề vào video
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={config.keepBackgroundMusic} onChange={(event) => patchConfig({ keepBackgroundMusic: event.target.checked })} />
                      Giữ âm gốc
                    </label>
                    <Field label="Tên file xuất">
                      <Input value={config.outputFileName} onChange={(event) => patchConfig({ outputFileName: event.target.value })} />
                    </Field>
                    {openOutput ? (
                      <a className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[7px] bg-[#4389ee] px-3 text-xs font-black text-white hover:bg-[#5a9bff]" href={`${API_BASE}${openOutput}`} download title="Tải file đã xuất">
                        <Download className="h-4 w-4" />Tải sản phẩm gần nhất
                      </a>
                    ) : null}

                    <div className="grid gap-2">
                      <details className="group/export rounded-[6px] border border-[#2a4268] bg-[#091326]">
                        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-2.5 text-xs font-black text-white">
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-sky-500 text-[10px] text-white">1</span>
                          STT gốc
                          <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400 transition group-open/export:rotate-90" />
                        </summary>
                        <div className="grid gap-2 border-t border-[#243a5d] p-2.5">
                          <div className="grid grid-cols-3 gap-2">
                            <Button tone="blue" className="h-9 min-w-0 px-1 text-[11px]" onClick={exportSourceSrt} disabled={!rows.length}><FileText className="h-3.5 w-3.5" />SRT</Button>
                            <Button tone="blue" className="h-9 min-w-0 px-1 text-[11px]" onClick={exportSourceTxt} disabled={!rows.length}><FileText className="h-3.5 w-3.5" />TXT</Button>
                            <Button tone="dark" className="h-9 min-w-0 px-1 text-[11px]" onClick={() => copySubtitleText('source')} disabled={!rows.length}><Copy className="h-3.5 w-3.5" />Văn bản</Button>
                          </div>
                        </div>
                      </details>

                      <details className="group/export rounded-[6px] border border-[#2a4268] bg-[#091326]">
                        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-2.5 text-xs font-black text-white">
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-[#f1cc00] text-[10px] text-black">2</span>
                          Bản dịch
                          <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400 transition group-open/export:rotate-90" />
                        </summary>
                        <div className="grid gap-2 border-t border-[#243a5d] p-2.5">
                          <div className="grid grid-cols-3 gap-2">
                            <Button tone="blue" className="h-9 min-w-0 px-1 text-[11px]" onClick={exportSrt} disabled={!rows.length}><FileText className="h-3.5 w-3.5" />SRT</Button>
                            <Button tone="blue" className="h-9 min-w-0 px-1 text-[11px]" onClick={exportTxt} disabled={!rows.length}><FileText className="h-3.5 w-3.5" />TXT</Button>
                            <Button tone="dark" className="h-9 min-w-0 px-1 text-[11px]" onClick={() => copySubtitleText('translation')} disabled={!rows.length}><Copy className="h-3.5 w-3.5" />Văn bản</Button>
                          </div>
                        </div>
                      </details>

                      <details className="group/export rounded-[6px] border border-[#2a4268] bg-[#091326]">
                        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-2.5 text-xs font-black text-white">
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-[10px] text-white">3</span>
                          Báo cáo kiểm tra
                          <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400 transition group-open/export:rotate-90" />
                        </summary>
                        <div className="flex flex-wrap gap-2 border-t border-[#243a5d] p-2.5 text-[10px]">
                          {outputs.sourceCoverageReportUrl ? <a className="rounded border border-emerald-400/35 bg-emerald-400/10 px-2 py-1 text-emerald-200 hover:bg-emerald-400/20" href={`${API_BASE}${outputs.sourceCoverageReportUrl}`} download>Độ phủ nguồn</a> : null}
                          <QcReportPanel
                            apiBase={API_BASE}
                            jobId={job.jobId}
                            outputs={outputs}
                            onSelectIssue={selectQcIssue}
                            onRepairTtsIssue={repairQcTtsIssue}
                            onRerunTtsIssue={rerunQcTtsIssue}
                            onSummaryLoaded={(qcSummary) => setState((previous) => ({
                              ...previous,
                              outputs: { ...(previous.outputs || {}), qcSummary },
                            }))}
                          />
                          {!(outputs.sourceQcReportUrl || outputs.sourceCoverageReportUrl || outputs.translationQcReportUrl || outputs.readabilityQcReportUrl || outputs.ttsQcReportUrl || outputs.syncQcReportUrl || outputs.autoTtsRepairReportUrl || outputs.ttsFitPlan) ? <span className="text-slate-400">Chưa có báo cáo kiểm tra.</span> : null}
                        </div>
                      </details>
                    </div>
                  </Panel> : null}
                </div>
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-[8px] border border-[#20385f] bg-[#071020] shadow-[0_12px_34px_rgba(0,0,0,0.18)]">
                <div className="border-b border-[#20385f] bg-[#0a1528] px-3 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="shrink-0 whitespace-nowrap text-sm font-black text-white">Nhật ký hoạt động</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={copyLogs} className="whitespace-nowrap rounded-[6px] border border-[#2a4166] bg-[#101e34] px-2 py-1 text-[10px] font-bold text-slate-200 hover:border-sky-400/60 hover:bg-sky-400/10">Sao chép</button>
                      <button type="button" onClick={clearLogs} className="whitespace-nowrap rounded-[6px] border border-[#2a4166] bg-[#101e34] px-2 py-1 text-[10px] font-bold text-slate-200 hover:border-red-400/60 hover:bg-red-400/10 hover:text-red-100">Xóa</button>
                    </div>
                  </div>
                </div>
                {state.error ? (
                  <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">{state.error}</div>
                ) : null}
                <div ref={logListRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto font-mono text-[10px] leading-4">
                  {(logs.length ? logs : ['Chưa có hoạt động.']).map((line, index) => {
                    const entry = parseActivityLogLine(line);
                    const tone = activityLogTone(entry.message);
                    return (
                      <div key={`${line}-${index}`} className={`grid grid-cols-[52px_8px_minmax(0,1fr)] items-start gap-1.5 border-b px-2.5 py-1.5 ${tone.row}`}>
                        <span className="whitespace-nowrap text-slate-500">{entry.time}</span>
                        <span className={`mt-1 h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                        <span className={`min-w-0 whitespace-pre-wrap break-all ${tone.text}`}>{entry.message}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          </div>
        )}
        </main>

        <RunningTaskBar
          task={currentTask}
          rows={rows}
          wordCount={wordCount}
          logs={logs}
          onCancel={stopCurrentTask}
          modalOpen={Boolean(activeModal)}
        />

        {contextMenu ? (
          <div
            ref={contextMenuRef}
            className="fixed z-[60] w-52 overflow-hidden rounded-[6px] border border-[#28436d] bg-[#071020] py-1 text-sm text-white shadow-[0_18px_60px_rgba(0,0,0,0.45)]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button className="block w-full px-3 py-2 text-left font-semibold text-sky-100 hover:bg-[#123154]" onClick={() => rerunTtsForRow(contextMenu.rowId)}>TTS dòng này</button>
            <button className="block w-full px-3 py-2 text-left hover:bg-[#10213b]" onClick={() => { retranslateRow(contextMenu.rowId); setContextMenu(null); }}>Dịch dòng này</button>
            <button className="block w-full px-3 py-2 text-left text-red-200 hover:bg-[#451515]" onClick={() => deleteRow(contextMenu.rowId)}>Xóa dòng</button>
          </div>
        ) : null}

        {activeModal === 'newProject' ? (
          <Modal
            title="Tạo project mới"
            onClose={() => setActiveModal(null)}
            footer={<Button tone="yellow" onClick={createNewProject}>Tạo project</Button>}
          >
            <div className="grid gap-1.5 text-xs text-slate-200">
              <label htmlFor="new-project-name" className="font-semibold text-slate-300">Tên project</label>
              <input
                id="new-project-name"
                ref={newProjectNameInputRef}
                type="text"
                autoFocus
                value={newProjectNameDraft}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setNewProjectNameDraft(event.currentTarget.value)}
                onInput={(event) => setNewProjectNameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    createNewProject();
                  }
                }}
                placeholder="Nhập tên project"
                className="h-11 w-full rounded-[4px] border border-[#263a5d] bg-[#0b1426] px-3 text-sm text-white outline-none focus:border-[#f1cc00]"
              />
            </div>
          </Modal>
        ) : null}

        {activeModal === 'source' ? (
          <Modal
            title="Thêm nguồn video"
            onClose={() => setActiveModal(null)}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                tone="green"
                onClick={() => {
                  setActiveModal(null);
                  pickVideo();
                }}
              >
                Chọn file local
              </Button>
              <Button
                tone="yellow"
                onClick={() => {
                  setActiveModal(null);
                  loadYoutubeVideo(youtubeDraft);
                }}
              >
                Tải YouTube
              </Button>
            </div>
            <Field label="YouTube URL">
              <Input value={youtubeDraft} onChange={(event) => setYoutubeDraft(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
            </Field>
          </Modal>
        ) : null}

        {activeModal === 'srt' ? (
          <Modal
            title="Thêm SRT vào timeline"
            onClose={() => setActiveModal(null)}
          >
            <div className="rounded border border-[#263a5d] bg-[#0b1426] p-3 text-xs leading-5 text-slate-300">
              Chọn đúng loại SRT trước khi up file để app biết cần nạp vào cột nào. Timeline sẽ lấy theo chính file SRT bạn chọn.
            </div>
            <Field label="Bạn đang thêm loại SRT nào?">
              <Select value={srtImportType} onChange={(event) => setSrtImportType(event.target.value)}>
                {SRT_IMPORT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="File .srt">
              <Input
                type="file"
                accept=".srt,text/plain"
                onChange={(event) => handleSrtFile(event.target.files?.[0])}
              />
            </Field>
            <div className="grid gap-2 text-xs text-slate-300">
              <div>SRT gốc: nạp vào cột nội dung gốc và giữ timeline theo file.</div>
              <div>SRT dịch: nạp vào cột dịch và giữ timeline theo file.</div>
              <div>SRT hoàn chỉnh: nạp vào nội dung final để lồng tiếng/xuất, giữ timeline theo file.</div>
            </div>
          </Modal>
        ) : null}

        {activeModal === 'output' ? (
          <Modal
            title="Nơi lưu video xuất"
            onClose={() => setActiveModal(null)}
            footer={<Button tone="blue" onClick={() => setActiveModal(null)}>Đóng</Button>}
          >
            <div className="rounded border border-[#263a5d] bg-[#0b1426] p-3 text-xs leading-5 text-slate-300">
              Folder hiện tại: {config.outputDirectory || 'chưa chọn, app sẽ lưu trong job hiện tại'}.
            </div>
            <Button tone="blue" onClick={pickOutputFolder}>Chọn folder lưu</Button>
            <Field label="Tên file xuất">
              <Input value={config.outputFileName} onChange={(event) => patchConfig({ outputFileName: event.target.value })} />
            </Field>
            <div className="rounded border border-[#263a5d] bg-[#0b1426] p-3 text-xs leading-5 text-slate-300">
              Khi xuất xong, log sẽ ghi đường dẫn file đã lưu.
            </div>
          </Modal>
        ) : null}

        {activeModal === 'translationSkill' ? (
          <Modal
            title={skillDoc.name === 'subtitle-cue-grouping' ? 'Skill gộp STT' : skillDoc.name === 'subtitle-translation-prompt' ? 'Skill dịch' : skillDoc.name === 'subtitle-tts-overflow-repair' ? 'Skill sửa lỗi TTS' : 'Skill'}
            className="!max-w-[1120px]"
            onClose={() => setActiveModal(null)}
            footer={<Button tone="blue" onClick={() => setActiveModal(null)}>Đóng</Button>}
          >
            <div className="grid gap-3">
              <div className="rounded border border-[#263a5d] bg-[#071020] p-3 text-xs leading-5 text-slate-300">
                <div className="font-semibold text-[#f1cc00]">{skillDoc.name ? `$${skillDoc.name}` : '$skill'}</div>
                <div>File portable trong project: .codex/skills/{skillDoc.name || 'skill'}/SKILL.md</div>
                {skillDoc.path ? <div className="break-all text-slate-400">Backend doc: {skillDoc.path}</div> : null}
              </div>
              {skillDoc.loading ? (
                <div className="rounded border border-[#263a5d] bg-[#071020] p-4 text-sm text-slate-300">Đang tải skill...</div>
              ) : skillDoc.error ? (
                <div className="rounded border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-100">{skillDoc.error}</div>
              ) : (
                <pre className="max-h-[62vh] overflow-auto whitespace-pre-wrap rounded border border-[#263a5d] bg-[#050b16] p-4 text-xs leading-5 text-slate-100">{skillDoc.content}</pre>
              )}
            </div>
          </Modal>
        ) : null}

        {activeModal === 'stt' ? (
          <Modal
            title="Tùy chọn tốc độ — phụ đề gốc"
            onClose={() => setActiveModal(null)}
            footer={(
              sttToolTab === 'stt' ? (
                <Button
                  tone="yellow"
                  disabled={false}
                  onClick={() => startModalTask(generateSourceSubtitle)}
                >
                  Tiếp tục →
                </Button>
              ) : (
                <Button tone="dark" onClick={() => setActiveModal(null)}>Đóng</Button>
              )
            )}
          >
            <div className="hidden">
              <Field label="Tốc độ video">
                <Input type="number" step="0.05" min="0.5" max="2" value={config.videoSpeed} onChange={(event) => patchConfig({ videoSpeed: Number(event.target.value) })} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={config.autoAdjustSpeed} onChange={(event) => patchConfig({ autoAdjustSpeed: event.target.checked })} />
                Tự động điều chỉnh tốc độ
              </label>
              <p className="text-xs leading-5 text-slate-400">
                Tool sẽ tự động giảm tốc độ video về mức hợp lý để lồng tiếng, sau đó tự động tăng lại để giữ nguyên thời lượng video gốc.
              </p>
              <div className="rounded border border-[#263a5d] bg-[#0b1426] p-3 text-sm text-slate-300">
                Dùng provider thật trong repo: Faster Whisper Local hoặc Groq Whisper STT.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded border border-[#263a5d] bg-[#071020] p-1">
              <Button tone={sttToolTab === 'stt' ? 'yellow' : 'dark'} className="h-9" onClick={() => setSttToolTab('stt')}>Tạo STT</Button>
              <Button tone={sttToolTab === 'srt' ? 'yellow' : 'dark'} className="h-9" onClick={() => setSttToolTab('srt')}>Thêm SRT gốc</Button>
            </div>
            {sttToolTab === 'srt' ? (
              <div className="grid gap-4 rounded border border-[#263a5d] bg-[#0b1426] p-4">
                <Field label="SRT gốc">
                  <Input type="file" accept=".srt,text/plain" onChange={(event) => handleSrtFile(event.target.files?.[0], 'source')} />
                </Field>
              </div>
            ) : null}
            {sttToolTab === 'stt' ? (
              <div className="grid gap-3 rounded border border-[#263a5d] bg-[#071020] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="grid gap-1">
                    <div className="text-sm font-black uppercase text-[#f1cc00]">Skill gộp STT</div>
                    <div className="text-xs font-semibold text-slate-300">$subtitle-cue-grouping</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openSkill('subtitle-cue-grouping')}
                    className="h-9 rounded-[6px] border border-[#f1cc00]/50 bg-[#071020] px-3 text-xs font-bold text-[#f1cc00] hover:bg-[#111827]"
                  >
                    Xem skill
                  </button>
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#263a5d] bg-[#0b1426] px-3 py-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={isSubtitleCueGroupingEnabled(config)}
                    onChange={(event) => patchConfig({ subtitleGroupSettingsVersion: 1, subtitleGroupEnabled: event.target.checked })}
                    className="mt-0.5 accent-[#f1cc00]"
                  />
                  <span>
                    <span className="block font-bold text-white">Gộp ý bằng AI</span>
                    <span className="block text-xs leading-5 text-slate-400">
                      Tắt: trả về nguyên bản từng cue STT. Bật: AI chỉ chọn các cue để gộp, vẫn giữ nguyên text và mốc thời gian gốc.
                    </span>
                  </span>
                </label>
              </div>
            ) : null}
            <div className={`${sttToolTab === 'stt' ? 'grid' : 'hidden'} gap-4 sm:grid-cols-2`}>
              <Field label="Công cụ nhận diện giọng nói">
                <Select value={config.sttProvider} onChange={(event) => patchConfig(defaultSttPatchForProvider(event.target.value))}>
                  {STT_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </Select>
              </Field>
              <Field label="Mô hình nhận diện">
                <Select value={config.sttModel} onChange={(event) => patchConfig({ sttModel: event.target.value })}>
                  {(STT_MODELS[config.sttProvider] || []).map((item) => <option key={item} value={item}>{item}</option>)}
                </Select>
              </Field>
              <Field label="Kiểu mốc thời gian">
                <Select value={config.sttTimestampMode} onChange={(event) => patchConfig({ sttTimestampMode: event.target.value })}>
                  {(config.sttProvider === 'assemblyai_speech_to_text' ? ASSEMBLYAI_TIMESTAMP_MODES : STT_TIMESTAMP_MODES).map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Ngôn ngữ gốc">
                <Select value={config.sourceLanguage} onChange={(event) => patchConfig({ sourceLanguage: event.target.value })}>
                  {LANGUAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </Select>
              </Field>
            </div>
            {sttToolTab === 'stt' && isSubtitleCueGroupingEnabled(config) ? (
            <div className="grid gap-3 rounded border border-[#263a5d] bg-[#0b1426] p-3 text-sm text-slate-200">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Provider AI gộp">
                  <Select
                    value={normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider)}
                    onChange={(event) => {
                      patchConfig({ subtitleGroupProvider: event.target.value, subtitleGroupModel: '' });
                      setEditingSubtitleGroupModel(false);
                    }}
                  >
                    {TRANSLATION_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </Select>
                </Field>
                <Field label="Model AI gộp">
                  <div className="grid gap-2">
                    <Select
                      value={(editingSubtitleGroupModel || getCliTranslationCustomModel(normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider), config.subtitleGroupModel))
                        ? '__custom'
                        : getCliTranslationModelSelectValue(normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider), config.subtitleGroupModel)}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === '__custom') {
                          setEditingSubtitleGroupModel(true);
                          return;
                        }
                        setEditingSubtitleGroupModel(false);
                        patchConfig({ subtitleGroupModel: value });
                      }}
                    >
                      <option value="">Mặc định</option>
                      {getCliTranslationModelOptions(normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider)).map((item) => (
                        <option key={item} value={item}>{item}</option>
                      ))}
                      <option value="__custom">Tự nhập...</option>
                    </Select>
                    {(editingSubtitleGroupModel || getCliTranslationCustomModel(normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider), config.subtitleGroupModel)) ? (
                      <Input
                        value={getCliTranslationCustomModel(normalizeSubtitleGroupProvider(config.subtitleGroupProvider, config.translationProvider), config.subtitleGroupModel)}
                        onChange={(event) => patchConfig({ subtitleGroupModel: event.target.value })}
                        placeholder="Nhập model AI gộp"
                      />
                    ) : null}
                  </div>
                </Field>
              </div>              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Ngôn ngữ gộp">
                  <Select
                    value={config.subtitleGroupLanguage || DEFAULT_STATE.config.subtitleGroupLanguage}
                    onChange={(event) => patchConfig({ subtitleGroupLanguage: event.target.value })}
                  >
                    {SUBTITLE_GROUP_LANGUAGE_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Số cue gửi mỗi batch">
                  <Input
                    type="number"
                    min="8"
                    max="120"
                    step="1"
                    value={config.subtitleGroupBatchSize ?? DEFAULT_STATE.config.subtitleGroupBatchSize}
                    onChange={(event) => patchConfig({ subtitleGroupBatchSize: Number(event.target.value) || DEFAULT_STATE.config.subtitleGroupBatchSize })}
                  />
                </Field>
                <Field label="Batch AI song song">
                  <Input
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.subtitleGroupConcurrency}
                    onChange={(event) => patchConfig({
                      subtitleGroupConcurrency: Number(event.target.value) || DEFAULT_STATE.config.subtitleGroupConcurrency,
                      cliTranslationConcurrency: Number(event.target.value) || DEFAULT_STATE.config.cliTranslationConcurrency,
                    })}
                  />
                </Field>
              </div>
            </div>
            ) : null}
            {sttToolTab === 'stt' && config.sttProvider === 'groq_speech_to_text' ? (
              <Field label="Khóa API Groq">
                <GroqKeyManager
                  config={config}
                  onChange={patchConfig}
                  placeholder="Khóa Groq"
                />
                <span className="text-xs leading-5 text-slate-400">
                  Nhập mỗi khóa một dòng. App lưu cục bộ và dùng tối đa 3 khóa song song khi nhận diện bằng Groq.
                </span>
              </Field>
            ) : null}
            {sttToolTab === 'stt' && config.sttProvider === 'assemblyai_speech_to_text' ? (
              <>
                <Field label="Khóa API AssemblyAI">
                  <AssemblyAiKeyManager
                    config={config}
                    onChange={patchConfig}
                    placeholder="Khóa AssemblyAI"
                  />
                  <span className="text-xs leading-5 text-slate-400">
                    Nhập mỗi khóa một dòng. Mặc định cắt audio thành nhiều đoạn và chạy song song để hướng tới thời gian 2-3 phút với video vừa phải.
                  </span>
                </Field>
                <details className="rounded border border-[#263a5d] bg-[#0b1426] text-sm text-slate-200">
                  <summary className="cursor-pointer px-3 py-2 font-semibold text-slate-300">
                    Tùy chọn nâng cao AssemblyAI
                  </summary>
                  <div className="grid gap-3 border-t border-[#263a5d] p-3">
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Field label="Chế độ xử lý">
                        <Select
                          value={config.assemblyAiProcessingMode || DEFAULT_STATE.config.assemblyAiProcessingMode}
                          onChange={(event) => patchConfig({ assemblyAiProcessingMode: event.target.value })}
                        >
                          <option value="parallel">Tách đoạn song song</option>
                          <option value="whole">Gửi nguyên file</option>
                        </Select>
                      </Field>
                      <Field label="Độ dài đoạn">
                        <Input
                          type="number"
                          min="60"
                          max="600"
                          step="30"
                          value={config.assemblyAiChunkSeconds ?? DEFAULT_STATE.config.assemblyAiChunkSeconds}
                          onChange={(event) => patchConfig({ assemblyAiChunkSeconds: Number(event.target.value) || DEFAULT_STATE.config.assemblyAiChunkSeconds })}
                        />
                      </Field>
                      <Field label="Chồng lấn">
                        <Input
                          type="number"
                          min="2"
                          max="30"
                          step="1"
                          value={config.assemblyAiOverlapSeconds ?? DEFAULT_STATE.config.assemblyAiOverlapSeconds}
                          onChange={(event) => patchConfig({ assemblyAiOverlapSeconds: Number(event.target.value) || DEFAULT_STATE.config.assemblyAiOverlapSeconds })}
                        />
                      </Field>
                      <Field label="Số luồng">
                        <Input
                          type="number"
                          min="1"
                          max="6"
                          step="1"
                          value={config.assemblyAiConcurrency ?? DEFAULT_STATE.config.assemblyAiConcurrency}
                          onChange={(event) => patchConfig({ assemblyAiConcurrency: Number(event.target.value) || DEFAULT_STATE.config.assemblyAiConcurrency })}
                        />
                      </Field>
                    </div>
                    <div className="text-xs leading-5 text-slate-400">
                      Gợi ý 2-3 phút: 180 giây mỗi đoạn, chồng lấn 6 giây, số luồng bằng số khóa đang có.
                    </div>
                    <Field label="Gợi ý ngữ cảnh">
                      <TextArea
                        value={config.assemblyAiPrompt}
                        onChange={(event) => patchConfig({ assemblyAiPrompt: event.target.value })}
                        placeholder="VD: Video tài liệu có tên riêng, địa danh, số liệu hoặc thuật ngữ chuyên môn."
                      />
                    </Field>
                    <Field label="Thuật ngữ ưu tiên">
                      <TextArea
                        value={config.assemblyAiKeyterms}
                        onChange={(event) => patchConfig({ assemblyAiKeyterms: event.target.value })}
                        placeholder="Mỗi dòng một tên riêng hoặc thuật ngữ. VD:&#10;DubFlow&#10;Hang Sơn Đoòng"
                      />
                    </Field>
                  </div>
                </details>
              </>
            ) : null}
            {sttToolTab === 'stt' && config.sttProvider === 'faster_whisper_local' ? (
              <div className="rounded border border-[#263a5d] bg-[#0b1426] p-3 text-xs leading-5 text-slate-300">
                Faster Whisper đã sẵn sàng với CUDA. Khuyến nghị dùng large-v3 trên GPU int8; nếu muốn nhẹ hơn có thể chọn medium hoặc small.
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              <Button tone="blue" onClick={saveGlobalSettings}>Lưu cấu hình</Button>
              <SettingsSaveStatus />
            </div>
          </Modal>
        ) : null}

        {activeModal === 'subtitleTools' ? (
          <Modal
            title="Phụ đề"
            className="max-w-[820px]"
            onClose={() => setActiveModal(null)}
            footer={(
              subtitleToolTab === 'ocr' ? (
                <Button
                  tone="yellow"
                  onClick={() => startModalTask(generateBurnedSubtitleKeyframeOcr)}
                >
                  {'Chạy OCR -> SRT'}
                </Button>
              ) : subtitleToolTab === 'translate' ? (
                <Button
                  tone="yellow"
                  onClick={() => startModalTask(translateSubtitle)}
                >
                  Dịch phụ đề
                </Button>
              ) : (
                <Button tone="dark" onClick={() => setActiveModal(null)}>Đóng</Button>
              )
            )}
          >
            <div className="grid grid-cols-3 gap-2 rounded border border-[#263a5d] bg-[#071020] p-1">
              <Button
                tone={subtitleToolTab === 'ocr' ? 'yellow' : 'dark'}
                className="h-9"
                onClick={() => setSubtitleToolTab('ocr')}
              >
                OCR phụ đề cháy
              </Button>
              <Button
                tone={subtitleToolTab === 'translate' ? 'yellow' : 'dark'}
                className="h-9"
                onClick={() => setSubtitleToolTab('translate')}
              >
                Dịch phụ đề
              </Button>
              <Button
                tone={subtitleToolTab === 'srt' ? 'yellow' : 'dark'}
                className="h-9"
                onClick={() => setSubtitleToolTab('srt')}
              >
                Thêm SRT dịch
              </Button>
            </div>
            {subtitleToolTab === 'ocr' ? (
              <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Local timeline FPS">
                  <Select value={String(config.ocrKeyframeTimelineFps ?? 30)} onChange={(event) => patchConfig({ ocrKeyframeTimelineFps: Number(event.target.value) })}>
                    <option value="15">15 fps - nhanh hơn</option>
                    <option value="20">20 fps - cân bằng</option>
                    <option value="30">30 fps - sát frame gốc</option>
                    <option value="50">50 fps - timeline rất sát</option>
                    <option value="60">60 fps - tối đa</option>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 rounded border border-[#263a5d] bg-[#0b1426] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button tone="blue" onClick={loadOcrFramePicker}>Lấy 1 frame để khoanh crop</Button>
                </div>
                {ocrFramePicker?.imageUrl ? (
                  <div className="grid gap-2">
                    <div
                      className="relative max-h-[360px] cursor-crosshair overflow-hidden rounded border border-[#263a5d] bg-black"
                      onPointerDown={beginOcrCropDrag}
                      onPointerMove={moveOcrCropDrag}
                      onPointerUp={finishOcrCropDrag}
                      onPointerCancel={() => setOcrCropDrag(null)}
                    >
                      <img
                        src={`${API_BASE}${ocrFramePicker.imageUrl}?t=${ocrFramePicker.cacheBust || 0}`}
                        alt="OCR frame crop picker"
                        draggable={false}
                        className="block max-h-[360px] w-full select-none object-contain"
                      />
                      {(() => {
                        const rect = ocrCropDrag
                          ? cropRectFromPoints(ocrCropDrag.start, ocrCropDrag.current)
                          : {
                              x: Number(config.ocrCropX ?? 0) || 0,
                              y: Number(config.ocrCropY ?? 0.72) || 0.72,
                              w: Number(config.ocrCropW ?? 1) || 1,
                              h: Number(config.ocrCropH ?? 0.24) || 0.24,
                            };
                        return (
                          <div
                            className="pointer-events-none absolute border-2 border-[#f1cc00] bg-[#f1cc00]/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                            style={{
                              left: `${clamp(rect.x, 0, 1) * 100}%`,
                              top: `${clamp(rect.y, 0, 1) * 100}%`,
                              width: `${clamp(rect.w, 0.01, 1) * 100}%`,
                              height: `${clamp(rect.h, 0.01, 1) * 100}%`,
                            }}
                          />
                        );
                      })()}
                    </div>
                    <div className="text-xs leading-5 text-slate-400">
                      Frame: {formatClock(Number(ocrFramePicker.time) || 0)} | Ảnh: {ocrFramePicker.width || '?'}x{ocrFramePicker.height || '?'}
                    </div>
                  </div>
                ) : null}
              </div>
            <div className="flex items-center gap-3">
              <Button tone="blue" onClick={saveGlobalSettings}>Lưu cấu hình</Button>
              <SettingsSaveStatus />
            </div>
              </div>
            ) : null}
            {subtitleToolTab === 'srt' ? (
              <div className="grid gap-4 rounded border border-[#263a5d] bg-[#0b1426] p-4">
                <Field label="SRT dịch">
                  <Input type="file" accept=".srt,text/plain" onChange={(event) => handleSrtFile(event.target.files?.[0], 'translated')} />
                </Field>
                <Field label="SRT hoàn chỉnh">
                  <Input type="file" accept=".srt,text/plain" onChange={(event) => handleSrtFile(event.target.files?.[0], 'final')} />
                </Field>
              </div>
            ) : null}
            {subtitleToolTab === 'translate' ? (
              <div className="grid gap-4">
                <section className="grid gap-4 rounded border border-[#263a5d] bg-[#0b1426] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[#263a5d] bg-[#071020] p-3">
                    <div className="grid gap-1">
                      <div className="text-sm font-black uppercase text-[#f1cc00]">Thiết lập dịch</div>
                      <div className="flex flex-wrap gap-2 text-[11px] font-semibold text-slate-300">
                        <span className="rounded border border-[#31537f] bg-[#0b1426] px-2 py-1">Skill: {translationUsesPromptSkill ? '$subtitle-translation-prompt' : 'dịch thường'}</span>
                        <span className="rounded border border-[#31537f] bg-[#0b1426] px-2 py-1">Provider: {activeTranslationProviderLabel}</span>
                        <span className="rounded border border-[#31537f] bg-[#0b1426] px-2 py-1">Model: {activeTranslationModelLabel}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openSkill('subtitle-translation-prompt')}
                      className="h-9 rounded-[6px] border border-[#f1cc00]/50 bg-[#071020] px-3 text-xs font-bold text-[#f1cc00] hover:bg-[#111827]"
                    >
                      Xem skill
                    </button>
                  </div>

                  {translationUsesPromptSkill ? (
                    <div className="hidden">
                      <div className="font-bold text-[#f1cc00]">Đang dùng Skill dịch Prompt 2</div>
                      <div className="mt-1 text-yellow-100/80">
                        Bảng hiện tại là group từ Prompt 1, nên hệ thống chỉ gửi text đã gộp vào skill và nhận lại <span className="font-mono">translation_merged</span>. Provider, model, ngôn ngữ đích và batch song song vẫn được dùng để chạy AI.
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Provider dịch">
                      <Select
                        value={config.translationProvider}
                        onChange={(event) => {
                          setEditingCliTranslationModel(false);
                          patchConfig({ translationProvider: event.target.value, cliTranslationModel: '' });
                        }}
                      >
                        {TRANSLATION_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </Select>
                    </Field>

                    <Field label="Model dịch">
                      <div className="grid gap-2">
                        <Select
                          value={(editingCliTranslationModel || getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel))
                            ? '__custom'
                            : getCliTranslationModelSelectValue(config.translationProvider, config.cliTranslationModel)}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (value === '__custom') {
                              setEditingCliTranslationModel(true);
                              return;
                            }
                            setEditingCliTranslationModel(false);
                            patchConfig({ cliTranslationModel: value });
                          }}
                        >
                          <option value="">Mặc định</option>
                          {getCliTranslationModelOptions(config.translationProvider).map((item) => (
                            <option key={item} value={item}>{item}</option>
                          ))}
                          <option value="__custom">Tùy chỉnh...</option>
                        </Select>
                        {(editingCliTranslationModel || getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel)) ? (
                          <Input
                            value={getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel)}
                            placeholder="Nhập model tùy chỉnh"
                            onChange={(event) => patchConfig({ cliTranslationModel: event.target.value })}
                          />
                        ) : null}
                      </div>
                    </Field>

                    <Field label="Chế độ dịch">
                      <Select
                        value={config.translationMode || DEFAULT_STATE.config.translationMode}
                        onChange={(event) => {
                          const translationMode = event.target.value;
                          patchConfig({
                            translationMode,
                            ttsUnitMode: translationMode === 'story_v2' ? 'story_segments' : 'meaning_units',
                          });
                        }}
                      >
                        <option value="story_v2">{translationUsesPromptSkill ? 'Câu chuyện liền mạch (khuyến nghị)' : 'Câu chuyện tự nhiên (v2)'}</option>
                        <option value="legacy">{translationUsesPromptSkill ? 'Dịch từng cụm (Prompt 2)' : 'Dự phòng: cách dịch cũ'}</option>
                      </Select>
                    </Field>

                    <Field label="Ngôn ngữ đích">
                      <Select value={config.targetLanguage} onChange={(event) => patchConfig({ targetLanguage: event.target.value })}>
                        {LANGUAGES.filter((item) => item.value !== 'auto').map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </Select>
                    </Field>

                    {config.translationMode !== 'story_v2' && !translationUsesPromptSkill ? (
                      <Field label="Timeline sau dịch">
                        <Select
                          value={config.translationDisplayMode || DEFAULT_STATE.config.translationDisplayMode}
                          onChange={(event) => patchConfig({ translationDisplayMode: event.target.value })}
                        >
                          <option value="source_timeline">Giữ timeline gốc</option>
                          <option value="meaning_timeline">Dùng timeline cụm nghĩa</option>
                        </Select>
                      </Field>
                    ) : (
                      <div className="hidden">
                        <span className="block font-bold text-emerald-200">{translationUsesPromptSkill && config.translationMode !== 'story_v2' ? 'Timeline theo group Prompt 1' : 'Timeline story v2'}</span>
                        <span className="block">{translationUsesPromptSkill && config.translationMode !== 'story_v2' ? 'Mode nhanh: mỗi group được dịch riêng.' : 'Group Prompt 1 được dùng làm ngữ cảnh; câu kể được viết theo nhiều group liên tiếp.'}</span>
                      </div>
                    )}

                    <Field label="Tốc độ mục tiêu khi dịch">
                      <Input
                        type="number"
                        step="0.05"
                        min="0.75"
                        max="1.5"
                        value={String(normalizeTranslationTargetTtsRate(config.translationTargetTtsRate ?? DEFAULT_STATE.config.translationTargetTtsRate)).replace(',', '.')}
                        onChange={(event) => patchConfig({ translationTargetTtsRate: normalizeTranslationTargetTtsRate(event.target.value) })}
                      />
                    </Field>

                    <Field label="Batch dịch song song">
                      <Input
                        type="number"
                        min="1"
                        max="5"
                        value={String(Number(config.cliTranslationConcurrency ?? config.subtitleGroupConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency) || DEFAULT_STATE.config.cliTranslationConcurrency)}
                        onChange={(event) => patchConfig({
                          cliTranslationConcurrency: Number(event.target.value) || DEFAULT_STATE.config.cliTranslationConcurrency,
                        })}
                      />
                    </Field>

                    <div className="hidden">
                      <span className="block font-bold text-emerald-300">Tự chuyển số sang chữ khi dịch tiếng Việt.</span>
                      <span className="block">Ví dụ: 52 người thành năm mươi hai người.</span>
                    </div>
                  </div>
                </section>

                <section className="grid gap-3 rounded border border-[#263a5d] bg-[#0b1426] p-4">
                  <Field label="Ngữ cảnh video">
                    <TextArea value={config.videoContext} onChange={(event) => patchConfig({ videoContext: event.target.value })} />
                  </Field>
                  <div className="flex items-center gap-3">
                    <Button tone="blue" onClick={saveGlobalSettings}>Lưu cấu hình</Button>
                    <SettingsSaveStatus />
                  </div>
                </section>
              </div>
            ) : null}
          </Modal>
        ) : null}

        {activeModal === 'tts' ? (
          <Modal
            title="Lồng tiếng"
            className="!max-w-[1180px]"
            onClose={() => setActiveModal(null)}
            footer={(
              <Button
                tone="green"
                className="h-9 px-5 text-sm"
                onClick={() => startModalTask(runTts)}
              >
                Lồng tiếng ngay
              </Button>
            )}
          >
            <div className="hidden">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.ttsProvider === 'edge_tts'} onChange={() => patchConfig({ ttsProvider: 'edge_tts', ttsVoiceName: '', ttsConcurrency: 20, ttsMaxAttempts: 4 })} />Giọng Edge (Free)</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.ttsProvider === 'google_cloud_tts'} onChange={() => patchConfig({ ttsProvider: 'google_cloud_tts', ttsVoiceName: '', ttsConcurrency: 2, ttsMaxAttempts: 4 })} />Google Cloud TTS</label>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.85fr)] lg:items-start">
              <section className="grid gap-4 rounded-[8px] border border-[#20385f] bg-[#0b1528] p-4">
                <div>
                  <h4 className="text-lg font-black text-[#f1cc00]">Phân luồng tiếng</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-400">Chia câu đọc, khớp timeline và kiểm soát audio trước khi tạo lồng tiếng.</p>
                </div>

                <div className="grid gap-3 rounded-[6px] border border-[#263a5d] bg-[#071020] p-3 sm:grid-cols-2">
                  <Field label="Cách chia câu đọc">
                    <Select value={effectiveTtsUnitModeForRows(config.ttsUnitMode, rows)} onChange={(event) => patchConfig({ ttsUnitMode: event.target.value })}>
                      <option value="story_segments">Theo câu chuyện đã duyệt</option>
                      <option value="meaning_units">Theo cụm nghĩa</option>
                      <option value="post_translation">Theo bản dịch cuối</option>
                    </Select>
                  </Field>
                  {effectiveTtsUnitModeForRows(config.ttsUnitMode, rows) === 'meaning_units' ? (
                    <>
                      <Field label="Min câu gộp (giây)">
                        <Input type="number" step="0.1" min="1" max="6" value={config.naturalDubTargetMinSeconds ?? DEFAULT_STATE.config.naturalDubTargetMinSeconds} onChange={(event) => patchConfig({ naturalDubTargetMinSeconds: Number(event.target.value) })} />
                      </Field>
                      <Field label="Max câu gộp (giây)">
                        <Input type="number" step="0.1" min="1.5" max="8" value={config.naturalDubTargetMaxSeconds ?? DEFAULT_STATE.config.naturalDubTargetMaxSeconds} onChange={(event) => patchConfig({ naturalDubTargetMaxSeconds: Number(event.target.value) })} />
                      </Field>
                      <Field label="Số dòng gộp tối đa">
                        <Input type="number" step="1" min="1" max="10" value={config.maxMeaningUnitSourceRows ?? DEFAULT_STATE.config.maxMeaningUnitSourceRows} onChange={(event) => patchConfig({ maxMeaningUnitSourceRows: Number(event.target.value) })} />
                      </Field>
                    </>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Tốc độ đọc">
                    <Input
                      type="number"
                      step="0.05"
                      min="0.5"
                      max="2"
                      value={String(normalizeSpeakingRate(config.speakingRate)).replace(',', '.')}
                      onChange={(event) => {
                        const speakingRate = normalizeSpeakingRate(event.target.value);
                        patchConfig({
                          speakingRate,
                          ttsFitMaxRate: speakingRate,
                        });
                      }}
                    />
                  </Field>
                  {config.ttsProvider !== 'aimax_tts' ? (
                    <Field label="Pitch">
                      <Input type="number" step="0.5" min="-20" max="20" value={config.pitch} onChange={(event) => patchConfig({ pitch: Number(event.target.value) })} />
                    </Field>
                  ) : null}
                </div>

                <div className="rounded border border-amber-400/25 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="font-black text-amber-200">Chống tràn TTS</div>
                    <Toggle checked={config.ttsFitEnabled !== false} onChange={(checked) => patchConfig({ ttsFitEnabled: checked })} label="Bật" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Dấu câu TTS">
                      <Select value={config.ttsTextCleanupMode || DEFAULT_STATE.config.ttsTextCleanupMode} onChange={(event) => patchConfig({ ttsTextCleanupMode: event.target.value })}>
                        <option value="natural">Giữ dấu câu</option>
                        <option value="fast">Đọc nhanh - lược dấu</option>
                        <option value="strict">Giữ nguyên tối đa</option>
                      </Select>
                    </Field>
                  </div>
                  <p className="mt-2 text-[11px] text-amber-100/80">
                    Bật: TTS ghép timeline trước ở tốc độ đọc, đo audio thực tế rồi tính lại mọi cue tràn quá 0,02 giây bằng chính audio đó; không gọi TTS lần hai và không đổi nội dung dịch. Tràn từ 1 giây vẫn được đánh dấu mức nghiêm trọng. Tắt: chỉ ghép và kiểm tra tràn theo cơ chế thường.
                  </p>
                  <div className="mt-3 grid gap-3 border-t border-amber-400/20 pt-3 sm:grid-cols-3">
                    <div className="flex items-center justify-between gap-3 rounded border border-amber-400/25 bg-[#071020] px-3 py-2">
                      <span className="text-[11px] font-black text-amber-100">Auto repair TTS</span>
                      <Toggle checked={config.autoTtsRepairEnabled === true} onChange={(checked) => patchConfig({ autoTtsRepairEnabled: checked })} label="On" />
                    </div>
                    <Field label="Auto max passes">
                      <Input
                        type="number"
                        min="1"
                        max="3"
                        value={Math.max(1, Math.min(3, Number(config.autoTtsRepairMaxPasses ?? DEFAULT_STATE.config.autoTtsRepairMaxPasses) || DEFAULT_STATE.config.autoTtsRepairMaxPasses))}
                        onChange={(event) => patchConfig({ autoTtsRepairMaxPasses: Math.max(1, Math.min(3, Number(event.target.value) || DEFAULT_STATE.config.autoTtsRepairMaxPasses)) })}
                        disabled={config.autoTtsRepairEnabled !== true}
                      />
                    </Field>
                    <Field label="Auto rows/pass">
                      <Input
                        type="number"
                        min="1"
                        max="50"
                        value={Math.max(1, Math.min(50, Number(config.autoTtsRepairMaxRowsPerPass ?? DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass))}
                        onChange={(event) => patchConfig({ autoTtsRepairMaxRowsPerPass: Math.max(1, Math.min(50, Number(event.target.value) || DEFAULT_STATE.config.autoTtsRepairMaxRowsPerPass)) })}
                        disabled={config.autoTtsRepairEnabled !== true}
                      />
                    </Field>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Số request song song">
                      <Input
                        type="number"
                        min="1"
                        max={maxTtsConcurrencyForProvider(config.ttsProvider)}
                        value={clampTtsConcurrency(config.ttsProvider, config.ttsConcurrency)}
                        onChange={(event) => patchConfig({ ttsConcurrency: clampTtsConcurrency(config.ttsProvider, event.target.value) })}
                      />
                    </Field>
                    <Field label="Retry đoạn lỗi">
                      <Input
                        type="number"
                        min="1"
                        max="5"
                        value={Math.min(Math.max(Number(config.ttsMaxAttempts) || defaultTtsAttemptsForProvider(config.ttsProvider), 1), 5)}
                        onChange={(event) => patchConfig({ ttsMaxAttempts: Math.min(Math.max(Number(event.target.value) || 1, 1), 5) })}
                      />
                    </Field>
                </div>

              </section>

              <aside className="grid gap-3 rounded-[8px] border border-[#20385f] bg-[#0b1528] p-4 lg:sticky lg:top-0">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-lg font-black text-white">Cấu hình giọng</h4>
                    <p className="mt-1 text-xs text-slate-400">{visibleVoices.length}/{effectiveVoices.length} giọng phù hợp</p>
                  </div>
                  <Button tone="dark" className="h-9 px-3" onClick={loadVoices}>
                    <Volume2 className="h-4 w-4" />
                    Tải giọng
                  </Button>
                </div>

                <Field label="Provider">
                  <Select
                    value={config.ttsProvider}
                    onChange={(event) => {
                      const nextProvider = event.target.value;
                      setTtsProviderTestResult(null);
                      patchState({ voices: [] });
                      patchConfig({
                        ttsProvider: nextProvider,
                        ttsVoiceName: '',
                        voiceGenderFilter: 'all',
                        ssmlGender: 'NEUTRAL',
                        voiceFamilyFilter: 'all',
                        voiceSampleRateFilter: 'all',
                        voiceControlsFilter: 'all',
                        ttsConcurrency: defaultTtsConcurrencyForProvider(nextProvider),
                        ttsMaxAttempts: defaultTtsAttemptsForProvider(nextProvider),
                        ...(nextProvider === 'aimax_tts' ? {
                          aimaxProvider: config.aimaxProvider || DEFAULT_AIMAX_PROVIDER,
                          aimaxModel: config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider),
                        } : {}),
                      });
                    }}
                  >
                    <option value="edge_tts">Edge TTS</option>
                    <option value="aimax_tts">AIMAX Clone</option>
                    <option value="google_cloud_tts">Google Cloud TTS</option>
                  </Select>
                </Field>
                <Field label="Ngôn ngữ">
                  <Select
                    value={config.ttsLanguageCode}
                    onChange={(event) => {
                      setTtsProviderTestResult(null);
                      patchState({ voices: [] });
                      patchConfig({ ttsLanguageCode: event.target.value, ttsVoiceName: '', voiceGenderFilter: 'all', ssmlGender: 'NEUTRAL', voiceFamilyFilter: 'all', voiceSampleRateFilter: 'all', voiceControlsFilter: 'all' });
                    }}
                  >
                    {TTS_LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}
                  </Select>
                </Field>
                <Field label="Giới tính">
                  <Select value={config.voiceGenderFilter} onChange={(event) => {
                    const gender = selectedGenderFilter({ voiceGenderFilter: event.target.value });
                    setTtsProviderTestResult(null);
                    patchConfig({ voiceGenderFilter: event.target.value, ssmlGender: gender || 'NEUTRAL', ttsVoiceName: '' });
                  }}>
                    <option value="all">Tất cả</option>
                    <option value="MALE">Nam</option>
                    <option value="FEMALE">Nữ</option>
                    <option value="NEUTRAL">Trung tính</option>
                  </Select>
                </Field>
                {config.ttsProvider !== 'google_cloud_tts' ? (
                  <Field label={`Giọng (${visibleVoices.length})`}>
                    <Select className="border-[#f1cc00]" value={selectedTtsVoiceName} onChange={(event) => {
                      setTtsProviderTestResult(null);
                      patchConfig({ ttsVoiceName: event.target.value });
                    }}>
                      {!visibleVoices.length ? <option value="">Tự chọn giọng</option> : null}
                      {visibleVoices.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}
                    </Select>
                  </Field>
                ) : null}
                {config.ttsProvider === 'aimax_tts' ? (
                  <div className="grid gap-3 rounded-[6px] border border-sky-400/25 bg-sky-400/10 p-3">
                    <Field label="AIMAX API key">
                      <Input
                        type="password"
                        value={config.aimaxApiKey}
                        placeholder="Để trống sẽ dùng Backend\\.env"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          setTtsProviderTestResult(null);
                          patchState({ voices: [] });
                          patchConfig({ aimaxApiKey: event.target.value, ttsVoiceName: '' });
                        }}
                      />
                    </Field>
                    <div className="hidden">
                      <Field label="AIMAX provider">
                        <Select
                          value={config.aimaxProvider || DEFAULT_AIMAX_PROVIDER}
                          onChange={(event) => {
                            const aimaxProvider = event.target.value;
                            patchState({ voices: [] });
                            patchConfig({ aimaxProvider, aimaxModel: defaultAimaxModelForProvider(aimaxProvider), ttsVoiceName: '' });
                          }}
                        >
                          <option value="minimax">Mini</option>
                          <option value="elevenlabs">EL Voice</option>
                        </Select>
                      </Field>
                      <Field label="AIMAX model">
                        <Select
                          value={aimaxModelOptions(config.aimaxProvider).some((model) => model.value === config.aimaxModel) ? config.aimaxModel : 'custom'}
                          onChange={(event) => patchConfig({ aimaxModel: event.target.value === 'custom' ? '' : event.target.value })}
                        >
                          {aimaxModelOptions(config.aimaxProvider).map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                          <option value="custom">Model khác</option>
                        </Select>
                      </Field>
                    </div>
                    {!aimaxModelOptions(config.aimaxProvider).some((model) => model.value === config.aimaxModel) ? (
                      <Field label="Tên model AIMAX">
                        <Input value={config.aimaxModel || ''} onChange={(event) => patchConfig({ aimaxModel: event.target.value })} placeholder={defaultAimaxModelForProvider(config.aimaxProvider)} />
                      </Field>
                    ) : null}
                    <div className="grid gap-3 rounded border border-sky-300/20 bg-[#071020] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-black text-sky-100">TTS theo SRT batch</div>
                          <div className="mt-1 text-[11px] leading-4 text-sky-200/80">Dung cue dich lam text, AIMAX tra SRT moi theo audio.</div>
                        </div>
                        <Toggle checked={config.aimaxSrtBatchEnabled === true} onChange={(checked) => patchConfig({ aimaxSrtBatchEnabled: checked })} label="On" />
                      </div>
                      {config.aimaxSrtBatchEnabled === true ? (
                        <div className="grid gap-3 border-t border-sky-300/20 pt-3 sm:grid-cols-2">
                          <Field label="Batch mode">
                            <Select value={normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode)} onChange={(event) => patchConfig({ aimaxSrtBatchMode: normalizeAimaxSrtBatchMode(event.target.value) })}>
                              <option value="cue_count">Theo cue/request</option>
                              <option value="request_count">Theo so request</option>
                            </Select>
                          </Field>
                          {normalizeAimaxSrtBatchMode(config.aimaxSrtBatchMode) === 'request_count' ? (
                            <Field label="So request">
                              <Input
                                type="number"
                                min="1"
                                max="100"
                                value={clampAimaxSrtRequestCount(config.aimaxSrtRequestCount ?? DEFAULT_STATE.config.aimaxSrtRequestCount)}
                                onChange={(event) => patchConfig({ aimaxSrtRequestCount: clampAimaxSrtRequestCount(event.target.value) })}
                              />
                            </Field>
                          ) : (
                            <Field label="Cue/request">
                              <Input
                                type="number"
                                min="1"
                                max="200"
                                value={clampAimaxSrtCuesPerRequest(config.aimaxSrtCuesPerRequest ?? DEFAULT_STATE.config.aimaxSrtCuesPerRequest)}
                                onChange={(event) => patchConfig({ aimaxSrtCuesPerRequest: clampAimaxSrtCuesPerRequest(event.target.value) })}
                              />
                            </Field>
                          )}
                          <Field label="Batch song song">
                            <Input
                              type="number"
                              min="1"
                              max="3"
                              value={clampAimaxSrtBatchConcurrency(config.aimaxSrtBatchConcurrency ?? DEFAULT_STATE.config.aimaxSrtBatchConcurrency)}
                              onChange={(event) => patchConfig({ aimaxSrtBatchConcurrency: clampAimaxSrtBatchConcurrency(event.target.value) })}
                            />
                          </Field>
                          <div className="self-end text-[11px] leading-4 text-sky-200/80">Luon gui enable_srt=true, split_by_line=true, match_srt_time=false.</div>
                        </div>
                      ) : null}
                    </div>
                    <div className="text-xs leading-5 text-sky-100">Chọn voice clone dạng uv_*. AIMAX có thể chạy tối đa 30 request song song.</div>
                  </div>
                ) : null}

                {config.ttsProvider === 'google_cloud_tts' ? (
                  <div className="grid gap-3 rounded-[6px] border border-[#263a5d] bg-[#071020] p-3">
                    <Field label="Google Cloud API key">
                      <Input
                        type="password"
                        value={config.googleApiKey || ''}
                        placeholder="AIza..."
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          setTtsProviderTestResult(null);
                          patchState({ voices: [] });
                          patchConfig({
                            googleApiKey: event.target.value,
                            googleServiceAccountPath: '',
                            ttsVoiceName: '',
                          });
                        }}
                      />
                    </Field>
                    <div className="grid gap-1 rounded border border-emerald-400/25 bg-emerald-400/10 p-3 text-xs leading-5 text-emerald-50">
                      <div className="font-black text-emerald-200">Ước tính quota Google Cloud TTS</div>
                      <div>Dòng tính phí: {googleTtsBilling.label} - miễn phí riêng {formatInteger(googleTtsBilling.freeChars)} ký tự/tháng</div>
                      <div>Job này: {formatInteger(googleTtsEstimatedChars)} ký tự</div>
                      <div>Đã ghi nhận riêng dòng {googleTtsBilling.label} tháng này: {formatInteger(googleTtsUsedChars)} ký tự</div>
                      <div>Tổng Google Cloud TTS mọi dòng trong app tháng này: {formatInteger(googleTtsAllUsedChars)} ký tự</div>
                      <div>Còn lại sau khi chạy: {formatInteger(googleTtsRemainingAfterEstimate)} ký tự</div>
                      <div>Phát sinh sau hạn mức miễn phí của dòng này: {formatInteger(googleTtsNewBillableChars)} ký tự ({formatUsd(googleTtsEstimatedCostUsd)})</div>
                      <div>Giới hạn request: {googleTtsBilling.rpm}/phút, mỗi request tối đa 5.000 byte text</div>
                    </div>
                    <Field label="Dòng / model giọng">
                      <Select
                        value={config.voiceFamilyFilter}
                        onChange={(event) => {
                          const voiceFamilyFilter = event.target.value;
                          const nextConfig = { ...voiceSelectionConfig, voiceFamilyFilter, ttsVoiceName: '' };
                          setTtsProviderTestResult(null);
                          patchConfig({
                            voiceFamilyFilter,
                            ttsVoiceName: selectVoiceNameForConfig(effectiveVoices, nextConfig),
                          });
                        }}
                      >
                        <option value="all">Tất cả</option>
                        {voiceFamilyOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                      </Select>
                    </Field>
                    <Field label={`Giọng ${config.voiceFamilyFilter && config.voiceFamilyFilter !== 'all' ? config.voiceFamilyFilter : 'Google'} (${visibleVoices.length})`}>
                      <Select className="border-[#f1cc00]" value={selectedTtsVoiceName} onChange={(event) => {
                        setTtsProviderTestResult(null);
                        patchConfig({ ttsVoiceName: event.target.value });
                      }}>
                        {!visibleVoices.length ? <option value="">Nhập API key rồi bấm Tải giọng</option> : null}
                        {visibleVoices.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}
                      </Select>
                    </Field>
                    <div className="hidden">
                      <Field label="Sample rate">
                        <Select
                          value={config.voiceSampleRateFilter}
                          onChange={(event) => {
                            const voiceSampleRateFilter = event.target.value;
                            const nextConfig = { ...voiceSelectionConfig, voiceSampleRateFilter, ttsVoiceName: '' };
                            patchConfig({
                              voiceSampleRateFilter,
                              ttsVoiceName: selectVoiceNameForConfig(effectiveVoices, nextConfig),
                            });
                          }}
                        >
                          <option value="all">Tất cả</option>
                          {voiceSampleRateOptions.map((item) => <option key={item} value={item}>{item} Hz</option>)}
                        </Select>
                      </Field>
                      <Field label="Điều khiển giọng">
                        <Select
                          value={config.voiceControlsFilter}
                          onChange={(event) => {
                            const voiceControlsFilter = event.target.value;
                            patchConfig({
                              voiceControlsFilter,
                              ttsVoiceName: selectedTtsVoiceName,
                            });
                          }}
                        >
                          <option value="all">Tất cả</option>
                          <option value="rate_pitch">Có tốc độ / pitch</option>
                          <option value="fixed">Giọng cố định</option>
                        </Select>
                      </Field>
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-2 rounded-[6px] border border-[#263a5d] bg-[#071020] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-black text-[#f1cc00]">Test provider TTS đang chọn</div>
                      <div className="mt-1 text-[11px] text-slate-400">{activeTtsProviderLabel} · 2 đoạn đầu, tùy chọn, không ghi đè/duyệt.</div>
                    </div>
                    <Button
                      tone="blue"
                      className="h-9 px-3"
                      onClick={testTtsProviders}
                      disabled={state.busy || currentTask?.active || !rows.length}
                    >
                      {ttsProviderTestResult?.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      Test 2 đoạn
                    </Button>
                  </div>
                  {ttsProviderTestResult?.error ? (
                    <div className="rounded border border-red-500/35 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-100">
                      {ttsProviderTestResult.error}
                    </div>
                  ) : null}
                  {Array.isArray(ttsProviderTestResult?.providers) && ttsProviderTestResult.providers.length ? (
                    <div className="grid gap-2">
                      {ttsProviderTestResult.providers.map((provider) => {
                        const firstError = (provider.segments || []).find((segment) => !segment.ok);
                        const sample = provider.sampleAudio;
                        const skippedCount = Number(provider.skippedCount) || 0;
                        return (
                          <div key={provider.provider} className="grid gap-1.5 rounded border border-[#20385f] bg-[#0b1426] p-2">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-black text-white">{provider.label || provider.provider}</span>
                              <span className={provider.ok ? 'font-bold text-emerald-300' : 'font-bold text-red-300'}>
                                {provider.ok
                                  ? `OK ${provider.passedCount || 0}/${provider.segmentCount || 0}`
                                  : `Lỗi ${provider.failedCount || 0}${skippedCount ? `, bỏ qua ${skippedCount}` : ''}`}
                              </span>
                            </div>
                            {sample?.audioContent ? (
                              <audio controls src={`data:${sample.mimeType || 'audio/mpeg'};base64,${sample.audioContent}`} className="h-8 w-full" />
                            ) : null}
                            {firstError ? (
                              <div className="line-clamp-2 text-[11px] leading-4 text-red-100">
                                {firstError.detail || firstError.message || 'Provider test failed.'}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">
                      {ttsProviderTestResult?.running ? 'Đang test provider...' : 'Chưa có kết quả test.'}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t border-[#20385f] pt-3">
                  <Button tone="blue" className="h-9 px-4" onClick={saveGlobalSettings}>Lưu cấu hình</Button>
                  <SettingsSaveStatus />
                </div>
              </aside>
            </div>
          </Modal>
        ) : null}

        {false && activeModal === 'ttsRepairEditor' ? (
          <Modal
            title={`Sửa lỗi TTS${ttsRepairRows.length ? ` (${ttsRepairRows.length})` : ''}`}
            className="max-w-[1040px]"
            onClose={() => setActiveModal(null)}
            footer={(
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button tone="yellow" onClick={() => repairSelectedTtsErrors()} disabled={!ttsRepairRows.some((item) => item.selected !== false)}>Dịch tất cả</Button>
                <Button tone="yellow" onClick={() => selectedTtsRepairItem && repairSelectedTtsErrors([selectedTtsRepairItem.rowId])} disabled={!selectedTtsRepairItem}>Dịch dòng này</Button>
                <Button tone="green" onClick={() => applyTtsRepairRows(ttsRepairRows.map((item) => item.rowId))} disabled={!ttsRepairRows.some((item) => canApplyTtsRepairPreview(item))}>Áp dụng all</Button>
                <Button tone="green" onClick={() => selectedTtsRepairItem && applyTtsRepairRows([selectedTtsRepairItem.rowId])} disabled={!selectedTtsRepairItem || !canApplyTtsRepairPreview(selectedTtsRepairItem)}>Áp dụng dòng</Button>
                <Button tone="blue" onClick={() => selectedTtsRepairRow && rerunTtsForRow(selectedTtsRepairRow)} disabled={!selectedTtsRepairRow || selectedTtsRepairItem?.status !== 'applied'}>TTS dòng này</Button>
                <Button tone="blue" onClick={rerunAppliedTtsRepairs} disabled={!ttsRepairRows.some((item) => item.status === 'applied')}>TTS tất cả</Button>
              </div>
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[#263a5d] bg-[#0b1426] p-3 text-xs text-slate-200">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-300">Dòng lỗi</span>
                <select
                  value={selectedTtsRepairItem?.rowId || ''}
                  onChange={(event) => selectTtsRepairItem(event.target.value)}
                  disabled={!ttsRepairRows.length}
                  className="h-8 min-w-[220px] rounded border border-[#263a5d] bg-[#071020] px-2 text-white outline-none focus:border-[#f1cc00]"
                >
                  {ttsRepairRows.length ? ttsRepairRows.map((item) => {
                    const row = rows.find((candidate) => String(candidate.id) === String(item.rowId));
                    return (
                      <option key={item.rowId} value={item.rowId}>
                        #{row?.index || item.rowId} - {item.error_reason || 'Lỗi TTS'}
                      </option>
                    );
                  }) : <option value="">Chưa có lỗi TTS</option>}
                </select>
                {selectedTtsRepairItem ? (
                  <span className="truncate text-red-200">
                    {selectedTtsRepairIndex + 1}/{ttsRepairRows.length} · {selectedTtsRepairItem.error_reason || selectedTtsRepairItem.reason || 'Lỗi TTS'}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button className="h-8 px-3 text-xs" tone="dark" onClick={() => moveTtsRepairSelection(-1)} disabled={selectedTtsRepairIndex <= 0}>Trước</Button>
                <Button className="h-8 px-3 text-xs" tone="dark" onClick={() => moveTtsRepairSelection(1)} disabled={selectedTtsRepairIndex < 0 || selectedTtsRepairIndex >= ttsRepairRows.length - 1}>Sau</Button>
                {selectedTtsRepairItem ? (
                  <label className="flex items-center gap-1 text-slate-300">
                    <input
                      type="checkbox"
                      checked={selectedTtsRepairItem.selected !== false}
                      onChange={(event) => toggleTtsRepairRow(selectedTtsRepairItem.rowId, event.target.checked)}
                      className="h-3.5 w-3.5 accent-[#f1cc00]"
                    />
                    giữ lỗi
                  </label>
                ) : null}
              </div>
            </div>

            {selectedTtsRepairItem ? (
              <div className="grid gap-3 lg:grid-cols-[1.08fr_0.92fr]">
                <div className="grid gap-2 rounded border border-red-500/35 bg-red-950/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-red-200">Bản lỗi</span>
                    <span className="font-mono text-[11px] text-slate-300">
                      {selectedTtsRepairRow ? `${formatSrtTime(selectedTtsRepairRow.start).replace(',', '.')} -> ${formatSrtTime(selectedTtsRepairRow.end).replace(',', '.')}` : selectedTtsRepairItem.rowId}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 text-[10px] text-slate-300">
                    {Number.isFinite(selectedTtsRepairItem.slotSeconds) ? <span className="rounded bg-black/25 px-1.5 py-0.5">Slot {formatSecondsShort(selectedTtsRepairItem.slotSeconds)}</span> : null}
                    {Number.isFinite(selectedTtsRepairItem.audioSeconds) ? <span className="rounded bg-black/25 px-1.5 py-0.5">Audio {formatSecondsShort(selectedTtsRepairItem.audioSeconds)}</span> : null}
                    {Number.isFinite(selectedTtsRepairItem.overflowSeconds) && selectedTtsRepairItem.overflowSeconds > 0 ? <span className="rounded bg-red-500 px-1.5 py-0.5 text-white">Tràn {formatSecondsShort(selectedTtsRepairItem.overflowSeconds)}</span> : null}
                    {Number.isFinite(selectedTtsRepairItem.fitRatio) && selectedTtsRepairItem.fitRatio > 0 ? <span className="rounded bg-black/25 px-1.5 py-0.5">Fit {selectedTtsRepairItem.fitRatio.toFixed(2)}x</span> : null}
                    {isStaleTtsRepairItem(selectedTtsRepairItem) ? <span className="rounded bg-amber-400 px-1.5 py-0.5 text-black">Bản cũ - dịch lại</span> : null}
                    {selectedTtsRepairItem.ttsPreviewStatus === 'overflow' ? <span className="rounded bg-red-500 px-1.5 py-0.5 text-white">TTS tràn {formatSecondsShort(selectedTtsRepairItem.ttsPreviewOverflowSeconds)}</span> : null}
                    {selectedTtsRepairItem.ttsPreviewStatus === 'slack' ? <span className="rounded bg-emerald-500 px-1.5 py-0.5 text-black">TTS dư {formatSecondsShort(selectedTtsRepairItem.ttsPreviewSlackSeconds)}</span> : null}
                    {selectedTtsRepairItem.ttsPreviewStatus === 'fit' ? <span className="rounded bg-sky-500 px-1.5 py-0.5 text-black">TTS khớp</span> : null}
                  </div>
                  <textarea
                    readOnly
                    value={selectedTtsRepairItem.currentTranslation || rowText(selectedTtsRepairRow, finalField) || ''}
                    className="min-h-[150px] resize-y rounded border border-red-500/30 bg-[#071020] px-3 py-2 text-sm leading-6 text-white outline-none"
                  />
                  <details className="rounded border border-white/10 bg-black/15 px-3 py-2 text-xs text-slate-300">
                    <summary className="cursor-pointer select-none font-semibold">STT gốc / ngữ cảnh</summary>
                    <div className="mt-2 grid gap-2">
                      <div className="whitespace-pre-wrap">{selectedTtsRepairItem.source_text || '(không có STT gốc)'}</div>
                      {selectedTtsRepairItem.previous_translation ? <div><span className="text-slate-500">Trước: </span>{selectedTtsRepairItem.previous_translation}</div> : null}
                      {selectedTtsRepairItem.next_translation ? <div><span className="text-slate-500">Sau: </span>{selectedTtsRepairItem.next_translation}</div> : null}
                    </div>
                  </details>
                </div>

                <div className="grid gap-2 rounded border border-emerald-500/35 bg-emerald-950/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-emerald-200">Bản sửa</span>
                    <span className="text-[11px] text-slate-300">{String(selectedTtsRepairItem.repairedTranslation || '').length} ký tự</span>
                  </div>
                  <textarea
                    value={selectedTtsRepairItem.repairedTranslation || ''}
                    placeholder="Bấm Dịch dòng này hoặc Dịch đã chọn để tạo bản sửa, rồi chỉnh tay nếu cần."
                    onChange={(event) => updateTtsRepairDraft(selectedTtsRepairItem.rowId, event.target.value)}
                    className="min-h-[150px] resize-y rounded border border-[#28436d] bg-[#071020] px-3 py-2 text-sm leading-6 text-white outline-none focus:border-[#f1cc00]"
                  />
                  <div className="rounded border border-sky-500/35 bg-sky-950/25 px-2 py-1.5 text-[11px] text-sky-100">
                    TTS thử chỉ tạo audio tạm để kiểm tra. Timeline và audio TTS cũ vẫn giữ nguyên; chỉ nút Áp dụng mới thay audio cũ bằng bản này.
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button className="h-8 px-3 text-xs" tone="yellow" onClick={() => repairSelectedTtsErrors([selectedTtsRepairItem.rowId])}>Dịch dòng này</Button>
                    <Button className="h-8 px-3 text-xs" tone="blue" onClick={() => previewSelectedTtsRepairSrt([selectedTtsRepairItem.rowId])} disabled={!selectedTtsRepairItem.repairedTranslation?.trim()}>
                      <Play className="h-3.5 w-3.5" />
                      TTS thử
                    </Button>
                    <Button
                      className="h-8 px-3 text-xs"
                      tone="dark"
                      title={hasTtsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId) ? 'Nghe lại audio TTS của cue này' : 'Bấm TTS dòng này trước để có audio nghe lại'}
                      onClick={() => replayTtsRepairPreviewAudio(selectedTtsRepairItem.rowId)}
                      disabled={!hasTtsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId)}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                      Nghe lại
                    </Button>
                    <Button className="h-8 px-3 text-xs" tone="green" onClick={() => applyTtsRepairRows([selectedTtsRepairItem.rowId])} disabled={!canApplyTtsRepairPreview(selectedTtsRepairItem)}>Áp dụng dòng</Button>
                    <Button className="h-8 px-3 text-xs" tone="dark" onClick={() => removeTtsRepairRow(selectedTtsRepairItem.rowId)}>Xóa khỏi lỗi</Button>
                  </div>
                  <div className="grid gap-2 rounded border border-[#28436d] bg-[#071020] p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-300">
                      <span>Kết quả TTS</span>
                      <span className={selectedTtsRepairItem.status === 'passed' ? 'text-emerald-300' : selectedTtsRepairItem.status === 'failed' ? 'text-red-300' : 'text-slate-400'}>
                        {selectedTtsRepairItem.status === 'passed' ? 'Đã khớp timeline' : selectedTtsRepairItem.status === 'failed' ? 'Còn cần sửa' : 'Chưa xác nhận'}
                      </span>
                    </div>
                    {hasTtsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId) ? (
                      <audio ref={ttsRepairPreviewAudioRef} controls autoPlay src={ttsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId)} className="h-10 w-full" />
                    ) : (
                      <div className="text-[11px] text-slate-500">Bấm TTS để kiểm tra bản sửa bằng SRT AIMAX.</div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Modal>
        ) : null}

        {activeModal === 'bulkEditV2' ? (
          <Modal
            title={bulkEditMode === 'ttsRepair' ? `Chỉnh sửa${ttsRepairRows.length ? ` (${ttsRepairRows.length})` : ''}` : 'Chỉnh sửa phụ đề'}
            className="!max-h-[92vh] !max-w-[1600px]"
            onClose={() => setActiveModal(null)}
            footer={(
              <div className="flex flex-wrap items-center justify-end gap-2">
                {bulkEditMode === 'ttsRepair' ? (
                  <>
                    <Button tone="yellow" onClick={() => repairSelectedTtsErrors()} disabled={!ttsRepairRows.some((item) => item.selected !== false)}>Dịch đã chọn</Button>
                    <Button tone="yellow" onClick={() => selectedTtsRepairItem && repairSelectedTtsErrors([selectedTtsRepairItem.rowId])} disabled={!selectedTtsRepairItem}>Dịch dòng này</Button>
                    <Button tone="blue" onClick={() => previewSelectedTtsRepairSrt()} disabled={!ttsRepairRowsWithDraft.some((item) => item.selected !== false)}>TTS thử đã chọn</Button>
                    <Button tone="blue" onClick={() => selectedTtsRepairItem && previewSelectedTtsRepairSrt([selectedTtsRepairItem.rowId])} disabled={!selectedTtsRepairItem?.repairedTranslation?.trim()}>TTS thử dòng</Button>
                    <Button
                      tone="dark"
                      title={selectedTtsRepairItem && hasTtsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId) ? 'Nghe lại audio TTS của cue đang chọn' : 'Bấm TTS dòng trước để có audio nghe lại'}
                      onClick={() => selectedTtsRepairItem && replayTtsRepairPreviewAudio(selectedTtsRepairItem.rowId)}
                      disabled={!selectedTtsRepairItem || !hasTtsRepairPreviewAudioForRow(selectedTtsRepairItem.rowId)}
                    >
                      <Volume2 className="h-4 w-4" />
                      Nghe lại
                    </Button>
                    <Button
                      tone="green"
                      title="Chỉ đổi audio TTS khi bản TTS thử đã khớp timeline"
                      onClick={applyCheckedTtsRepairRows}
                      disabled={!ttsRepairApplyRows.length}
                    >
                      Áp dụng audio đã tick
                    </Button>
                    <Button
                      tone="dark"
                      title="Đưa bản dịch sửa vào timeline ngay cả khi chưa TTS thử. Audio hiện tại sẽ được gỡ để bạn lồng tiếng lại."
                      onClick={applyCheckedTtsRepairTextRows}
                      disabled={!ttsRepairTextApplyRows.length}
                    >
                      Áp dụng chữ đã tick
                    </Button>
                  </>
                ) : (
                  <>
                    <Button tone="yellow" onClick={applyBulkEdit}>Lưu tất cả</Button>
                  </>
                )}
              </div>
            )}
          >
            <div className="flex items-center gap-2 rounded border border-[#263a5d] bg-[#0b1426] p-1 text-xs">
              <button
                type="button"
                onClick={() => openBulkEditor('all')}
                className={`rounded px-3 py-1 font-bold ${bulkEditMode === 'all' ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
              >
                Tất cả
              </button>
              <button
                type="button"
                onClick={() => openBulkEditor('ttsRepair')}
                className={`rounded px-3 py-1 font-bold ${bulkEditMode === 'ttsRepair' ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
              >
                <span className="inline-flex items-center gap-1">
                  <Pencil className="h-3 w-3" />
                  Chỉnh sửa {ttsRepairRows.length ? `(${ttsRepairRows.length})` : ''}
                </span>
              </button>
            </div>

            {bulkEditMode === 'ttsRepair' ? (
              <div className="grid gap-3 rounded border border-[#31537f] bg-[#071020] p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="grid gap-1">
                    <div className="text-sm font-black uppercase text-[#f1cc00]">Dịch lại lỗi TTS</div>
                    <div className="flex flex-wrap gap-2 font-semibold text-slate-300">
                      <span className="rounded border border-[#31537f] bg-[#0b1426] px-2 py-1">Skill: $subtitle-tts-overflow-repair</span>
                      <button
                        type="button"
                        onClick={() => setTtsRepairSeverityFilter('major')}
                        className={`rounded border border-[#31537f] px-2 py-1 text-left ${ttsRepairSeverityFilter === 'major' ? 'bg-[#f1cc00] text-black' : 'bg-[#0b1426] hover:bg-[#142540]'}`}
                      >
                        &gt;=1s: {ttsRepairMajorRows}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTtsRepairSeverityFilter('minor')}
                        className={`rounded border border-[#31537f] px-2 py-1 text-left ${ttsRepairSeverityFilter === 'minor' ? 'bg-[#f1cc00] text-black' : 'bg-[#0b1426] hover:bg-[#142540]'}`}
                      >
                        &lt;1s: {ttsRepairMinorRows}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex rounded-[5px] border border-[#28436d] bg-[#071020] p-0.5 text-[11px]">
                      {[
                        ['all', `Tất cả ${ttsRepairRows.length}`],
                        ['major', `>=1s ${ttsRepairMajorRows}`],
                        ['minor', `<1s ${ttsRepairMinorRows}`],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={`rounded px-2 py-1 font-bold ${ttsRepairSeverityFilter === value ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
                          onClick={() => setTtsRepairSeverityFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => openSkill('subtitle-tts-overflow-repair')}
                      className="h-9 rounded-[6px] border border-[#f1cc00]/50 bg-[#071020] px-3 text-xs font-bold text-[#f1cc00] hover:bg-[#111827]"
                    >
                      Xem skill sửa lỗi
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                  <Field label="Provider dịch">
                    <Select
                      value={config.translationProvider}
                      onChange={(event) => {
                        setEditingCliTranslationModel(false);
                        patchConfig({ translationProvider: event.target.value, cliTranslationModel: '' });
                      }}
                    >
                      {TRANSLATION_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </Select>
                  </Field>

                  <Field label="Model dịch">
                    <div className="grid gap-2">
                      <Select
                        value={(editingCliTranslationModel || getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel))
                          ? '__custom'
                          : getCliTranslationModelSelectValue(config.translationProvider, config.cliTranslationModel)}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === '__custom') {
                            setEditingCliTranslationModel(true);
                            return;
                          }
                          setEditingCliTranslationModel(false);
                          patchConfig({ cliTranslationModel: value });
                        }}
                      >
                        <option value="">Mặc định</option>
                        {getCliTranslationModelOptions(config.translationProvider).map((item) => (
                          <option key={item} value={item}>{item}</option>
                        ))}
                        <option value="__custom">Tùy chỉnh...</option>
                      </Select>
                      {(editingCliTranslationModel || getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel)) ? (
                        <Input
                          value={getCliTranslationCustomModel(config.translationProvider, config.cliTranslationModel)}
                          placeholder="Nhập model tùy chỉnh"
                          onChange={(event) => patchConfig({ cliTranslationModel: event.target.value })}
                        />
                      ) : null}
                    </div>
                  </Field>

                  <Field label="Batch dịch song song">
                    <Input
                      type="number"
                      min="1"
                      max="5"
                      value={String(Number(config.cliTranslationConcurrency ?? DEFAULT_STATE.config.cliTranslationConcurrency) || DEFAULT_STATE.config.cliTranslationConcurrency)}
                      onChange={(event) => patchConfig({
                        cliTranslationConcurrency: Number(event.target.value) || DEFAULT_STATE.config.cliTranslationConcurrency,
                      })}
                    />
                  </Field>

                  <Field label="Provider TTS">
                    <Select
                      value={config.ttsProvider}
                      onChange={(event) => {
                        const nextProvider = event.target.value;
                        patchState({ voices: [] });
                        patchConfig({
                          ttsProvider: nextProvider,
                          ttsVoiceName: '',
                          voiceGenderFilter: 'all',
                          ssmlGender: 'NEUTRAL',
                          voiceFamilyFilter: 'all',
                          voiceSampleRateFilter: 'all',
                          voiceControlsFilter: 'all',
                          ttsConcurrency: defaultTtsConcurrencyForProvider(nextProvider),
                          ttsMaxAttempts: defaultTtsAttemptsForProvider(nextProvider),
                          ...(nextProvider === 'aimax_tts' ? {
                            aimaxProvider: config.aimaxProvider || DEFAULT_AIMAX_PROVIDER,
                            aimaxModel: config.aimaxModel || defaultAimaxModelForProvider(config.aimaxProvider),
                          } : {}),
                        });
                      }}
                    >
                      <option value="edge_tts">Edge TTS</option>
                      <option value="aimax_tts">AIMAX Clone</option>
                      <option value="google_cloud_tts">Google Cloud TTS</option>
                    </Select>
                  </Field>

                  <Field label="Ngôn ngữ TTS">
                    <Select
                      value={config.ttsLanguageCode}
                      onChange={(event) => {
                        patchState({ voices: [] });
                        patchConfig({ ttsLanguageCode: event.target.value, ttsVoiceName: '', voiceGenderFilter: 'all', ssmlGender: 'NEUTRAL', voiceFamilyFilter: 'all', voiceSampleRateFilter: 'all', voiceControlsFilter: 'all' });
                      }}
                    >
                      {TTS_LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}
                    </Select>
                  </Field>

                  <Field label="TTS song song">
                    <Input
                      type="number"
                      min="1"
                      max={maxTtsConcurrencyForProvider(config.ttsProvider)}
                      value={clampTtsConcurrency(config.ttsProvider, config.ttsConcurrency)}
                      onChange={(event) => patchConfig({ ttsConcurrency: clampTtsConcurrency(config.ttsProvider, event.target.value) })}
                    />
                  </Field>
                </div>

                <div className={`grid gap-3 md:items-end ${config.ttsProvider === 'google_cloud_tts' ? 'md:grid-cols-[minmax(180px,0.9fr)_minmax(260px,1fr)_auto]' : 'md:grid-cols-[minmax(260px,1fr)_auto]'}`}>
                  {config.ttsProvider === 'google_cloud_tts' ? (
                    <Field label="Dòng / model giọng">
                      <Select
                        value={config.voiceFamilyFilter}
                        onChange={(event) => {
                          const voiceFamilyFilter = event.target.value;
                          const nextConfig = { ...voiceSelectionConfig, voiceFamilyFilter, ttsVoiceName: '' };
                          patchConfig({
                            voiceFamilyFilter,
                            ttsVoiceName: selectVoiceNameForConfig(effectiveVoices, nextConfig),
                          });
                        }}
                      >
                        <option value="all">Tất cả</option>
                        {voiceFamilyOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                      </Select>
                    </Field>
                  ) : null}
                  <Field label={`Giọng/model TTS (${visibleVoices.length})`}>
                    <Select className="border-[#f1cc00]" value={selectedTtsVoiceName} onChange={(event) => patchConfig({ ttsVoiceName: event.target.value })}>
                      {!visibleVoices.length ? <option value="">Tự chọn giọng</option> : null}
                      {visibleVoices.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}
                    </Select>
                  </Field>
                  <Button tone="dark" className="h-9 px-3" onClick={loadVoices}>
                    <Volume2 className="h-4 w-4" />
                    Tải giọng
                  </Button>
                </div>
              </div>
            ) : null}

            {bulkEditMode === 'ttsRepair' ? (
              <>
                <div className="max-h-[62vh] overflow-auto rounded-xl border border-slate-800 bg-slate-900/80 text-xs backdrop-blur-md">
                  <div
                    className="sticky top-0 z-10 grid w-max min-w-full border-b border-slate-800 bg-slate-900 text-center font-bold text-indigo-300"
                    style={{ gridTemplateColumns: ttsRepairTableGridTemplate }}
                  >
                    {[
                      ['apply', 'Áp dụng'],
                      ['index', '#'],
                      ['start', 'Start'],
                      ['end', 'End'],
                      ['text', 'Bản lỗi'],
                      ['repair', 'Bản sửa'],
                      ['error', 'Lỗi'],
                    ].map(([column, label], index) => (
                      <div key={column} className={`relative py-2.5 ${index < 6 ? 'border-r border-slate-800' : ''}`}>
                        {label}
                        <button
                          type="button"
                          aria-label={`Kéo đổi cột ${label}`}
                          onPointerDown={(event) => startTtsRepairColumnResize(event, column)}
                          className="absolute right-[-4px] top-0 h-full w-2 cursor-col-resize touch-none bg-transparent hover:bg-indigo-500/40"
                        />
                      </div>
                    ))}
                  </div>
                  {visibleTtsRepairRows.length ? visibleTtsRepairRows.map((item) => {
                    const row = rows.find((candidate) => String(candidate.id) === String(item.rowId));
                    const selected = String(item.rowId) === String(selectedTtsRepairItem?.rowId);
                    const repairStale = isStaleTtsRepairItem(item);
                    const rowTone = selected
                      ? 'bg-indigo-600/30 text-white ring-1 ring-indigo-400'
                      : item.status === 'passed'
                        ? 'bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
                        : item.status === 'failed'
                          ? 'bg-rose-950/40 text-rose-100 hover:bg-rose-900/40'
                          : 'bg-slate-900/40 text-slate-100 hover:bg-slate-800/50';
                    const statusText = repairStale
                      ? 'Cũ - dịch lại'
                      : item.status === 'passed'
                      ? 'OK'
                      : item.status === 'failed'
                        ? 'Lỗi'
                        : item.status === 'rerun'
                          ? 'Đã TTS'
                          : item.status === 'applied'
                            ? 'Đã áp dụng'
                            : item.status === 'repaired' || item.status === 'edited'
                              ? 'Có bản sửa'
                              : item.status === 'notice' || item.selected === false
                                ? 'Theo dõi'
                                : 'Chờ';
                    const previewStatus = item.ttsPreviewStatus || '';
                    const previewStatusLabel = previewStatus === 'overflow'
                      ? `Tràn ${formatSecondsShort(item.ttsPreviewOverflowSeconds)}`
                      : previewStatus === 'slack'
                        ? `Dư ${formatSecondsShort(item.ttsPreviewSlackSeconds)}`
                        : previewStatus === 'fit'
                          ? 'Khớp'
                          : '';
                    const previewStatusTone = previewStatus === 'overflow'
                      ? 'bg-rose-600 text-white'
                      : previewStatus === 'slack'
                        ? 'bg-emerald-500 text-slate-950 font-bold'
                        : previewStatus === 'fit'
                          ? 'bg-indigo-500 text-white font-bold'
                          : 'bg-slate-700 text-slate-200';
                    const textOverflowSeconds = Math.max(
                      0,
                      Number(item.overflowSeconds ?? item.overflow_seconds) || 0,
                      Number(row?.ttsSync?.endOverflowSeconds) || 0,
                      Number(row?.ttsSync?.overlapNextSeconds) || 0
                    );
                    const textTimingBadge = textOverflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS
                      ? {
                          label: 'Tràn',
                          seconds: textOverflowSeconds,
                          tone: textOverflowSeconds >= TTS_TIMING_MAJOR_OVERFLOW_SECONDS ? 'red' : 'amber',
                        }
                      : null;
                    const displayedErrorReason = textOverflowSeconds > TTS_TIMING_TRACE_OVERFLOW_SECONDS
                      ? `tràn ${formatSecondsShort(textOverflowSeconds)}`
                      : (item.error_reason || item.reason || '');
                    const originalText = item.currentTranslation || rowText(row, finalField) || '';
                    const sourceContextText = String(item.source_text || row?.sourceText || row?.originalText || '').trim();
                    const repairedText = item.repairedTranslation || '';
                    const canApplyAudio = canApplyTtsRepairPreview(item);
                    const repairPreviewAudioUrl = ttsRepairPreviewAudioForRow(item.rowId);
                    const hasRepairPreviewAudio = Boolean(repairPreviewAudioUrl);
                    return (
                      <div
                        key={item.rowId}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectTtsRepairItem(item.rowId)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            selectTtsRepairItem(item.rowId);
                          }
                        }}
                        title={`${item.error_reason || item.reason || 'TTS'} · ${statusText}`}
                        className={`grid min-h-[72px] w-max min-w-full cursor-pointer border-b border-slate-800 text-left ${rowTone}`}
                        style={{ gridTemplateColumns: ttsRepairTableGridTemplate }}
                      >
                        <div className="flex items-center justify-center border-r border-slate-800 px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={item.applySelected === true}
                            title={!repairedText
                              ? 'Hãy dịch hoặc nhập bản sửa trước'
                              : canApplyAudio
                                ? 'Có thể áp dụng audio đã TTS thử'
                                : 'Có thể tick và áp dụng chữ ngay; muốn đổi audio thì TTS thử cần khớp timeline'}
                            disabled={!repairedText}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleTtsRepairApplyRow(item.rowId, event.target.checked)}
                            className="h-4 w-4 accent-emerald-500"
                          />
                        </div>
                        <div className="border-r border-slate-800 px-2 py-2 text-center font-mono">{row?.index || item.rowId}</div>
                        <div className="border-r border-slate-800 px-2 py-2 font-mono">{row ? formatSrtTime(row.start).replace(',', '.') : '-'}</div>
                        <div className="border-r border-slate-800 px-2 py-2 font-mono">{row ? formatSrtTime(row.end).replace(',', '.') : '-'}</div>
                        <div className="min-w-0 border-r border-slate-800 px-2 py-1.5 leading-5">
                          {textTimingBadge ? (
                            <div className="mb-1 flex flex-wrap gap-1">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${textTimingBadge.tone === 'red' ? 'bg-rose-500 text-white' : 'bg-amber-500 text-slate-950'}`}
                              >
                                {textTimingBadge.label} {formatSecondsShort(textTimingBadge.seconds)}
                              </span>
                            </div>
                          ) : null}
                          <div className="max-h-[116px] overflow-auto whitespace-pre-wrap break-words text-sm font-semibold leading-5 text-slate-100">
                            {originalText}
                          </div>
                          {sourceContextText ? (
                            <div className="mt-1 max-h-[72px] overflow-auto whitespace-pre-wrap break-words border-t border-slate-800 pt-1 text-[11px] leading-4 text-slate-400">
                              <span className="font-bold text-slate-300">STT gốc: </span>{sourceContextText}
                            </div>
                          ) : null}
                        </div>
                        <div className="min-w-0 border-r border-slate-800 px-2 py-1.5">
                          <textarea
                            value={repairedText}
                            placeholder="Bấm Dịch dòng này hoặc nhập bản sửa..."
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => updateTtsRepairDraft(item.rowId, event.target.value)}
                            className="min-h-[58px] max-h-[150px] w-full resize-y rounded-lg border border-slate-800 bg-slate-950/80 px-2.5 py-2 text-sm leading-5 text-slate-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <div className="min-w-0 px-2 py-1.5 text-[10px] font-bold leading-4">
                          <div className="flex flex-wrap items-start gap-1">
                            <span className={`rounded-md px-1.5 py-0.5 ${item.severity === 'major' ? 'bg-rose-600 text-white' : item.severity === 'minor' ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>
                              {item.severity === 'major' ? '>=1s' : item.severity === 'minor' ? '<1s' : statusText}
                            </span>
                            <span className={item.status === 'passed' ? 'text-emerald-300' : item.status === 'failed' ? 'text-rose-300' : 'text-slate-400'}>
                              {statusText}
                            </span>
                            {previewStatusLabel ? (
                              <span className={`rounded-md px-1.5 py-0.5 ${previewStatusTone}`}>
                                {previewStatusLabel}
                              </span>
                            ) : null}
                            {repairStale ? (
                              <span className="rounded-md bg-amber-500 px-1.5 py-0.5 text-slate-950">
                                Bản cũ
                              </span>
                            ) : null}
                          </div>
                          {displayedErrorReason ? (
                            <div className="mt-1 whitespace-normal break-words text-rose-300">{displayedErrorReason}</div>
                          ) : null}
                          {previewStatusLabel ? (
                            <div className="mt-1 whitespace-normal break-words text-slate-400 font-mono">
                              Slot {formatSecondsShort(item.ttsPreviewSlotSeconds)} · Audio {formatSecondsShort(item.ttsPreviewAudioSeconds)}
                            </div>
                          ) : null}
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Button className="h-6 px-2 text-[10px]" tone="yellow" onClick={(event) => { event.stopPropagation(); repairSelectedTtsErrors([item.rowId]); }}>Dịch</Button>
                            <Button className="h-6 px-2 text-[10px]" tone="blue" onClick={(event) => { event.stopPropagation(); previewSelectedTtsRepairSrt([item.rowId]); }} disabled={!item.repairedTranslation?.trim() || repairStale}>
                              <Play className="h-3 w-3" />TTS
                            </Button>
                            <Button
                              className="h-6 px-2 text-[10px]"
                              tone="dark"
                              title={hasRepairPreviewAudio ? 'Nghe lại audio TTS của cue này' : 'Bấm TTS cue này trước để có audio nghe lại'}
                              onClick={(event) => { event.stopPropagation(); replayTtsRepairPreviewAudio(item.rowId); }}
                              disabled={!hasRepairPreviewAudio}
                            >
                              <Volume2 className="h-3 w-3" />Nghe lại
                            </Button>
                            <Button className="h-6 px-2 text-[10px]" tone="green" onClick={(event) => { event.stopPropagation(); applyTtsRepairRows([item.rowId]); }} disabled={!canApplyTtsRepairPreview(item)}>Áp</Button>
                            <Button className="h-6 px-2 text-[10px]" tone="dark" onClick={(event) => { event.stopPropagation(); removeTtsRepairRow(item.rowId); }}>Bỏ</Button>
                          </div>
                          {selected && hasRepairPreviewAudio ? (
                            <audio ref={ttsRepairPreviewAudioRef} controls autoPlay src={repairPreviewAudioUrl} className="mt-1 h-8 w-full min-w-0" onClick={(event) => event.stopPropagation()} />
                          ) : null}
                        </div>
                      </div>
                    );
                  }) : (
                    <div className="flex h-32 items-center justify-center text-slate-400">Chưa có dòng cần chỉnh sửa trong bộ lọc này.</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="grid max-h-[58vh] overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 text-xs backdrop-blur-md">
                  <div className="grid grid-cols-[44px_118px_118px_1fr] border-b border-slate-800 bg-slate-900 text-center font-bold text-indigo-300">
                    <div className="border-r border-slate-800 py-2">#</div>
                    <div className="border-r border-slate-800 py-2">Start</div>
                    <div className="border-r border-slate-800 py-2">End</div>
                    <div className="py-2">Text</div>
                  </div>
                  <div className="max-h-[48vh] overflow-auto">
                    {rows.map((row) => {
                      const lines = bulkEditRows();
                      const text = lines[row.index - 1] ?? rowText(row, finalField);
                      const selected = row.id === bulkEditSelectedId;
                      return (
                        <div
                          key={row.id}
                          onClick={() => selectBulkEditRow(row)}
                          className={`grid min-h-[48px] w-full grid-cols-[44px_118px_118px_1fr] border-b border-slate-800 text-left transition-colors ${selected ? 'bg-indigo-600/30 text-white ring-1 ring-indigo-500' : 'bg-slate-900/40 text-slate-100 hover:bg-slate-800/50'}`}
                        >
                          <div className="border-r border-slate-800 px-2 py-2 text-center font-mono text-slate-400">{row.index}</div>
                          <div className="border-r border-slate-800 px-2 py-2 font-mono text-slate-300">{formatSrtTime(row.start).replace(',', '.')}</div>
                          <div className="border-r border-slate-800 px-2 py-2 font-mono text-slate-300">{formatSrtTime(row.end).replace(',', '.')}</div>
                          <div className="px-2 py-1.5">
                            <textarea
                              value={text}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => updateBulkEditLine(row, event.target.value)}
                              className={`min-h-[36px] max-h-[110px] w-full resize-y rounded-lg border px-2.5 py-1.5 text-sm leading-5 outline-none transition-all ${selected ? 'border-indigo-500 bg-slate-950 text-white placeholder-slate-500 focus:ring-2 focus:ring-indigo-500/20' : 'border-slate-800 bg-slate-950/80 text-slate-100 focus:border-indigo-500'}`}
                              placeholder="Nhập text phụ đề..."
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </Modal>
        ) : null}

        {activeModal === 'bulkEdit' ? (
          <Modal
            title="Chỉnh sửa phụ đề"
            className="!max-h-[90vh] !max-w-[1120px]"
            onClose={() => setActiveModal(null)}
            footer={(
              <div className="flex items-center gap-2">
                <Button tone="yellow" onClick={applyBulkEdit}>Lưu tất cả</Button>
              </div>
            )}
          >
            <div className="grid max-h-[58vh] overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 text-xs backdrop-blur-md">
              <div className="grid grid-cols-[44px_118px_118px_1fr] border-b border-slate-800 bg-slate-900 text-center font-bold text-indigo-300">
                <div className="border-r border-slate-800 py-2">#</div>
                <div className="border-r border-slate-800 py-2">Start</div>
                <div className="border-r border-slate-800 py-2">End</div>
                <div className="py-2">Text</div>
              </div>
              <div className="max-h-[48vh] overflow-auto">
                {rows.map((row) => {
                  const lines = bulkEditRows();
                  const text = lines[row.index - 1] ?? rowText(row, finalField);
                  const selected = row.id === bulkEditSelectedId;
                  return (
                    <div
                      key={row.id}
                      onClick={() => selectBulkEditRow(row)}
                      className={`grid min-h-[48px] w-full grid-cols-[44px_118px_118px_1fr] border-b border-[#162949] text-left ${selected ? 'bg-[#f1cc00] text-black' : 'bg-[#0c1629] text-white hover:bg-[#10213b]'}`}
                    >
                      <div className="border-r border-[#263a5d] px-2 py-2 text-center font-mono">{row.index}</div>
                      <div className="border-r border-[#263a5d] px-2 py-2 font-mono">{formatSrtTime(row.start).replace(',', '.')}</div>
                      <div className="border-r border-[#263a5d] px-2 py-2 font-mono">{formatSrtTime(row.end).replace(',', '.')}</div>
                      <div className="px-2 py-1.5">
                        <textarea
                          value={text}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateBulkEditLine(row, event.target.value)}
                          className={`min-h-[36px] max-h-[110px] w-full resize-y rounded border px-2 py-1.5 text-sm leading-5 outline-none ${selected ? 'border-black/25 bg-black/10 text-black placeholder-black/50 focus:border-black' : 'border-[#28436d] bg-[#071020] text-white focus:border-[#f1cc00]'}`}
                          placeholder="Nhập text phụ đề..."
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Modal>
        ) : null}

        {activeModal === 'rowTiming' && timingDraft ? (
          <Modal
            title="Sub Editor"
            className="max-w-[980px]"
            onClose={() => {
              setTimingDraft(null);
              setActiveModal(null);
            }}
            footer={(
              <div className="flex items-center gap-2">
                <Button tone="blue" onClick={exportSrt} disabled={!rows.length}>Lưu SRT</Button>
              <Button tone="blue" onClick={exportSourceSrt} disabled={!rows.length}>SRT gốc</Button>
                <Button tone="yellow" onClick={() => saveTimingEditor(true)}>Lưu & đóng</Button>
              </div>
            )}
          >
            <div className="grid gap-3 rounded-[4px] border border-[#263a5d] bg-[#0b1426] p-3">
              <div className="grid gap-2 lg:grid-cols-[auto_minmax(120px,1fr)_auto_minmax(120px,1fr)_auto_70px_auto_70px_auto_auto] lg:items-center">
                <span className="text-xs font-semibold text-slate-300">Search</span>
                <Input value={timingSearch} onChange={(event) => setTimingSearch(event.target.value)} />
                <span className="text-xs font-semibold text-slate-300">Replace</span>
                <Input value={timingReplace} onChange={(event) => setTimingReplace(event.target.value)} />
                <span className="text-xs font-semibold text-slate-300">From #</span>
                <Input value={timingFrom} onChange={(event) => setTimingFrom(event.target.value)} />
                <span className="text-xs font-semibold text-slate-300">To #</span>
                <Input value={timingTo} onChange={(event) => setTimingTo(event.target.value)} />
                <Button onClick={() => replaceTimingText(false)}>Replace</Button>
                <Button tone="blue" onClick={() => replaceTimingText(true)}>Replace All</Button>
              </div>

              <div className="grid max-h-[34vh] overflow-hidden rounded-[4px] border border-[#263a5d] bg-[#071020] text-xs">
                <div className="grid grid-cols-[48px_122px_122px_minmax(260px,1fr)] border-b border-[#263a5d] bg-[#101b2e] text-center font-black text-slate-200">
                  <div className="border-r border-[#263a5d] py-2">#</div>
                  <div className="border-r border-[#263a5d] py-2">Start</div>
                  <div className="border-r border-[#263a5d] py-2">End</div>
                  <div className="py-2">Text</div>
                </div>
                <div className="max-h-[30vh] overflow-auto">
                  {rows.map((row) => {
                    const selected = row.id === timingDraft.id;
                    const text = rowText(row, finalField);
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => selectTimingEditorRow(row)}
                        className={`grid min-h-[30px] w-full grid-cols-[48px_122px_122px_minmax(260px,1fr)] border-b border-[#172a48] text-left ${selected ? 'bg-[#566173] text-white' : 'bg-[#0c1629] text-slate-200 hover:bg-[#10213b]'}`}
                      >
                        <span className="border-r border-[#263a5d] px-2 py-1.5 text-center font-mono">{row.index}</span>
                        <span className="border-r border-[#263a5d] px-2 py-1.5 font-mono">{formatSrtTime(row.start).replace(',', '.')}</span>
                        <span className="border-r border-[#263a5d] px-2 py-1.5 font-mono">{formatSrtTime(row.end).replace(',', '.')}</span>
                        <span className="truncate px-2 py-1.5">{text || <span className="text-slate-500">(trống)</span>}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-[4px] border border-[#263a5d] bg-[#0b1426] p-3">
              <div className="grid gap-3 sm:grid-cols-[120px_120px_1fr_auto] sm:items-end">
                <Field label="Start">
                  <Input value={timingDraft.start} onChange={(event) => setTimingDraft((draft) => ({ ...draft, start: event.target.value }))} />
                </Field>
                <Field label="End">
                  <Input value={timingDraft.end} onChange={(event) => setTimingDraft((draft) => ({ ...draft, end: event.target.value }))} />
                </Field>
                <Field label="Duration">
                  <Input value={Math.max(0.1, parseDecimal(timingDraft.end, 0) - parseDecimal(timingDraft.start, 0)).toFixed(3)} readOnly />
                </Field>
                <Button tone="blue" className="h-9 px-4" onClick={() => saveTimingEditor(false)}>Apply Sub</Button>
              </div>
              <Field label="Text">
                <TextArea
                  value={timingDraft.text}
                  onChange={(event) => setTimingDraft((draft) => ({ ...draft, text: event.target.value }))}
                  className="min-h-[120px] text-sm"
                />
              </Field>
            </div>
          </Modal>
        ) : null}

        {activeModal === 'export' ? (
          <Modal
            title="Xuất video / phụ đề"
            className="!max-w-[1040px]"
            onClose={() => setActiveModal(null)}
            footer={(
              <Button
                tone="green"
                onClick={runSelectedExport}
                disabled={!canRunSelectedExport}
              >
                {selectedExportLabel()} →
              </Button>
            )}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Định dạng xuất">
                <Select value={config.outputFormat} onChange={(event) => patchConfig({ outputFormat: event.target.value, outputFileName: `final_dubbed.${event.target.value}` })}>
                  <option value="mp4">MP4</option>
                  <option value="mkv">MKV</option>
                  <option value="avi">AVI</option>
                </Select>
              </Field>
              <Field label="Ti le khung hinh">
                <Select value={normalizeOutputAspectRatio(config.outputAspectRatio)} onChange={(event) => patchConfig({ outputAspectRatio: normalizeOutputAspectRatio(event.target.value) })}>
                  <option value="source">Theo video goc</option>
                  <option value="9:16">9:16 doc</option>
                  <option value="16:9">16:9 ngang</option>
                  <option value="4:3">4:3</option>
                </Select>
              </Field>
              <Field label={`Chất lượng xuất: ${config.outputQuality}%`}>
                <input type="range" min="30" max="100" value={config.outputQuality} onChange={(event) => patchConfig({ outputQuality: Number(event.target.value) })} className="accent-[#f1cc00]" />
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.includeDubbedAudio} onChange={(event) => patchConfig({ includeDubbedAudio: event.target.checked })} />Giọng đọc</label>
              <div className="grid gap-2 text-sm sm:col-span-2">
                <span className="text-xs font-black text-slate-300">Kiểu phụ đề</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSubtitleExportMode('soft')}
                    className={`inline-flex h-10 items-center justify-center gap-2 rounded border px-3 text-xs font-black ${subtitleExportMode === 'soft' ? 'border-[#f1cc00] bg-[#f1cc00] text-black' : 'border-[#28436d] bg-[#071020] text-slate-300 hover:border-sky-400/60'}`}
                  >
                    <FileText className="h-4 w-4" />
                    Sub mềm (.srt)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubtitleExportMode('burn')}
                    className={`inline-flex h-10 items-center justify-center gap-2 rounded border px-3 text-xs font-black ${subtitleExportMode === 'burn' ? 'border-[#f1cc00] bg-[#f1cc00] text-black' : 'border-[#28436d] bg-[#071020] text-slate-300 hover:border-sky-400/60'}`}
                  >
                    <Download className="h-4 w-4" />
                    Burn vào video
                  </button>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.keepOriginalAudioTrack} onChange={(event) => patchConfig({ keepOriginalAudioTrack: event.target.checked, keepBackgroundMusic: event.target.checked })} />Giữ âm gốc</label>
              <Field label="Tên file xuất">
                <Input value={config.outputFileName} onChange={(event) => patchConfig({ outputFileName: event.target.value })} />
              </Field>
            </div>
            <Field label="Nơi lưu">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                  value={config.outputDirectory}
                  onChange={(event) => patchOutputFolderConfig({ outputDirectory: event.target.value, outputCreateFolder: false, outputFolderName: '' })}
                  placeholder="Để trống để lưu trong thư mục job hiện tại"
                />
                <Button tone="blue" className="h-9 px-3" onClick={pickOutputFolder}>
                  <FolderOpen className="h-4 w-4" />
                  Chọn
                </Button>
                <Button className="h-9 px-3" onClick={clearOutputFolder} disabled={!config.outputDirectory}>
                  <X className="h-4 w-4" />
                  Job
                </Button>
              </div>
              <div className="break-all rounded border border-[#263a5d] bg-[#0b1426] p-2.5 text-xs leading-5 text-slate-300">
                {config.outputDirectory ? `Sẽ lưu vào: ${config.outputDirectory}${config.outputCreateFolder !== false && config.outputFolderName ? `\\${config.outputFolderName}` : ''}` : 'Sẽ lưu trong thư mục job hiện tại.'}
              </div>
            </Field>
            {exportAction === 'video' ? (
              <div className="grid gap-2 rounded border border-[#263a5d] bg-[#0b1426] p-3">
                <div className="text-xs font-black uppercase tracking-wide text-slate-300">Kiểm tra trước khi xuất</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {videoExportChecks.map((item) => {
                    const muted = item.blocking === false && item.present === false;
                    const statusText = item.ok ? (muted ? 'Không có' : 'Có') : 'Thiếu';
                    return (
                      <div
                        key={item.key}
                        className={`grid gap-1 rounded border p-2.5 text-xs ${item.ok ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-red-400/40 bg-red-500/10'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-black text-white">{item.label}</span>
                          <span className={`rounded px-2 py-0.5 text-[10px] font-black ${item.ok ? (muted ? 'bg-slate-600 text-slate-200' : 'bg-emerald-400 text-black') : 'bg-red-500 text-white'}`}>
                            {statusText}
                          </span>
                        </div>
                        <div className="break-all leading-5 text-slate-300">{item.detail}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 rounded border border-[#263a5d] bg-[#0b1426] p-3">
              <div className="flex flex-wrap items-center gap-2 rounded border border-[#263a5d] bg-[#071020] p-1">
                <button
                  type="button"
                  onClick={() => setExportAction('video')}
                  className={`inline-flex h-9 items-center gap-2 rounded-[5px] px-4 text-sm font-black ${exportAction === 'video' ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
                >
                  <Download className="h-4 w-4" />
                  Video
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportTab('srt');
                    setExportAction((value) => String(value).startsWith('srt_') ? value : 'srt_translation');
                  }}
                  className={`inline-flex h-9 items-center gap-2 rounded-[5px] px-4 text-sm font-black ${exportTab === 'srt' ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
                >
                  <FileText className="h-4 w-4" />
                  SRT
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportTab('text');
                    setExportAction((value) => String(value).startsWith('text_') ? value : 'text_translation');
                  }}
                  className={`inline-flex h-9 items-center gap-2 rounded-[5px] px-4 text-sm font-black ${exportTab === 'text' ? 'bg-[#f1cc00] text-black' : 'text-slate-300 hover:bg-[#142540]'}`}
                >
                  <FileText className="h-4 w-4" />
                  Text
                </button>
              </div>

              {exportTab === 'srt' ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    ['srt_source', 'SRT gốc', rows.length],
                    ['srt_translation', 'SRT dịch', rows.filter((row) => row.finalText || row.translatedText).length],
                  ].map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setExportAction(value)}
                      className={`grid gap-2 rounded border p-3 text-left ${exportAction === value ? 'border-[#f1cc00] bg-[#f1cc00]/12' : 'border-[#28436d] bg-[#071020] hover:border-sky-400/60'}`}
                    >
                      <span className="text-sm font-black text-white">{label}</span>
                      <span className="text-[11px] font-semibold text-slate-400">{count} dòng</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    ['text_source', 'Text gốc', rows.length],
                    ['text_translation', 'Text dịch', rows.filter((row) => row.finalText || row.translatedText).length],
                  ].map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setExportAction(value)}
                      className={`grid gap-2 rounded border p-3 text-left ${exportAction === value ? 'border-[#f1cc00] bg-[#f1cc00]/12' : 'border-[#28436d] bg-[#071020] hover:border-sky-400/60'}`}
                    >
                      <span className="text-sm font-black text-white">{label}</span>
                      <span className="text-[11px] font-semibold text-slate-400">{count} dòng</span>
                    </button>
                  ))}
                </div>
              )}

            </div>
          </Modal>
        ) : null}
        <AppDialog dialog={appDialog} onResult={resolveAppDialog} />
    </div>
  );
}

