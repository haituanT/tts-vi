const { execFile } = require('child_process');
const { promisify } = require('util');
const { canRunPython, resolvePythonExecutable } = require('./pythonRuntimeService');

const execFileAsync = promisify(execFile);

async function canRun(command, args) {
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function checkFfmpeg() {
  return canRun('ffmpeg', ['-version']);
}

async function checkYtDlp() {
  return canRun('yt-dlp', ['--version']);
}

async function checkPython() {
  return canRunPython(resolvePythonExecutable());
}

async function checkTkinter() {
  try {
    await execFileAsync(
      resolvePythonExecutable(),
      ['-c', 'import tkinter; print("ok")'],
      { windowsHide: true, timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function checkFasterWhisper() {
  try {
    await execFileAsync(
      resolvePythonExecutable(),
      ['-c', 'import faster_whisper; print("ok")'],
      { windowsHide: true, timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function checkNodeDependencies() {
  return true;
}

module.exports = {
  checkFasterWhisper,
  checkFfmpeg,
  checkNodeDependencies,
  checkPython,
  checkTkinter,
  checkYtDlp,
};
