import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
import {
  downloadNativeTranscriptionModel,
  getNativeModelIdForEngine,
  listNativeTranscriptionModels,
  transcribeWithNativeModel,
  type NativeModelDownloadProgress,
  type NativeTranscriptionEngine,
  type NativeTranscriptionModel,
  type NativeTranscriptOutput,
  type NativeTranscriptionResult
} from './native-transcriber'

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
      'Native transcription sidecar is required',
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

async function transcribeWithWhisper(
  inputPath: string,
  outputDir: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<NativeTranscriptionResult> {
  const config = getConfig()
  const model = config.transcription.localModel || 'whisper-small'
  return transcribeWithNativeModel(
    'whisper',
    getNativeModelIdForEngine('whisper', model),
    inputPath,
    join(outputDir, 'native-whisper.json'),
    config.transcription.language || 'auto',
    progressCallback
  )
}

async function transcribeWithParakeet(
  inputPath: string,
  outputDir: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<NativeTranscriptionResult> {
  const config = getConfig()
  const model = config.transcription.parakeetModel || 'parakeet-v3'
  return transcribeWithNativeModel(
    'parakeet',
    getNativeModelIdForEngine('parakeet', model),
    inputPath,
    join(outputDir, 'native-parakeet.json'),
    config.transcription.language || 'auto',
    progressCallback
  )
}

export interface ParakeetModelDownloadResult {
  success: boolean
  model: string
  message?: string
  error?: string
}

export async function downloadParakeetModel(
  _pythonCommandOverride?: string,
  modelOverride?: string,
  onProgress?: (progress: NativeModelDownloadProgress) => void
): Promise<ParakeetModelDownloadResult> {
  return downloadNativeTranscriptionModel(getNativeModelIdForEngine('parakeet', modelOverride), onProgress)
}

export async function listLocalTranscriptionModels(): Promise<NativeTranscriptionModel[]> {
  return listNativeTranscriptionModels()
}

export async function downloadLocalTranscriptionModel(
  engineOverride?: NativeTranscriptionEngine,
  modelOverride?: string,
  onProgress?: (progress: NativeModelDownloadProgress) => void
): Promise<ParakeetModelDownloadResult> {
  const config = getConfig()
  const engine = engineOverride || config.transcription.localEngine
  const configuredModel = modelOverride || (
    engine === 'whisper'
      ? config.transcription.localModel
      : config.transcription.parakeetModel
  )
  return downloadNativeTranscriptionModel(getNativeModelIdForEngine(engine, configuredModel), onProgress)
}

function normalizeTranscriptText(output: NativeTranscriptOutput): string {
  const text = output.text?.trim()
  const segmentText = output.segments
    ?.map((segment) => segment.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim()

  if (segmentText && (!text || countWords(segmentText) > countWords(text))) {
    return segmentText
  }
  if (text) return text
  if (segmentText) return segmentText
  throw new Error('Local transcription output did not contain transcript text')
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g)
  return matches ? matches.length : 0
}

function buildTranscriptSegmentsJson(output: NativeTranscriptOutput): string | undefined {
  const segments = output.segments
    ?.map((segment) => ({
      speaker: segment.speaker?.trim() || undefined,
      start: typeof segment.start === 'number' ? segment.start : undefined,
      end: typeof segment.end === 'number' ? segment.end : undefined,
      text: segment.text?.trim()
    }))
    .filter((segment) => Boolean(segment.text))

  if (!segments?.length) {
    return undefined
  }

  if (!segments.some((segment) => Boolean(segment.speaker))) {
    return undefined
  }

  return JSON.stringify(segments)
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

  const outputDir = mkdtempSync(join(tmpdir(), 'recorder-transcription-'))
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
      speakers: buildTranscriptSegmentsJson(result.output),
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
