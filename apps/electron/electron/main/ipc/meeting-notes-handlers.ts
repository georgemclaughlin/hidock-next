import { ipcMain } from 'electron'
import { generateMeetingNotesForRecording } from '../services/meeting-notes'
import {
  enqueueMeetingNotesForRecording,
  getMeetingNotesQueueStatus,
  type MeetingNotesQueueStatus
} from '../services/meeting-notes-queue'
import { error, Result, success } from '../types/api'
import type { MeetingNotesGenerationResult } from '../services/meeting-notes'

export function registerMeetingNotesHandlers(): void {
  ipcMain.handle(
    'notes:generateForRecording',
    async (_event, recordingId: string): Promise<Result<MeetingNotesGenerationResult>> => {
      try {
        if (!recordingId || typeof recordingId !== 'string') {
          return error('VALIDATION_ERROR', 'Recording ID is required')
        }

        return success(await generateMeetingNotesForRecording(recordingId, { force: true }))
      } catch (err) {
        console.error('notes:generateForRecording error:', err)
        return error('INTERNAL_ERROR', 'Failed to generate meeting summary', err)
      }
    }
  )

  ipcMain.handle(
    'notes:enqueueForRecording',
    async (_event, recordingId: string): Promise<Result<MeetingNotesQueueStatus>> => {
      try {
        if (!recordingId || typeof recordingId !== 'string') {
          return error('VALIDATION_ERROR', 'Recording ID is required')
        }

        return success(enqueueMeetingNotesForRecording(recordingId, { force: true }))
      } catch (err) {
        console.error('notes:enqueueForRecording error:', err)
        return error('INTERNAL_ERROR', 'Failed to queue meeting summary', err)
      }
    }
  )

  ipcMain.handle(
    'notes:getStatus',
    async (_event, recordingId: string): Promise<Result<MeetingNotesQueueStatus | null>> => {
      try {
        if (!recordingId || typeof recordingId !== 'string') {
          return error('VALIDATION_ERROR', 'Recording ID is required')
        }

        return success(getMeetingNotesQueueStatus(recordingId))
      } catch (err) {
        console.error('notes:getStatus error:', err)
        return error('INTERNAL_ERROR', 'Failed to read meeting summary status', err)
      }
    }
  )

  console.log('Meeting summary IPC handlers registered')
}
