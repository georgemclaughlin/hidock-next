# Local-Only Model

This fork is scoped to local device management and local transcript processing.

## In Scope

- USB communication with compatible recorder devices
- Local download of recordings
- Local playback
- Local Parakeet transcription through the Rust sidecar
- Local Whisper transcription through the Rust sidecar
- Local SQLite storage
- Local transcript indexing
- Local transcript search with native embeddings
- Local Ollama meeting-note generation

## Out Of Scope

- Hosted speech-to-text providers
- Hosted chat/LLM providers
- Chat/RAG assistant workflows
- External calendar sync
- Auto-upload of recordings
- Automatic transcript sharing

## Data Boundary

The app stores recordings and transcript data on the user's computer. By default, recording storage is under:

```text
~/LocalRecorder/
```

Electron configuration uses the OS-specific Electron user data path.

## Network Boundary

The app is expected to work without sending recordings or transcripts to a third-party web service.

Expected local network use:

- `http://localhost:11434` or a private-LAN address for Ollama
- USB device communication

The Ollama notes model and thinking mode are user-configurable in settings.

Expected user-initiated external network use:

- Model downloads when the user clicks `Settings -> Local Transcription -> Download Model`

Public remote Ollama URLs are blocked in local-only mode unless the user explicitly allows them. Loopback and private-LAN Ollama URLs are treated as local network endpoints.

## User-Initiated Export

Users can still manually copy or export transcripts. If a transcript is pasted into ChatGPT, Microsoft Copilot, email, or another external service, that action is outside this app's local-only boundary.
