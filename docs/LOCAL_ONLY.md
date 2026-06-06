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
- Local Ollama chat/search

## Out Of Scope

- Hosted speech-to-text providers
- Hosted chat/LLM providers
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

- `http://localhost:11434` for Ollama
- USB device communication

Expected user-initiated external network use:

- Model downloads when the user clicks `Settings -> Local Transcription -> Download Model`

Remote Ollama URLs are blocked in local-only mode unless the user explicitly allows them.

## User-Initiated Export

Users can still manually copy or export transcripts. If a transcript is pasted into ChatGPT, Microsoft Copilot, email, or another external service, that action is outside this app's local-only boundary.
