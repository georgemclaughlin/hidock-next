# Local Recorder

Local-only Electron app for USB recorder workflows.

This fork is focused on one job: download recordings from a compatible USB recorder, transcribe them on the local machine, and make the resulting transcripts searchable without sending recording data to a third-party service.

## Supported App

The maintained app lives in [apps/electron](apps/electron).

The older Python desktop app, browser app, audio-insights prototype, meeting recorder, meeting assistant, shared cloud-provider packages, historical firmware research, and broad planning docs have been removed from this fork. They were useful upstream history, but they were not part of this local-only workflow.

## Local-Only Boundary

The Electron app is designed around these constraints:

- Recordings are downloaded over USB from the device.
- Recordings, transcripts, indexes, and app data are stored on the local computer.
- Speech-to-text is local through the required Rust sidecar: Parakeet by default, Whisper as an alternate engine.
- Transcript search uses a native local embedding model.
- Meeting notes and title suggestions can be generated with local Ollama.
- External calendar sync is disabled.
- Hosted transcription and hosted LLM providers are not included in the supported path.

Manual export is still possible. If a user copies a transcript into ChatGPT, Microsoft Copilot, or another enterprise tool, that happens outside this app's local-only boundary.

## Requirements

- Node.js 20 or newer
- npm
- Rust and CMake for building the local transcription sidecar
- A compatible USB recorder
- Optional: Ollama for local meeting notes and title suggestions

Linux/WSL packaging may also need libudev development headers for the existing USB native module, for example `sudo apt install libudev-dev`. If the `usb` native rebuild fails with C++ language feature errors, run packaging with `CXXFLAGS="-std=c++17"`.

For Windows users, run the Electron app from native Windows PowerShell or Command Prompt when you need the GUI and USB device access. WSL is fine for editing, building, and tests, but it usually needs extra display and USB forwarding setup to run Electron reliably.

## Quick Start

### Windows Native

```powershell
git clone <your-fork-url>
cd local-recorder
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
git clone <your-fork-url>
cd local-recorder/apps/electron
npm install
npm run build
```

On a Linux desktop with display and USB permissions configured:

```bash
npm run dev
```

## Local Transcription

Parakeet is the default engine. Transcription requires the Rust native sidecar based on `transcribe-rs`, following the same local model approach used by Handy. The sidecar runs Whisper and Parakeet locally on CPU-capable runtimes and decodes common audio formats, including OGG imports.

Build the sidecar:

```bash
cd apps/electron
npm run build:transcriber
```

`npm run dev`, `npm run build`, and packaged build scripts also build and verify the sidecar before continuing. If the sidecar is missing at runtime, the app stops during startup and asks you to build it for the current OS.

Then use `Settings -> Local Transcription -> Download Model` to download the selected local model. The app stores models under the local app data directory and does not upload recordings or transcripts.

The default Parakeet model is:

```text
parakeet-v3
```

Whisper uses the local sidecar model catalog too. The app stores native model IDs: `whisper-small` or `whisper-medium`.

## Local Ollama

For generated meeting notes and title suggestions:

```bash
ollama serve
ollama pull llama3.2
```

The default Ollama URL is:

```text
http://localhost:11434
```

The Ollama model name and thinking mode are configurable in `Settings -> Local Notes`.

Public remote Ollama URLs are blocked by local-only mode. Loopback and private-LAN Ollama URLs are allowed.

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
local-recorder/
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
