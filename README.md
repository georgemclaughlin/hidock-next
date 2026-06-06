# HiDock Local

Local-only Electron app for HiDock recorder workflows.

This is an unofficial fork focused on one job: download recordings from a HiDock device, transcribe them on the local machine, and make the resulting transcripts searchable without sending recording data to a third-party service.

HiDock is a trademark of its respective owner. This project is not affiliated with or endorsed by HiDock or its manufacturers.

## Supported App

The maintained app lives in [apps/electron](apps/electron).

The older Python desktop app, browser app, audio-insights prototype, meeting recorder, meeting assistant, shared cloud-provider packages, historical firmware research, and broad planning docs have been removed from this fork. They were useful upstream history, but they were not part of this local-only workflow.

## Local-Only Boundary

The Electron app is designed around these constraints:

- Recordings are downloaded over USB from the HiDock device.
- Recordings, transcripts, indexes, and app data are stored on the local computer.
- Speech-to-text is local: Parakeet by default, Whisper as a fallback.
- Transcript chat/search uses local Ollama by default.
- External calendar sync is disabled.
- Hosted transcription and hosted LLM providers are not included in the supported path.

Manual export is still possible. If a user copies a transcript into ChatGPT, Microsoft Copilot, or another enterprise tool, that happens outside this app's local-only boundary.

## Requirements

- Node.js 20 or newer
- npm
- A HiDock H1, H1E, P1, or compatible recorder
- Optional: Ollama for local transcript chat/search
- Optional: a local Parakeet or Whisper environment for transcription

For Windows users, run the Electron app from native Windows PowerShell or Command Prompt when you need the GUI and USB device access. WSL is fine for editing, building, and tests, but it usually needs extra display and USB forwarding setup to run Electron reliably.

## Quick Start

### Windows Native

```powershell
git clone https://github.com/sgeraldes/hidock-next.git
cd hidock-next
cd apps\electron
npm install
npm run dev
```

You can also use the root helper:

```powershell
.\run-electron.bat
```

### macOS / Linux / WSL Build

```bash
git clone https://github.com/sgeraldes/hidock-next.git
cd hidock-next/apps/electron
npm install
npm run build
```

On a Linux desktop with display and USB permissions configured:

```bash
npm run dev
```

## Local Transcription

Parakeet is the default engine. The app launches a configured Python command and expects the model to already be available locally. The default model is:

```text
nvidia/parakeet-tdt-0.6b-v2
```

Because the app forces offline model loading for Parakeet, pre-cache the model before relying on it offline. On Windows, use a Windows Python environment if you run the Electron app from Windows.

Example Parakeet setup:

```powershell
python -m venv .venv-parakeet
.\.venv-parakeet\Scripts\Activate.ps1
pip install torch torchaudio "nemo_toolkit[asr]"
python -c "import nemo.collections.asr as nemo_asr; nemo_asr.models.ASRModel.from_pretrained(model_name='nvidia/parakeet-tdt-0.6b-v2')"
```

Then set the app's Parakeet Python command to the venv Python path, for example:

```text
C:\path\to\.venv-parakeet\Scripts\python.exe
```

Whisper fallback uses a local `whisper` command:

```bash
pip install -U openai-whisper
```

## Local Ollama

For transcript chat and semantic search:

```bash
ollama serve
ollama pull nomic-embed-text
ollama pull llama3.2
```

The default Ollama URL is:

```text
http://localhost:11434
```

Remote Ollama URLs are blocked by local-only mode unless explicitly allowed in settings.

## Development

```bash
cd apps/electron
npm install
npm run dev
npm run build
npm run test:run
```

Useful root helpers:

```bash
./run-electron.sh
./build-electron.sh
make dev
make build
make test
```

## Project Layout

```text
hidock-next/
  apps/electron/        Electron main/preload/renderer app
  docs/                 Local-only setup notes
  run-electron.*        Root launch helpers
  build-electron.*      Root build helpers
```

## More Docs

- [Electron app README](apps/electron/README.md)
- [Architecture](apps/electron/ARCHITECTURE.md)
- [Local-only model](docs/LOCAL_ONLY.md)
- [Windows and WSL notes](docs/WINDOWS_WSL.md)

## License

MIT. See [LICENSE](LICENSE).
