function optionalModulePath(load) {
  try {
    const value = load();
    return typeof value === 'string' ? value : String(value?.path || '');
  } catch {
    return '';
  }
}

function resolveMediaBinary(command = '') {
  const name = String(command || '').trim().toLowerCase();
  if (name === 'ffmpeg') {
    return String(process.env.DUBFLOW_FFMPEG_PATH || '').trim()
      || optionalModulePath(() => require('ffmpeg-static'))
      || 'ffmpeg';
  }
  if (name === 'ffprobe') {
    return String(process.env.DUBFLOW_FFPROBE_PATH || '').trim()
      || optionalModulePath(() => require('ffprobe-static'))
      || 'ffprobe';
  }
  return command;
}

module.exports = { resolveMediaBinary };
