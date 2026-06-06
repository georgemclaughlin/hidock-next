/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  queryAll: vi.fn(),
  run: vi.fn()
}))

vi.mock('electron', () => {
  const electronMock = {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [])
    },
    Notification: {
      isSupported: vi.fn(() => false)
    },
    ipcMain: {
      handle: vi.fn()
    }
  }
  return {
    ...electronMock,
    default: electronMock
  }
})

vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(),
  addSyncedFile: vi.fn(),
  isFileSynced: vi.fn(() => false),
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFilenames: vi.fn(() => new Set()),
  addToQueue: vi.fn(),
  updateRecordingTranscriptionStatus: vi.fn(),
  queryOne: vi.fn(() => null),
  queryAll: dbMocks.queryAll,
  run: dbMocks.run,
  runInTransaction: vi.fn((fn: () => void) => fn())
}))

vi.mock('../file-storage', () => ({
  saveRecording: vi.fn().mockResolvedValue('/mock/recordings/file.mp3'),
  getRecordingsPath: vi.fn(() => '/mock/recordings')
}))

vi.mock('../activity-log', () => ({
  emitActivityLog: vi.fn()
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      autoTranscribe: false
    }
  }))
}))

vi.mock('../transcription', () => ({
  processQueueManually: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => false) },
    existsSync: vi.fn(() => false)
  }
})

describe('DownloadService startup queue reconciliation', () => {
  it('clears non-resumable pending and downloading rows on startup', async () => {
    vi.resetModules()
    dbMocks.queryAll.mockReturnValueOnce([
      {
        id: '2026Jun06-133908-Rec27.hda',
        filename: '2026Jun06-133908-Rec27.hda',
        file_size: 1024,
        progress: 0,
        status: 'pending',
        error: null,
        started_at: null,
        completed_at: null,
        recording_date: null
      },
      {
        id: '2026Jun06-133854-Rec26.hda',
        filename: '2026Jun06-133854-Rec26.hda',
        file_size: 2048,
        progress: 10,
        status: 'downloading',
        error: null,
        started_at: '2026-06-06T18:38:54.000Z',
        completed_at: null,
        recording_date: null
      }
    ])

    const { getDownloadService } = await import('../download-service')
    const service = getDownloadService()

    expect(dbMocks.run).toHaveBeenCalledWith("DELETE FROM download_queue WHERE status IN ('pending', 'downloading')")
    expect(service.getState().queue).toEqual([])

    service.destroy()
  })
})
