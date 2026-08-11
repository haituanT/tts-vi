const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveMediaBinary } = require('./mediaBinaryService');

const execFileAsyncRaw = promisify(execFile);
const execFileAsync = (command, ...args) => execFileAsyncRaw(resolveMediaBinary(command), ...args);
const PROVIDER_SPEED_HANDLED_BY_TTS = new Set(['aimax_tts', 'google_cloud_tts', 'edge_tts']);
const TIMING_TRACE_OVERFLOW_SECONDS = 0.02;
const TIMING_MAJOR_OVERFLOW_SECONDS = 1.0;
const POST_SPEED_MAJOR_OVERFLOW_SECONDS = 1.0;

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

function buildAtempoFilter(speedFactor) {
  const parsed = Number(speedFactor);
  if (!Number.isFinite(parsed) || Math.abs(parsed - 1) <= 0.01) return [];
  const filters = [];
  let remaining = parsed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${clampNumber(remaining, 0.5, 2).toFixed(3)}`);
  return filters;
}

function concatListPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function createSilence(duration, outputPath, sampleRate = 32000) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`,
      '-t',
      Math.max(0.05, duration).toFixed(3),
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  return outputPath;
}

function getSyncProfile(syncConfig = {}) {
  const mode = String(syncConfig.syncMode || 'balanced').toLowerCase();
  if (mode === 'strict') {
    return {
      mode,
      maxSpeedFactor: 1.5,
      emergencyMaxSpeedFactor: 1.6,
      trimOverflowToleranceSeconds: 0.08,
      minDurationRetention: 0.82,
      hardTrimOverflow: syncConfig.hardTrimOverflow === true,
    };
  }

  if (mode === 'natural') {
    return {
      mode,
      maxSpeedFactor: 1.08,
      emergencyMaxSpeedFactor: 1.12,
      trimOverflowToleranceSeconds: 0,
      minDurationRetention: 1,
      hardTrimOverflow: syncConfig.hardTrimOverflow === true,
    };
  }

  return {
    mode: 'balanced',
    maxSpeedFactor: 1.2,
    emergencyMaxSpeedFactor: 1.28,
    trimOverflowToleranceSeconds: 0.04,
    minDurationRetention: 0.92,
    hardTrimOverflow: syncConfig.hardTrimOverflow === true,
  };
}

function getMaxEffectiveSpeedFactor(clip = {}, syncConfig = {}) {
  const baseRate = clampNumber(Number(clip.ttsSpeakingRate) || Number(clip.speakingRate) || Number(syncConfig.speakingRate) || 1, 0.5, 2.0);
  const configuredMax = Number(syncConfig.maxEffectiveSpeakingRate ?? syncConfig.maxSpeakingRate ?? Math.min(2.0, baseRate * 1.35));
  const maxRate = Number.isFinite(configuredMax) && configuredMax > 0
    ? clampNumber(configuredMax, baseRate, 2.0)
    : baseRate;
  return Math.max(1, maxRate / Math.max(0.1, baseRate));
}

function baseEffectiveSpeakingRate(clip = {}, syncConfig = {}) {
  return Number(clip.ttsSpeakingRate) || Number(clip.speakingRate) || Number(syncConfig.speakingRate) || 1;
}

function shouldAllowPostTtsSpeedProcessing(clip = {}, syncConfig = {}) {
  // Anti-overflow explicitly asks to speed up an already generated audio clip
  // after the first timeline check. This is intentionally the sole exception
  // to the provider-level "do not post-process" guard below.
  if (clip.forcePostTtsSpeedProcessing === true) return true;
  if (clip.allowPostTtsSpeedProcessing === false) return false;
  if (clip.ttsSpeedAppliedByProvider === true) return false;
  const provider = String(clip.provider || syncConfig.ttsProvider || '').trim();
  return !PROVIDER_SPEED_HANDLED_BY_TTS.has(provider);
}

async function trimClipToDuration(inputPath, outputPath, targetSeconds, sampleRate = 32000) {
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', inputPath, '-t', Math.max(0.05, targetSeconds).toFixed(3), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', outputPath],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  return outputPath;
}

async function padClipToDuration(inputPath, outputPath, targetSeconds, headPadSeconds, sampleRate = 32000) {
  const headMs = Math.max(0, Math.round(headPadSeconds * 1000));
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-af',
      `adelay=${headMs}|${headMs},apad,atrim=0:${Math.max(0.05, targetSeconds).toFixed(3)},aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono`,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  return outputPath;
}

function resolveSlotDurations(segment = {}, nextSegmentStart = null) {
  const segmentStart = Number(segment.start || 0);
  const segmentEnd = Number(segment.end || 0);
  const timelineDuration = segmentEnd > segmentStart ? segmentEnd - segmentStart : 0;
  const nominalDuration = Math.max(0.1, Number(segment.duration) || 0, timelineDuration);
  const naturalSlotDuration = nextSegmentStart && nextSegmentStart > segmentStart
    ? Math.max(0.1, nextSegmentStart - segmentStart)
    : nominalDuration;
  const configuredAllowedDuration = Number(segment.allowedDuration);
  const requestedSlotDuration = Number.isFinite(configuredAllowedDuration) && configuredAllowedDuration > 0
    ? configuredAllowedDuration
    : nominalDuration;
  const availableSlotDuration = Math.max(0.1, Math.min(Math.max(nominalDuration, requestedSlotDuration), naturalSlotDuration));
  return {
    segmentStart,
    segmentEnd,
    timelineDuration,
    nominalDuration,
    naturalSlotDuration,
    availableSlotDuration,
  };
}

async function normalizeClip(clip, segment, outputPath, syncConfig = {}, nextSegmentStart = null, sampleRate = 32000) {
  const actualDuration = await getAudioDuration(clip.path);
  if (!actualDuration) return null;
  const {
    segmentStart,
    nominalDuration,
    availableSlotDuration,
  } = resolveSlotDurations(segment, nextSegmentStart);
  const acceptedOverflowSeconds = Math.max(0, Number(syncConfig.acceptOverflowSeconds) || 0);
  const retryOverflowSeconds = Math.max(acceptedOverflowSeconds, Number(syncConfig.retryOverflowSeconds) || 2.5);
  const noTouchDuration = availableSlotDuration + acceptedOverflowSeconds;
  const allowPostTtsSpeedProcessing = shouldAllowPostTtsSpeedProcessing(clip, syncConfig);
  const allowSpeedUp = syncConfig.speedUpLongSegments !== false && allowPostTtsSpeedProcessing;
  const allowStretchShortClips = syncConfig.stretchShortClips === true && allowPostTtsSpeedProcessing;
  const forcedPostTtsRepair = clip.forcePostTtsSpeedProcessing === true;
  const syncProfile = getSyncProfile(syncConfig);
  const baseRate = baseEffectiveSpeakingRate(clip, syncConfig);
  const maxEffectiveSpeedFactor = allowPostTtsSpeedProcessing ? getMaxEffectiveSpeedFactor(clip, syncConfig) : 1;
  const maxSpeedFactor = Math.min(syncProfile.maxSpeedFactor, maxEffectiveSpeedFactor);
  const emergencyMaxSpeedFactor = Math.min(syncProfile.emergencyMaxSpeedFactor, maxEffectiveSpeedFactor);
  const strictEndGuardSeconds = syncProfile.mode === 'strict'
    ? Math.max(0.02, Number(syncConfig.strictEndGuardSeconds) || 0.03)
    : 0;
  const fitSlotDuration = Math.max(0.08, availableSlotDuration - strictEndGuardSeconds);

  if (syncConfig.preserveTtsAudio !== false) {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        clip.path,
        '-af',
        `aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono`,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-c:a',
        'pcm_s16le',
        outputPath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );
    const preservedDuration = await getAudioDuration(outputPath);
    return {
      path: outputPath,
      sourceDuration: actualDuration,
      duration: preservedDuration || actualDuration,
      nominalDuration,
      availableSlotDuration,
      targetDuration: actualDuration,
      speedFactor: 1,
      effectiveSpeedFactor: baseRate,
      maxEffectiveSpeedFactor: baseRate,
      strictEndGuardSeconds,
      overflowAfterFitSeconds: Math.max(0, (preservedDuration || actualDuration) - availableSlotDuration),
    };
  }

  const overlapAmount = Math.max(0, nominalDuration - availableSlotDuration);
  let targetDuration = nominalDuration;

  if (syncProfile.mode === 'strict') {
    targetDuration = Math.max(0.08, Math.min(nominalDuration, fitSlotDuration));
  } else if (syncProfile.mode === 'balanced') {
    targetDuration = overlapAmount > 0.12
      ? Math.max(availableSlotDuration, nominalDuration * syncProfile.minDurationRetention)
      : nominalDuration;
  } else {
    targetDuration = nominalDuration;
  }

  const shouldEmergencyFit = actualDuration > noTouchDuration + retryOverflowSeconds;
  const forcedSpeedLimit = forcedPostTtsRepair ? maxEffectiveSpeedFactor : emergencyMaxSpeedFactor;
  const forcedSpeedFactor = allowSpeedUp && forcedPostTtsRepair
    ? clampNumber(Number(clip.postTtsSpeedFactor) || 1, 1, forcedSpeedLimit)
    : 1;
  let appliedSpeedFactor = forcedSpeedFactor > 1.001
    ? forcedSpeedFactor
    : (shouldEmergencyFit && allowSpeedUp
      ? Math.min(actualDuration / targetDuration, maxSpeedFactor)
      : 1);
  if (allowStretchShortClips && !shouldEmergencyFit && actualDuration > 0) {
    const maxStretchFactor = clampNumber(syncConfig.maxShortClipStretchFactor ?? 1.45, 1, 2.5);
    const targetFillRatio = clampNumber(syncConfig.shortClipStretchTargetRatio ?? 0.88, 0.5, 1);
    const minSilenceToStretch = clampNumber(syncConfig.minSilenceToStretchSeconds ?? 0.75, 0, 5);
    const targetCeiling = Math.max(0.08, Math.min(fitSlotDuration, availableSlotDuration * targetFillRatio));
    const stretchTargetDuration = Math.min(targetCeiling, actualDuration * maxStretchFactor);
    if (targetCeiling - actualDuration >= minSilenceToStretch && stretchTargetDuration > actualDuration + 0.08) {
      appliedSpeedFactor = Math.max(0.4, actualDuration / stretchTargetDuration);
    }
  }
  async function renderWithSpeed(renderSpeedFactor, targetPath) {
    const filters = [
      'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-45dB',
      'areverse',
      'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-45dB',
      'areverse',
      `aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono`,
      ...buildAtempoFilter(renderSpeedFactor),
    ];
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', clip.path, '-af', filters.join(','), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', targetPath],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );
  }

  await renderWithSpeed(appliedSpeedFactor, outputPath);
  let normalizedPath = outputPath;
  let normalizedDuration = await getAudioDuration(outputPath);
  const overflowSeconds = normalizedDuration - availableSlotDuration;

  if (syncProfile.mode !== 'strict' && normalizedDuration > 0) {
    const padTargetDuration = forcedPostTtsRepair
      ? Math.min(nominalDuration, availableSlotDuration)
      : nominalDuration;
    // A forced anti-overflow repair must not pad a clip back beyond the
    // actual available slot. The normal natural-mode padding remains
    // unchanged for ordinary TTS clips.
    if (normalizedDuration < padTargetDuration) {
      const delta = padTargetDuration - normalizedDuration;
      const headPadSeconds = segment.naturalPhrase ? 0 : Math.min(0.25, delta * 0.35);
      const paddedPath = outputPath.replace(/\.wav$/i, '_padded.wav');
      normalizedPath = await padClipToDuration(normalizedPath, paddedPath, padTargetDuration, headPadSeconds, sampleRate);
      normalizedDuration = await getAudioDuration(normalizedPath);
    }
  }

  if (syncProfile.hardTrimOverflow && overflowSeconds > 0 && syncProfile.trimOverflowToleranceSeconds > 0 && overflowSeconds <= syncProfile.trimOverflowToleranceSeconds) {
    const trimmedPath = outputPath.replace(/\.wav$/i, '_trimmed.wav');
    normalizedPath = await trimClipToDuration(outputPath, trimmedPath, fitSlotDuration, sampleRate);
    normalizedDuration = await getAudioDuration(normalizedPath);
  }

  // Prefer emergency speed-up over cutting mid-sentence.
  if (nextSegmentStart && normalizedDuration > noTouchDuration + retryOverflowSeconds && allowSpeedUp) {
    const emergencyFactor = Math.min(
      Math.max(appliedSpeedFactor, actualDuration / Math.max(0.1, fitSlotDuration)),
      forcedPostTtsRepair ? maxEffectiveSpeedFactor : emergencyMaxSpeedFactor
    );
    if (emergencyFactor > appliedSpeedFactor + 0.01) {
      const emergencyPath = outputPath.replace(/\.wav$/i, '_emergency.wav');
      await renderWithSpeed(emergencyFactor, emergencyPath);
      const emergencyDuration = await getAudioDuration(emergencyPath);
      if (emergencyDuration && emergencyDuration < normalizedDuration) {
        normalizedPath = emergencyPath;
        normalizedDuration = emergencyDuration;
        appliedSpeedFactor = emergencyFactor;
      }
    }
  }

  if (normalizedDuration > fitSlotDuration && allowSpeedUp) {
    const fitFactor = Math.min(
      Math.max(appliedSpeedFactor, actualDuration / Math.max(0.1, fitSlotDuration)),
      forcedPostTtsRepair ? maxEffectiveSpeedFactor : emergencyMaxSpeedFactor
    );
    if (fitFactor > appliedSpeedFactor + 0.01) {
      const fitPath = outputPath.replace(/\.wav$/i, '_fit.wav');
      await renderWithSpeed(fitFactor, fitPath);
      const fitDuration = await getAudioDuration(fitPath);
      if (fitDuration && fitDuration < normalizedDuration) {
        normalizedPath = fitPath;
        normalizedDuration = fitDuration;
        appliedSpeedFactor = fitFactor;
      }
    }
  }

  // Hard trim is disabled by default to avoid cutting sentences mid-way.
  if (normalizedDuration > fitSlotDuration && syncProfile.hardTrimOverflow) {
    const hardTrimPath = outputPath.replace(/\.wav$/i, '_hardtrim.wav');
    normalizedPath = await trimClipToDuration(normalizedPath, hardTrimPath, fitSlotDuration, sampleRate);
    normalizedDuration = await getAudioDuration(normalizedPath);
  }

  return {
    path: normalizedPath,
    sourceDuration: actualDuration,
    duration: normalizedDuration || actualDuration,
    nominalDuration,
    availableSlotDuration,
    targetDuration,
    speedFactor: appliedSpeedFactor,
    effectiveSpeedFactor: appliedSpeedFactor * baseRate,
    maxEffectiveSpeedFactor: maxEffectiveSpeedFactor * baseRate,
    strictEndGuardSeconds,
    overflowAfterFitSeconds: Math.max(0, (normalizedDuration || 0) - availableSlotDuration),
  };
}

function roundMetric(value) {
  return Number(Number(value || 0).toFixed(3));
}

function postSpeedMajorOverflowThreshold(item = {}, fallback = TIMING_MAJOR_OVERFLOW_SECONDS) {
  const postSpeed = Number(item.speedFactor) > 1.001;
  return postSpeed ? POST_SPEED_MAJOR_OVERFLOW_SECONDS : fallback;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function resolveOutputSampleRate(syncConfig = {}) {
  const configured = Number(syncConfig.audioSampleRate || syncConfig.outputSampleRate || syncConfig.sampleRate);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(clampNumber(configured, 16000, 48000));
  }
  return 32000;
}

function shouldCompactVoiceGaps(syncConfig = {}) {
  const mode = String(syncConfig.syncMode || '').toLowerCase();
  if (mode === 'strict') return false;
  return syncConfig.addSilenceGaps === false || mode === 'natural';
}

function resolveVoiceAlignSettings(syncConfig = {}) {
  const mode = String(syncConfig.voiceAlignMode || 'start').toLowerCase();
  const rawMaxShift = Number(syncConfig.voiceAlignMaxShiftSeconds);
  const maxShiftFallback = 0.6;
  const maxShiftSeconds = Number.isFinite(rawMaxShift) && rawMaxShift >= 0 && rawMaxShift <= 2
    ? rawMaxShift
    : maxShiftFallback;
  return {
    enabled: syncConfig.voiceAlignShortClips !== false && mode !== 'start',
    mode: mode === 'smart' ? 'smart' : (mode === 'center' ? 'center' : 'start'),
    minSlackSeconds: clampNumber(syncConfig.voiceAlignMinSlackSeconds ?? 0.05, 0, 5),
    maxShiftSeconds: clampNumber(maxShiftSeconds, 0, 2),
  };
}

function assignPlaybackStarts(items, syncConfig = {}) {
  const compactGaps = shouldCompactVoiceGaps(syncConfig);
  const maxVoiceGapSeconds = clampNumber(syncConfig.maxVoiceGapSeconds ?? 0.12, 0, 1.5);
  const voiceAlign = resolveVoiceAlignSettings(syncConfig);
  let cursor = 0;
  let previousSourceEnd = null;

  return items.map((item, index) => {
    const expectedStart = Math.max(0, Number(item.expectedStart ?? item.start) || 0);
    const sourceEnd = Math.max(expectedStart, Number(item.segment?.end) || expectedStart + (Number(item.segment?.duration) || 0));
    const audioDuration = Math.max(0, Number(item.normalized?.duration) || 0);
    let playbackStart = expectedStart;
    let voiceAlignApplied = false;
    let voiceAlignSlackSeconds = 0;
    let voiceAlignShiftSeconds = 0;

    if (compactGaps) {
      if (index === 0) {
        playbackStart = expectedStart;
      } else {
        const sourceGap = previousSourceEnd === null ? 0 : Math.max(0, expectedStart - previousSourceEnd);
        playbackStart = Math.max(0, cursor + Math.min(sourceGap, maxVoiceGapSeconds));
      }
    }

    if (voiceAlign.enabled && !compactGaps && audioDuration > 0) {
      const slotDuration = Math.max(0, sourceEnd - expectedStart);
      const slackSeconds = slotDuration - audioDuration;
      if (slackSeconds > voiceAlign.minSlackSeconds) {
        const requestedShift = Math.min(slackSeconds / 2, voiceAlign.maxShiftSeconds);
        const desiredStart = expectedStart + requestedShift;
        const nextExpectedStart = items[index + 1]
          ? Math.max(0, Number(items[index + 1].expectedStart ?? items[index + 1].start) || 0)
          : Number.POSITIVE_INFINITY;
        const latestStart = Math.min(sourceEnd - audioDuration, nextExpectedStart - audioDuration);
        const earliestStart = Math.max(0, cursor);
        playbackStart = Math.max(earliestStart, Math.min(desiredStart, Math.max(earliestStart, latestStart)));
        voiceAlignApplied = true;
        voiceAlignSlackSeconds = slackSeconds;
        voiceAlignShiftSeconds = playbackStart - expectedStart;
      }
    }

    cursor = Math.max(cursor, playbackStart + audioDuration);
    previousSourceEnd = sourceEnd;
    return {
      ...item,
      start: playbackStart,
      expectedStart,
      startDriftSeconds: playbackStart - expectedStart,
      // In continuous voice mode, the shift is an intentional gap
      // compaction, not an unscheduled timeline drift.
      unplannedStartDriftSeconds: voiceAlignApplied || compactGaps ? 0 : playbackStart - expectedStart,
      compactedGapSeconds: compactGaps ? Math.max(0, expectedStart - playbackStart) : 0,
      voiceAlignApplied,
      voiceAlignMode: voiceAlignApplied ? voiceAlign.mode : 'start',
      voiceAlignSlackSeconds,
      voiceAlignShiftSeconds,
    };
  });
}

function buildSyncReport(items, options = {}) {
  const totalSegments = items.length;
  const compactVoiceGaps = options.compactVoiceGaps === true;
  const strictStartToleranceSeconds = 0.04;
  const traceEndToleranceSeconds = TIMING_TRACE_OVERFLOW_SECONDS;
  const defaultMajorEndToleranceSeconds = Number(options.majorEndToleranceSeconds) || TIMING_MAJOR_OVERFLOW_SECONDS;
  if (!totalSegments) {
    return {
      quality: 'unknown',
      totalSegments: 0,
      avgStartDriftSeconds: 0,
      maxStartDriftSeconds: 0,
      avgDurationDeltaSeconds: 0,
      within150msPercent: 0,
      within40msPercent: 0,
      overflowSegmentCount: 0,
      overlapSegmentCount: 0,
      failedSegmentCount: 0,
      maxEndOverflowSeconds: 0,
      strictPass: false,
      placementMode: compactVoiceGaps ? 'continuous_voice' : 'absolute_timeline',
      message: 'No sync analysis was produced.',
      segments: [],
    };
  }

  const driftValues = items.map((item) => Math.abs(item.unplannedStartDriftSeconds ?? item.startDriftSeconds));
  const actualDriftValues = items.map((item) => Math.abs(item.startDriftSeconds));
  const voiceAlignShiftValues = items.map((item) => Math.max(0, Number(item.voiceAlignShiftSeconds) || 0));
  const durationDeltaValues = items.map((item) => Math.abs(item.durationDeltaSeconds));
  const avgStartDriftSeconds = driftValues.reduce((sum, value) => sum + value, 0) / totalSegments;
  const maxStartDriftSeconds = Math.max(...driftValues);
  const maxActualStartDriftSeconds = Math.max(...actualDriftValues);
  const centeredClipCount = items.filter((item) => item.voiceAlignApplied).length;
  const avgVoiceAlignShiftSeconds = voiceAlignShiftValues.reduce((sum, value) => sum + value, 0) / totalSegments;
  const maxVoiceAlignShiftSeconds = Math.max(...voiceAlignShiftValues);
  const avgDurationDeltaSeconds = durationDeltaValues.reduce((sum, value) => sum + value, 0) / totalSegments;
  const within150msCount = items.filter((item) => Math.abs(item.unplannedStartDriftSeconds ?? item.startDriftSeconds) <= 0.15).length;
  const within40msCount = items.filter((item) => Math.abs(item.unplannedStartDriftSeconds ?? item.startDriftSeconds) <= strictStartToleranceSeconds).length;
  const overflowSegmentCount = items.filter((item) => (item.endOverflowSeconds || 0) > traceEndToleranceSeconds).length;
  const overlapSegmentCount = items.filter((item) => (item.overlapNextSeconds || 0) > traceEndToleranceSeconds).length;
  const majorOverflowSegmentCount = items.filter((item) => (
    (item.endOverflowSeconds || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const majorOverlapSegmentCount = items.filter((item) => (
    (item.overlapNextSeconds || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const minorOverflowSegmentCount = Math.max(0, overflowSegmentCount - majorOverflowSegmentCount);
  const minorOverlapSegmentCount = Math.max(0, overlapSegmentCount - majorOverlapSegmentCount);
  const failedSegmentCount = items.filter((item) => (
    item.ttsError === true
    || item.status === 'error'
    || Math.abs((item.unplannedStartDriftSeconds ?? item.startDriftSeconds) || 0) > strictStartToleranceSeconds
    || (item.endOverflowSeconds || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
    || (item.overlapNextSeconds || 0) >= postSpeedMajorOverflowThreshold(item, defaultMajorEndToleranceSeconds)
  )).length;
  const maxEndOverflowSeconds = Math.max(...items.map((item) => Number(item.endOverflowSeconds) || 0));
  const within150msPercent = (within150msCount / totalSegments) * 100;
  const within40msPercent = (within40msCount / totalSegments) * 100;
  const strictPass = failedSegmentCount === 0 && !compactVoiceGaps;

  let quality = 'good';
  let message = centeredClipCount > 0
    ? `Centered ${centeredClipCount} short TTS clip(s) inside their timeline slots.`
    : (compactVoiceGaps
    ? 'Voice gaps were compacted for smoother continuous dubbing.'
    : 'Dub timing stayed close to the transcript timeline.');
  if (!compactVoiceGaps) {
    if (!strictPass) {
      quality = 'warning';
      message = items.some((item) => item.ttsError === true || item.status === 'error')
        ? 'TTS failed for one or more timeline segments. Those segments were skipped and marked for repair.'
        : 'Strict sync failed for one or more segments. Check start drift, end overflow, or next-cue overlap.';
    } else if (maxStartDriftSeconds > 0.35 || within150msPercent < 75) {
      quality = 'warning';
      message = 'Noticeable sync drift was detected in some segments.';
    } else if (maxStartDriftSeconds > 0.18 || within150msPercent < 90) {
      quality = 'fair';
      message = 'Sync is usable, but some segments drifted beyond tight timing.';
    }
  }

  return {
    quality,
    placementMode: compactVoiceGaps ? 'continuous_voice' : (centeredClipCount > 0 ? 'center_short_clips' : 'absolute_timeline'),
    totalSegments,
    avgStartDriftSeconds: roundMetric(avgStartDriftSeconds),
    maxStartDriftSeconds: roundMetric(maxStartDriftSeconds),
    maxActualStartDriftSeconds: roundMetric(maxActualStartDriftSeconds),
    centeredClipCount,
    avgVoiceAlignShiftSeconds: roundMetric(avgVoiceAlignShiftSeconds),
    maxVoiceAlignShiftSeconds: roundMetric(maxVoiceAlignShiftSeconds),
    avgDurationDeltaSeconds: roundMetric(avgDurationDeltaSeconds),
    within150msPercent: roundMetric(within150msPercent),
    within40msPercent: roundMetric(within40msPercent),
    overflowSegmentCount,
    overlapSegmentCount,
    minorOverflowSegmentCount,
    minorOverlapSegmentCount,
    majorOverflowSegmentCount,
    majorOverlapSegmentCount,
    failedSegmentCount,
    maxEndOverflowSeconds: roundMetric(maxEndOverflowSeconds),
    strictPass,
    message,
    segments: items,
  };
}

function buildStrictSyncError(report) {
  const error = new Error(
    `TTS sync failed: ${report.failedSegmentCount} segment(s) overflow or overlap. Shorten highlighted subtitles, increase speaking rate, or split/adjust the timeline before exporting.`
  );
  error.code = 'TTS_SYNC_FAILED';
  error.syncReport = report;
  return error;
}

function isFailedTtsClip(clip = {}) {
  return clip.ttsFailed === true || clip.ttsError === true || clip.status === 'error';
}

function failedClipToSyncItem(clip = {}, segment = {}) {
  const start = Math.max(0, Number(segment.start ?? clip.start) || 0);
  const end = Math.max(
    start + 0.1,
    Number(segment.end ?? clip.end) || start + Number(segment.duration ?? clip.duration) || start + 0.1
  );
  const message = String(clip.errorMessage || clip.error_reason || clip.reason || 'TTS failed.')
    .replace(/\s+/g, ' ')
    .trim();
  const sourceIds = Array.isArray(segment.sourceIds) && segment.sourceIds.length
    ? segment.sourceIds
    : (Array.isArray(clip.sourceIds) && clip.sourceIds.length ? clip.sourceIds : [segment.id || clip.id].filter(Boolean));
  const sourceRowIds = Array.isArray(segment.sourceRowIds) && segment.sourceRowIds.length
    ? segment.sourceRowIds
    : (Array.isArray(clip.sourceRowIds) && clip.sourceRowIds.length ? clip.sourceRowIds : sourceIds);

  return {
    id: segment.id || clip.id || `tts-${clip.index}`,
    sourceIds,
    sourceRowIds,
    index: Number(clip.index) || 0,
    status: 'error',
    ttsError: true,
    errorCode: clip.errorCode || 'TTS_FAILED',
    errorMessage: message,
    error_reason: message,
    expectedStartSeconds: roundMetric(start),
    expectedEndSeconds: roundMetric(end),
    actualStartSeconds: roundMetric(start),
    actualEndSeconds: roundMetric(start),
    startDriftSeconds: 0,
    unplannedStartDriftSeconds: 0,
    voiceAlignApplied: false,
    voiceAlignMode: 'start',
    voiceAlignSlackSeconds: 0,
    voiceAlignShiftSeconds: 0,
    expectedDurationSeconds: roundMetric(Math.max(0.1, end - start)),
    availableSlotDurationSeconds: roundMetric(Math.max(0.1, end - start)),
    targetDurationSeconds: roundMetric(Math.max(0.1, end - start)),
    actualDurationSeconds: 0,
    durationDeltaSeconds: roundMetric(0 - Math.max(0.1, end - start)),
    speedFactor: 1,
    effectiveSpeedFactor: 1,
    maxEffectiveSpeedFactor: 1,
    overflowAfterFitSeconds: 0,
    cueEndOverflowSeconds: 0,
    endOverflowSeconds: 0,
    overlapNextSeconds: 0,
  };
}

async function concatAudio(files, outputPath, workDir, sampleRate = 32000) {
  const listPath = path.join(workDir, 'concat_list.txt');
  const content = files.map((filePath) => `file '${concatListPath(filePath)}'`).join('\n');
  await fs.writeFile(listPath, content, 'utf8');
  await execFileAsync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', outputPath],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  return outputPath;
}

async function mixClipAt(basePath, clipPath, outputPath, startSeconds, sampleRate = 32000) {
  const delayMs = Math.max(0, Math.round(startSeconds * 1000));
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      basePath,
      '-i',
      clipPath,
      '-filter_complex',
      `[1:a]adelay=${delayMs}|${delayMs}[delayed];[0:a][delayed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false,aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono[mixed]`,
      '-map',
      '[mixed]',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
  );
  return outputPath;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mixDelayedBatch(items, outputPath, timelineDuration, sampleRate = 32000) {
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-t',
    Math.max(0.05, timelineDuration).toFixed(3),
    '-i',
    `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`,
  ];
  items.forEach((item) => {
    args.push('-i', item.normalized.path);
  });

  const delayedLabels = items.map((item, index) => {
    const inputIndex = index + 1;
    const delayMs = Math.max(0, Math.round(item.start * 1000));
    return {
      filter: `[${inputIndex}:a]adelay=${delayMs}|${delayMs}[d${index}]`,
      label: `[d${index}]`,
    };
  });
  const filterParts = delayedLabels.map((item) => item.filter);
  const mixInputs = ['[0:a]', ...delayedLabels.map((item) => item.label)].join('');
  filterParts.push(
    `${mixInputs}amix=inputs=${items.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false,aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono[mixed]`
  );

  args.push(
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[mixed]',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    outputPath
  );

  await execFileAsync('ffmpeg', args, { windowsHide: true, maxBuffer: 1024 * 1024 * 30 });
  return outputPath;
}

async function mixBatchOutputs(batchPaths, outputPath, sampleRate = 32000) {
  const args = ['-y'];
  batchPaths.forEach((batchPath) => {
    args.push('-i', batchPath);
  });
  const labels = batchPaths.map((_, index) => `[${index}:a]`).join('');
  args.push(
    '-filter_complex',
    `${labels}amix=inputs=${batchPaths.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false,aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono[mixed]`,
    '-map',
    '[mixed]',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    outputPath
  );

  await execFileAsync('ffmpeg', args, { windowsHide: true, maxBuffer: 1024 * 1024 * 30 });
  return outputPath;
}

async function mixClipsAtTimeline(playbackItems, outputPath, workDir, timelineDuration, sampleRate = 32000) {
  if (playbackItems.length === 1) {
    return mixDelayedBatch(playbackItems, outputPath, timelineDuration, sampleRate);
  }

  const batchSize = 32;
  const batches = chunkArray(playbackItems, batchSize);
  const batchPaths = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batchPath = path.join(workDir, `batch_mix_${String(index).padStart(3, '0')}.wav`);
    await mixDelayedBatch(batches[index], batchPath, timelineDuration, sampleRate);
    batchPaths.push(batchPath);
  }

  if (batchPaths.length === 1) {
    await fs.copyFile(batchPaths[0], outputPath);
    return outputPath;
  }

  return mixBatchOutputs(batchPaths, outputPath, sampleRate);
}

async function normalizeLoudness(inputPath, outputPath, sampleRate = 32000) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-af',
      `loudnorm=I=-15:TP=-1.5:LRA=8,aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=mono`,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 30 }
  );
  return outputPath;
}

async function createAlignedAudio(segments, audioClips, outputPath, syncConfig = {}) {
  if (!audioClips.length) {
    throw new Error('No TTS clips are available for audio sync.');
  }

  const outputSampleRate = resolveOutputSampleRate(syncConfig);
  const workDir = path.join(path.dirname(outputPath), 'sync_work');
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const sortedClips = [...audioClips].sort((a, b) => (segments[a.index]?.start || a.start || 0) - (segments[b.index]?.start || b.start || 0));
  const failedSyncItems = sortedClips
    .filter(isFailedTtsClip)
    .map((clip) => failedClipToSyncItem(clip, segments[clip.index] || clip));
  const playableClips = sortedClips.filter((clip) => !isFailedTtsClip(clip));
  const normalizedItems = [];
  const syncItems = [];
  let sequence = 0;

  try {
    for (const clip of playableClips) {
      const segment = segments[clip.index] || clip;
      const start = Math.max(0, Number(segment.start) || 0);
      const nextSegment = segments[clip.index + 1];
      const nextSegmentStart = nextSegment ? Math.max(0, Number(nextSegment.start) || 0) : null;
      const clipPath = path.join(workDir, `part_${String(sequence).padStart(4, '0')}_clip.wav`);
      const normalized = await normalizeClip(clip, segment, clipPath, syncConfig, nextSegmentStart, outputSampleRate);
      if (!normalized) continue;
      normalizedItems.push({
        clip,
        segment,
        start,
        expectedStart: start,
        normalized,
      });
      syncItems.push({
        id: segment.id || clip.id || `tts-${clip.index}`,
        sourceIds: Array.isArray(segment.sourceIds) ? segment.sourceIds : [segment.id || clip.id].filter(Boolean),
        sourceRowIds: Array.isArray(segment.sourceRowIds)
          ? segment.sourceRowIds
          : (Array.isArray(segment.sourceIds) ? segment.sourceIds : [segment.id || clip.id].filter(Boolean)),
        index: clip.index,
        expectedStartSeconds: roundMetric(start),
        expectedEndSeconds: roundMetric(Number(segment.end) || (start + normalized.nominalDuration)),
        actualStartSeconds: roundMetric(start),
        actualEndSeconds: roundMetric(start + normalized.duration),
        startDriftSeconds: 0,
        unplannedStartDriftSeconds: 0,
        voiceAlignApplied: false,
        voiceAlignMode: 'start',
        voiceAlignSlackSeconds: 0,
        voiceAlignShiftSeconds: 0,
        expectedDurationSeconds: roundMetric(normalized.nominalDuration),
        availableSlotDurationSeconds: roundMetric(normalized.availableSlotDuration),
        targetDurationSeconds: roundMetric(normalized.targetDuration),
        actualDurationSeconds: roundMetric(normalized.duration),
        durationDeltaSeconds: roundMetric(normalized.duration - normalized.targetDuration),
        speedFactor: roundMetric(normalized.speedFactor),
        effectiveSpeedFactor: roundMetric(normalized.effectiveSpeedFactor),
        maxEffectiveSpeedFactor: roundMetric(normalized.maxEffectiveSpeedFactor),
        overflowAfterFitSeconds: roundMetric(normalized.overflowAfterFitSeconds),
        cueEndOverflowSeconds: roundMetric(Math.max(0, (start + normalized.duration) - (Number(segment.end) || start + normalized.nominalDuration))),
        endOverflowSeconds: 0,
        overlapNextSeconds: 0,
      });
      sequence += 1;
    }

    if (!normalizedItems.length) {
      if (failedSyncItems.length) {
        const report = buildSyncReport(failedSyncItems, {
          compactVoiceGaps: shouldCompactVoiceGaps(syncConfig),
          majorEndToleranceSeconds: syncConfig.majorEndToleranceSeconds,
        });
        await fs.rm(workDir, { recursive: true, force: true });
        return {
          outputPath: '',
          outputSampleRate,
          report,
        };
      }
      throw new Error('No valid TTS clips were created for audio sync.');
    }

    const playbackItems = assignPlaybackStarts(normalizedItems, syncConfig);
    for (let index = 0; index < playbackItems.length; index += 1) {
      const item = playbackItems[index];
      if (syncItems[index]) {
        const expectedEnd = Number(syncItems[index].expectedEndSeconds) || (item.start + item.normalized.duration);
        const actualEnd = item.start + item.normalized.duration;
        const nextExpectedStart = playbackItems[index + 1]
          ? Number(playbackItems[index + 1].expectedStart ?? playbackItems[index + 1].start) || 0
          : null;
        const timelineEnd = Number(syncConfig.timelineDurationSeconds) || 0;
        const collisionBoundary = nextExpectedStart !== null
          ? nextExpectedStart
          : (timelineEnd > expectedEnd ? timelineEnd : expectedEnd);
        const cueEndOverflow = Math.max(0, actualEnd - expectedEnd);
        const boundaryOverflow = Math.max(0, actualEnd - collisionBoundary);
        syncItems[index].actualStartSeconds = roundMetric(item.start);
        syncItems[index].actualEndSeconds = roundMetric(actualEnd);
        syncItems[index].startDriftSeconds = roundMetric(item.startDriftSeconds);
        syncItems[index].unplannedStartDriftSeconds = roundMetric(item.unplannedStartDriftSeconds ?? item.startDriftSeconds);
        syncItems[index].voiceAlignApplied = item.voiceAlignApplied === true;
        syncItems[index].voiceAlignMode = item.voiceAlignMode || 'start';
        syncItems[index].voiceAlignSlackSeconds = roundMetric(item.voiceAlignSlackSeconds || 0);
        syncItems[index].voiceAlignShiftSeconds = roundMetric(item.voiceAlignShiftSeconds || 0);
        syncItems[index].cueEndOverflowSeconds = roundMetric(cueEndOverflow);
        syncItems[index].endOverflowSeconds = roundMetric(boundaryOverflow);
        syncItems[index].overlapNextSeconds = roundMetric(nextExpectedStart === null ? 0 : Math.max(0, actualEnd - nextExpectedStart));
      }
    }

    const reportItems = [...syncItems, ...failedSyncItems]
      .sort((left, right) => (Number(left.expectedStartSeconds) || 0) - (Number(right.expectedStartSeconds) || 0));
    const report = buildSyncReport(reportItems, {
      compactVoiceGaps: shouldCompactVoiceGaps(syncConfig),
      majorEndToleranceSeconds: syncConfig.majorEndToleranceSeconds,
    });
    if (syncConfig.failOnStrictSync === true && !report.strictPass && !failedSyncItems.length) {
      throw buildStrictSyncError(report);
    }

    const lastAudioEnd = playbackItems.reduce((max, item) => Math.max(max, item.start + item.normalized.duration), 0);
    const lastSegmentEnd = segments.reduce((max, segment) => Math.max(max, Number(segment.end) || 0), 0);
    const timelineDuration = Math.max(
      0.1,
      Number(syncConfig.timelineDurationSeconds) || 0,
      lastAudioEnd,
      lastSegmentEnd
    );
    const currentMixPath = path.join(workDir, 'timeline_mix.wav');
    await mixClipsAtTimeline(playbackItems, currentMixPath, workDir, timelineDuration, outputSampleRate);

    if (syncConfig.normalizeLoudness !== false) {
      await normalizeLoudness(currentMixPath, outputPath, outputSampleRate);
    } else {
      await fs.copyFile(currentMixPath, outputPath);
    }
    await fs.rm(workDir, { recursive: true, force: true });
    return {
      outputPath,
      outputSampleRate,
      report,
    };
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (error.syncReport) {
      throw error;
    }
    throw new Error(`Audio sync failed: ${error.stderr || error.message}`);
  }
}

module.exports = {
  createAlignedAudio,
  _private: {
    assignPlaybackStarts,
    buildSyncReport,
    postSpeedMajorOverflowThreshold,
    resolveSlotDurations,
    resolveVoiceAlignSettings,
    shouldCompactVoiceGaps,
    shouldAllowPostTtsSpeedProcessing,
  },
};
