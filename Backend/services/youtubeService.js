const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function probeVideoStream(videoPath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', videoPath],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout || '{}');
    return parsed.streams?.[0] || {};
  } catch {
    return {};
  }
}

async function probeAudioStream(videoPath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', videoPath],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout || '{}');
    return parsed.streams?.[0] || {};
  } catch {
    return {};
  }
}

function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/;
  const match = String(url || '').match(regex);
  return match ? match[1] : null;
}

async function assertTool(command, installMessage, versionArgs = ['--version']) {
  try {
    await execFileAsync(command, versionArgs, { windowsHide: true });
  } catch {
    throw new Error(installMessage);
  }
}

async function downloadVideo(url, outputPath) {
  await assertTool('yt-dlp', 'yt-dlp is missing or not available in PATH. Install yt-dlp and restart the backend.');

  try {
    await execFileAsync(
      'yt-dlp',
      ['-f', 'best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', outputPath, url],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );
    await fs.access(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`YouTube download failed: ${error.stderr || error.message}`);
  }
}

async function extractAudio(videoPath, audioPath) {
  await assertTool('ffmpeg', 'FFmpeg is missing or not available in PATH. Install FFmpeg and restart the backend.', ['-version']);

  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );
    await fs.access(audioPath);
    return audioPath;
  } catch (error) {
    throw new Error(`FFmpeg audio extraction failed: ${error.stderr || error.message}`);
  }
}

async function createPreviewVideo(videoPath, previewPath) {
  await assertTool('ffmpeg', 'FFmpeg is missing or not available in PATH. Install FFmpeg and restart the backend.', ['-version']);

  try {
    const stream = await probeVideoStream(videoPath);
    const audioStream = await probeAudioStream(videoPath);
    const isBrowserMp4Video = String(stream.codec_name || '').toLowerCase() === 'h264'
      && String(stream.pix_fmt || '').toLowerCase() === 'yuv420p';
    const audioCodec = String(audioStream.codec_name || '').toLowerCase();
    const canCopyAudio = !audioCodec || ['aac', 'mp3'].includes(audioCodec);

    if (isBrowserMp4Video) {
      const codecArgs = canCopyAudio
        ? ['-c', 'copy']
        : ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'];

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i', videoPath,
          '-map', '0:v:0',
          '-map', '0:a?',
          '-sn',
          '-dn',
          ...codecArgs,
          '-movflags', '+faststart',
          previewPath,
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 * 40 }
      );
      await fs.access(previewPath);
      return previewPath;
    }

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', videoPath,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-sn',
        '-dn',
        '-vf', 'scale=w=min(1280\\,iw):h=-2,setsar=1',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '28',
        '-profile:v', 'high',
        '-level:v', '4.1',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '128k',
        previewPath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 40 }
    );
    await fs.access(previewPath);
    return previewPath;
  } catch (error) {
    throw new Error(`FFmpeg preview transcode failed: ${error.stderr || error.message}`);
  }
}

module.exports = {
  extractVideoId,
  downloadVideo,
  extractAudio,
  createPreviewVideo,
};
