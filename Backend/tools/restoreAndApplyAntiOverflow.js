const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createAlignedAudio } = require('../services/syncService');
const aimaxTtsService = require('../services/aimaxTtsService');
const { normalizeCueSegments, _private } = require('../services/aimaxSrtBatchService');
const { resolveMediaBinary } = require('../services/mediaBinaryService');

const execFileAsync = promisify(execFile);
const jobId = process.argv[2];
if (!jobId) throw new Error('Usage: node tools/restoreAndApplyAntiOverflow.js <jobId>');

const ORIGINAL_BATCHES = [
  { historyId: '1421409', cueCount: 70 },
  { historyId: '1421410', cueCount: 54 },
];

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

async function writeStatus(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function readAimaxKeyFromDesktopProfile() {
  const levelDbDir = path.join(process.env.LOCALAPPDATA || '', 'DubFlow', 'electron-profile', 'Local Storage', 'leveldb');
  const files = await fs.readdir(levelDbDir);
  for (const file of files) {
    if (!/\.(ldb|log)$/i.test(file)) continue;
    const content = await fs.readFile(path.join(levelDbDir, file), 'utf8').catch(() => '');
    const match = content.match(/ak_[A-Za-z0-9_-]{20,}/);
    if (match) return match[0];
  }
  throw new Error('AIMAX key is unavailable in the local desktop profile.');
}

async function main() {
  const root = path.join(process.cwd(), 'jobs', jobId, 'tts');
  const restoreDir = path.join(root, 'aimax_original_history_audio');
  const statePath = path.join(root, 'anti_overflow_apply.status.json');
  const translation = JSON.parse(await fs.readFile(path.join(process.cwd(), 'jobs', jobId, 'translations', 'translated.json'), 'utf8'));
  const cues = normalizeCueSegments(translation.segments);
  const aimaxApiKey = await readAimaxKeyFromDesktopProfile();
  if (cues.length !== 124) throw new Error(`Expected 124 project cues, got ${cues.length}.`);
  await fs.mkdir(restoreDir, { recursive: true });
  const clips = [];
  for (let batchIndex = 0; batchIndex < ORIGINAL_BATCHES.length; batchIndex += 1) {
    const batch = ORIGINAL_BATCHES[batchIndex];
    const stem = `batch_${String(batchIndex + 1).padStart(3, '0')}`;
    const zipPath = path.join(restoreDir, `${stem}_segments.zip`);
    const segmentDir = path.join(restoreDir, `${stem}_segments`);
    await writeStatus(statePath, { status: 'downloading_existing_history_audio', providerCalls: 0, textChanged: false, historyId: batch.historyId });
    await aimaxTtsService._private.downloadSegmentsZip(`https://www.aimaxstudio.com/api/v1/tts/history/${batch.historyId}/segments`, zipPath, { aimaxApiKey });
    const files = await _private.extractAimaxSegmentsZip(zipPath, segmentDir, { expectedCount: batch.cueCount, batchIndex });
    for (const file of files) {
      const index = clips.length;
      clips.push({ id: cues[index].id, index: cues[index].position, path: file.audioPath, provider: 'aimax_tts', speakingRate: 1.05, ttsSpeakingRate: 1.05, ttsSpeedAppliedByProvider: true, allowPostTtsSpeedProcessing: false, audioDurationSeconds: await audioDuration(file.audioPath) });
    }
  }
  if (clips.length !== cues.length) throw new Error('Original history audio count does not match project cues.');
  const baseOptions = { ttsProvider: 'aimax_tts', speakingRate: 1.05, syncMode: 'strict', addSilenceGaps: true, voiceAlignShortClips: false, stretchShortClips: false, failOnStrictSync: false, normalizeLoudness: false, outputSampleRate: 32000, timelineDurationSeconds: Math.max(...cues.map((cue) => cue.end)) };
  const baselinePath = path.join(root, 'anti_overflow_restored_baseline_105.wav');
  const outputPath = path.join(root, 'manual_dubbed_voice.wav');
  const reportPath = path.join(root, 'aimax_srt_batch_report.json');
  await writeStatus(statePath, { status: 'assembling_baseline_105', providerCalls: 0, textChanged: false });
  const baseline = await createAlignedAudio(cues, clips, baselinePath, { ...baseOptions, preserveTtsAudio: true, speedUpLongSegments: false, maxEffectiveSpeakingRate: 1.05 });
  const selected = new Set((baseline.report.segments || []).filter((item) => overflowSeconds(item) > 1).map((item) => String(item.id)));
  await writeStatus(statePath, { status: 'baseline_measured', providerCalls: 0, textChanged: false, selectedOverOneSecond: selected.size });
  const accelerated = clips.map((clip) => selected.has(String(clip.id)) ? { ...clip, allowPostTtsSpeedProcessing: true, forcePostTtsSpeedProcessing: true, postTtsSpeedFactor: Number((1.10 / 1.05).toFixed(6)) } : clip);
  const temporaryOutputPath = path.join(root, 'manual_dubbed_voice.anti_overflow_pending.wav');
  await writeStatus(statePath, { status: 'accelerating_selected_cues', providerCalls: 0, textChanged: false, selectedOverOneSecond: selected.size });
  const final = await createAlignedAudio(cues, accelerated, temporaryOutputPath, { ...baseOptions, preserveTtsAudio: false, speedUpLongSegments: true, maxEffectiveSpeakingRate: 1.10 });
  await fs.rename(temporaryOutputPath, outputPath);
  const remainingRed = (final.report.segments || []).filter((item) => overflowSeconds(item) >= 1).length;
  const acceleratedCueCount = (final.report.segments || []).filter((item) => Number(item.speedFactor) > 1.001).length;
  const report = { success: true, mode: 'aimax_srt_batches', cueCount: cues.length, outputAudioPath: outputPath, report: final.report, overflowSegmentCount: final.report.overflowSegmentCount, overlapSegmentCount: final.report.overlapSegmentCount, failedSegmentCount: final.report.failedSegmentCount, strictPass: final.report.strictPass, antiOverflow: { enabled: true, applied: selected.size > 0, baseSpeakingRate: 1.05, targetSpeakingRate: 1.10, speedFactor: Number((1.10 / 1.05).toFixed(6)), triggeredCueCount: selected.size, acceleratedCueCount, stillMajorOverflowCount: remainingRed, providerCalls: 0, textChanged: false }, batches: ORIGINAL_BATCHES.map((batch, index) => ({ index, jobId: `history-${batch.historyId}`, cueCount: batch.cueCount, outputMode: 'existing_history_segments' })) };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  const statusFilePath = path.join(process.cwd(), 'jobs', jobId, 'status.json');
  const jobStatus = JSON.parse(await fs.readFile(statusFilePath, 'utf8'));
  jobStatus.updatedAt = new Date().toISOString();
  jobStatus.status = 'completed';
  jobStatus.stage = 'voice';
  jobStatus.message = 'Manual TTS audio ready.';
  jobStatus.logs = [...(Array.isArray(jobStatus.logs) ? jobStatus.logs : []), { time: jobStatus.updatedAt, level: remainingRed ? 'warn' : 'success', message: `Anti-overflow applied from existing AIMAX history audio only: ${selected.size} cue(s) above 1s accelerated to 1.10x; ${remainingRed} cue(s) remain red.` }];
  await fs.writeFile(statusFilePath, JSON.stringify(jobStatus, null, 2), 'utf8');
  await writeStatus(statePath, { status: 'completed', ...report.antiOverflow, outputPath, reportPath });
  console.log(JSON.stringify(report.antiOverflow));
}

main().catch(async (error) => {
  const statePath = path.join(process.cwd(), 'jobs', jobId, 'tts', 'anti_overflow_apply.status.json');
  await writeStatus(statePath, { status: 'failed', providerCalls: 0, textChanged: false, error: error.message }).catch(() => {});
  throw error;
});
