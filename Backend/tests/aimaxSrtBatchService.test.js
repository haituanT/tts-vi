const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  buildCueBatches,
  mergeBatchSrtEntries,
  normalizeCueSegments,
  _private,
} = require('../services/aimaxSrtBatchService');
const { parseSrtEntries } = require('../services/googleTranslateService');

function cue(index) {
  return {
    id: `row-${index}`,
    index,
    start: index,
    end: index + 0.8,
    finalText: `Translated cue ${index}`,
  };
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

test('AIMAX SRT batch mode chunks translated cues by cue count', () => {
  const cues = Array.from({ length: 75 }, (_, index) => cue(index + 1));
  const batches = buildCueBatches(cues, { aimaxSrtCuesPerRequest: 30 });

  assert.equal(batches.length, 3);
  assert.equal(batches[0].cues.length, 30);
  assert.equal(batches[1].cues.length, 30);
  assert.equal(batches[2].cues.length, 15);
  assert.equal(batches[0].text.split('\n').length, 30);
  assert.equal(batches[2].text.split('\n')[0], 'Translated cue 61');
});

test('AIMAX SRT batch mode can split by requested request count', () => {
  const cues = Array.from({ length: 90 }, (_, index) => cue(index + 1));
  const batches = buildCueBatches(cues, {
    aimaxSrtBatchMode: 'request_count',
    aimaxSrtRequestCount: 3,
  });

  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.cues.length), [30, 30, 30]);
});

test('AIMAX anti-overflow selects only cues that spill beyond one second', () => {
  const selected = _private.overflowCueIds({
    segments: [
      { id: 'minor', endOverflowSeconds: 0.9 },
      { id: 'boundary', endOverflowSeconds: 1.0 },
      { id: 'major', overlapNextSeconds: 1.001 },
    ],
  }, 1);

  assert.deepEqual([...selected], ['major']);
});

test('AIMAX anti-overflow recalculates every cue above the trace tolerance', () => {
  const selected = _private.overflowCueIds({
    segments: [
      { id: 'noise', endOverflowSeconds: 0.02 },
      { id: 'small', endOverflowSeconds: 0.021 },
      { id: 'major', overlapNextSeconds: 1.001 },
    ],
  }, 0.02);

  assert.deepEqual([...selected], ['small', 'major']);
});

test('AIMAX anti-overflow auto speed scales by measured overflow', () => {
  assert.equal(_private.antiOverflowSpeedFactorForReportItem({
    actualDurationSeconds: 4,
    endOverflowSeconds: 0.9,
  }, {
    baseSpeakingRate: 1,
    triggerOverflowSeconds: 1,
    targetOverflowSeconds: 1,
  }), 1);

  assert.equal(_private.antiOverflowSpeedFactorForReportItem({
    actualDurationSeconds: 4,
    endOverflowSeconds: 1.5,
  }, {
    baseSpeakingRate: 1,
    triggerOverflowSeconds: 1,
    targetOverflowSeconds: 1,
  }), 1.333);

  assert.equal(_private.antiOverflowSpeedFactorForReportItem({
    actualDurationSeconds: 4,
    endOverflowSeconds: 3.5,
  }, {
    baseSpeakingRate: 1,
    triggerOverflowSeconds: 1,
    targetOverflowSeconds: 1,
  }), 1.6);
});

test('AIMAX anti-overflow calculates a speed factor for small measured overflow', () => {
  assert.equal(_private.antiOverflowSpeedFactorForReportItem({
    actualDurationSeconds: 4,
    endOverflowSeconds: 0.1,
  }, {
    baseSpeakingRate: 1,
    triggerOverflowSeconds: 0.02,
    targetOverflowSeconds: 0.02,
  }), 1.026);
});

test('AIMAX segments ZIP extraction requires one numbered line file per cue', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-ok-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const zipPath = path.join(tmpDir, 'segments.zip');
  const outputDir = path.join(tmpDir, 'unzipped');
  await fs.writeFile(zipPath, createStoredZip([
    { name: '1413458_1784743063.srt', data: '1\n00:00:00,000 --> 00:00:01,000\nOne\n' },
    { name: 'line_002.mp3', data: 'two' },
    { name: 'line_001.mp3', data: 'one' },
  ]));

  const files = await _private.extractAimaxSegmentsZip(zipPath, outputDir, {
    expectedCount: 2,
    batchIndex: 0,
  });

  assert.deepEqual(files.map((file) => file.fileName), ['line_001.mp3', 'line_002.mp3']);
  assert.equal(await fs.readFile(files[0].audioPath, 'utf8'), 'one');
  assert.equal(await fs.readFile(files[1].audioPath, 'utf8'), 'two');
});

test('AIMAX segments ZIP extraction fails when a line file is missing', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-missing-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const zipPath = path.join(tmpDir, 'segments.zip');
  await fs.writeFile(zipPath, createStoredZip([
    { name: 'line_001.mp3', data: 'one' },
  ]));

  await assert.rejects(
    () => _private.extractAimaxSegmentsZip(zipPath, path.join(tmpDir, 'unzipped'), {
      expectedCount: 2,
      batchIndex: 1,
    }),
    /expected 2 line audio file\(s\), got 1/
  );
});

test('AIMAX SRT batch cache reuses matching line audio files', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-cache-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const batch = buildCueBatches([cue(1), cue(2)], {
    aimaxSrtCuesPerRequest: 30,
  })[0];
  const config = {
    aimaxProvider: 'minimax',
    aimaxModel: 'speech-2.8-hd',
    ttsVoiceName: 'voice-1',
    ttsLanguageCode: 'vi-VN',
    speakingRate: 1.2,
  };
  const paths = {
    srtPath: path.join(tmpDir, 'batch_001.srt'),
    segmentsZipPath: path.join(tmpDir, 'batch_001_segments.zip'),
    segmentsDir: path.join(tmpDir, 'batch_001_segments'),
    metaPath: path.join(tmpDir, 'batch_001_segments.meta.json'),
  };
  await fs.writeFile(paths.segmentsZipPath, createStoredZip([
    { name: 'line_001.mp3', data: 'one' },
    { name: 'line_002.mp3', data: 'two' },
  ]));
  await fs.writeFile(paths.metaPath, JSON.stringify({
    ..._private.batchCacheIdentity(batch, config),
    jobId: 'job-1',
    segmentsUrl: '/audio/job_segments.zip',
  }));

  const reusable = await _private.loadReusableBatchSegments(batch, paths, config);

  assert.equal(reusable.jobId, 'job-1');
  assert.equal(reusable.outputMode, 'segments_url_cached');
  assert.deepEqual(reusable.segmentFiles.map((file) => file.fileName), ['line_001.mp3', 'line_002.mp3']);
  assert.equal(await fs.readFile(reusable.segmentFiles[0].audioPath, 'utf8'), 'one');
});

test('AIMAX SRT batch cache rejects stale line audio files when text changes', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-stale-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const config = { ttsVoiceName: 'voice-1', ttsLanguageCode: 'vi-VN', speakingRate: 1 };
  const original = buildCueBatches([cue(1)], config)[0];
  const changed = buildCueBatches([{ ...cue(1), finalText: 'Changed translated cue' }], config)[0];
  const paths = {
    srtPath: path.join(tmpDir, 'batch_001.srt'),
    segmentsZipPath: path.join(tmpDir, 'batch_001_segments.zip'),
    segmentsDir: path.join(tmpDir, 'batch_001_segments'),
    metaPath: path.join(tmpDir, 'batch_001_segments.meta.json'),
  };
  await fs.writeFile(paths.segmentsZipPath, createStoredZip([
    { name: 'line_001.mp3', data: 'one' },
  ]));
  await fs.writeFile(paths.metaPath, JSON.stringify(_private.batchCacheIdentity(original, config)));

  const reusable = await _private.loadReusableBatchSegments(changed, paths, config);

  assert.equal(reusable, null);
});

test('AIMAX SRT batch resume only accepts matching pending job metadata', () => {
  const config = { ttsVoiceName: 'voice-1', ttsLanguageCode: 'vi-VN', speakingRate: 1 };
  const original = buildCueBatches([cue(1)], config)[0];
  const changed = buildCueBatches([{ ...cue(1), finalText: 'Changed translated cue' }], config)[0];
  const meta = {
    ..._private.batchCacheIdentity(original, config),
    status: 'pending',
    jobId: 'job-123',
  };

  assert.equal(_private.resumableBatchJobId(meta, original, config), 'job-123');
  assert.equal(_private.resumableBatchJobId(meta, changed, config), '');
});

test('AIMAX SRT batch workdir lock prevents duplicate project runs', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-lock-'));
  let release = null;
  t.after(async () => {
    if (release) await release();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  release = await _private.acquireBatchWorkDirLock(tmpDir);

  await assert.rejects(
    () => _private.acquireBatchWorkDirLock(tmpDir),
    /already running|lock is active/
  );
});

test('AIMAX SRT batch workdir lock stays active while owner process is alive even when old', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aimax-segments-old-lock-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  await fs.mkdir(tmpDir, { recursive: true });
  const lockPath = path.join(tmpDir, '.aimax_srt_batch.lock');
  await fs.writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  }));
  const oldDate = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await fs.utimes(lockPath, oldDate, oldDate);

  await assert.rejects(
    () => _private.acquireBatchWorkDirLock(tmpDir),
    /already running/
  );
  assert.equal(await fs.readFile(lockPath, 'utf8').then(Boolean), true);
});

test('AIMAX SRT merge maps returned cues back to the original timeline and reports overflow', () => {
  const first = parseSrtEntries([
    '1',
    '00:00:00,000 --> 00:00:01,200',
    'One',
    '',
    '2',
    '00:00:01,200 --> 00:00:01,800',
    'Two',
  ].join('\n'));
  const second = parseSrtEntries([
    '1',
    '00:00:00,000 --> 00:00:00,800',
    'Three',
    '',
    '2',
    '00:00:00,800 --> 00:00:01,600',
    'Four',
  ].join('\n'));

  const merged = mergeBatchSrtEntries([
    {
      index: 0,
      entries: first,
      cueCount: 2,
      durationSeconds: 1.8,
      cues: [
        { id: 'row-1', position: 0, start: 10, end: 11, duration: 1, text: 'One' },
        { id: 'row-2', position: 1, start: 11.1, end: 11.9, duration: 0.8, text: 'Two' },
      ],
    },
    {
      index: 1,
      entries: second,
      cueCount: 2,
      durationSeconds: 1.6,
      cues: [
        { id: 'row-3', position: 2, start: 20, end: 21, duration: 1, text: 'Three' },
        { id: 'row-4', position: 3, start: 22, end: 23, duration: 1, text: 'Four' },
      ],
    },
  ]);

  assert.equal(merged.entries.length, 4);
  assert.equal(merged.entries[0].start, 10);
  assert.equal(merged.entries[0].end, 11);
  assert.equal(merged.entries[2].start, 20);
  assert.equal(merged.entries[3].end, 23);
  assert.equal(merged.report.failedSegmentCount, 0);
  assert.equal(merged.report.strictPass, true);
  assert.equal(merged.report.overflowSegmentCount, 1);
  assert.equal(merged.report.minorOverflowSegmentCount, 1);
  assert.equal(merged.report.majorOverflowSegmentCount, 0);
  assert.equal(merged.report.segments[0].endOverflowSeconds, 0.2);
  assert.equal(merged.report.segments[0].overlapNextSeconds, 0.1);
  assert.match(merged.srtContent, /3\n00:00:20,000 --> 00:00:21,000\nThree/);
});

test('AIMAX SRT report only flags overflow at one second or more as warning', () => {
  const merged = mergeBatchSrtEntries([
    {
      index: 0,
      cueCount: 1,
      cues: [
        { id: 'row-1', position: 0, start: 10, end: 11, duration: 1, text: 'Long translated cue' },
      ],
      segmentFiles: [
        { entryIndex: 0, fileName: 'line_001.mp3', audioPath: 'C:/tmp/line_001.mp3', durationSeconds: 2 },
      ],
    },
  ]);

  assert.equal(merged.report.failedSegmentCount, 1);
  assert.equal(merged.report.strictPass, false);
  assert.equal(merged.report.overflowSegmentCount, 1);
  assert.equal(merged.report.minorOverflowSegmentCount, 0);
  assert.equal(merged.report.majorOverflowSegmentCount, 1);
  assert.equal(merged.report.segments[0].endOverflowSeconds, 1);
});

test('AIMAX SRT report treats post-speed overflow below one second as minor', () => {
  const report = _private.buildAimaxTimelineReport([
    {
      id: 'row-1',
      index: 0,
      startDriftSeconds: 0,
      unplannedStartDriftSeconds: 0,
      durationDeltaSeconds: 0.31,
      endOverflowSeconds: 0.31,
      overlapNextSeconds: 0.31,
      speedFactor: 1.1,
      effectiveSpeedFactor: 1.1,
    },
  ]);

  assert.equal(report.failedSegmentCount, 0);
  assert.equal(report.strictPass, true);
  assert.equal(report.overflowSegmentCount, 1);
  assert.equal(report.overlapSegmentCount, 1);
  assert.equal(report.minorOverflowSegmentCount, 1);
  assert.equal(report.minorOverlapSegmentCount, 1);
  assert.equal(report.majorOverflowSegmentCount, 0);
  assert.equal(report.majorOverlapSegmentCount, 0);
});

test('AIMAX SRT merge maps segments_url line files directly to original cues', () => {
  const merged = mergeBatchSrtEntries([
    {
      index: 0,
      cueCount: 2,
      cues: [
        { id: 'row-1', position: 0, start: 10, end: 11, duration: 1, text: 'Original translated one' },
        { id: 'row-2', position: 1, start: 11, end: 12.5, duration: 1.5, text: 'Original translated two' },
      ],
      segmentFiles: [
        { entryIndex: 0, fileName: 'line_001.mp3', audioPath: 'C:/tmp/line_001.mp3', durationSeconds: 1.25 },
        { entryIndex: 1, fileName: 'line_002.mp3', audioPath: 'C:/tmp/line_002.mp3', durationSeconds: 1.4 },
      ],
    },
  ]);

  assert.equal(merged.entries.length, 2);
  assert.equal(merged.entries[0].start, 10);
  assert.equal(merged.entries[0].end, 11);
  assert.equal(merged.entries[0].text, 'Original translated one');
  assert.equal(merged.mappedItems[0].cueClipPath, 'C:/tmp/line_001.mp3');
  assert.equal(merged.mappedItems[0].sourceMode, 'segments_url');
  assert.equal(merged.report.overflowSegmentCount, 1);
  assert.equal(merged.report.minorOverflowSegmentCount, 1);
  assert.equal(merged.report.majorOverflowSegmentCount, 0);
  assert.equal(merged.report.failedSegmentCount, 0);
  assert.equal(merged.report.segments[0].aimaxSegmentFileName, 'line_001.mp3');
  assert.equal(merged.report.segments[0].endOverflowSeconds, 0.25);
});

test('AIMAX SRT sync report keeps line segment metadata after alignment', () => {
  const report = {
    segments: [
      { id: 'row-1', actualDurationSeconds: 1.25 },
    ],
  };
  const metadataReport = {
    segments: [
      {
        id: 'row-1',
        aimaxBatchIndex: 0,
        aimaxEntryIndex: 0,
        aimaxSourceMode: 'segments_url',
        aimaxSegmentFileName: 'line_001.mp3',
      },
    ],
  };

  const merged = _private.mergeAimaxReportSegmentMetadata(report, metadataReport);

  assert.equal(merged.segments[0].actualDurationSeconds, 1.25);
  assert.equal(merged.segments[0].aimaxBatchIndex, 0);
  assert.equal(merged.segments[0].aimaxEntryIndex, 0);
  assert.equal(merged.segments[0].aimaxSourceMode, 'segments_url');
  assert.equal(merged.segments[0].aimaxSegmentFileName, 'line_001.mp3');
});

test('AIMAX SRT cue normalization keeps one output line per cue', () => {
  const cues = normalizeCueSegments([
    { finalText: '  Hello\nworld  ' },
    { translatedText: '  Second   cue  ' },
    { text: '' },
  ]);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world');
  assert.equal(cues[1].text, 'Second cue');
});

test('AIMAX SRT normalization preserves display rows covered by a narration group', () => {
  const [group] = normalizeCueSegments([
    {
      id: 'tts-001',
      start: 0,
      end: 4.8,
      ttsText: 'First continuation second result',
      sourceIds: ['row-1', 'row-2'],
      sourceSegmentCount: 2,
    },
  ]);

  assert.deepEqual(group.sourceIds, ['row-1', 'row-2']);
  assert.deepEqual(group.sourceRowIds, ['row-1', 'row-2']);
  assert.equal(group.sourceSegmentCount, 2);
});
