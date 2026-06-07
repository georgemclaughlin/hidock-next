import { ipcMain } from 'electron'
import { generateMeetingNotesForRecording } from '../services/meeting-notes'
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
        return error('INTERNAL_ERROR', 'Failed to generate meeting notes', err)
      }
    }
  )

  console.log('Meeting notes IPC handlers registered')
}
