const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..', '..');
const frontendDir = path.resolve(__dirname, '..');
const backendDir = path.resolve(rootDir, 'Backend');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cmdExe = process.env.ComSpec || 'cmd.exe';
const electronPath = require('electron');
const nextBin = path.resolve(frontendDir, 'node_modules', 'next', 'dist', 'bin', 'next');
const appPort = String(process.env.DUBFLOW_APP_PORT || '3173');
const appUrl = process.env.DUBFLOW_APP_URL || `http://127.0.0.1:${appPort}`;
const backendPort = Number(process.env.PORT || '3001');
const backendUrl = (process.env.DUBFLOW_BACKEND_URL || `http://127.0.0.1:${backendPort}`).replace(/\/$/, '');
const backendHealthUrl = `${backendUrl}/api/health`;
const autoReloadEnabled = String(process.env.DUBFLOW_AUTO_RELOAD || '').trim().toLowerCase() === 'true';
const desktopOnlyEnabled = String(process.env.DUBFLOW_DESKTOP_ONLY || 'true').trim().toLowerCase() !== 'false';
const desktopToken = process.env.DUBFLOW_DESKTOP_TOKEN || getStableDesktopToken();
const defaultUserDataDir = process.env.LOCALAPPDATA
  ? path.resolve(process.env.LOCALAPPDATA, 'DubFlow', 'electron-profile')
  : path.resolve(frontendDir, '.dubflow', 'electron-profile');
const userDataDir = process.env.DUBFLOW_USER_DATA_DIR || defaultUserDataDir;
const desiredFasterWhisperDevice = process.env.FASTER_WHISPER_DEVICE || 'cuda';
const desiredFasterWhisperComputeType = process.env.FASTER_WHISPER_COMPUTE_TYPE || 'int8';
const localFfmpegBin = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.resolve(process.env.LOCALAPPDATA, 'Programs', 'DubFlow', 'ffmpeg', 'bin')
  : '';
const projectToolBins = [
  path.resolve(rootDir, 'tools', 'ffmpeg', 'dist', 'bin'),
  path.resolve(rootDir, 'tools', 'yt-dlp'),
  path.resolve(rootDir, 'python_embed'),
  path.resolve(rootDir, 'python_embed', 'Scripts'),
  path.resolve(rootDir, 'Clone'),
];

function getStableDesktopToken() {
  const tokenDir = process.env.LOCALAPPDATA
    ? path.resolve(process.env.LOCALAPPDATA, 'DubFlow')
    : path.resolve(frontendDir, '.dubflow');
  const tokenPath = path.resolve(tokenDir, 'desktop-token');

  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) return existing;
    }

    fs.mkdirSync(tokenDir, { recursive: true });
    const token = crypto.randomUUID();
    fs.writeFileSync(tokenPath, token, { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch {
    return crypto.randomUUID();
  }
}

function withLocalToolPaths(env = process.env) {
  const currentPath = env.Path || env.PATH || '';
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  const extraBins = [
    ...(localFfmpegBin && fs.existsSync(path.join(localFfmpegBin, 'ffmpeg.exe')) ? [localFfmpegBin] : []),
    ...projectToolBins.filter((toolPath) => fs.existsSync(toolPath)),
  ];
  const missingBins = extraBins.filter((toolPath) => {
    const normalizedToolPath = toolPath.trim().replace(/[\\/]$/, '').toLowerCase();
    return !parts.some((item) => item.trim().replace(/[\\/]$/, '').toLowerCase() === normalizedToolPath);
  });
  if (missingBins.length) {
    const nextPath = [...missingBins, ...parts].join(path.delimiter);
    return { ...env, Path: nextPath, PATH: nextPath };
  }
  return env;
}

process.env = withLocalToolPaths(process.env);

const children = new Set();
let shuttingDown = false;
let backendChild = null;
let frontendChild = null;
let electronChild = null;
let sourceReloadTimer = null;
let sourceReloadInProgress = false;
let sourceReloadQueued = false;
const sourceWatchers = [];

function spawnManaged(command, args, options) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function runNpmSync(args, options = {}) {
  if (process.platform !== 'win32') {
    return spawnSync(npmCmd, args, options);
  }

  return spawnSync(cmdExe, ['/d', '/s', '/c', npmCmd, ...args], options);
}

function ensureFrontendBuild() {
  const buildIdPath = path.resolve(frontendDir, '.next', 'BUILD_ID');
  if (fs.existsSync(buildIdPath) && !isFrontendSourceNewerThan(buildIdPath)) {
    return;
  }

  console.log('Building DubFlow frontend for local app mode ...');
  const result = runNpmSync(['run', 'build'], {
    cwd: frontendDir,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    if (result.error) {
      console.error(result.error);
    }
    throw new Error('Frontend build failed. Fix the build error above, then run the app again.');
  }
}

function isFrontendSourceNewerThan(buildIdPath) {
  if (!fs.existsSync(buildIdPath)) return true;
  const buildMtime = fs.statSync(buildIdPath).mtimeMs;
  const sourceRoots = [
    path.resolve(frontendDir, 'app'),
    path.resolve(frontendDir, 'components'),
    path.resolve(frontendDir, 'electron'),
  ];
  const sourceFiles = [
    path.resolve(frontendDir, 'package.json'),
    path.resolve(frontendDir, 'next.config.js'),
    path.resolve(frontendDir, 'tailwind.config.js'),
  ];

  function visit(targetPath) {
    if (!fs.existsSync(targetPath)) return false;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      return stat.mtimeMs > buildMtime;
    }
    if (!stat.isDirectory()) return false;
    return fs.readdirSync(targetPath).some((name) => visit(path.join(targetPath, name)));
  }

  return sourceFiles.some(visit) || sourceRoots.some(visit);
}

function waitForHttp(url, timeoutMs = 90000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(check, 700);
      });

      request.setTimeout(30000, () => {
        request.destroy();
      });
    };

    check();
  });
}

function isHttpReady(url, token = '') {
  return new Promise((resolve) => {
    const request = http.get(url, {
      headers: token ? { 'x-dubflow-desktop-token': token } : {},
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });

    request.on('error', () => resolve(false));
    request.setTimeout(30000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function fetchStatus(url, token = '') {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (statusCode) => {
      if (settled) return;
      settled = true;
      resolve(statusCode);
    };

    const request = http.get(url, {
      headers: token ? { 'x-dubflow-desktop-token': token } : {},
    }, (response) => {
      response.resume();
      settle(response.statusCode || 0);
    });

    request.on('error', () => settle(0));
    request.setTimeout(5000, () => {
      request.destroy();
      settle(0);
    });
  });
}

function fetchJson(url) {
  return fetchText(url).then((text) => JSON.parse(text));
}

function getListeningPid(port) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('netstat', ['-ano'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;

  const lines = String(result.stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const localAddress = columns[1] || '';
    const state = columns[3] || '';
    const pid = Number(columns[4]);
    if (localAddress.endsWith(`:${port}`) && state === 'LISTENING' && Number.isInteger(pid)) {
      return pid;
    }
  }
  return null;
}

function stopListeningProcess(port, label = 'process') {
  const pid = getListeningPid(port);
  if (!pid) return false;
  console.log(`Stopping stale ${label} process ${pid} on port ${port} ...`);
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'inherit' });
  return true;
}

function getDubFlowElectronPids() {
  if (process.platform !== 'win32') return [];
  const mainPath = path.resolve(__dirname, 'main.js').toLowerCase();
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Select-Object -ExpandProperty ProcessId",
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return [];

  const allElectronPids = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  return allElectronPids.filter((pid) => {
    const detail = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commandLine = String(detail.stdout || '').trim().toLowerCase();
    return commandLine.includes(mainPath);
  });
}

function stopDubFlowElectronProcesses() {
  const pids = getDubFlowElectronPids();
  for (const pid of pids) {
    console.log(`Stopping stale DubFlow desktop window process ${pid} ...`);
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'inherit' });
  }
  return pids.length > 0;
}

function isBackendRuntimeCurrent(health) {
  const runtime = health?.fasterWhisperRuntime || {};
  return runtime.device === desiredFasterWhisperDevice
    && runtime.computeType === desiredFasterWhisperComputeType;
}

async function waitForNextUiReady(baseUrl, token, timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const html = await fetchText(baseUrl, token);
      const cssHref = html.match(/href="([^"]*\/_next\/static\/css\/[^"]+)"/)?.[1];

      if (cssHref) {
        const cssUrl = new URL(cssHref.replace(/&amp;/g, '&'), baseUrl).toString();
        await fetchText(cssUrl, token);
        return;
      }

      if (html.includes('/_next/static/')) {
        return;
      }
    } catch {
      // Wait and retry while Next.js compiles the first route.
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  throw new Error(`Timed out waiting for styled Next.js UI at ${baseUrl}`);
}

function fetchText(url, token = '') {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: token ? { 'x-dubflow-desktop-token': token } : {},
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
    });

    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error(`Timed out fetching ${url}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startBackend() {
  console.log('Starting DubFlow backend service ...');
  backendChild = spawnManaged(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: withLocalToolPaths({
      ...process.env,
      PORT: process.env.PORT || String(backendPort),
      LOCAL_FILE_PICKER_ENABLED: process.env.LOCAL_FILE_PICKER_ENABLED || 'true',
      FASTER_WHISPER_DEVICE: desiredFasterWhisperDevice,
      FASTER_WHISPER_COMPUTE_TYPE: desiredFasterWhisperComputeType,
    }),
  });
  backendChild.on('exit', (code) => {
    if (shuttingDown || backendChild === null) return;
    console.error(`DubFlow backend exited unexpectedly with code ${code ?? 'unknown'}.`);
    shutdown(code || 1);
  });
  return backendChild;
}

function startFrontendServer() {
  console.log('Starting DubFlow desktop UI service ...');
  frontendChild = spawnManaged(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', appPort], {
    cwd: frontendDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DUBFLOW_DESKTOP_ONLY: desktopOnlyEnabled ? 'true' : 'false',
      DUBFLOW_DESKTOP_TOKEN: desktopToken,
    },
  });
  frontendChild.stdout?.resume();
  frontendChild.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  frontendChild.on('exit', (code) => {
    if (shuttingDown || frontendChild === null) return;
    console.error(`DubFlow desktop UI server exited unexpectedly with code ${code ?? 'unknown'}.`);
    shutdown(code || 1);
  });
  return frontendChild;
}

function killChildTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

function openElectronWindow() {
  console.log('Opening DubFlow Local Studio ...');
  const previousElectron = electronChild;
  electronChild = null;
  killChildTree(previousElectron);
  stopDubFlowElectronProcesses();

  const electronMain = path.resolve(__dirname, 'main.js');
  const child = spawnManaged(electronPath, [electronMain], {
    cwd: frontendDir,
    env: {
      ...process.env,
      DUBFLOW_APP_URL: appUrl,
      DUBFLOW_DESKTOP_TOKEN: desktopToken,
      DUBFLOW_USER_DATA_DIR: userDataDir,
    },
  });

  electronChild = child;
  child.on('exit', (code) => {
    if (child !== electronChild) return;
    shutdown(code || 0);
  });
  return child;
}

async function ensureBackendServiceStarted() {
  if (await isHttpReady(backendUrl)) {
    console.log('DubFlow backend service is already running.');
    return;
  }

  if (getListeningPid(backendPort)) {
    console.log('DubFlow backend port is occupied but not responding; restarting local backend service ...');
    stopListeningProcess(backendPort, 'backend');
  }

  startBackend();
}

async function reportBackendReadiness() {
  try {
    await waitForHttp(backendUrl, 60000);
    const health = await fetchJson(backendHealthUrl).catch((error) => {
      console.warn(`DubFlow backend health check is slow or unavailable: ${error.message}`);
      return null;
    });

    if (!health) return;

    if (health.dependencies?.ffmpeg === false) {
      console.warn('DubFlow backend cannot see FFmpeg. Video export will fail until FFmpeg is available.');
    }

    if (!isBackendRuntimeCurrent(health)) {
      const runtime = health.fasterWhisperRuntime || {};
      console.warn(
        `DubFlow backend is using Faster Whisper ${runtime.device || 'unknown'}/${runtime.computeType || 'unknown'}; expected ${desiredFasterWhisperDevice}/${desiredFasterWhisperComputeType}.`
      );
    }

    console.log('DubFlow backend service is ready.');
  } catch (error) {
    console.warn(`DubFlow backend service did not become ready: ${error.message}`);
  }
}

function shouldIgnoreSourceEvent(filename = '') {
  const normalized = String(filename || '').replace(/\\/g, '/').toLowerCase();
  return !normalized
    || normalized.includes('/.next/')
    || normalized.includes('/node_modules/')
    || normalized.includes('/.git/')
    || normalized.endsWith('.log')
    || normalized.endsWith('.tmp');
}

function scheduleSourceReload(filename) {
  if (shuttingDown || shouldIgnoreSourceEvent(filename)) return;
  clearTimeout(sourceReloadTimer);
  sourceReloadTimer = setTimeout(() => {
    reloadFromSourceChange().catch((error) => {
      console.error('DubFlow auto-update failed:', error);
    });
  }, 1800);
}

function watchSourceChanges() {
  if (!autoReloadEnabled) {
    console.log('DubFlow source auto-reload is off. Set DUBFLOW_AUTO_RELOAD=true to enable it.');
    return;
  }

  const watchTargets = [
    path.resolve(frontendDir, 'app'),
    path.resolve(frontendDir, 'components'),
    path.resolve(frontendDir, 'electron'),
    path.resolve(frontendDir, 'package.json'),
    path.resolve(frontendDir, 'next.config.js'),
    path.resolve(backendDir, 'server.js'),
    path.resolve(backendDir, 'services'),
    path.resolve(backendDir, 'domain'),
    path.resolve(backendDir, 'helpers'),
  ].filter((targetPath) => fs.existsSync(targetPath));

  for (const targetPath of watchTargets) {
    try {
      const stat = fs.statSync(targetPath);
      const watcher = fs.watch(
        targetPath,
        { recursive: stat.isDirectory() && process.platform === 'win32' },
        (_eventType, filename) => scheduleSourceReload(path.join(targetPath, filename || ''))
      );
      watcher.on('error', () => {});
      sourceWatchers.push(watcher);
    } catch (error) {
      console.warn(`Could not watch ${targetPath}: ${error.message}`);
    }
  }
}

async function reloadFromSourceChange() {
  if (sourceReloadInProgress) {
    sourceReloadQueued = true;
    return;
  }

  sourceReloadInProgress = true;
  try {
    do {
      sourceReloadQueued = false;
      console.log('DubFlow source changed; rebuilding and refreshing the app ...');
      ensureFrontendBuild();

      stopListeningProcess(Number(appPort), 'desktop UI');
      const oldFrontendChild = frontendChild;
      frontendChild = null;
      killChildTree(oldFrontendChild);
      startFrontendServer();

      stopListeningProcess(backendPort, 'backend');
      const oldBackendChild = backendChild;
      backendChild = null;
      killChildTree(oldBackendChild);
      startBackend();

      await waitForHttp(backendUrl);
      await waitForNextUiReady(appUrl, desktopToken);
      await delay(800);
      openElectronWindow();
    } while (sourceReloadQueued && !shuttingDown);
  } finally {
    sourceReloadInProgress = false;
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const watcher of sourceWatchers) {
    try {
      watcher.close();
    } catch {
      // Ignore watcher shutdown errors.
    }
  }

  for (const child of children) {
    if (!child.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    }
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
});

async function main() {
  await ensureBackendServiceStarted();

  let frontendReady = await isHttpReady(appUrl, desktopToken);
  const frontendBuildIdPath = path.resolve(frontendDir, '.next', 'BUILD_ID');

  if (frontendReady && isFrontendSourceNewerThan(frontendBuildIdPath)) {
    console.log('DubFlow desktop UI service is stale; rebuilding before restart ...');
    ensureFrontendBuild();
    console.log('Restarting DubFlow desktop UI service with the latest frontend build ...');
    stopListeningProcess(Number(appPort), 'desktop UI');
    frontendReady = false;
  }

  if (frontendReady && desktopOnlyEnabled) {
    const publicStatus = await fetchStatus(appUrl);
    if (publicStatus >= 200 && publicStatus < 300) {
      console.log('DubFlow desktop UI service is still accepting browser access; restarting in desktop-only mode ...');
      stopListeningProcess(Number(appPort), 'desktop UI');
      frontendReady = false;
    }
  }

  if (!frontendReady && getListeningPid(Number(appPort))) {
    console.log('DubFlow desktop UI service is not accessible with the current desktop session; restarting it ...');
    stopListeningProcess(Number(appPort), 'desktop UI');
  }

  if (frontendReady) {
    console.log('DubFlow desktop UI service is already running.');
  } else {
    ensureFrontendBuild();
    startFrontendServer();
  }

  await waitForNextUiReady(appUrl, desktopToken);
  console.log('DubFlow desktop UI service is ready.');
  openElectronWindow();
  reportBackendReadiness();
  watchSourceChanges();
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
