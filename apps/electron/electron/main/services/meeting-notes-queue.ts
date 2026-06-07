import { BrowserWindow } from 'electron'
import {
  generateMeetingNotesForRecording,
  type MeetingNotesGenerationResult
} from './meeting-notes'

export type MeetingNotesQueueState = 'queued' | 'generating' | 'complete' | 'skipped' | 'failed'

export type MeetingNotesQueueStatus = {
  recordingId: string
  status: MeetingNotesQueueState
  queuedAt?: string
  startedAt?: string
  completedAt?: string
  result?: MeetingNotesGenerationResult
  error?: string
}

type QueueEntry = {
  recordingId: string
  force: boolean
}

const statuses = new Map<string, MeetingNotesQueueStatus>()
const queue: QueueEntry[] = []
let processing = false

function nowIso(): string {
  return new Date().toISOString()
}

function emitStatus(status: MeetingNotesQueueStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('notes:status-changed', status)
  }
}

function setStatus(recordingId: string, updates: Omit<MeetingNotesQueueStatus, 'recordingId'>): MeetingNotesQueueStatus {
  const current = statuses.get(recordingId)
  const status: MeetingNotesQueueStatus = {
    ...current,
    ...updates,
    recordingId
  }
  statuses.set(recordingId, status)
  emitStatus(status)
  return status
}

function findPending(recordingId: string): QueueEntry | undefined {
  return queue.find((entry) => entry.recordingId === recordingId)
}

export function getMeetingNotesQueueStatus(recordingId: string): MeetingNotesQueueStatus | null {
  return statuses.get(recordingId) ?? null
}

export function isMeetingNotesQueuedOrGenerating(recordingId: string): boolean {
  const status = statuses.get(recordingId)?.status
  return status === 'queued' || status === 'generating'
}

export function enqueueMeetingNotesForRecording(
  recordingId: string,
  options: { force?: boolean } = {}
): MeetingNotesQueueStatus {
  const existing = statuses.get(recordingId)
  if (existing?.status === 'queued' || existing?.status === 'generating') {
    const pending = findPending(recordingId)
    if (pending && options.force) pending.force = true
    return existing
  }

  queue.push({ recordingId, force: options.force === true })
  const status = setStatus(recordingId, {
    status: 'queued',
    queuedAt: nowIso(),
    startedAt: undefined,
    completedAt: undefined,
    result: undefined,
    error: undefined
  })

  void processMeetingNotesQueue()
  return status
}

async function processMeetingNotesQueue(): Promise<void> {
  if (processing) return
  processing = true

  try {
    while (queue.length > 0) {
      const entry = queue.shift()
      if (!entry) continue

      setStatus(entry.recordingId, {
        status: 'generating',
        startedAt: nowIso(),
        completedAt: undefined,
        result: undefined,
        error: undefined
      })

      try {
        const result = await generateMeetingNotesForRecording(entry.recordingId, { force: entry.force })
        const status: MeetingNotesQueueState = result.generated ? 'complete' : 'skipped'
        if (!result.generated && result.skippedReason) {
          console.log(`[MeetingNotes] Skipped for ${entry.recordingId}: ${result.skippedReason}`)
        }
        setStatus(entry.recordingId, {
          status,
          completedAt: nowIso(),
          result,
          error: undefined
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[MeetingNotes] Failed for ${entry.recordingId}: ${message}`)
        setStatus(entry.recordingId, {
          status: 'failed',
          completedAt: nowIso(),
          result: undefined,
          error: message
        })
      }
    }
  } finally {
    processing = false
  }
}
