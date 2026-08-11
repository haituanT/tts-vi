const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/syncService');

function item(start, end, duration) {
  return {
    expectedStart: start,
    start,
    segment: { start, end, duration: end - start },
    normalized: { duration },
  };
}

test('voice placement centers a short clip inside its slot', () => {
  const [placed] = _private.assignPlaybackStarts([
    item(0, 5, 3),
  ], {
    syncMode: 'strict',
    voiceAlignShortClips: true,
    voiceAlignMode: 'center',
    voiceAlignMaxShiftSeconds: 2,
  });

  assert.equal(placed.start, 1);
  assert.equal(placed.voiceAlignApplied, true);
  assert.equal(placed.voiceAlignShiftSeconds, 1);
  assert.equal(placed.unplannedStartDriftSeconds, 0);
});

test('voice placement does not shift clips that already fill the slot', () => {
  const [placed] = _private.assignPlaybackStarts([
    item(0, 5, 5),
  ], {
    syncMode: 'strict',
    voiceAlignShortClips: true,
    voiceAlignMode: 'center',
    voiceAlignMaxShiftSeconds: 2,
  });

  assert.equal(placed.start, 0);
  assert.equal(placed.voiceAlignApplied, false);
});

test('voice placement clamps centered clips after previous audio', () => {
  const placed = _private.assignPlaybackStarts([
    item(0, 4, 4),
    item(3.5, 8.5, 2),
  ], {
    syncMode: 'strict',
    voiceAlignShortClips: true,
    voiceAlignMode: 'center',
    voiceAlignMaxShiftSeconds: 2,
  });

  assert.equal(placed[1].start, 5);
  assert.equal(placed[1].voiceAlignApplied, true);
  assert.ok(placed[1].start >= placed[0].start + placed[0].normalized.duration);
});

test('voice placement limits stale huge center shift settings', () => {
  const [placed] = _private.assignPlaybackStarts([
    item(0, 10, 1),
  ], {
    syncMode: 'strict',
    voiceAlignShortClips: true,
    voiceAlignMode: 'center',
    voiceAlignMaxShiftSeconds: 999,
  });

  assert.equal(placed.start, 0.6);
  assert.equal(placed.voiceAlignApplied, true);
});

test('continuous voice placement caps inter-group silence and marks the shift as planned', () => {
  const placed = _private.assignPlaybackStarts([
    item(0, 2, 1.2),
    item(4, 6, 1),
  ], {
    syncMode: 'natural',
    addSilenceGaps: false,
    maxVoiceGapSeconds: 0.12,
  });

  assert.equal(Number(placed[1].start.toFixed(2)), 1.32);
  assert.equal(placed[1].unplannedStartDriftSeconds, 0);
  assert.equal(Number(placed[1].compactedGapSeconds.toFixed(2)), 2.68);
});

test('strict sync slot budget stays tied to timeline duration', () => {
  const slot = _private.resolveSlotDurations({ start: 0, end: 1, duration: 1 }, 2);

  assert.equal(slot.nominalDuration, 1);
  assert.equal(slot.availableSlotDuration, 1);
});

test('sync slot budget can borrow allowed time but not pass next cue', () => {
  const slot = _private.resolveSlotDurations({ start: 0, end: 1, duration: 1, allowedDuration: 3 }, 2);

  assert.equal(slot.nominalDuration, 1);
  assert.equal(slot.availableSlotDuration, 2);
});

test('sync report does not warn when audio only uses the silent gap before the next cue', () => {
  const report = _private.buildSyncReport([{
    startDriftSeconds: 0,
    unplannedStartDriftSeconds: 0,
    durationDeltaSeconds: 0.61,
    cueEndOverflowSeconds: 0.61,
    endOverflowSeconds: 0,
    overlapNextSeconds: 0,
  }]);

  assert.equal(report.failedSegmentCount, 0);
  assert.equal(report.overflowSegmentCount, 0);
  assert.equal(report.strictPass, true);
});

test('sync report tracks sub-second overflow without marking it as warning', () => {
  const report = _private.buildSyncReport([{
    startDriftSeconds: 0,
    unplannedStartDriftSeconds: 0,
    durationDeltaSeconds: 0.61,
    cueEndOverflowSeconds: 1.31,
    endOverflowSeconds: 0.61,
    overlapNextSeconds: 0.61,
  }]);

  assert.equal(report.failedSegmentCount, 0);
  assert.equal(report.overflowSegmentCount, 1);
  assert.equal(report.overlapSegmentCount, 1);
  assert.equal(report.minorOverflowSegmentCount, 1);
  assert.equal(report.minorOverlapSegmentCount, 1);
  assert.equal(report.majorOverflowSegmentCount, 0);
  assert.equal(report.majorOverlapSegmentCount, 0);
  assert.equal(report.strictPass, true);
});

test('sync report treats post-speed overflow below one second as minor', () => {
  const report = _private.buildSyncReport([{
    startDriftSeconds: 0,
    unplannedStartDriftSeconds: 0,
    durationDeltaSeconds: 0.31,
    cueEndOverflowSeconds: 0.31,
    endOverflowSeconds: 0.31,
    overlapNextSeconds: 0.31,
    speedFactor: 1.1,
    effectiveSpeedFactor: 1.1,
  }]);

  assert.equal(report.failedSegmentCount, 0);
  assert.equal(report.overflowSegmentCount, 1);
  assert.equal(report.overlapSegmentCount, 1);
  assert.equal(report.minorOverflowSegmentCount, 1);
  assert.equal(report.minorOverlapSegmentCount, 1);
  assert.equal(report.majorOverflowSegmentCount, 0);
  assert.equal(report.majorOverlapSegmentCount, 0);
  assert.equal(report.strictPass, true);
});

test('sync report warns when overflow reaches one second', () => {
  const report = _private.buildSyncReport([{
    startDriftSeconds: 0,
    unplannedStartDriftSeconds: 0,
    durationDeltaSeconds: 1,
    cueEndOverflowSeconds: 1,
    endOverflowSeconds: 1,
    overlapNextSeconds: 1,
  }]);

  assert.equal(report.failedSegmentCount, 1);
  assert.equal(report.overflowSegmentCount, 1);
  assert.equal(report.overlapSegmentCount, 1);
  assert.equal(report.minorOverflowSegmentCount, 0);
  assert.equal(report.minorOverlapSegmentCount, 0);
  assert.equal(report.majorOverflowSegmentCount, 1);
  assert.equal(report.majorOverlapSegmentCount, 1);
  assert.equal(report.strictPass, false);
});

test('AIMAX clips do not allow post TTS speed processing', () => {
  assert.equal(
    _private.shouldAllowPostTtsSpeedProcessing(
      { provider: 'aimax_tts', ttsSpeakingRate: 1.2, ttsSpeedAppliedByProvider: true },
      { ttsProvider: 'aimax_tts', speedUpLongSegments: true }
    ),
    false
  );
});

test('Google Cloud and Edge clips do not allow post TTS speed processing', () => {
  for (const provider of ['google_cloud_tts', 'edge_tts']) {
    assert.equal(
      _private.shouldAllowPostTtsSpeedProcessing(
        { provider, ttsSpeakingRate: 1.1, ttsSpeedAppliedByProvider: true },
        { ttsProvider: provider, speedUpLongSegments: true }
      ),
      false
    );
  }
});

test('anti-overflow may explicitly speed up an existing provider clip after timeline QC', () => {
  assert.equal(
    _private.shouldAllowPostTtsSpeedProcessing(
      {
        provider: 'edge_tts',
        ttsSpeakingRate: 1,
        ttsSpeedAppliedByProvider: true,
        allowPostTtsSpeedProcessing: false,
        forcePostTtsSpeedProcessing: true,
        postTtsSpeedFactor: 1.05,
      },
      { ttsProvider: 'edge_tts', speedUpLongSegments: true }
    ),
    true
  );
});

test('unknown clips keep existing post TTS speed behavior', () => {
  assert.equal(
    _private.shouldAllowPostTtsSpeedProcessing(
      { provider: 'custom_tts', ttsSpeakingRate: 1.1 },
      { ttsProvider: 'custom_tts', speedUpLongSegments: true }
    ),
    true
  );
});
