const DEFAULTS = {
  sourceType: 'youtube',
  sourceLanguage: 'en-US',
  targetLanguage: 'vi',
  sttProvider: 'faster_whisper_local',
  sttModel: 'small',
  translationProvider: 'codex_cli',
  translationMode: 'story_v2',
  groqApiKey: '',
  groqApiKeys: [],
  assemblyAiApiKey: '',
  assemblyAiApiKeys: [],
  assemblyAiPrompt: '',
  assemblyAiKeyterms: '',
  assemblyAiProcessingMode: 'parallel',
  assemblyAiChunkSeconds: 180,
  assemblyAiOverlapSeconds: 6,
  assemblyAiConcurrency: 3,
  googleSttLocation: 'us',
  userContext: '',
  customGlossary: '',
  autoContext: '',
  translationCleanupMode: 'wtpsplit_local',
  ttsProvider: 'edge_tts',
  ttsUnitMode: 'story_segments',
  ttsLanguageCode: 'vi-VN',
  ttsVoiceName: '',
  voiceGenderFilter: 'all',
  aimaxApiKey: '',
  aimaxBaseUrl: 'https://aimaxstudio.com',
  aimaxProvider: 'minimax',
  aimaxModel: 'speech-2.8-hd',
  aimaxSrtBatchEnabled: false,
  aimaxSrtBatchMode: 'cue_count',
  aimaxSrtCuesPerRequest: 70,
  aimaxSrtRequestCount: 0,
  aimaxSrtBatchConcurrency: 1,
  ssmlGender: 'NEUTRAL',
  speakingRate: 1,
  minSpeakingRate: 1,
  maxSpeakingRate: 1,
  pitch: 0,
  ttsDurationControl: true,
  preserveTtsAudio: true,
  ttsFitEnabled: true,
  ttsFitMode: 'balanced',
  ttsFitMaxRate: 1,
  ttsTextCleanupMode: 'natural',
  ttsFitWordsPerSecond: 3.15,
  useYouTubeCaptions: true,
  fallbackToGoogleStt: false,
  enableWordTimestamps: true,
  sttTimestampMode: 'word_timestamps',
  nlpSourceResegment: true,
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
  ocrKeyframeTimelineFps: 30,
  ocrLanguageHints: ['zh', 'zh-Hans'],
  preserveTimestamps: true,
  keepNamesAndTerms: true,
  allowTextShortening: false,
  translationCharsPerSecond: 13,
  translationConstraintThreshold: 1.05,
  translationTargetTtsRate: 1,
  translationTimingValidationMode: 'estimate_plus_probe',
  translationTimingRewriteMaxPasses: 0,
  cliTranslationModel: '',
  cliTranslationChunkSize: 12,
  cliTranslationConcurrency: 3,
  ttsTimingRewriteBatchSize: 40,
  ttsTimingRewriteMaxLines: 80,
  ttsTimingRewriteShortRatio: 0.72,
  ttsTimingRewrite: false,
  normalizeTimelineBeforeTranslate: true,
  translationDisplayMode: 'source_timeline',
  storyContextTargetSeconds: 22,
  storyContextMaxSeconds: 30,
  storyHardBreakGapSeconds: 1.2,
  storyTargetMinSeconds: 4,
  storyTargetMaxSeconds: 8,
  storyAbsoluteMaxSegmentSeconds: 10,
  storyBoundaryMaxShiftSeconds: 0.35,
  storyVerifierEnabled: true,
  storyRepairMaxAttempts: 2,
  timelineMergeGapSeconds: 0.35,
  timelineBreakGapSeconds: 0.5,
  timelineMaxUnitDuration: 2.8,
  timelineHardMaxUnitDuration: 3.6,
  timelineMaxUnitWeight: 30,
  timelineHardMaxUnitWeight: 46,
  timelineMaxTranslatedChars: 56,
  timelineGuardSeconds: 0.15,
  naturalDubTargetMinSeconds: 2.0,
  naturalDubTargetMaxSeconds: 4.2,
  maxMeaningUnitDuration: 4.6,
  hardMaxMeaningUnitDuration: 5.2,
  maxMeaningUnitChars: 96,
  hardMaxMeaningUnitChars: 140,
  maxMeaningUnitSourceRows: 3,
  minMeaningUnitStandaloneChars: 20,
  meaningUnitHardBreakGapSeconds: 0.6,
  meaningUnitSoftBreakGapSeconds: 0.25,
  maxMeaningSegmentDuration: 6.5,
  maxMeaningSegmentWords: 32,
  maxMeaningSegmentChars: 150,
  meaningSegmentBreakGap: 0.6,
  minDubbingSegmentDuration: 0.9,
  shortSegmentMergeGap: 0.25,
  maxTtsSegmentDuration: 10.0,
  maxTtsSegmentChars: 260,
  targetTtsChunkDuration: 5.5,
  maxTtsChunksPerSegment: 3,
  borrowGapSeconds: 0.75,
  acceptOverflowSeconds: 0.8,
  retryOverflowSeconds: 1.5,
  syncMode: 'strict',
  naturalPhraseSync: false,
  phraseLengthMode: 'natural',
  pauseStyle: 'natural',
  normalizeLoudness: false,
  audioSampleRate: 32000,
  subtitleDisplayMode: 'compact',
  targetPhraseSeconds: 1.6,
  maxPhraseSeconds: 3.2,
  absoluteMaxPhraseSeconds: 4.0,
  addSilenceGaps: false,
  maxVoiceGapSeconds: 0.06,
  voiceAlignShortClips: false,
  voiceAlignMode: 'start',
  voiceAlignMinSlackSeconds: 0.05,
  voiceAlignMaxShiftSeconds: 0.6,
  ttsConcurrency: 3,
  ttsMaxAttempts: 1,
  speedUpLongSegments: true,
  keepBackgroundMusic: false,
  originalAudioVolume: 0.18,
  overlayEnabled: false,
  overlayText: '',
  overlayX: 50,
  overlayY: 50,
  overlayStart: 0,
  overlayEnd: 5,
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
  outputAspectRatio: 'source',
  outputQuality: 80,
  exportOptions: ['mp4', 'audio', 'transcript', 'srt', 'vtt'],
  credentialsMode: 'backend_env',
};

const PROVIDER_ALIASES = {
  stt: {
    'google-cloud-speech': 'faster_whisper_local',
    'google_cloud_speech': 'faster_whisper_local',
    'google-speech-to-text': 'faster_whisper_local',
    'google_speech_to_text': 'faster_whisper_local',
    'faster_whisper_local': 'faster_whisper_local',
    'faster-whisper-local': 'faster_whisper_local',
    'groq_speech_to_text': 'groq_speech_to_text',
    'groq-stt': 'groq_speech_to_text',
    'groq_whisper': 'groq_speech_to_text',
    'groq-whisper': 'groq_speech_to_text',
    'assemblyai_speech_to_text': 'assemblyai_speech_to_text',
    'assemblyai-stt': 'assemblyai_speech_to_text',
    'assemblyai': 'assemblyai_speech_to_text',
    'assembly_ai': 'assemblyai_speech_to_text',
    'assembly-ai': 'assemblyai_speech_to_text',
    'gemini_speech_to_text': 'faster_whisper_local',
    'gemini-stt': 'faster_whisper_local',
    'gemini_audio_stt': 'faster_whisper_local',
  },
  translation: {
    'google-cloud-translation': 'codex_cli',
    'google_cloud_translation': 'codex_cli',
    'gemini': 'codex_cli',
    'google-gemini': 'codex_cli',
    'google_gemini': 'codex_cli',
    'gemini_api': 'codex_cli',
    'antigravity_cli': 'antigravity_cli',
    'antigravity-cli': 'antigravity_cli',
    'agy': 'antigravity_cli',
    'codex_cli': 'codex_cli',
    'codex-cli': 'codex_cli',
    'grok_cli': 'codex_cli',
    'grok-cli': 'codex_cli',
    'grok': 'codex_cli',
  },
  tts: {
    'google-cloud-tts': 'google_cloud_tts',
    'google_cloud_tts': 'google_cloud_tts',
    'edge-tts': 'edge_tts',
    'edge_tts': 'edge_tts',
    'zipvoice': 'edge_tts',
    'zipvoice_clone': 'edge_tts',
    'zipvoice-clone': 'edge_tts',
    'clone': 'edge_tts',
    'aimax': 'aimax_tts',
    'aimax_tts': 'aimax_tts',
    'aimax-tts': 'aimax_tts',
    'aimax_clone': 'aimax_tts',
    'aimax-clone': 'aimax_tts',
  },
};

const SAFE_GROQ_STT_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
];

const SAFE_ASSEMBLYAI_STT_MODELS = [
  'universal-3-5-pro',
  'universal-2',
];

function blankToUndefined(value) {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    const normalized = blankToUndefined(value);
    if (normalized !== undefined && normalized !== null) return normalized;
  }
  return undefined;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return Boolean(value);
}

function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeArray(value, fallback) {
  if (Array.isArray(value)) {
    return value;
  }
  return fallback;
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

function normalizeProvider(value, map, fallback) {
  const normalized = blankToUndefined(value);
  if (!normalized) return fallback;
  return map[String(normalized).trim().toLowerCase()] || normalized;
}

function normalizeVoiceGender(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'MALE' || text === 'FEMALE' || text === 'NEUTRAL') return text;
  if (text === 'ALL') return '';
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  if (text.startsWith('N')) return 'NEUTRAL';
  return '';
}

function normalizeGroqSttModel(value, fallback = 'whisper-large-v3-turbo') {
  const model = String(blankToUndefined(value) || fallback).trim();
  return SAFE_GROQ_STT_MODELS.includes(model) ? model : fallback;
}

function normalizeAssemblyAiSttModel(value, fallback = 'universal-3-5-pro') {
  const model = String(blankToUndefined(value) || fallback).trim();
  return SAFE_ASSEMBLYAI_STT_MODELS.includes(model) ? model : fallback;
}

function normalizeCredentialsMode(value) {
  const mode = blankToUndefined(value);
  if (!mode) return DEFAULTS.credentialsMode;
  if (['backend_env', 'api_key', 'service_account'].includes(mode)) {
    return mode;
  }
  return DEFAULTS.credentialsMode;
}

function normalizeSyncMode(value) {
  const mode = String(blankToUndefined(value) || DEFAULTS.syncMode).trim().toLowerCase();
  if (mode === 'strict timestamps' || mode === 'strict' || mode === 'strict_timestamps') {
    return 'strict';
  }
  if (mode === 'natural voice priority' || mode === 'natural' || mode === 'natural_voice_priority') {
    return 'natural';
  }
  return 'balanced';
}

function normalizeVoiceAlignMode(value) {
  const mode = String(blankToUndefined(value) || DEFAULTS.voiceAlignMode).trim().toLowerCase();
  if (mode === 'start' || mode === 'off' || mode === 'none') return 'start';
  if (mode === 'smart') return 'smart';
  return 'center';
}

function normalizeTranslationCleanupMode(value) {
  const mode = String(blankToUndefined(value) || DEFAULTS.translationCleanupMode).trim().toLowerCase();
  if (['wtpsplit_local', 'wtpsplit', 'local', 'local_wtpsplit'].includes(mode)) {
    return 'wtpsplit_local';
  }
  if (['llm_formatter', 'llm', 'gemini'].includes(mode)) {
    return 'llm_formatter';
  }
  if (['off', 'none', 'disabled'].includes(mode)) {
    return 'off';
  }
  return DEFAULTS.translationCleanupMode;
}

function looksLikeGoogleCloudVoice(voiceName) {
  const voice = String(voiceName || '').trim();
  if (!voice) return false;
  return /-(Standard|Wavenet|Neural2|Studio|Chirp3-HD|Chirp-HD)-/i.test(voice);
}

function looksLikeEdgeVoice(voiceName) {
  const voice = String(voiceName || '').trim();
  if (!voice) return false;
  return /Neural$/i.test(voice) && !/Neural2/i.test(voice);
}

function requiresGoogleCloudCredentials(config) {
  return config.ttsProvider === 'google_cloud_tts';
}

function normalizeSttModelForProvider(provider, value) {
  if (provider === 'faster_whisper_local') {
    const model = String(value || '').trim();
    return ['tiny', 'base', 'small', 'medium', 'large-v3'].includes(model) ? model : 'small';
  }
  if (provider === 'groq_speech_to_text') {
    return normalizeGroqSttModel(value, 'whisper-large-v3-turbo');
  }
  if (provider === 'assemblyai_speech_to_text') {
    return normalizeAssemblyAiSttModel(value, 'universal-3-5-pro');
  }
  return normalizeSttModelForProvider(DEFAULTS.sttProvider, value);
}

function normalizeSttTimestampMode(value) {
  const mode = String(blankToUndefined(value) || DEFAULTS.sttTimestampMode).trim().toLowerCase();
  if (['segment', 'segment_level', 'segment-level', 'segment_timestamps', 'segment-timestamps'].includes(mode)) {
    return 'segment_timestamps';
  }
  if (['word', 'word_level', 'word-level', 'word_timestamps', 'word-timestamps'].includes(mode)) {
    return mode.includes('level') ? 'word_level' : 'word_timestamps';
  }
  return DEFAULTS.sttTimestampMode;
}

function resolveGoogleCloudConfig(body = {}) {
  const requestConfig = body.googleCloudConfig || {};
  const config = {
    ...DEFAULTS,
    sourceType: blankToUndefined(body.sourceType) || DEFAULTS.sourceType,
    sourceLanguage: blankToUndefined(requestConfig.sourceLanguage) || blankToUndefined(body.sourceLanguage) || DEFAULTS.sourceLanguage,
    targetLanguage: blankToUndefined(requestConfig.targetLanguage) || blankToUndefined(body.targetLanguage) || DEFAULTS.targetLanguage,
    credentialsMode: normalizeCredentialsMode(requestConfig.credentialsMode),
    apiKey: firstConfiguredValue(
      requestConfig.apiKey,
      requestConfig.googleApiKey,
      requestConfig.googleCloudApiKey,
      body.apiKey,
      body.googleApiKey,
      body.googleCloudApiKey,
      process.env.GOOGLE_CLOUD_API_KEY
    ),
    projectId: firstConfiguredValue(
      requestConfig.projectId,
      requestConfig.googleProjectId,
      requestConfig.googleCloudProjectId,
      body.projectId,
      body.googleProjectId,
      body.googleCloudProjectId,
      process.env.GOOGLE_CLOUD_PROJECT_ID
    ),
    googleSttLocation: blankToUndefined(requestConfig.googleSttLocation)
      || blankToUndefined(requestConfig.sttLocation)
      || blankToUndefined(process.env.GOOGLE_STT_V2_LOCATION)
      || DEFAULTS.googleSttLocation,
    applicationCredentials: firstConfiguredValue(
      requestConfig.serviceAccountPath,
      requestConfig.googleServiceAccountPath,
      requestConfig.applicationCredentials,
      requestConfig.googleApplicationCredentials,
      body.serviceAccountPath,
      body.googleServiceAccountPath,
      body.applicationCredentials,
      body.googleApplicationCredentials,
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),
    sttProvider: normalizeProvider(requestConfig.sttProvider, PROVIDER_ALIASES.stt, DEFAULTS.sttProvider),
    sttModel: requestConfig.sttModel || DEFAULTS.sttModel,
    translationProvider: normalizeProvider(requestConfig.translationProvider, PROVIDER_ALIASES.translation, DEFAULTS.translationProvider),
    groqApiKey: blankToUndefined(requestConfig.groqApiKey) || blankToUndefined(process.env.GROQ_API_KEY),
    groqApiKeys: [
      ...normalizeSecretList(requestConfig.groqApiKeys),
      ...normalizeSecretList(process.env.GROQ_API_KEYS),
    ],
    assemblyAiApiKey: blankToUndefined(requestConfig.assemblyAiApiKey) || blankToUndefined(process.env.ASSEMBLYAI_API_KEY) || DEFAULTS.assemblyAiApiKey,
    assemblyAiApiKeys: [
      ...normalizeSecretList(requestConfig.assemblyAiApiKeys),
      ...normalizeSecretList(process.env.ASSEMBLYAI_API_KEYS),
    ],
    assemblyAiPrompt: blankToUndefined(requestConfig.assemblyAiPrompt) || DEFAULTS.assemblyAiPrompt,
    assemblyAiKeyterms: blankToUndefined(requestConfig.assemblyAiKeyterms) || DEFAULTS.assemblyAiKeyterms,
    assemblyAiProcessingMode: blankToUndefined(requestConfig.assemblyAiProcessingMode)
      || blankToUndefined(process.env.ASSEMBLYAI_STT_PROCESSING_MODE)
      || DEFAULTS.assemblyAiProcessingMode,
    assemblyAiChunkSeconds: normalizeNumber(
      requestConfig.assemblyAiChunkSeconds ?? process.env.ASSEMBLYAI_STT_CHUNK_SECONDS,
      DEFAULTS.assemblyAiChunkSeconds
    ),
    assemblyAiOverlapSeconds: normalizeNumber(
      requestConfig.assemblyAiOverlapSeconds ?? process.env.ASSEMBLYAI_STT_OVERLAP_SECONDS,
      DEFAULTS.assemblyAiOverlapSeconds
    ),
    assemblyAiConcurrency: normalizeNumber(
      requestConfig.assemblyAiConcurrency ?? process.env.ASSEMBLYAI_STT_CONCURRENCY,
      DEFAULTS.assemblyAiConcurrency
    ),
    userContext: blankToUndefined(requestConfig.userContext) || DEFAULTS.userContext,
    customGlossary: blankToUndefined(requestConfig.customGlossary) || DEFAULTS.customGlossary,
    autoContext: blankToUndefined(requestConfig.autoContext) || DEFAULTS.autoContext,
    translationCleanupMode: normalizeTranslationCleanupMode(requestConfig.translationCleanupMode),
    translationMode: ['story_v2', 'legacy'].includes(String(requestConfig.translationMode || '').trim())
      ? String(requestConfig.translationMode).trim()
      : DEFAULTS.translationMode,
    ttsProvider: normalizeProvider(requestConfig.ttsProvider, PROVIDER_ALIASES.tts, DEFAULTS.ttsProvider),
    ttsUnitMode: ['story_segments', 'meaning_units', 'post_translation'].includes(String(requestConfig.ttsUnitMode || '').trim())
      ? String(requestConfig.ttsUnitMode).trim()
      : DEFAULTS.ttsUnitMode,
    ttsLanguageCode: blankToUndefined(requestConfig.ttsLanguageCode) || DEFAULTS.ttsLanguageCode,
    ttsVoiceName: blankToUndefined(requestConfig.ttsVoiceName) || DEFAULTS.ttsVoiceName,
    voiceGenderFilter: normalizeVoiceGender(requestConfig.voiceGenderFilter) || DEFAULTS.voiceGenderFilter,
    aimaxApiKey: blankToUndefined(requestConfig.aimaxApiKey) || blankToUndefined(process.env.AIMAX_API_KEY) || DEFAULTS.aimaxApiKey,
    aimaxBaseUrl: blankToUndefined(requestConfig.aimaxBaseUrl) || blankToUndefined(process.env.AIMAX_BASE_URL) || DEFAULTS.aimaxBaseUrl,
    aimaxProvider: blankToUndefined(requestConfig.aimaxProvider) || blankToUndefined(process.env.AIMAX_TTS_PROVIDER) || DEFAULTS.aimaxProvider,
    aimaxModel: blankToUndefined(requestConfig.aimaxModel) || blankToUndefined(process.env.AIMAX_TTS_MODEL) || DEFAULTS.aimaxModel,
    aimaxSrtBatchEnabled: normalizeBoolean(requestConfig.aimaxSrtBatchEnabled, DEFAULTS.aimaxSrtBatchEnabled),
    aimaxSrtBatchMode: ['cue_count', 'request_count'].includes(String(requestConfig.aimaxSrtBatchMode || '').trim())
      ? String(requestConfig.aimaxSrtBatchMode).trim()
      : DEFAULTS.aimaxSrtBatchMode,
    aimaxSrtCuesPerRequest: normalizeNumber(requestConfig.aimaxSrtCuesPerRequest ?? requestConfig.aimaxSrtBatchCueCount, DEFAULTS.aimaxSrtCuesPerRequest),
    aimaxSrtRequestCount: normalizeNumber(requestConfig.aimaxSrtRequestCount ?? requestConfig.aimaxSrtBatchRequestCount, DEFAULTS.aimaxSrtRequestCount),
    aimaxSrtBatchConcurrency: normalizeNumber(requestConfig.aimaxSrtBatchConcurrency, DEFAULTS.aimaxSrtBatchConcurrency),
    ssmlGender: normalizeVoiceGender(requestConfig.ssmlGender) || normalizeVoiceGender(requestConfig.voiceGenderFilter) || DEFAULTS.ssmlGender,
    speakingRate: normalizeNumber(requestConfig.speakingRate, DEFAULTS.speakingRate),
    minSpeakingRate: normalizeNumber(requestConfig.minSpeakingRate, DEFAULTS.minSpeakingRate),
    maxSpeakingRate: normalizeNumber(requestConfig.maxSpeakingRate, DEFAULTS.maxSpeakingRate),
    pitch: normalizeNumber(requestConfig.pitch, DEFAULTS.pitch),
    ttsDurationControl: normalizeBoolean(requestConfig.ttsDurationControl, DEFAULTS.ttsDurationControl),
    preserveTtsAudio: normalizeBoolean(requestConfig.preserveTtsAudio, DEFAULTS.preserveTtsAudio),
    ttsFitEnabled: normalizeBoolean(requestConfig.ttsFitEnabled, DEFAULTS.ttsFitEnabled),
    ttsFitMode: blankToUndefined(requestConfig.ttsFitMode) || DEFAULTS.ttsFitMode,
    ttsFitMaxRate: normalizeNumber(requestConfig.ttsFitMaxRate, DEFAULTS.ttsFitMaxRate),
    ttsTextCleanupMode: blankToUndefined(requestConfig.ttsTextCleanupMode) || DEFAULTS.ttsTextCleanupMode,
    ttsFitWordsPerSecond: normalizeNumber(requestConfig.ttsFitWordsPerSecond, DEFAULTS.ttsFitWordsPerSecond),
    audioSampleRate: normalizeNumber(requestConfig.audioSampleRate, DEFAULTS.audioSampleRate),
    useYouTubeCaptions: normalizeBoolean(requestConfig.useYouTubeCaptions, DEFAULTS.useYouTubeCaptions),
    fallbackToGoogleStt: normalizeBoolean(requestConfig.fallbackToGoogleStt, DEFAULTS.fallbackToGoogleStt),
    sttTimestampMode: normalizeSttTimestampMode(requestConfig.sttTimestampMode || body.sttTimestampMode),
    enableWordTimestamps: normalizeBoolean(requestConfig.enableWordTimestamps, DEFAULTS.enableWordTimestamps),
    nlpSourceResegment: normalizeBoolean(requestConfig.nlpSourceResegment, DEFAULTS.nlpSourceResegment),
    ocrProvider: blankToUndefined(requestConfig.ocrProvider) || blankToUndefined(body.ocrProvider) || blankToUndefined(body.provider) || DEFAULTS.ocrProvider,
    ocrFps: normalizeNumber(requestConfig.ocrFps ?? body.ocrFps ?? body.fps, DEFAULTS.ocrFps),
    ocrCropX: normalizeNumber(requestConfig.ocrCropX ?? body.ocrCropX, DEFAULTS.ocrCropX),
    ocrCropY: normalizeNumber(requestConfig.ocrCropY ?? body.ocrCropY, DEFAULTS.ocrCropY),
    ocrCropW: normalizeNumber(requestConfig.ocrCropW ?? body.ocrCropW, DEFAULTS.ocrCropW),
    ocrCropH: normalizeNumber(requestConfig.ocrCropH ?? body.ocrCropH, DEFAULTS.ocrCropH),
    ocrMergeSimilarity: normalizeNumber(requestConfig.ocrMergeSimilarity ?? body.ocrMergeSimilarity, DEFAULTS.ocrMergeSimilarity),
    ocrMaxEmptyGap: normalizeNumber(requestConfig.ocrMaxEmptyGap ?? body.ocrMaxEmptyGap, DEFAULTS.ocrMaxEmptyGap),
    ocrMinDuration: normalizeNumber(requestConfig.ocrMinDuration ?? body.ocrMinDuration, DEFAULTS.ocrMinDuration),
    ocrRequireCjk: normalizeBoolean(requestConfig.ocrRequireCjk ?? body.ocrRequireCjk, DEFAULTS.ocrRequireCjk),
    ocrSkipUnchanged: normalizeBoolean(requestConfig.ocrSkipUnchanged ?? body.ocrSkipUnchanged, DEFAULTS.ocrSkipUnchanged),
    ocrChangeThreshold: normalizeNumber(requestConfig.ocrChangeThreshold ?? body.ocrChangeThreshold, DEFAULTS.ocrChangeThreshold),
    ocrConcurrency: normalizeNumber(requestConfig.ocrConcurrency ?? body.ocrConcurrency, DEFAULTS.ocrConcurrency),
    ocrMaxKeyframeGap: normalizeNumber(requestConfig.ocrMaxKeyframeGap ?? body.ocrMaxKeyframeGap, DEFAULTS.ocrMaxKeyframeGap),
    ocrKeyframeTimelineFps: normalizeNumber(requestConfig.ocrKeyframeTimelineFps ?? body.ocrKeyframeTimelineFps ?? body.timelineFps, DEFAULTS.ocrKeyframeTimelineFps),
    ocrLanguageHints: normalizeArray(requestConfig.ocrLanguageHints ?? body.ocrLanguageHints ?? body.languageHints, DEFAULTS.ocrLanguageHints),
    preserveTimestamps: normalizeBoolean(requestConfig.preserveTimestamps, DEFAULTS.preserveTimestamps),
    keepNamesAndTerms: normalizeBoolean(requestConfig.keepNamesAndTerms, DEFAULTS.keepNamesAndTerms),
    allowTextShortening: normalizeBoolean(requestConfig.allowTextShortening, DEFAULTS.allowTextShortening),
    translationCharsPerSecond: normalizeNumber(requestConfig.translationCharsPerSecond, DEFAULTS.translationCharsPerSecond),
    translationConstraintThreshold: normalizeNumber(requestConfig.translationConstraintThreshold, DEFAULTS.translationConstraintThreshold),
    translationTargetTtsRate: normalizeNumber(requestConfig.translationTargetTtsRate, DEFAULTS.translationTargetTtsRate),
    translationTimingValidationMode: blankToUndefined(requestConfig.translationTimingValidationMode) || DEFAULTS.translationTimingValidationMode,
    translationTimingRewriteMaxPasses: normalizeNumber(requestConfig.translationTimingRewriteMaxPasses, DEFAULTS.translationTimingRewriteMaxPasses),
    cliTranslationModel: blankToUndefined(requestConfig.cliTranslationModel) || DEFAULTS.cliTranslationModel,
    cliTranslationChunkSize: normalizeNumber(requestConfig.cliTranslationChunkSize, DEFAULTS.cliTranslationChunkSize),
    cliTranslationConcurrency: normalizeNumber(requestConfig.cliTranslationConcurrency, DEFAULTS.cliTranslationConcurrency),
    ttsTimingRewriteBatchSize: normalizeNumber(requestConfig.ttsTimingRewriteBatchSize, DEFAULTS.ttsTimingRewriteBatchSize),
    ttsTimingRewriteMaxLines: normalizeNumber(requestConfig.ttsTimingRewriteMaxLines, DEFAULTS.ttsTimingRewriteMaxLines),
    ttsTimingRewriteShortRatio: normalizeNumber(requestConfig.ttsTimingRewriteShortRatio, DEFAULTS.ttsTimingRewriteShortRatio),
    ttsTimingRewrite: normalizeBoolean(requestConfig.ttsTimingRewrite, DEFAULTS.ttsTimingRewrite),
    normalizeTimelineBeforeTranslate: normalizeBoolean(requestConfig.normalizeTimelineBeforeTranslate, DEFAULTS.normalizeTimelineBeforeTranslate),
    translationDisplayMode: ['source_timeline', 'meaning_timeline'].includes(String(requestConfig.translationDisplayMode || '').trim())
      ? String(requestConfig.translationDisplayMode).trim()
      : DEFAULTS.translationDisplayMode,
    storyContextTargetSeconds: normalizeNumber(requestConfig.storyContextTargetSeconds, DEFAULTS.storyContextTargetSeconds),
    storyContextMaxSeconds: normalizeNumber(requestConfig.storyContextMaxSeconds, DEFAULTS.storyContextMaxSeconds),
    storyHardBreakGapSeconds: normalizeNumber(requestConfig.storyHardBreakGapSeconds, DEFAULTS.storyHardBreakGapSeconds),
    storyTargetMinSeconds: normalizeNumber(requestConfig.storyTargetMinSeconds, DEFAULTS.storyTargetMinSeconds),
    storyTargetMaxSeconds: normalizeNumber(requestConfig.storyTargetMaxSeconds, DEFAULTS.storyTargetMaxSeconds),
    storyAbsoluteMaxSegmentSeconds: normalizeNumber(requestConfig.storyAbsoluteMaxSegmentSeconds, DEFAULTS.storyAbsoluteMaxSegmentSeconds),
    storyBoundaryMaxShiftSeconds: normalizeNumber(requestConfig.storyBoundaryMaxShiftSeconds, DEFAULTS.storyBoundaryMaxShiftSeconds),
    storyVerifierEnabled: normalizeBoolean(requestConfig.storyVerifierEnabled, DEFAULTS.storyVerifierEnabled),
    storyRepairMaxAttempts: normalizeNumber(requestConfig.storyRepairMaxAttempts, DEFAULTS.storyRepairMaxAttempts),
    storyReuseArtifact: requestConfig.storyReuseArtifact && typeof requestConfig.storyReuseArtifact === 'object'
      ? requestConfig.storyReuseArtifact
      : null,
    timelineMergeGapSeconds: normalizeNumber(requestConfig.timelineMergeGapSeconds, DEFAULTS.timelineMergeGapSeconds),
    timelineBreakGapSeconds: normalizeNumber(requestConfig.timelineBreakGapSeconds, DEFAULTS.timelineBreakGapSeconds),
    timelineMaxUnitDuration: normalizeNumber(requestConfig.timelineMaxUnitDuration, DEFAULTS.timelineMaxUnitDuration),
    timelineHardMaxUnitDuration: normalizeNumber(requestConfig.timelineHardMaxUnitDuration, DEFAULTS.timelineHardMaxUnitDuration),
    timelineMaxUnitWeight: normalizeNumber(requestConfig.timelineMaxUnitWeight, DEFAULTS.timelineMaxUnitWeight),
    timelineHardMaxUnitWeight: normalizeNumber(requestConfig.timelineHardMaxUnitWeight, DEFAULTS.timelineHardMaxUnitWeight),
    timelineMaxTranslatedChars: normalizeNumber(requestConfig.timelineMaxTranslatedChars, DEFAULTS.timelineMaxTranslatedChars),
    timelineGuardSeconds: normalizeNumber(requestConfig.timelineGuardSeconds, DEFAULTS.timelineGuardSeconds),
    naturalDubTargetMinSeconds: normalizeNumber(requestConfig.naturalDubTargetMinSeconds, DEFAULTS.naturalDubTargetMinSeconds),
    naturalDubTargetMaxSeconds: normalizeNumber(requestConfig.naturalDubTargetMaxSeconds, DEFAULTS.naturalDubTargetMaxSeconds),
    maxMeaningUnitDuration: normalizeNumber(requestConfig.maxMeaningUnitDuration, DEFAULTS.maxMeaningUnitDuration),
    hardMaxMeaningUnitDuration: normalizeNumber(requestConfig.hardMaxMeaningUnitDuration, DEFAULTS.hardMaxMeaningUnitDuration),
    maxMeaningUnitChars: normalizeNumber(requestConfig.maxMeaningUnitChars, DEFAULTS.maxMeaningUnitChars),
    hardMaxMeaningUnitChars: normalizeNumber(requestConfig.hardMaxMeaningUnitChars, DEFAULTS.hardMaxMeaningUnitChars),
    maxMeaningUnitSourceRows: normalizeNumber(requestConfig.maxMeaningUnitSourceRows, DEFAULTS.maxMeaningUnitSourceRows),
    minMeaningUnitStandaloneChars: normalizeNumber(requestConfig.minMeaningUnitStandaloneChars, DEFAULTS.minMeaningUnitStandaloneChars),
    meaningUnitHardBreakGapSeconds: normalizeNumber(requestConfig.meaningUnitHardBreakGapSeconds, DEFAULTS.meaningUnitHardBreakGapSeconds),
    meaningUnitSoftBreakGapSeconds: normalizeNumber(requestConfig.meaningUnitSoftBreakGapSeconds, DEFAULTS.meaningUnitSoftBreakGapSeconds),
    maxMeaningSegmentDuration: normalizeNumber(requestConfig.maxMeaningSegmentDuration, DEFAULTS.maxMeaningSegmentDuration),
    maxMeaningSegmentWords: normalizeNumber(requestConfig.maxMeaningSegmentWords, DEFAULTS.maxMeaningSegmentWords),
    maxMeaningSegmentChars: normalizeNumber(requestConfig.maxMeaningSegmentChars, DEFAULTS.maxMeaningSegmentChars),
    meaningSegmentBreakGap: normalizeNumber(requestConfig.meaningSegmentBreakGap, DEFAULTS.meaningSegmentBreakGap),
    minDubbingSegmentDuration: normalizeNumber(requestConfig.minDubbingSegmentDuration, DEFAULTS.minDubbingSegmentDuration),
    shortSegmentMergeGap: normalizeNumber(requestConfig.shortSegmentMergeGap, DEFAULTS.shortSegmentMergeGap),
    maxTtsSegmentDuration: normalizeNumber(requestConfig.maxTtsSegmentDuration, DEFAULTS.maxTtsSegmentDuration),
    maxTtsSegmentChars: normalizeNumber(requestConfig.maxTtsSegmentChars, DEFAULTS.maxTtsSegmentChars),
    targetTtsChunkDuration: normalizeNumber(requestConfig.targetTtsChunkDuration, DEFAULTS.targetTtsChunkDuration),
    maxTtsChunksPerSegment: normalizeNumber(requestConfig.maxTtsChunksPerSegment, DEFAULTS.maxTtsChunksPerSegment),
    borrowGapSeconds: normalizeNumber(requestConfig.borrowGapSeconds, DEFAULTS.borrowGapSeconds),
    acceptOverflowSeconds: normalizeNumber(requestConfig.acceptOverflowSeconds, DEFAULTS.acceptOverflowSeconds),
    retryOverflowSeconds: normalizeNumber(requestConfig.retryOverflowSeconds, DEFAULTS.retryOverflowSeconds),
    syncMode: normalizeSyncMode(requestConfig.syncMode),
    naturalPhraseSync: normalizeBoolean(requestConfig.naturalPhraseSync, DEFAULTS.naturalPhraseSync),
    phraseLengthMode: blankToUndefined(requestConfig.phraseLengthMode) || DEFAULTS.phraseLengthMode,
    pauseStyle: blankToUndefined(requestConfig.pauseStyle) || DEFAULTS.pauseStyle,
    normalizeLoudness: normalizeBoolean(requestConfig.normalizeLoudness, DEFAULTS.normalizeLoudness),
    subtitleDisplayMode: blankToUndefined(requestConfig.subtitleDisplayMode) || DEFAULTS.subtitleDisplayMode,
    targetPhraseSeconds: normalizeNumber(requestConfig.targetPhraseSeconds, DEFAULTS.targetPhraseSeconds),
    maxPhraseSeconds: normalizeNumber(requestConfig.maxPhraseSeconds, DEFAULTS.maxPhraseSeconds),
    absoluteMaxPhraseSeconds: normalizeNumber(requestConfig.absoluteMaxPhraseSeconds, DEFAULTS.absoluteMaxPhraseSeconds),
    addSilenceGaps: normalizeBoolean(requestConfig.addSilenceGaps, DEFAULTS.addSilenceGaps),
    maxVoiceGapSeconds: normalizeNumber(requestConfig.maxVoiceGapSeconds, DEFAULTS.maxVoiceGapSeconds),
    voiceAlignShortClips: normalizeBoolean(requestConfig.voiceAlignShortClips, DEFAULTS.voiceAlignShortClips),
    voiceAlignMode: normalizeVoiceAlignMode(requestConfig.voiceAlignMode),
    voiceAlignMinSlackSeconds: normalizeNumber(requestConfig.voiceAlignMinSlackSeconds, DEFAULTS.voiceAlignMinSlackSeconds),
    voiceAlignMaxShiftSeconds: normalizeNumber(requestConfig.voiceAlignMaxShiftSeconds, DEFAULTS.voiceAlignMaxShiftSeconds),
    ttsConcurrency: normalizeNumber(requestConfig.ttsConcurrency, DEFAULTS.ttsConcurrency),
    ttsMaxAttempts: normalizeNumber(requestConfig.ttsMaxAttempts, DEFAULTS.ttsMaxAttempts),
    speedUpLongSegments: normalizeBoolean(requestConfig.speedUpLongSegments, DEFAULTS.speedUpLongSegments),
    keepBackgroundMusic: normalizeBoolean(requestConfig.keepBackgroundMusic, DEFAULTS.keepBackgroundMusic),
    originalAudioVolume: Math.min(1, Math.max(0, normalizeNumber(requestConfig.originalAudioVolume, DEFAULTS.originalAudioVolume))),
    overlayEnabled: normalizeBoolean(requestConfig.overlayEnabled, DEFAULTS.overlayEnabled),
    overlayText: blankToUndefined(requestConfig.overlayText) || DEFAULTS.overlayText,
    overlayX: Math.min(100, Math.max(0, normalizeNumber(requestConfig.overlayX, DEFAULTS.overlayX))),
    overlayY: Math.min(100, Math.max(0, normalizeNumber(requestConfig.overlayY, DEFAULTS.overlayY))),
    overlayStart: Math.max(0, normalizeNumber(requestConfig.overlayStart, DEFAULTS.overlayStart)),
    overlayEnd: Math.max(0, normalizeNumber(requestConfig.overlayEnd, DEFAULTS.overlayEnd)),
    musicEnabled: normalizeBoolean(requestConfig.musicEnabled, DEFAULTS.musicEnabled),
    musicPath: blankToUndefined(requestConfig.musicPath) || DEFAULTS.musicPath,
    musicVolume: Math.min(100, Math.max(0, normalizeNumber(requestConfig.musicVolume, DEFAULTS.musicVolume))),
    musicFade: normalizeBoolean(requestConfig.musicFade, DEFAULTS.musicFade),
    logoEnabled: normalizeBoolean(requestConfig.logoEnabled, DEFAULTS.logoEnabled),
    logoPath: blankToUndefined(requestConfig.logoPath) || DEFAULTS.logoPath,
    logoPosition: blankToUndefined(requestConfig.logoPosition) || DEFAULTS.logoPosition,
    logoX: Math.min(100, Math.max(0, normalizeNumber(requestConfig.logoX, DEFAULTS.logoX))),
    logoY: Math.min(100, Math.max(0, normalizeNumber(requestConfig.logoY, DEFAULTS.logoY))),
    logoSize: Math.min(80, Math.max(0, normalizeNumber(requestConfig.logoSize, DEFAULTS.logoSize))),
    logoOpacity: Math.min(100, Math.max(0, normalizeNumber(requestConfig.logoOpacity, DEFAULTS.logoOpacity))),
    randomLogoText: normalizeBoolean(requestConfig.randomLogoText, DEFAULTS.randomLogoText),
    randomLogoPaths: blankToUndefined(requestConfig.randomLogoPaths) || DEFAULTS.randomLogoPaths,
    randomIntervalSeconds: Math.max(1, normalizeNumber(requestConfig.randomIntervalSeconds, DEFAULTS.randomIntervalSeconds)),
    outputAspectRatio: ['source', '16:9', '9:16', '4:3'].includes(String(requestConfig.outputAspectRatio || '').trim())
      ? String(requestConfig.outputAspectRatio).trim()
      : DEFAULTS.outputAspectRatio,
    outputQuality: Math.min(100, Math.max(30, normalizeNumber(requestConfig.outputQuality, DEFAULTS.outputQuality))),
    exportOptions: normalizeArray(requestConfig.exportOptions, DEFAULTS.exportOptions),
  };

  const safeSttProviders = new Set(['faster_whisper_local', 'groq_speech_to_text', 'assemblyai_speech_to_text']);
  const safeTranslationProviders = new Set(['codex_cli', 'antigravity_cli']);
  const safeTtsProviders = new Set(['edge_tts', 'google_cloud_tts', 'aimax_tts']);
  if (!safeSttProviders.has(config.sttProvider)) config.sttProvider = DEFAULTS.sttProvider;
  if (!safeTranslationProviders.has(config.translationProvider)) config.translationProvider = DEFAULTS.translationProvider;
  
  const { isCliAvailableSync } = require('./cliTranslationService');
  if (!isCliAvailableSync(config.translationProvider)) {
    if (isCliAvailableSync('antigravity_cli')) {
      config.translationProvider = 'antigravity_cli';
    } else if (isCliAvailableSync('codex_cli')) {
      config.translationProvider = 'codex_cli';
    }
  }

  if (!safeTtsProviders.has(config.ttsProvider)) config.ttsProvider = DEFAULTS.ttsProvider;

  if (
    requiresGoogleCloudCredentials(config)
    && !config.apiKey
    && !config.applicationCredentials
    && config.credentialsMode !== 'backend_env'
  ) {
    throw new Error('Missing Google Cloud credentials. Provide an API key, a service account path, or configure Backend/.env.');
  }

  config.sttModel = normalizeSttModelForProvider(config.sttProvider, config.sttModel);
  config.enableWordTimestamps = ['word_timestamps', 'word_level'].includes(config.sttTimestampMode);
  config.groqApiKeys = Array.from(new Set([
    ...normalizeSecretList(config.groqApiKey),
    ...normalizeSecretList(config.groqApiKeys),
  ]));
  config.groqApiKey = config.groqApiKeys[0] || '';
  config.assemblyAiApiKeys = Array.from(new Set([
    ...normalizeSecretList(config.assemblyAiApiKey),
    ...normalizeSecretList(config.assemblyAiApiKeys),
  ]));
  config.assemblyAiApiKey = config.assemblyAiApiKeys[0] || '';
  config.assemblyAiProcessingMode = ['parallel', 'fast', 'chunked', 'chunks', 'whole', 'whole_file', 'single', 'auto']
    .includes(String(config.assemblyAiProcessingMode || '').toLowerCase())
    ? String(config.assemblyAiProcessingMode).toLowerCase()
    : DEFAULTS.assemblyAiProcessingMode;
  config.assemblyAiChunkSeconds = Math.max(60, Math.min(600, Math.round(Number(config.assemblyAiChunkSeconds) || DEFAULTS.assemblyAiChunkSeconds)));
  config.assemblyAiOverlapSeconds = Math.max(2, Math.min(30, Math.round(Number(config.assemblyAiOverlapSeconds) || DEFAULTS.assemblyAiOverlapSeconds)));
  config.assemblyAiConcurrency = Math.max(1, Math.min(6, Math.round(Number(config.assemblyAiConcurrency) || DEFAULTS.assemblyAiConcurrency)));
  config.projectId = String(config.projectId || '').trim();
  config.googleSttLocation = String(config.googleSttLocation || DEFAULTS.googleSttLocation).trim();
  config.speakingRate = Number(Math.max(0.75, Math.min(2.0, config.speakingRate)).toFixed(2));
  config.minSpeakingRate = Number(Math.max(0.75, Math.min(2.0, config.minSpeakingRate || config.speakingRate)).toFixed(2));
  config.maxSpeakingRate = Number(Math.max(config.minSpeakingRate, Math.min(2.0, config.maxSpeakingRate || config.speakingRate)).toFixed(2));
  config.ttsFitEnabled = config.ttsFitEnabled !== false;
  config.ttsFitMode = ['natural', 'balanced', 'strict'].includes(String(config.ttsFitMode).toLowerCase())
    ? String(config.ttsFitMode).toLowerCase()
    : DEFAULTS.ttsFitMode;
  config.ttsFitMaxRate = Number(Math.max(config.speakingRate, Math.min(1.35, config.ttsFitMaxRate || DEFAULTS.ttsFitMaxRate)).toFixed(2));
  config.ttsTextCleanupMode = ['natural', 'fast', 'strict'].includes(String(config.ttsTextCleanupMode).toLowerCase())
    ? String(config.ttsTextCleanupMode).toLowerCase()
    : DEFAULTS.ttsTextCleanupMode;
  config.ttsFitWordsPerSecond = Math.max(1.8, Math.min(5.6, config.ttsFitWordsPerSecond || DEFAULTS.ttsFitWordsPerSecond));
  config.translationCharsPerSecond = Math.max(8, Math.min(26, config.translationCharsPerSecond));
  config.translationConstraintThreshold = Math.max(1.02, Math.min(1.5, config.translationConstraintThreshold));
  config.translationTargetTtsRate = Number(Math.max(0.75, Math.min(1.5, config.translationTargetTtsRate || DEFAULTS.translationTargetTtsRate)).toFixed(2));
  config.translationTimingValidationMode = ['estimate_only', 'estimate_plus_probe'].includes(String(config.translationTimingValidationMode).toLowerCase())
    ? String(config.translationTimingValidationMode).toLowerCase()
    : DEFAULTS.translationTimingValidationMode;
  config.translationTimingRewriteMaxPasses = Math.round(Math.max(0, Math.min(3, config.translationTimingRewriteMaxPasses)));
  config.storyContextTargetSeconds = Math.max(15, Math.min(25, config.storyContextTargetSeconds));
  config.storyContextMaxSeconds = Math.max(config.storyContextTargetSeconds, Math.min(30, config.storyContextMaxSeconds));
  config.storyHardBreakGapSeconds = Math.max(0.6, Math.min(2, config.storyHardBreakGapSeconds));
  config.storyTargetMinSeconds = Math.max(2, Math.min(6, config.storyTargetMinSeconds));
  config.storyTargetMaxSeconds = Math.max(config.storyTargetMinSeconds, Math.min(8, config.storyTargetMaxSeconds));
  config.storyAbsoluteMaxSegmentSeconds = Math.max(config.storyTargetMaxSeconds, Math.min(10, config.storyAbsoluteMaxSegmentSeconds));
  config.storyBoundaryMaxShiftSeconds = Math.max(0, Math.min(0.35, config.storyBoundaryMaxShiftSeconds));
  config.storyRepairMaxAttempts = Math.max(0, Math.min(2, Math.round(config.storyRepairMaxAttempts)));
  config.cliTranslationModel = String(config.cliTranslationModel || '').trim().slice(0, 120);
  config.cliTranslationChunkSize = Math.round(Math.max(5, Math.min(40, config.cliTranslationChunkSize)));
  config.cliTranslationConcurrency = Math.round(Math.max(1, Math.min(5, config.cliTranslationConcurrency)));
  config.ttsTimingRewriteBatchSize = Math.round(Math.max(10, Math.min(60, config.ttsTimingRewriteBatchSize)));
  config.ttsTimingRewriteMaxLines = Math.round(Math.max(0, Math.min(200, config.ttsTimingRewriteMaxLines)));
  config.ttsTimingRewriteShortRatio = Math.max(0.45, Math.min(0.85, config.ttsTimingRewriteShortRatio));
  config.timelineMergeGapSeconds = Math.max(0, Math.min(1.2, config.timelineMergeGapSeconds));
  config.timelineBreakGapSeconds = Math.max(0.1, Math.min(2, config.timelineBreakGapSeconds));
  config.timelineMaxUnitDuration = Math.max(2, Math.min(12, config.timelineMaxUnitDuration));
  config.timelineHardMaxUnitDuration = Math.max(config.timelineMaxUnitDuration, Math.min(14, config.timelineHardMaxUnitDuration));
  config.timelineMaxUnitWeight = Math.max(24, Math.min(120, config.timelineMaxUnitWeight));
  config.timelineHardMaxUnitWeight = Math.max(config.timelineMaxUnitWeight, Math.min(140, config.timelineHardMaxUnitWeight));
  config.timelineMaxTranslatedChars = Math.max(42, Math.min(80, config.timelineMaxTranslatedChars));
  config.timelineGuardSeconds = Math.max(0, Math.min(0.2, config.timelineGuardSeconds));
  config.naturalDubTargetMinSeconds = Math.max(0.8, Math.min(6.0, config.naturalDubTargetMinSeconds));
  config.naturalDubTargetMaxSeconds = Math.max(config.naturalDubTargetMinSeconds, Math.min(7.2, config.naturalDubTargetMaxSeconds));
  config.maxMeaningUnitDuration = Math.max(config.naturalDubTargetMaxSeconds, Math.min(7.8, config.maxMeaningUnitDuration));
  config.hardMaxMeaningUnitDuration = Math.max(config.maxMeaningUnitDuration, Math.min(8.5, config.hardMaxMeaningUnitDuration));
  config.maxMeaningUnitChars = Math.max(45, Math.min(220, config.maxMeaningUnitChars));
  config.hardMaxMeaningUnitChars = Math.max(config.maxMeaningUnitChars, Math.min(280, config.hardMaxMeaningUnitChars));
  config.maxMeaningUnitSourceRows = Math.max(1, Math.min(6, Math.round(config.maxMeaningUnitSourceRows)));
  config.minMeaningUnitStandaloneChars = Math.max(6, Math.min(60, config.minMeaningUnitStandaloneChars));
  config.meaningUnitHardBreakGapSeconds = Math.max(0.2, Math.min(1.5, config.meaningUnitHardBreakGapSeconds));
  config.meaningUnitSoftBreakGapSeconds = Math.max(0.05, Math.min(config.meaningUnitHardBreakGapSeconds, config.meaningUnitSoftBreakGapSeconds));
  config.maxMeaningSegmentDuration = Math.max(2.0, Math.min(7.8, config.maxMeaningSegmentDuration));
  config.maxMeaningSegmentWords = Math.max(8, Math.min(60, config.maxMeaningSegmentWords));
  config.maxMeaningSegmentChars = Math.max(45, Math.min(220, config.maxMeaningSegmentChars));
  config.meaningSegmentBreakGap = Math.max(0.15, Math.min(1.5, config.meaningSegmentBreakGap));
  config.minDubbingSegmentDuration = Math.max(0.4, Math.min(2.5, config.minDubbingSegmentDuration));
  config.shortSegmentMergeGap = Math.max(0, Math.min(config.meaningUnitHardBreakGapSeconds, config.shortSegmentMergeGap));
  config.maxTtsSegmentDuration = Math.max(6.0, Math.min(14.0, config.maxTtsSegmentDuration));
  config.maxTtsSegmentChars = Math.max(140, Math.min(360, config.maxTtsSegmentChars));
  config.targetTtsChunkDuration = Math.max(3.5, Math.min(8.0, config.targetTtsChunkDuration));
  config.maxTtsChunksPerSegment = Math.max(2, Math.min(5, Math.round(config.maxTtsChunksPerSegment)));
  config.borrowGapSeconds = Math.max(0, Math.min(1.5, config.borrowGapSeconds));
  config.acceptOverflowSeconds = Math.max(0, Math.min(1.2, config.acceptOverflowSeconds));
  config.retryOverflowSeconds = Math.max(config.acceptOverflowSeconds, Math.min(2.5, config.retryOverflowSeconds));
  config.maxVoiceGapSeconds = Math.max(0, Math.min(1.5, config.maxVoiceGapSeconds));
  const maxTtsConcurrency = config.ttsProvider === 'aimax_tts'
    ? 30
    : config.ttsProvider === 'edge_tts'
      ? 20
      : config.ttsProvider === 'google_cloud_tts'
        ? 20
        : 6;
  const defaultTtsConcurrency = config.ttsProvider === 'aimax_tts'
    ? 30
    : config.ttsProvider === 'edge_tts'
      ? 20
      : config.ttsProvider === 'google_cloud_tts'
        ? 3
        : DEFAULTS.ttsConcurrency;
  config.ttsConcurrency = Math.max(1, Math.min(maxTtsConcurrency, Math.round(Number.isFinite(config.ttsConcurrency) ? config.ttsConcurrency : defaultTtsConcurrency)));
  config.ttsMaxAttempts = Math.max(1, Math.min(5, Math.round(config.ttsMaxAttempts)));
  config.aimaxSrtBatchEnabled = config.ttsProvider === 'aimax_tts' && config.aimaxSrtBatchEnabled === true;
  config.aimaxSrtBatchMode = ['cue_count', 'request_count'].includes(String(config.aimaxSrtBatchMode || '').trim())
    ? String(config.aimaxSrtBatchMode).trim()
    : DEFAULTS.aimaxSrtBatchMode;
  config.aimaxSrtCuesPerRequest = Math.max(1, Math.min(200, Math.round(Number(config.aimaxSrtCuesPerRequest) || DEFAULTS.aimaxSrtCuesPerRequest)));
  config.aimaxSrtRequestCount = Math.max(0, Math.min(100, Math.round(Number(config.aimaxSrtRequestCount) || DEFAULTS.aimaxSrtRequestCount)));
  config.aimaxSrtBatchConcurrency = Math.max(1, Math.min(3, Math.round(Number(config.aimaxSrtBatchConcurrency) || DEFAULTS.aimaxSrtBatchConcurrency)));
  if (['aimax_tts', 'google_cloud_tts'].includes(config.ttsProvider)) {
    config.ttsMaxAttempts = Math.max(config.ttsMaxAttempts, 3);
  }
  if (config.ttsProvider === 'edge_tts') {
    config.ttsMaxAttempts = Math.max(config.ttsMaxAttempts, 4);
  }
  if (!['short', 'natural', 'detailed'].includes(String(config.phraseLengthMode).toLowerCase())) {
    config.phraseLengthMode = DEFAULTS.phraseLengthMode;
  }
  if (!['tight', 'natural', 'dramatic'].includes(String(config.pauseStyle).toLowerCase())) {
    config.pauseStyle = DEFAULTS.pauseStyle;
  }
  if (!['compact', 'detailed'].includes(String(config.subtitleDisplayMode).toLowerCase())) {
    config.subtitleDisplayMode = DEFAULTS.subtitleDisplayMode;
  }
  config.targetPhraseSeconds = Math.max(0.8, Math.min(2.6, config.targetPhraseSeconds));
  config.maxPhraseSeconds = Math.max(config.targetPhraseSeconds, Math.min(4.0, config.maxPhraseSeconds));
  config.absoluteMaxPhraseSeconds = Math.max(config.maxPhraseSeconds, Math.min(5.0, config.absoluteMaxPhraseSeconds));

  if (config.ttsProvider === 'edge_tts' && config.ttsVoiceName && !looksLikeEdgeVoice(config.ttsVoiceName)) {
    config.ttsVoiceName = '';
  }

  if (config.ttsProvider === 'google_cloud_tts' && config.ttsVoiceName && !looksLikeGoogleCloudVoice(config.ttsVoiceName)) {
    config.ttsVoiceName = '';
  }

  return config;
}

function getGoogleConfigStatus() {
  const hasApiKey = Boolean(process.env.GOOGLE_CLOUD_API_KEY);
  const hasProjectId = Boolean(process.env.GOOGLE_CLOUD_PROJECT_ID);
  const hasApplicationCredentials = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

  return {
    configured: hasApiKey || hasApplicationCredentials,
    hasApiKey,
    hasProjectId,
    hasApplicationCredentials,
    mode: hasApplicationCredentials ? 'service_account' : hasApiKey ? 'env' : 'missing',
    speechToText: 'unknown',
    translation: 'unknown',
    textToSpeech: 'unknown',
  };
}

module.exports = {
  getGoogleConfigStatus,
  resolveGoogleCloudConfig,
};


