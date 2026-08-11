const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePythonExecutable } = require('./pythonRuntimeService');

const execFileAsync = promisify(execFile);
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const JSON_EXTENSIONS = new Set(['.json']);

function ensureAllowedExtension(videoPath) {
  const extension = path.extname(videoPath || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('LOCAL_FILE_UNSUPPORTED_FORMAT');
  }
  return extension;
}

async function validateLocalVideoPath(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('LOCAL_FILE_NOT_FOUND');
  }

  const normalizedInput = String(videoPath).trim();
  ensureAllowedExtension(normalizedInput);

  try {
    const stats = await fs.stat(normalizedInput);
    if (!stats.isFile()) {
      throw new Error('LOCAL_FILE_NOT_FOUND');
    }
    return normalizedInput;
  } catch {
    const resolved = await resolveWindowsLiteralPath(normalizedInput).catch(() => null);
    if (!resolved) {
      throw new Error('LOCAL_FILE_NOT_FOUND');
    }

    ensureAllowedExtension(resolved);

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        throw new Error('LOCAL_FILE_NOT_FOUND');
      }
      return resolved;
    } catch {
      throw new Error('LOCAL_FILE_NOT_FOUND');
    }
  }
}

async function resolveWindowsLiteralPath(videoPath) {
  if (process.platform !== 'win32') {
    return null;
  }

  const escapedPath = String(videoPath).replace(/'/g, "''");
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$literalPath = '${escapedPath}'`,
    '$fso = New-Object -ComObject Scripting.FileSystemObject',
    '$file = $fso.GetFile($literalPath)',
    'if ($file.ShortPath) { $file.ShortPath } else { $file.Path }',
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }
  );

  const resolved = String(stdout || '').trim();
  return resolved || null;
}

function getFileInfo(videoPath) {
  const extension = path.extname(videoPath || '').toLowerCase();
  return {
    videoPath,
    fileName: path.basename(videoPath || ''),
    extension,
    sourceType: 'local',
  };
}

async function validateLocalPath(filePath, allowedExtensions, errorCode) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(errorCode);
  }
  const normalizedInput = String(filePath).trim();
  const extension = path.extname(normalizedInput).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(errorCode);
  }
  const stats = await fs.stat(normalizedInput).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(errorCode);
  }
  return normalizedInput;
}

async function pickFileWithPowerShell({ title, filter, allowedExtensions, errorCode }) {
  const escapedTitle = String(title || 'Choose File').replace(/'/g, "''");
  const escapedFilter = String(filter || 'All files (*.*)|*.*').replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${escapedTitle}'
$dialog.Filter = '${escapedFilter}'
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
if (Test-Path -LiteralPath $downloads) {
  $dialog.InitialDirectory = $downloads
}
$owner.Show()
$owner.Activate()
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $dialog.FileName
}
$dialog.Dispose()
$owner.Close()
$owner.Dispose()
`;
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    windowsHide: false,
    timeout: 1000 * 60 * 5,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  const filePath = String(stdout || '').trim();
  if (!filePath) {
    return {
      success: false,
      cancelled: true,
      message: 'No file selected',
    };
  }

  await validateLocalPath(filePath, allowedExtensions, errorCode);
  return {
    success: true,
    filePath,
    fileName: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
  };
}

async function pickAudioWithDialog() {
  try {
    return await pickFileWithPowerShell({
      title: 'Choose Background Music',
      filter: 'Audio files (*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.opus;*.wma)|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.opus;*.wma|All files (*.*)|*.*',
      allowedExtensions: AUDIO_EXTENSIONS,
      errorCode: 'LOCAL_AUDIO_FILE_INVALID',
    });
  } catch (error) {
    if (error.message === 'LOCAL_AUDIO_FILE_INVALID') {
      return {
        success: false,
        error: 'LOCAL_AUDIO_FILE_INVALID',
        message: 'Selected audio file is missing or unsupported.',
        suggestion: 'Choose an audio file such as MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, or WMA.',
      };
    }
    return {
      success: false,
      error: 'LOCAL_AUDIO_PICKER_UNAVAILABLE',
      message: 'Audio file picker is unavailable.',
      suggestion: 'Paste the audio path manually or retry the picker.',
    };
  }
}

async function pickLogoWithDialog() {
  try {
    return await pickFileWithPowerShell({
      title: 'Choose Logo Image',
      filter: 'Image files (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|All files (*.*)|*.*',
      allowedExtensions: IMAGE_EXTENSIONS,
      errorCode: 'LOCAL_LOGO_FILE_INVALID',
    });
  } catch (error) {
    if (error.message === 'LOCAL_LOGO_FILE_INVALID') {
      return {
        success: false,
        error: 'LOCAL_LOGO_FILE_INVALID',
        message: 'Selected logo file is missing or unsupported.',
        suggestion: 'Choose an image file such as PNG, JPG, WEBP, BMP, or GIF.',
      };
    }
    return {
      success: false,
      error: 'LOCAL_LOGO_PICKER_UNAVAILABLE',
      message: 'Logo file picker is unavailable.',
      suggestion: 'Paste the logo path manually or retry the picker.',
    };
  }
}

async function pickGoogleCredentialsWithDialog() {
  try {
    return await pickFileWithPowerShell({
      title: 'Choose Google service account JSON',
      filter: 'Google credentials JSON (*.json)|*.json|All files (*.*)|*.*',
      allowedExtensions: JSON_EXTENSIONS,
      errorCode: 'GOOGLE_CREDENTIALS_FILE_INVALID',
    });
  } catch (error) {
    if (error.message === 'GOOGLE_CREDENTIALS_FILE_INVALID') {
      return {
        success: false,
        error: 'GOOGLE_CREDENTIALS_FILE_INVALID',
        message: 'Selected Google credentials file is missing or unsupported.',
        suggestion: 'Choose a Google service account JSON file.',
      };
    }
    return {
      success: false,
      error: 'GOOGLE_CREDENTIALS_PICKER_UNAVAILABLE',
      message: 'Google credentials file picker is unavailable.',
      suggestion: 'Paste the service account JSON path manually or retry the picker.',
    };
  }
}

async function pickVideoWithTkinter() {
  if (process.platform === 'win32') {
    const powershellResult = await pickFileWithPowerShell({
      title: 'Choose Video File',
      filter: 'Video files (*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v)|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v|All files (*.*)|*.*',
      allowedExtensions: ALLOWED_EXTENSIONS,
      errorCode: 'LOCAL_FILE_UNSUPPORTED_FORMAT',
    }).catch(() => null);
    if (powershellResult) return powershellResult;
  }

  const scriptPath = path.join(__dirname, '..', 'helpers', 'pick_video.py');
  try {
    const { stdout } = await execFileAsync(resolvePythonExecutable(), [scriptPath], {
      windowsHide: false,
      timeout: 1000 * 60 * 5,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim() || '{}');

    if (result.success && result.videoPath) {
      await validateLocalVideoPath(result.videoPath);
    }

    return result;
  } catch (error) {
    let parsed = null;
    try {
      parsed = JSON.parse((error.stdout || '').trim() || '{}');
    } catch {
      parsed = null;
    }

    if (parsed) {
      return parsed;
    }

    return {
      success: false,
      error: 'LOCAL_FILE_PICKER_UNAVAILABLE',
      message: 'Local file picker is unavailable. Make sure Python with tkinter is installed.',
      suggestion: 'Install Python from python.org with tkinter support, or paste a local file path manually.',
    };
  }
}

async function pickOutputFolderWithTkinter() {
  if (process.platform === 'win32') {
    const powershellResult = await pickOutputFolderWithPowerShell().catch(() => null);
    if (powershellResult) return powershellResult;
  }

  const scriptPath = path.join(__dirname, '..', 'helpers', 'pick_folder.py');
  try {
    const { stdout } = await execFileAsync(resolvePythonExecutable(), [scriptPath], {
      windowsHide: false,
      timeout: 1000 * 60 * 5,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim() || '{}');

    if (result.success && result.folderPath) {
      const stats = await fs.stat(result.folderPath);
      if (!stats.isDirectory()) {
        throw new Error('LOCAL_FOLDER_NOT_FOUND');
      }
    }

    return result;
  } catch (error) {
    let parsed = null;
    try {
      parsed = JSON.parse((error.stdout || '').trim() || '{}');
    } catch {
      parsed = null;
    }

    if (parsed) {
      return parsed;
    }

    if (error.message === 'LOCAL_FOLDER_NOT_FOUND') {
      return {
        success: false,
        error: 'LOCAL_FOLDER_NOT_FOUND',
        message: 'The selected output folder does not exist.',
        suggestion: 'Choose an existing output folder.',
      };
    }

    return {
      success: false,
      error: 'LOCAL_FOLDER_PICKER_UNAVAILABLE',
      message: 'Local folder picker is unavailable. Make sure Python with tkinter is installed.',
      suggestion: 'Install Python from python.org with tkinter support, then retry.',
    };
  }
}

async function pickOutputFolderWithPowerShell() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose Output Folder'
$dialog.ShowNewFolderButton = $true
$defaultPath = [Environment]::GetFolderPath('UserProfile')
if ($defaultPath) {
  $downloads = Join-Path $defaultPath 'Downloads'
  if (Test-Path -LiteralPath $downloads) {
    $dialog.SelectedPath = $downloads
  }
}
$owner.Show()
$owner.Activate()
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $dialog.SelectedPath
}
$dialog.Dispose()
$owner.Close()
$owner.Dispose()
`;
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    windowsHide: false,
    timeout: 1000 * 60 * 5,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  const folderPath = String(stdout || '').trim();
  if (!folderPath) {
    return {
      success: false,
      cancelled: true,
      message: 'No folder selected',
    };
  }

  const stats = await fs.stat(folderPath);
  if (!stats.isDirectory()) {
    throw new Error('LOCAL_FOLDER_NOT_FOUND');
  }

  return {
    success: true,
    folderPath,
    folderName: path.basename(folderPath),
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  JSON_EXTENSIONS,
  getFileInfo,
  pickAudioWithDialog,
  pickGoogleCredentialsWithDialog,
  pickLogoWithDialog,
  pickOutputFolderWithTkinter,
  pickVideoWithTkinter,
  validateLocalVideoPath,
};
