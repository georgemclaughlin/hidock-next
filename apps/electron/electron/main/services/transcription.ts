import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import crypto from 'crypto'
import { getConfig } from './config'
import {
  getMeetingById,
  getRecordingById,
  insertTranscript,
  updateRecordingTranscriptionStatus,
  getQueueItems,
  updateQueueItem,
  updateQueueProgress,
  removeFromQueueByRecordingId,
  cancelPendingTranscriptions,
  acquireTranscriptionLock,
  releaseTranscriptionLock,
  clearStaleTranscriptionLock,
  resetStuckTranscriptions
} from './database'
import { BrowserWindow } from 'electron'
import { getVectorStore } from './vector-store'

let mainWindow: BrowserWindow | null = null
let isProcessing = false
let processingInterval: ReturnType<typeof setInterval> | null = null
let lastSkipLogAt = 0 // Throttle "skipping" spam to once per 60s

export function setMainWindowForTranscription(win: BrowserWindow): void {
  mainWindow = win
}

export function startTranscriptionProcessor(): void {
  if (processingInterval) {
    console.log('Transcription processor already running')
    return
  }

  clearStaleTranscriptionLock()
  resetStuckTranscriptions()

  console.log('Starting transcription processor')

  // Process queue every 10 seconds
  processingInterval = setInterval(() => {
    processQueue()
  }, 10000)

  // Start immediately
  processQueue()
}

export function stopTranscriptionProcessor(): void {
  if (processingInterval) {
    clearInterval(processingInterval)
    processingInterval = null
    console.log('Transcription processor stopped')
  }
}

let cancelRequested = false

export function cancelTranscription(recordingId: string): void {
  removeFromQueueByRecordingId(recordingId)
  updateRecordingTranscriptionStatus(recordingId, 'none')
  notifyRenderer('transcription:cancelled', { recordingId })
}

export function cancelAllTranscriptions(): number {
  cancelRequested = true
  const count = cancelPendingTranscriptions()
  notifyRenderer('transcription:all-cancelled', { count })
  // cancelRequested is reset at the end of processQueue (after the loop breaks)
  // rather than on a timer, to avoid the race where the flag resets before
  // processQueue has a chance to observe it.
  return count
}

const MAX_RETRY_ATTEMPTS = 3 // spec-014: configurable max retry attempts

async function processQueue(): Promise<void> {
  if (isProcessing) return

  // spec-005: Acquire mutex lock to prevent concurrent processing
  const processId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
  const lockAcquired = acquireTranscriptionLock(processId)
  if (!lockAcquired) {
    // Throttle to once per 60s — this fires every 10s during active transcription, which is expected
    const now = Date.now()
    if (now - lastSkipLogAt > 60000) {
      console.log('[Transcription] Another process is already processing the queue, skipping')
      lastSkipLogAt = now
    }
    return
  }

  try {
    // spec-014: Retry failed items with max attempts
    // B-TXN-001: Exponential backoff before retrying failed items
    // C-005: Skip non-retryable errors (missing files, missing API key)
    const NON_RETRYABLE_ERRORS = [
      'Recording not found',
      'Recording file not found',
      'Local transcription provider is disabled',
      'Local transcription command is not configured',
      'no local file'
    ]
    const failedItems = getQueueItems('failed')
    const now = Date.now()
    for (const item of failedItems) {
      // B-TXN-003: Use typed property access instead of `as any` cast
      const retryCount = item.retry_count ?? 0

      // C-005: Don't retry items whose error indicates a permanent failure
      const errorMsg = item.error_message || ''
      const isNonRetryable = NON_RETRYABLE_ERRORS.some(pattern => errorMsg.includes(pattern))
      if (isNonRetryable) {
        continue
      }

      if (retryCount < MAX_RETRY_ATTEMPTS) {
        // B-TXN-001: Calculate backoff delay: 30s * 2^retryCount, capped at 120s
        const backoffMs = Math.min(30000 * Math.pow(2, retryCount), 120000)
        const completedAt = item.completed_at ? new Date(item.completed_at).getTime() : 0
        const timeSinceFailure = now - completedAt

        if (timeSinceFailure < backoffMs) {
          // Not enough time has passed; skip this retry cycle
          console.log(`[Transcription] Backoff for ${item.id}: waiting ${Math.round((backoffMs - timeSinceFailure) / 1000)}s more (retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`)
          continue
        }

        // Reset to pending so it gets picked up in the processing loop
        updateQueueItem(item.id, 'pending')
        // Also reset recording status so UI shows it's retrying
        updateRecordingTranscriptionStatus(item.recording_id, 'pending')
        console.log(`Re-queuing failed item ${item.id} (retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}, backoff ${backoffMs / 1000}s)`)
      }
    }

    const pendingItems = getQueueItems('pending')
    if (pendingItems.length === 0) {
      return
    }

    isProcessing = true

    for (const item of pendingItems) {
      if (cancelRequested) {
        console.log('Transcription cancelled by user')
        break
      }

      try {
        updateQueueItem(item.id, 'processing')
        updateQueueProgress(item.id, 0) // spec-014: reset progress
        notifyRenderer('transcription:started', { queueItemId: item.id, recordingId: item.recording_id })
        const { emitActivityLog } = await import('./activity-log')
        const recording = getRecordingById(item.recording_id)
        const filename = recording?.filename ?? item.recording_id
        emitActivityLog('info', 'Transcribing recording', filename)

        // B-TXN-002: Progress ticker that increments during long API calls
        // instead of being stuck at a hardcoded value
        let tickerProgress = 0
        const progressTicker = setInterval(() => {
          // Tick progress upward during API calls, capping below 95% (reserved for completion)
          if (tickerProgress < 90) {
            tickerProgress += 2
            updateQueueProgress(item.id, tickerProgress)
            notifyRenderer('transcription:progress', {
              queueItemId: item.id,
              recordingId: item.recording_id,
              stage: 'transcribing',
              progress: tickerProgress
            })
          }
        }, 3000)

        // spec-014: Progress callback for transcription stages
        const progressCallback = (stage: string, progress: number) => {
          tickerProgress = progress // Sync ticker with actual progress
          updateQueueProgress(item.id, progress)
          notifyRenderer('transcription:progress', {
            queueItemId: item.id,
            recordingId: item.recording_id,
            stage,
            progress
          })
        }

        try {
          await transcribeRecording(item.recording_id, progressCallback)
        } finally {
          clearInterval(progressTicker) // Always clean up the ticker
        }

        updateQueueProgress(item.id, 100) // spec-014: mark complete
        updateQueueItem(item.id, 'completed')
        notifyRenderer('transcription:completed', { queueItemId: item.id, recordingId: item.recording_id })
        const { emitActivityLog: emitDone } = await import('./activity-log')
        const recDone = getRecordingById(item.recording_id)
        emitDone('success', 'Transcription complete', recDone?.filename ?? item.recording_id)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Transcription failed:', errorMessage)

        updateQueueItem(item.id, 'failed', errorMessage)
        // AI-13: Use standard enum value 'error' (not 'failed')
        updateRecordingTranscriptionStatus(item.recording_id, 'error')
        notifyRenderer('transcription:failed', {
          queueItemId: item.id,
          recordingId: item.recording_id,
          error: errorMessage
        })
        const { emitActivityLog: emitFail } = await import('./activity-log')
        const recFail = getRecordingById(item.recording_id)
        emitFail('error', 'Transcription failed', `${recFail?.filename ?? item.recording_id}: ${errorMessage}`)

        // B-TXN-003: Use typed property access instead of `as any` cast
        const retryCount = item.retry_count ?? 0
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
          console.log(`Recording ${item.recording_id} failed after ${retryCount} retries (max: ${MAX_RETRY_ATTEMPTS})`)
        }
      }
    }

    isProcessing = false
    // AI-11: Reset cancel flag after loop exits, not on a timer
    cancelRequested = false
  } finally {
    // spec-005: Always release mutex lock, even if an error occurred
    releaseTranscriptionLock(processId)
  }
}

/**
 * spec-005: Manually trigger queue processing (exported for IPC handlers).
 * Call after adding items to the queue for immediate processing.
 */
export async function processQueueManually(): Promise<void> {
  return processQueue()
}

interface WhisperJsonSegment {
  text?: string
  start?: number
  end?: number
  speaker?: string
}

interface WhisperJsonOutput {
  text?: string
  language?: string
  segments?: WhisperJsonSegment[]
}

interface LocalTranscriptionResult {
  output: WhisperJsonOutput
  provider: 'local-parakeet' | 'local-whisper'
  model: string
}

interface RunCommandOptions {
  env?: NodeJS.ProcessEnv
  failureFormatter?: (detail: string, command: string) => string
}

function quoteCommandForDisplay(command: string): string {
  if (/^["'].*["']$/.test(command)) return command
  return /\s/.test(command) ? `"${command}"` : command
}

function isMissingNemoError(detail: string): boolean {
  return /(?:ImportError|ModuleNotFoundError):\s+No module named ['"]nemo['"]/.test(detail)
}

function isMissingOfflineModelError(detail: string): boolean {
  const lower = detail.toLowerCase()
  return lower.includes('localentrynotfounderror') ||
    lower.includes('offline mode') ||
    lower.includes('hf_hub_offline') ||
    lower.includes('transformers_offline')
}

function formatParakeetFailure(detail: string, command: string, model: string): string {
  const pythonCommand = quoteCommandForDisplay(command)

  if (isMissingNemoError(detail)) {
    return [
      'Parakeet setup incomplete: NVIDIA NeMo is not installed in the Python environment configured for Parakeet.',
      `Python command: ${pythonCommand}.`,
      `Install it in that same environment: ${pythonCommand} -m pip install torch torchaudio "nemo_toolkit[asr]".`,
      `Then pre-cache the model during setup: ${pythonCommand} -c "import nemo.collections.asr as nemo_asr; nemo_asr.models.ASRModel.from_pretrained(model_name='${model}')".`,
      'You can also set the Parakeet model field to a local .nemo file path.'
    ].join(' ')
  }

  if (isMissingOfflineModelError(detail)) {
    return [
      `Parakeet model "${model}" is not available locally.`,
      'The app runs Parakeet with offline model loading, so pre-cache the model in the configured Python environment or set the Parakeet model field to a local .nemo file path.',
      `Original error: ${detail}`
    ].join(' ')
  }

  return `Local transcription command failed: ${detail}`
}

const PARAKEET_RUNNER_SCRIPT = `
import json
import os
import sys
import traceback

audio_path = sys.argv[1]
output_path = sys.argv[2]
model_name = sys.argv[3]

try:
    import nemo.collections.asr as nemo_asr

    try:
        import torch
    except Exception:
        torch = None

    if os.path.isfile(model_name) and model_name.endswith(".nemo"):
        asr_model = nemo_asr.models.ASRModel.restore_from(restore_path=model_name)
    else:
        asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)

    if torch is not None and torch.cuda.is_available():
        asr_model = asr_model.to("cuda")

    try:
        results = asr_model.transcribe([audio_path], timestamps=True)
    except TypeError:
        results = asr_model.transcribe([audio_path])

    item = results[0]
    text = item if isinstance(item, str) else getattr(item, "text", str(item))
    timestamps = {} if isinstance(item, str) else (getattr(item, "timestamp", None) or {})
    segments = []

    if isinstance(timestamps, dict):
        for segment in timestamps.get("segment", []) or []:
            if isinstance(segment, dict):
                segments.append({
                    "start": segment.get("start"),
                    "end": segment.get("end"),
                    "text": segment.get("segment") or segment.get("text") or ""
                })

    language = "auto" if "parakeet-tdt-0.6b-v3" in model_name else ("en" if "parakeet-tdt-0.6b-v2" in model_name else "")
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"text": text, "language": language, "segments": segments}, handle, ensure_ascii=False)
except Exception:
    traceback.print_exc()
    sys.exit(1)
`

const PARAKEET_MODEL_DOWNLOAD_SCRIPT = `
import json
import os
import sys
import traceback

model_name = sys.argv[1]

try:
    import nemo.collections.asr as nemo_asr

    if os.path.isfile(model_name) and model_name.endswith(".nemo"):
        print(json.dumps({"status": "local-file", "model": model_name}))
    else:
        nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)
        print(json.dumps({"status": "cached", "model": model_name}))
except Exception:
    traceback.print_exc()
    sys.exit(1)
`

function runLocalTranscriptionCommand(
  command: string,
  args: string[],
  progressCallback?: (stage: string, progress: number) => void,
  options: RunCommandOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    progressCallback?.('launching local transcription', 10)

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      reject(new Error(`Failed to start local transcription command "${command}": ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        progressCallback?.('parsing transcript', 85)
        resolve()
        return
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const detail = stderr || stdout || `process exited with code ${code}`
      reject(new Error(options.failureFormatter?.(detail, command) ?? `Local transcription command failed: ${detail}`))
    })
  })
}

function readWhisperOutput(outputDir: string, inputPath: string): WhisperJsonOutput {
  const baseName = basename(inputPath, extname(inputPath))
  const jsonPath = join(outputDir, `${baseName}.json`)
  const txtPath = join(outputDir, `${baseName}.txt`)

  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJsonOutput
  }

  if (existsSync(txtPath)) {
    return {
      text: readFileSync(txtPath, 'utf8')
    }
  }

  throw new Error(`Local transcription command did not create ${jsonPath}`)
}

async function transcribeWithWhisper(
  inputPath: string,
  outputDir: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<LocalTranscriptionResult> {
  const config = getConfig()
  const command = config.transcription.localCommand?.trim()
  if (!command) {
    throw new Error('Whisper command is not configured.')
  }

  const model = config.transcription.localModel || 'base'
  const args = [
    inputPath,
    '--model',
    model,
    '--output_format',
    'json',
    '--output_dir',
    outputDir
  ]

  if (config.transcription.language && config.transcription.language !== 'auto') {
    args.push('--language', config.transcription.language)
  }

  await runLocalTranscriptionCommand(command, args, progressCallback)

  return {
    output: readWhisperOutput(outputDir, inputPath),
    provider: 'local-whisper',
    model
  }
}

async function transcribeWithParakeet(
  inputPath: string,
  outputDir: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<LocalTranscriptionResult> {
  const config = getConfig()
  const command = config.transcription.parakeetPythonCommand?.trim()
  if (!command) {
    throw new Error('Parakeet Python command is not configured.')
  }

  const model = config.transcription.parakeetModel || 'nvidia/parakeet-tdt-0.6b-v3'
  const outputPath = join(outputDir, 'parakeet.json')

  await runLocalTranscriptionCommand(
    command,
    ['-c', PARAKEET_RUNNER_SCRIPT, inputPath, outputPath, model],
    progressCallback,
    {
      env: {
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1'
      },
      failureFormatter: (detail, failedCommand) => formatParakeetFailure(detail, failedCommand, model)
    }
  )

  if (!existsSync(outputPath)) {
    throw new Error(`Parakeet command did not create ${outputPath}`)
  }

  return {
    output: JSON.parse(readFileSync(outputPath, 'utf8')) as WhisperJsonOutput,
    provider: 'local-parakeet',
    model
  }
}

export interface ParakeetModelDownloadResult {
  success: boolean
  model: string
  message?: string
  error?: string
}

export async function downloadParakeetModel(
  pythonCommandOverride?: string,
  modelOverride?: string
): Promise<ParakeetModelDownloadResult> {
  const config = getConfig()
  const command = pythonCommandOverride?.trim() || config.transcription.parakeetPythonCommand?.trim()
  if (!command) {
    throw new Error('Parakeet Python command is not configured.')
  }

  const model = modelOverride?.trim() || config.transcription.parakeetModel || 'nvidia/parakeet-tdt-0.6b-v3'
  if (!model) {
    throw new Error('Parakeet model is not configured.')
  }

  if (model.endsWith('.nemo') && existsSync(model)) {
    return {
      success: true,
      model,
      message: `Parakeet model is already configured as a local file: ${model}`
    }
  }

  await runLocalTranscriptionCommand(
    command,
    ['-c', PARAKEET_MODEL_DOWNLOAD_SCRIPT, model],
    undefined,
    {
      failureFormatter: (detail, failedCommand) => formatParakeetFailure(detail, failedCommand, model)
    }
  )

  return {
    success: true,
    model,
    message: `Parakeet model "${model}" is cached locally.`
  }
}

function normalizeTranscriptText(output: WhisperJsonOutput): string {
  const text = output.text?.trim()
  if (text) return text

  const segmentText = output.segments
    ?.map((segment) => segment.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim()

  if (segmentText) return segmentText
  throw new Error('Local transcription output did not contain transcript text')
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g)
  return matches ? matches.length : 0
}

function buildSpeakersJson(output: WhisperJsonOutput): string | undefined {
  if (!output.segments?.some((segment) => segment.speaker)) {
    return undefined
  }

  return JSON.stringify(
    output.segments.map((segment) => ({
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      text: segment.text
    }))
  )
}

async function transcribeRecording(
  recordingId: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<void> {
  const recording = getRecordingById(recordingId)
  if (!recording || !recording.file_path) {
    throw new Error(`Recording not found or no local file: ${recordingId}`)
  }

  if (!existsSync(recording.file_path)) {
    throw new Error(`Recording file not found: ${recording.file_path}`)
  }

  const config = getConfig()
  if (config.transcription.provider !== 'local') {
    throw new Error('Local transcription provider is disabled.')
  }

  updateRecordingTranscriptionStatus(recordingId, 'processing')
  progressCallback?.('preparing local transcription', 5)

  const outputDir = mkdtempSync(join(tmpdir(), 'hidock-transcription-'))
  try {
    const result = config.transcription.localEngine === 'whisper'
      ? await transcribeWithWhisper(recording.file_path, outputDir, progressCallback)
      : await transcribeWithParakeet(recording.file_path, outputDir, progressCallback)
    const fullText = normalizeTranscriptText(result.output)
    const transcriptId = crypto.randomUUID()
    const language = result.output.language || config.transcription.language || 'unknown'
    const meeting = recording.meeting_id ? getMeetingById(recording.meeting_id) : undefined

    insertTranscript({
      id: transcriptId,
      recording_id: recordingId,
      full_text: fullText,
      language,
      word_count: countWords(fullText),
      speakers: buildSpeakersJson(result.output),
      transcription_provider: result.provider,
      transcription_model: result.model
    })

    progressCallback?.('indexing transcript', 92)
    try {
      await getVectorStore().indexTranscript(fullText, {
        meetingId: recording.meeting_id,
        recordingId,
        timestamp: recording.date_recorded,
        subject: meeting?.subject || recording.filename
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Transcription] Transcript saved, but local embedding index failed: ${message}`)
    }

    updateRecordingTranscriptionStatus(recordingId, 'complete')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

export async function transcribeManually(recordingId: string): Promise<void> {
  try {
    notifyRenderer('transcription:started', { recordingId })
    await transcribeRecording(recordingId)
    notifyRenderer('transcription:completed', { recordingId })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    updateRecordingTranscriptionStatus(recordingId, 'error')
    notifyRenderer('transcription:failed', { recordingId, error: errorMessage })
    throw error
  }
}

export function getTranscriptionStatus(): {
  isProcessing: boolean
  pendingCount: number
  processingCount: number
} {
  const pending = getQueueItems('pending')
  const processing = getQueueItems('processing')

  return {
    isProcessing,
    pendingCount: pending.length,
    processingCount: processing.length
  }
}

function notifyRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}
