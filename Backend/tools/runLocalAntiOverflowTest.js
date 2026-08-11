const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createAlignedAudio } = require('../services/syncService');
const { normalizeCueSegments } = require('../services/aimaxSrtBatchService');
const { resolveMediaBinary } = require('../services/mediaBinaryService');

const execFileAsync = promisify(execFile);
const jobId = process.argv[2];
if (!jobId) throw new Error('Usage: node tools/runLocalAntiOverflowTest.js <jobId>');

function overflowSeconds(item = {}) {
  return Math.max(0, Number(item.endOverflowSeconds) || 0, Number(item.overlapNextSeconds) || 0,
    Number(item.cueEndOverflowSeconds) || 0, Number(item.overflowAfterFitSeconds) || 0);
}

async function audioDuration(filePath) {
  const { stdout } = await execFileAsync(resolveMediaBinary('ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}

async function main() {
  const root = path.join(process.cwd(), 'jobs', jobId, 'tts');
  const workDir = path.join(root, 'aimax_srt_batches');
  const statusPath = path.join(root, 'anti_overflow_test_110.status.json');
  const translation = JSON.parse(await fs.readFile(path.join(process.cwd(), 'jobs', jobId, 'translations', 'translated.json'), 'utf8'));
  const cues = normalizeCueSegments(translation.segments);
  const clips = [];
  for (const [batchIndex, expectedCount] of [[0, 70], [1, 54]]) {
    const dir = path.join(workDir, `batch_${String(batchIndex + 1).padStart(3, '0')}_segments`);
    const files = (await fs.readdir(dir))
      .filter((name) => /^line_\d+\.(mp3|wav|m4a|aac|ogg)$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (files.length !== expectedCount) throw new Error(`Batch ${batchIndex + 1} is missing local cue audio.`);
    for (const name of files) {
      const index = clips.length;
      const clipPath = path.join(dir, name);
      clips.push({ id: cues[index].id, index: cues[index].position, path: clipPath, provider: 'aimax_tts', speakingRate: 1.05, ttsSpeakingRate: 1.05, ttsSpeedAppliedByProvider: true, allowPostTtsSpeedProcessing: false, audioDurationSeconds: await audioDuration(clipPath) });
    }
  }
  if (clips.length !== cues.length) throw new Error('Cue/audio count mismatch.');
  const baseOptions = { ttsProvider: 'aimax_tts', speakingRate: 1.05, syncMode: 'strict', addSilenceGaps: true, voiceAlignShortClips: false, stretchShortClips: false, failOnStrictSync: false, normalizeLoudness: false, outputSampleRate: 32000, timelineDurationSeconds: Math.max(...cues.map((cue) => cue.end)) };
  const baselinePath = path.join(root, 'anti_overflow_test_baseline_105.wav');
  const resultPath = path.join(root, 'anti_overflow_test_110.wav');
  await fs.writeFile(statusPath, JSON.stringify({ status: 'assembling_baseline', providerCalls: 0, textChanged: false }, null, 2));
  const baseline = await createAlignedAudio(cues, clips, baselinePath, { ...baseOptions, preserveTtsAudio: true, speedUpLongSegments: false, maxEffectiveSpeakingRate: 1.05 });
  const selected = new Set((baseline.report.segments || []).filter((item) => overflowSeconds(item) > 1).map((item) => String(item.id)));
  await fs.writeFile(statusPath, JSON.stringify({ status: 'accelerating_selected_cues', providerCalls: 0, textChanged: false, selectedOverOneSecond: selected.size }, null, 2));
  const accelerated = clips.map((clip) => selected.has(String(clip.id)) ? { ...clip, allowPostTtsSpeedProcessing: true, forcePostTtsSpeedProcessing: true, postTtsSpeedFactor: Number((1.10 / 1.05).toFixed(6)) } : clip);
  const final = await createAlignedAudio(cues, accelerated, resultPath, { ...baseOptions, preserveTtsAudio: false, speedUpLongSegments: true, maxEffectiveSpeakingRate: 1.10 });
  const finalMajor = (final.report.segments || []).filter((item) => overflowSeconds(item) >= 1);
  const sped = (final.report.segments || []).filter((item) => Number(item.speedFactor) > 1.001);
  const report = { status: 'completed', mode: 'local_audio_only', providerCalls: 0, textChanged: false, baseRate: 1.05, antiOverflowTarget: 1.10, atempoFactor: Number((1.10 / 1.05).toFixed(6)), cueCount: cues.length, selectedOverOneSecond: selected.size, acceleratedCueCount: sped.length, remainingRedAtOrAboveOneSecond: finalMajor.length, baselineReport: baseline.report, finalReport: final.report, baselinePath, resultPath };
  await fs.writeFile(path.join(root, 'anti_overflow_test_110.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(statusPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

main().catch(async (error) => {
  const root = path.join(process.cwd(), 'jobs', jobId, 'tts');
  await fs.writeFile(path.join(root, 'anti_overflow_test_110.status.json'), JSON.stringify({ status: 'failed', providerCalls: 0, textChanged: false, error: error.message }, null, 2)).catch(() => {});
  throw error;
});
