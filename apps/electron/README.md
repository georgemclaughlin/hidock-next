# HiDock Local Electron App

This is the only maintained application in this fork.

It provides a local workflow for HiDock recorders:

1. Connect a device over USB.
2. Browse and download recordings.
3. Transcribe recordings locally with Parakeet or Whisper.
4. Store transcripts locally.
5. Search and chat with transcripts through local Ollama.

No hosted transcription provider is configured in this supported path.

## Requirements

- Node.js 20+
- npm
- Electron-compatible desktop environment
- USB access to the HiDock device
- Optional: local Parakeet Python environment
- Optional: local Whisper command
- Optional: Ollama for transcript chat/search

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

On Windows, run this from Windows PowerShell or Command Prompt for the most reliable USB and display behavior. WSL can build and test the app, but running Electron from WSL usually requires WSLg and USB forwarding.

## Build

```bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
```

Build output is written to `out/` for compiled app files and `dist/` for packaged installers.

## Test

```bash
npm run test:run
```

Focused smoke tests for the local-only transcription/settings path:

```bash
npx vitest run \
  src/pages/__tests__/Settings.test.tsx \
  electron/main/services/__tests__/transcription.test.ts \
  electron/main/ipc/__tests__/recording-handlers.test.ts
```

## App Data

Default recording storage is:

```text
~/HiDock/
```

The Electron config file is stored under Electron's per-user app data directory for the current OS. The storage path can be changed in app settings.

Typical local data:

```text
~/HiDock/
  data/hidock.db
  recordings/
  transcripts/
```

## Local Transcription

The app supports two local engines.

### Parakeet

Default engine:

```text
nvidia/parakeet-tdt-0.6b-v2
```

The app runs the configured Python command with a small embedded NeMo runner. It sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, so the model must already exist in the local Hugging Face cache or be referenced by a local `.nemo` path.

Example model pre-cache command:

```bash
python -c "import nemo.collections.asr as nemo_asr; nemo_asr.models.ASRModel.from_pretrained(model_name='nvidia/parakeet-tdt-0.6b-v2')"
```

Set `Settings -> Speech to Text -> Python Command` to the Python executable that has NeMo installed.

### Whisper

Whisper fallback expects a local command named `whisper` by default:

```bash
pip install -U openai-whisper
```

Set `Settings -> Speech to Text -> Engine` to `Whisper` and adjust the command/model fields as needed.

## Local Ollama

Transcript chat and embeddings use Ollama:

```bash
ollama serve
ollama pull nomic-embed-text
ollama pull llama3.2
```

Defaults:

```text
Ollama URL: http://localhost:11434
Embeddings: nomic-embed-text
Chat: llama3.2
```

Local-only mode accepts loopback Ollama URLs by default. Remote Ollama URLs require an explicit settings opt-in.

## Current Boundaries

- External calendar sync is disabled.
- Cloud speech-to-text providers are removed from this supported app.
- Cloud chat providers are not part of the supported path.
- Manual copy/paste or export to ChatGPT, Microsoft Copilot, or another external tool is outside the app boundary.

## Source Layout

```text
apps/electron/
  electron/main/        Node/Electron services and IPC handlers
  electron/preload/     Context bridge exposed to the renderer
  src/                  React renderer
  resources/            App icon and build resources
```
