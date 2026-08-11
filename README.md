# DubFlow AI

DubFlow AI is a local Windows-first video translation and dubbing workflow with:

- YouTube source mode
- Local file source mode
- Google Cloud Speech-to-Text
- Google Cloud Translation
- Google Cloud Text-to-Speech
- FFmpeg / ffprobe
- yt-dlp for YouTube imports
- native Windows local file picking through Python `tkinter`

Frontend runs on `http://localhost:3000`.
Backend runs on `http://localhost:3001`.

## What it does

You can:

1. Paste a YouTube URL, or
2. Open the Local tab and choose a local video on Windows

Then DubFlow AI:

1. validates input and dependencies
2. extracts audio with FFmpeg
3. runs Google Cloud Speech-to-Text
4. translates the transcript
5. generates TTS clips
6. syncs the new audio
7. exports:
   - dubbed MP4
   - dubbed WAV
   - transcript JSON
   - translated JSON
   - SRT
   - VTT

## Local File mode

Local File mode is backend-driven on purpose.

Browsers cannot safely expose real local absolute paths, so the backend opens the picker on the same Windows machine.

Flow:

1. Frontend calls `POST /api/pick-video`
2. Backend runs `Backend/helpers/pick_video.py`
3. Python opens a native `tkinter.filedialog.askopenfilename`
4. Backend returns the absolute local path
5. The backend processes that exact local path directly

Important:

- the original local file is **not uploaded**
- the original local file is **not moved**
- the original local file is **not renamed**
- FFmpeg reads directly from the selected path

If `tkinter` is unavailable, you can paste the local file path manually in the UI.

## Windows setup

Install:

- Node.js 18+
- Python 3 with `tkinter`
- FFmpeg / ffprobe
- yt-dlp

### Node.js

Install from:

- [https://nodejs.org/](https://nodejs.org/)

### Python with tkinter

Install Python from:

- [https://www.python.org/downloads/windows/](https://www.python.org/downloads/windows/)

During install, make sure Python is added to `PATH`.
The standard Windows installer usually includes `tkinter`.

Verify:

```powershell
python --version
python -c "import tkinter; print('tkinter ok')"
```

### FFmpeg

Install a Windows build and add `ffmpeg.exe` and `ffprobe.exe` to `PATH`.

Verify:

```powershell
ffmpeg -version
ffprobe -version
```

### yt-dlp

Install with winget:

```powershell
winget install yt-dlp.yt-dlp
```

Verify:

```powershell
yt-dlp --version
```

### Faster Whisper local STT

Faster Whisper is used for the local STT provider, including `large-v3`.

```powershell
python -m pip install -r Backend/requirements.txt
```

By default DubFlow lets Faster Whisper auto-select the device and uses `int8`. With the NVIDIA CUDA runtime available to Python/CTranslate2, this uses GPU on CUDA-capable machines. You can force a device in `Backend/.env`:

```env
FASTER_WHISPER_DEVICE=cuda
FASTER_WHISPER_COMPUTE_TYPE=int8
```

## Google Cloud setup

Create a Google Cloud project and enable:

- Speech-to-Text API
- Cloud Translation API
- Text-to-Speech API

Also make sure billing is enabled if your project requires it.

Supported auth modes in the app:

1. Backend `.env`
2. API key pasted into the frontend for local testing
3. Service account JSON path

### Backend `.env`

Create:

`Backend/.env`

From:

`Backend/.env.example`

Example:

```env
PORT=3001
GOOGLE_CLOUD_API_KEY=
GOOGLE_CLOUD_PROJECT_ID=
GOOGLE_STT_V2_LOCATION=us
GOOGLE_APPLICATION_CREDENTIALS=
LOCAL_FILE_PICKER_ENABLED=true
```

For Google Speech-to-Text V2 Chirp models, choose `chirp_3` in the UI and set a Google Cloud Project ID. `GOOGLE_STT_V2_LOCATION` defaults to `us`; the backend uses the matching regional endpoint such as `us-speech.googleapis.com`.

### Frontend API key mode

This is for local testing only.

Do not use frontend-pasted keys as production secrets.

### Service account mode

Set an absolute local path to a valid Google service account JSON file.

## Install

### One-click Windows setup

For a fresh clone or pull on Windows, double-click `Start DubFlow App.bat`.
The first run automatically installs the Backend and Frontend Node dependencies
from their lockfiles, installs the local Python packages listed in
`Backend/requirements.txt`, and prepares FFmpeg, ffprobe, and yt-dlp in the
ignored local tool folders. Later runs reuse the installed dependencies and
start the app normally.

The setup still requires an internet connection and may use winget to install
Node.js or Python 3.11 when they are not already available. Microsoft App
Installer/winget must be available for that automatic runtime installation.

### Backend

```powershell
cd Backend
npm install
```

### Frontend

```powershell
cd Frontend
npm install
```

The commands above are manual alternatives to the one-click setup.

## Run

### Local desktop app

This is the easiest mode while the app is still local and Windows-first. It starts the backend, starts the Next.js UI, then opens DubFlow in a desktop window.

```powershell
cd Frontend
npm run app
```

Close the DubFlow window to stop the local app runner.

### Backend

```powershell
cd Backend
node server.js
```

### Frontend

```powershell
cd Frontend
npm run dev
```

Open:

- [http://localhost:3000](http://localhost:3000)

Health:

- [http://localhost:3001/api/health](http://localhost:3001/api/health)

## How to test

1. Start backend
2. Start frontend
3. Open the Local tab
4. Choose video
5. Check Google Cloud
6. Start Translation
7. Watch progress and logs
8. Download result

You can also use the YouTube tab instead of Local mode.

## Result files

Each job writes internal working files under:

```text
Backend/jobs/{jobId}/
```

Published downloadable artifacts are copied to:

```text
Backend/downloads/{jobId}/
```

If you configured an output folder in the UI, the final MP4 is also copied there.

## Common errors

### Backend offline

Message:

`Backend is not running. Start the backend with node server.js.`

Fix:

```powershell
cd Backend
node server.js
```

### Local file picker unavailable

Message:

`Python tkinter is not available. Install Python with tkinter support or paste local path manually.`

Fix:

- install Python from python.org with tkinter support
- or paste the absolute local video path manually

### Local file not found

Message:

`The selected local video path does not exist.`

Fix:

- choose a valid file with the picker
- or paste an existing absolute path

### FFmpeg missing

Message:

`FFmpeg was not found. Install FFmpeg and make sure it is available in PATH.`

### yt-dlp missing

Message:

`yt-dlp was not found. Install yt-dlp or use Local File mode.`

### Google Speech-to-Text failed

Message:

`Google Cloud Speech-to-Text failed. Check API access, billing, language code, and credentials.`

Fix:

- verify Speech-to-Text API is enabled
- verify billing
- verify credentials
- use a concrete source language instead of auto detect for Google STT

### Google Translation failed

Message:

`Google Cloud Translation failed. Check Translation API access and target language.`

### Google TTS failed

Message:

`Google Cloud Text-to-Speech failed. Check selected voice and TTS API access.`

## Security

Never commit:

- API keys
- service account JSON files
- `.env`
- generated media artifacts

The repo ignores:

- `Backend/jobs/*`
- `Backend/downloads/*`
- `.env`
- common video/audio outputs
