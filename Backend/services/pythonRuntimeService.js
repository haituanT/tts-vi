const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PYTHON_PROBE_TIMEOUT_MS = 10000;

function existingFile(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function candidatePythonExecutables() {
  const configured = String(process.env.DUBFLOW_PYTHON || '').trim();
  const bundled = path.resolve(__dirname, '..', '..', 'python_embed', 'python.exe');
  return [
    configured,
    'python',
    'python3',
    bundled,
  ].filter(Boolean);
}

function canRunPython(command) {
  if (/[\\/]/.test(command) && !existingFile(command)) return false;
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: PYTHON_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return false;
  const output = `${result.stdout || ''} ${result.stderr || ''}`;
  return /\bPython\s+\d+\.\d+/i.test(output);
}

function resolvePythonExecutable() {
  const candidates = candidatePythonExecutables();
  for (const candidate of candidates) {
    if (canRunPython(candidate)) return candidate;
  }
  const bundled = candidates[candidates.length - 1] || 'python';
  return bundled;
}

function pythonRuntimeStatus() {
  return candidatePythonExecutables().map((command) => ({
    command,
    available: canRunPython(command),
  }));
}

module.exports = {
  canRunPython,
  candidatePythonExecutables,
  pythonRuntimeStatus,
  resolvePythonExecutable,
};
