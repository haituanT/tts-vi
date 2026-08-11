const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const pty = require('node-pty');
const { TextDecoder } = require('util');
const { resolvePythonExecutable } = require('./pythonRuntimeService');

const CLI_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_PROMPT_BYTES = 200 * 1024;
const LONG_PROMPT_BYTES = 24 * 1024;
const MAX_ANTIGRAVITY_PROMPT_CHARS = 24000;
const ANTIGRAVITY_FALLBACK_ENCODINGS = ['windows-1258', 'windows-1252'];
const CLI_PROVIDERS = new Set(['codex_cli', 'antigravity_cli']);
const resolvedCommands = new Map();
const availabilityCache = new Map();

function isCliTranslationProvider(provider) {
  return CLI_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

function cliProviderCommand(provider) {
  switch (String(provider || '').trim().toLowerCase()) {
    case 'codex_cli':
      return 'codex';
    case 'antigravity_cli':
      return 'agy';
    default:
      return '';
  }
}

function ensurePromptSize(text) {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8');
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(`CLI translation prompt exceeds ${Math.round(MAX_PROMPT_BYTES / 1024)}KB limit.`);
  }
}

function existingFile(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function findWinGetPackageExe(packagePrefix, exeName) {
  if (process.platform !== 'win32') return '';
  const localAppData = String(process.env.LOCALAPPDATA || '').trim();
  if (!localAppData) return '';
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(packagePrefix)) continue;
      const candidate = path.join(packagesDir, entry.name, exeName);
      if (existingFile(candidate)) return candidate;
    }
  } catch {
    // WinGet package cache is optional.
  }
  return '';
}

function getWindowsWhereMatches(command) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveCliCommand(command) {
  if (resolvedCommands.has(command)) {
    return resolvedCommands.get(command);
  }

  let resolved = null;
  if (process.platform === 'win32') {
    if (command === 'codex') {
      const configuredPath = String(process.env.DUBFLOW_CODEX_CLI_PATH || '').trim();
      const userProfile = String(process.env.USERPROFILE || process.env.HOME || '').trim();
      const localAppData = String(process.env.LOCALAPPDATA || '').trim();
      const candidates = [
        configuredPath,
        userProfile ? path.join(userProfile, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe') : '',
        localAppData ? path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
      ];
      const codexExe = candidates.find((item) => existingFile(item));
      if (codexExe) {
        resolved = { command: codexExe, prefixArgs: [] };
      }
    }

    const matches = getWindowsWhereMatches(command);
    if (!resolved) {
      const cmd = matches.find((item) => /\.cmd$/i.test(item) && existingFile(item));
      if (cmd) {
        resolved = { command: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'call', cmd] };
      }
    }

    if (!resolved) {
      const exe = matches.find((item) => /\.exe$/i.test(item) && existingFile(item));
      if (exe) {
        resolved = { command: exe, prefixArgs: [] };
      }
    }

    if (!resolved && command === 'agy') {
      const localAppData = String(process.env.LOCALAPPDATA || '').trim();
      const candidates = [
        localAppData ? path.join(localAppData, 'agy', 'bin', 'agy.exe') : '',
        findWinGetPackageExe('Google.AntigravityCLI_', 'agy.exe'),
      ];
      const agyExe = candidates.find((item) => existingFile(item));
      if (agyExe) {
        resolved = { command: agyExe, prefixArgs: [] };
      }
    }
  }

  if (!resolved) {
    resolved = { command, prefixArgs: [] };
  }

  resolvedCommands.set(command, resolved);
  return resolved;
}

function runProcess(commandSpec, args, {
  input = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = process.cwd(),
  env = process.env,
  fallbackEncodings = [],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.command, [...commandSpec.prefixArgs, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    const stdout = createUtf8StreamCollector(fallbackEncodings);
    const stderr = createUtf8StreamCollector(fallbackEncodings);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new Error(`CLI timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.write(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.end(), stderr: stderr.end() });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function runPtyProcess(commandSpec, args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = process.cwd(),
} = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let term;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (term) term.kill();
      } catch {
        // Process is already gone.
      }
      if (output.trim()) {
        resolve({ code: 0, stdout: output, stderr: 'PTY process timed out after producing output.' });
      } else {
        reject(new Error(`CLI timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);

    try {
      term = pty.spawn(commandSpec.command, [...commandSpec.prefixArgs, ...args], {
        name: 'xterm-color',
        cols: 160,
        rows: 40,
        cwd,
        env: process.env,
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }

    term.onData((chunk) => {
      output += chunk;
    });
    term.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: exitCode, stdout: output, stderr: '' });
    });
  });
}

async function probeCli(command) {
  if (availabilityCache.has(command)) {
    return availabilityCache.get(command);
  }

  const spec = resolveCliCommand(command);
  try {
    const result = await runProcess(spec, ['--version'], { timeoutMs: CLI_PROBE_TIMEOUT_MS });
    const available = result.code === 0;
    availabilityCache.set(command, available);
    return available;
  } catch {
    availabilityCache.set(command, false);
    return false;
  }
}

async function getCliTranslationProviderStatus(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!isCliTranslationProvider(normalized)) {
    throw new Error(`Unknown CLI translation provider: ${provider}`);
  }

  const command = cliProviderCommand(normalized);
  const spec = resolveCliCommand(command);
  const available = await probeCli(command);
  let version = '';
  if (available) {
    try {
      const result = await runProcess(spec, ['--version'], { timeoutMs: CLI_PROBE_TIMEOUT_MS });
      version = truncate(result.stdout || result.stderr || '', 200);
    } catch {
      version = '';
    }
  }

  return {
    provider: normalized,
    command,
    commandPath: spec.prefixArgs.length ? spec.prefixArgs[spec.prefixArgs.length - 1] : spec.command,
    available,
    version,
  };
}

function truncate(text, max = 400) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCliModel(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  if (value.length > 120) {
    throw new Error('CLI translation model name is too long.');
  }
  if (/[\r\n]/.test(value)) {
    throw new Error('CLI translation model name must be one line.');
  }
  return value;
}

function decodeProcessOutput(bytes, fallbackEncodings = []) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    for (const encoding of fallbackEncodings) {
      try {
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(buffer);
        if (!decoded.includes('\uFFFD')) return decoded;
      } catch {
        // Try the next configured Windows code page.
      }
    }
    return buffer.toString('utf8');
  }
}

function createUtf8StreamCollector(fallbackEncodings = []) {
  const chunks = [];
  return {
    write(chunk) {
      if (chunk && chunk.length) chunks.push(Buffer.from(chunk));
    },
    end() {
      return decodeProcessOutput(Buffer.concat(chunks), fallbackEncodings);
    },
  };
}

function killProcessTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/f', '/t', '/pid', String(child.pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    child.kill();
  } catch {
    // The process may have exited between the timeout and cleanup.
  }
}

function normalizeTerminalCarriageReturns(text) {
  const output = [];
  let line = '';
  const value = String(text || '');

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\r') {
      if (value[index + 1] === '\n') {
        continue;
      }
      line = '';
      continue;
    }
    if (char === '\n') {
      output.push(line);
      line = '';
      continue;
    }
    line += char;
  }

  if (line) output.push(line);
  return output.join('\n');
}

function keepLatestTerminalScreen(text) {
  const value = String(text || '');
  const homePattern = /\x1b\[H/g;
  let lastHome = null;
  let match;
  while ((match = homePattern.exec(value)) !== null) {
    lastHome = match.index + match[0].length;
  }
  return lastHome === null ? value : value.slice(lastHome);
}

function stripTerminalControls(text) {
  const cleaned = keepLatestTerminalScreen(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[([0-9]*)C/g, (_, count) => ' '.repeat(Math.max(1, Number(count) || 1)))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[=>]/g, '')
    .trim();
  return normalizeTerminalCarriageReturns(cleaned).trim();
}

function repairMojibake(text) {
  const value = String(text || '');
  if (!/[ÃÂÄÅáºá»]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    return /[\u00c0-\u1ef9]/.test(repaired) ? repaired : value;
  } catch {
    return value;
  }
}

function parseCodexOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('Codex CLI returned empty output.');
  }

  const jsonLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  for (let index = jsonLines.length - 1; index >= 0; index -= 1) {
    const event = jsonLines[index];
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      return event.item.text.trim();
    }
  }

  try {
    const envelope = JSON.parse(text);
    for (const key of ['result', 'output_text', 'text']) {
      if (typeof envelope?.[key] === 'string') {
        return envelope[key].trim();
      }
    }
  } catch {
    // Older/current Codex formats are handled above; fall through to a clear error.
  }

  throw new Error('Codex CLI response did not include an agent message.');
}

function buildCodexArgs(model = '', prompt = '') {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral'];
  const selectedModel = normalizeCliModel(model);
  if (selectedModel) {
    args.splice(1, 0, '--model', selectedModel);
  }

  const promptBytes = Buffer.byteLength(String(prompt || ''), 'utf8');
  // The desktop config may default to reasoning=max. That is too slow for
  // large subtitle prompts and is incompatible with some selectable models
  // such as gpt-5.4-mini. Translation does not need the maximum tier, so
  // bound it for explicit models and long prompts.
  if (selectedModel || promptBytes >= LONG_PROMPT_BYTES) {
    args.push('-c', 'model_reasoning_effort="high"');
  }
  args.push('-');
  return args;
}

async function runCodex({ systemPrompt, userPrompt, timeoutMs, model }) {
  ensurePromptSize(systemPrompt);
  ensurePromptSize(userPrompt);
  if (!await probeCli('codex')) {
    throw new Error('Codex CLI is not available on this machine.');
  }

  const fullPrompt = [
    systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}` : '',
    userPrompt,
  ].filter(Boolean).join('\n\n');
  ensurePromptSize(fullPrompt);
  const spec = resolveCliCommand('codex');
  const args = buildCodexArgs(model, fullPrompt);
  const result = await runProcess(spec, args, {
    input: fullPrompt,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(`Codex CLI exited ${result.code}: ${truncate(result.stderr || result.stdout)}`);
  }
  return parseCodexOutput(result.stdout);
}

function parseAntigravityOutput(stdout) {
  const text = repairMojibake(stripTerminalControls(stdout));
  if (!text) {
    throw new Error('Antigravity CLI returned empty output from --print.');
  }
  if (text.includes('\uFFFD')) {
    throw new Error('Antigravity CLI returned invalid text encoding from --print.');
  }
  return text;
}

function compactAntigravityPrompt(prompt) {
  const value = String(prompt || '');
  if (value.length <= MAX_ANTIGRAVITY_PROMPT_CHARS) return value;

  // Windows passes --print's prompt through the process command line. Keep
  // the core skill, task payload, output contract, and Vietnamese TTS rules,
  // but omit verbose reference prose when the command line is near its limit.
  const compact = value
    .replace(/(?:\r?\n){2,}---(?:\r?\n){2,}# Vietnamese Narration Style[\s\S]*?(?=(?:\r?\n){2,}---(?:\r?\n){2,}# Vietnamese TTS Reading Rules)/g, '\n\n')
    .replace(/(?:\r?\n){2,}---(?:\r?\n){2,}# Prompt 2 Template[\s\S]*$/g, '\n\n')
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim();

  if (compact.length > MAX_ANTIGRAVITY_PROMPT_CHARS) {
    const error = new Error(`Antigravity CLI prompt is too long for Windows command-line transport (${compact.length} characters after compaction).`);
    error.code = 'ANTIGRAVITY_PROMPT_TOO_LONG';
    throw error;
  }
  return compact;
}

function resolveBundledPython() {
  return resolvePythonExecutable();
}

function readLatestAntigravityPrintResponse(startedAt, promptHint) {
  const python = resolveBundledPython();
  const script = String.raw`
import json, os, re, sqlite3, sys
from pathlib import Path

started_at = float(sys.argv[1] or "0")
prompt_hint = sys.argv[2] if len(sys.argv) > 2 else ""
ansi_re = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

def app_data_dir():
    home = Path.home()
    return home / ".gemini" / "antigravity-cli"

def conversation_ids(app_dir):
    path = app_dir / "cache" / "last_conversations.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    cwd = Path.cwd().resolve()
    candidates = [str(cwd)] + [str(parent) for parent in cwd.parents]
    out = []
    for key in candidates:
        value = data.get(key)
        if isinstance(value, str) and value and value not in out:
            out.append(value)
    return out

def read_varint(buf, i):
    shift = 0
    value = 0
    while i < len(buf) and shift < 70:
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7
    raise ValueError("invalid varint")

def looks_printable(text):
    stripped = text.strip()
    if not stripped:
        return False
    printable = sum(1 for ch in stripped if ch.isprintable() or ch in "\r\n\t")
    return printable / max(len(stripped), 1) >= 0.85

def collect_proto_strings(buf, depth=0):
    out = []
    i = 0
    while i < len(buf):
        try:
            key, i = read_varint(buf, i)
        except Exception:
            i += 1
            continue
        wire_type = key & 7
        if wire_type == 0:
            try:
                _value, i = read_varint(buf, i)
            except Exception:
                i += 1
        elif wire_type == 1:
            i += 8
        elif wire_type == 5:
            i += 4
        elif wire_type == 2:
            try:
                size, start = read_varint(buf, i)
            except Exception:
                i += 1
                continue
            end = start + size
            if size < 0 or end > len(buf):
                i += 1
                continue
            chunk = buf[start:end]
            i = end
            try:
                text = chunk.decode("utf-8")
            except UnicodeDecodeError:
                text = ""
            if text and looks_printable(text):
                out.append(text.strip())
            if depth < 5 and len(chunk) > 1:
                out.extend(collect_proto_strings(chunk, depth + 1))
        else:
            i += 1
    return out

def is_metadata(value):
    if any(ord(ch) < 32 and ch not in "\r\n\t" for ch in value):
        return True
    if value.startswith("bot-") or value == "sessionID":
        return True
    if re.fullmatch(r"-?\d{8,}", value):
        return True
    if re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}", value):
        return True
    if len(value) >= 16 and re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return True
    if "\\" in value or "/" in value:
        return True
    return False

def looks_like_thinking(value):
    lowered = value.lower()
    return value.startswith("**") or any(marker in lowered for marker in (
        "i'm now ", "i've ", "i will ", "defining the ", "refining the ",
        "clarifying ", "formulating ", "finalizing ",
    ))

def response_score(value):
    stripped = value.strip()
    lowered = stripped.lower()
    score = 0
    if stripped.startswith("[") or stripped.startswith("{"):
        score += 100
    if "photoreal" in lowered or "editorial" in lowered:
        score += 30
    if "\n" not in stripped and len(stripped) <= 600:
        score += 20
    if looks_like_thinking(stripped):
        score -= 120
    if len(stripped) > 1200:
        score -= 20
    return (score, -abs(len(stripped) - 280), len(stripped))

def best_response(strings):
    cleaned = []
    for value in strings:
        s = ansi_re.sub("", value).strip()
        if not s or is_metadata(s):
            continue
        if s not in cleaned:
            cleaned.append(s)
    if not cleaned:
        return ""
    return max(cleaned, key=response_score).strip()

def db_contains_prompt(conn, hint):
    hint = hint.strip()
    if len(hint) < 4:
        return True
    needle = hint.encode("utf-8", errors="ignore")[:512]
    if not needle:
        return True
    try:
        rows = conn.execute("select step_payload from steps where step_payload is not null").fetchall()
    except sqlite3.Error:
        return False
    return any(isinstance(payload, bytes) and needle in payload for (payload,) in rows)

def read_db(db_path):
    try:
        if db_path.stat().st_mtime < started_at - 10:
            return ""
    except OSError:
        return ""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    except sqlite3.Error:
        return ""
    try:
        if not db_contains_prompt(conn, prompt_hint):
            return ""
        rows = conn.execute("""
            select idx, step_payload
            from steps
            where step_type = 15 and step_payload is not null
            order by idx desc
            limit 6
        """).fetchall()
    except sqlite3.Error:
        return ""
    finally:
        conn.close()
    for _idx, payload in rows:
        if isinstance(payload, bytes):
            text = best_response(collect_proto_strings(payload))
            if text:
                return text
    return ""

app_dir = app_data_dir()
conv_dir = app_dir / "conversations"
if not conv_dir.is_dir():
    sys.exit(0)
paths = []
for cid in conversation_ids(app_dir):
    p = conv_dir / f"{cid}.db"
    if p.exists():
        paths.append(p)
try:
    recent = sorted((p for p in conv_dir.glob("*.db") if p.stat().st_mtime >= started_at - 10), key=lambda p: p.stat().st_mtime, reverse=True)
except OSError:
    recent = []
for p in recent:
    if p not in paths:
        paths.append(p)
for p in paths:
    text = read_db(p)
    if text:
        print(text)
        break
`;
  const result = spawnSync(python, ['-c', script, String(startedAt || 0), String(promptHint || '')], {
    cwd: String(process.env.USERPROFILE || process.env.HOME || process.cwd()).trim() || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  return String(result.stdout || '').trim();
}

async function runAntigravity({ systemPrompt, userPrompt, timeoutMs, model }) {
  ensurePromptSize(systemPrompt);
  ensurePromptSize(userPrompt);
  if (!await probeCli('agy')) {
    throw new Error('Antigravity CLI is not available on this machine.');
  }

  const fullPrompt = [
    systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}` : '',
    userPrompt,
  ].filter(Boolean).join('\n\n');
  const transportPrompt = compactAntigravityPrompt(fullPrompt);
  ensurePromptSize(transportPrompt);
  const spec = resolveCliCommand('agy');
  const selectedModel = normalizeCliModel(model);
  const args = selectedModel
    ? ['--model', selectedModel, '--print', transportPrompt]
    : ['--print', transportPrompt];
  const cwd = String(process.env.USERPROFILE || process.env.HOME || process.cwd()).trim() || process.cwd();
  const startedAt = Date.now() / 1000;
  let result;
  try {
    result = await runProcess(spec, args, {
      timeoutMs,
      cwd,
      fallbackEncodings: ANTIGRAVITY_FALLBACK_ENCODINGS,
      env: {
        ...process.env,
        AGY_CLI_HIDE_ACCOUNT_INFO: process.env.AGY_CLI_HIDE_ACCOUNT_INFO || 'true',
      },
    });
  } catch (error) {
    const fallback = readLatestAntigravityPrintResponse(startedAt, userPrompt);
    if (fallback && !fallback.includes('\uFFFD')) return fallback;
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(`Antigravity CLI exited ${result.code}: ${truncate(result.stderr || result.stdout)}`);
  }
  try {
    return parseAntigravityOutput(result.stdout);
  } catch (error) {
    const fallback = readLatestAntigravityPrintResponse(startedAt, userPrompt);
    if (fallback && !fallback.includes('\uFFFD')) return fallback;
    throw error;
  }
}

async function runCliTranslation(provider, {
  systemPrompt = '',
  userPrompt = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model = '',
} = {}) {
  switch (String(provider || '').trim().toLowerCase()) {
    case 'codex_cli':
      return runCodex({ systemPrompt, userPrompt, timeoutMs, model });
    case 'antigravity_cli':
      return runAntigravity({ systemPrompt, userPrompt, timeoutMs, model });
    default:
      throw new Error(`Unknown CLI translation provider: ${provider}`);
  }
}

module.exports = {
  isCliTranslationProvider,
  getCliTranslationProviderStatus,
  runCliTranslation,
  _private: {
    createUtf8StreamCollector,
    decodeProcessOutput,
    compactAntigravityPrompt,
    buildCodexArgs,
    parseAntigravityOutput,
  },
};
