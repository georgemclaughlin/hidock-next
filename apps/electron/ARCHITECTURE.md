# Architecture

This fork keeps the Electron app as the only maintained runtime. The architecture is local-first and oriented around HiDock recordings.

## Process Model

```text
Renderer (React)
  |
  | typed IPC through preload
  v
Preload context bridge
  |
  | limited API surface
  v
Main process services
  |
  | USB, filesystem, SQLite, local subprocesses, Ollama
  v
Local device and local machine
```

The renderer does not get direct Node.js access. It talks to the main process through the preload bridge.

## Main Areas

```text
apps/electron/
  electron/main/index.ts          app lifecycle and service startup
  electron/main/ipc/              IPC handlers
  electron/main/services/         database, USB, transcription, RAG, storage
  electron/main/types/            main-process TypeScript types
  electron/preload/               context bridge definitions
  src/                            React UI
  src/pages/                      top-level app views
  src/store/                      Zustand stores
  src/features/library/           library UI and filtering
```

## Local-Only Controls

The local-only behavior is enforced in a few places:

- `services/config.ts` normalizes config to local providers and disables external calendar sync.
- `services/privacy.ts` blocks non-loopback Ollama URLs unless explicitly allowed.
- `services/transcription.ts` only supports local Parakeet or local Whisper.
- `ipc/calendar-handlers.ts` returns local-only removal errors for external calendar sync operations.
- `src/index.html` limits renderer network connections to self and local Ollama.

The app can still open external links through Electron shell behavior, but recording transcription and transcript chat are not routed through hosted providers.

## Data Flow

### Device Download

1. The renderer requests device status or file actions through IPC.
2. Main-process USB/Jensen services communicate with the HiDock device.
3. Downloaded recordings are stored under the configured local storage path.
4. SQLite metadata tracks device/local state.

### Transcription

1. A recording is queued for transcription.
2. `services/transcription.ts` selects the configured local engine.
3. Parakeet runs through a configured Python command and local NeMo model cache.
4. Whisper runs through a configured local CLI command.
5. Transcript text is written to SQLite.
6. The vector store attempts to index the transcript through local Ollama embeddings.

### Chat/Search

1. Transcript chunks are embedded through Ollama.
2. Queries are embedded locally.
3. Relevant transcript context is retrieved from the local vector store.
4. Ollama generates the response locally.

## Storage

Default recording storage:

```text
~/HiDock/
```

Typical contents:

```text
~/HiDock/
  data/hidock.db
  recordings/
  transcripts/
```

Electron app configuration is stored in the OS-specific Electron user data directory.

## Removed From This Fork

The repository no longer carries the old Python desktop app, web app, audio-insights prototype, meeting recorder, meeting assistant, shared cloud AI provider packages, firmware research, or historical planning docs.

Within the Electron app, stale implementation reports and backup artifacts were also removed. Source, tests, and active build configuration remain.

## Known Technical Debt

Some Electron code still has historical naming from the broader upstream app, especially around meetings and calendar-related local views. External calendar sync is disabled, but local calendar/meeting UI concepts still exist in the app data model.
