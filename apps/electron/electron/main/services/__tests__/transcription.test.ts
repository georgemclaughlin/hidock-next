/**
 * Transcription Service Tests
 *
 * BUG-TX-001: recordings.status stays 'transcribing' forever after transcription failure
 *   OBSERVED: User sees "Transcription in progress..." badge on recordings that failed
 *   ROOT CAUSE: processQueue() catch block updates queue item to 'failed' but did NOT
 *   update recordings.status back from 'transcribing' to 'failed'
 *   FIX: Added updateRecordingStatus(recordingId, 'failed') in the catch block
 *
 * @vitest-environment node
 */

// This test runs in node environment, so we must define mocks BEFORE imports
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track calls to updateRecordingStatus
const mockUpdateRecordingStatus = vi.fn()
const mockUpdateQueueItem = vi.fn()
const mockUpdateQueueProgress = vi.fn()
const mockGetQueueItems = vi.fn()
const mockGetRecordingById = vi.fn()
const mockGetTranscriptByRecordingId = vi.fn()
const mockInsertTranscript = vi.fn()
const mockTranscribeWithNativeModel = vi.fn()
const mockGetNativeModelIdForEngine = vi.fn((engine: string, _configuredModel?: string) => engine === 'parakeet' ? 'parakeet-v3' : 'whisper-small')

// Mock database
vi.mock('../database', () => ({
  getRecordingById: (...args: any[]) => mockGetRecordingById(...args),
  updateRecordingStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  updateRecordingTranscriptionStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  insertTranscript: (...args: any[]) => mockInsertTranscript(...args),
  getTranscriptByRecordingId: (...args: any[]) => mockGetTranscriptByRecordingId(...args),
  getQueueItems: (...args: any[]) => mockGetQueueItems(...args),
  updateQueueItem: (...args: any[]) => mockUpdateQueueItem(...args),
  updateQueueProgress: (...args: any[]) => mockUpdateQueueProgress(...args),
  getMeetingById: vi.fn(),
  findCandidateMeetingsForRecording: vi.fn(() => []),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  acquireTranscriptionLock: vi.fn().mockReturnValue(true),
  releaseTranscriptionLock: vi.fn().mockReturnValue(true),
  clearStaleTranscriptionLock: vi.fn(), // Called on startTranscriptionProcessor()
  resetStuckTranscriptions: vi.fn().mockReturnValue({ recordingsReset: 0, queueItemsReset: 0 }), // Called on startTranscriptionProcessor()
  run: vi.fn(),
  queryOne: vi.fn()
}))

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: { handle: vi.fn() }
}))

// Mock config
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      provider: 'local',
      localEngine: 'parakeet',
      localCommand: '',
      localModel: 'whisper-small',
      parakeetPythonCommand: '',
      parakeetModel: 'parakeet-v3',
      diarizationEnabled: true,
      language: 'auto'
    }
  }))
}))

vi.mock('../native-transcriber', () => ({
  downloadNativeTranscriptionModel: vi.fn(),
  getNativeModelIdForEngine: (engine: string, configuredModel?: string) => mockGetNativeModelIdForEngine(engine, configuredModel),
  listNativeTranscriptionModels: vi.fn(),
  transcribeWithNativeModel: (
    engine: string,
    modelId: string,
    inputPath: string,
    outputPath: string,
    language: string,
    progressCallback?: (stage: string, progress: number) => void,
    diarizationEnabled?: boolean
  ) => mockTranscribeWithNativeModel(engine, modelId, inputPath, outputPath, language, progressCallback, diarizationEnabled)
}))

// Mock fs - simple approach that works in jsdom environment
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdtempSync: vi.fn(() => '/tmp/recorder-transcription-test'),
    rmSync: vi.fn()
  }
})

// Mock vector store
vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    indexTranscript: vi.fn()
  }))
}))

describe('Transcription Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTranscriptByRecordingId.mockReturnValue(undefined)
    mockTranscribeWithNativeModel.mockRejectedValue(new Error('Native transcription sidecar is required but was not found.'))
  })

  describe('BUG-TX-001: recordings.status stuck at transcribing after failure', () => {
    it('should update recordings.status to failed when transcription fails', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'pending',
        attempts: 0
      }
      mockGetQueueItems.mockReturnValue([mockQueueItem])
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        status: 'complete'
      })

      const { startTranscriptionProcessor, stopTranscriptionProcessor } = await import('../transcription')

      startTranscriptionProcessor()
      await new Promise(resolve => setTimeout(resolve, 500))
      stopTranscriptionProcessor()

      // The key assertion: when transcription fails, the recording status
      // must be updated to indicate failure so the UI stops showing "In Progress"
      const statusCalls = mockUpdateRecordingStatus.mock.calls

      // After the fix, we expect:
      // 1. updateRecordingTranscriptionStatus(rec-123, 'processing') - before attempt
      // 2. updateRecordingTranscriptionStatus(rec-123, 'error') - after failure
      // Even if the exact flow varies due to mocking, the FAILURE status call must exist
      const hasFailureCall = statusCalls.some(
        (call: any[]) => call[0] === 'rec-123' && call[1] === 'error'
      )

      // Also verify the queue item was marked as failed
      const queueUpdateCalls = mockUpdateQueueItem.mock.calls
      const hasQueueFailure = queueUpdateCalls.some(
        (call: any[]) => call[0] === 'queue-1' && call[1] === 'failed'
      )

      expect(hasQueueFailure).toBe(true)
      expect(hasFailureCall).toBe(true)
    })

    it('should report missing required native transcription sidecar', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'pending',
        attempts: 0
      }
      mockGetQueueItems.mockReturnValue([mockQueueItem])
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        status: 'complete'
      })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      const failureCall = mockUpdateQueueItem.mock.calls.find(
        (call: any[]) => call[0] === 'queue-1' && call[1] === 'failed'
      )

      expect(mockTranscribeWithNativeModel).toHaveBeenCalledWith(
        'parakeet',
        'parakeet-v3',
        '/recordings/test.wav',
        '/tmp/recorder-transcription-test/native-parakeet.json',
        'auto',
        expect.any(Function),
        true
      )
      expect(failureCall?.[2]).toContain('Native transcription sidecar is required')
    })

    it('should complete transcription when audio has no speech', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'silent.wav',
        status: 'pending',
        attempts: 0,
        retry_count: 0
      }
      mockGetQueueItems.mockImplementation((status?: string) => {
        if (status === 'failed') return []
        if (status === 'pending') return [mockQueueItem]
        return []
      })
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'silent.wav',
        file_path: '/recordings/silent.wav',
        date_recorded: '2026-01-01T00:00:00.000Z',
        status: 'complete',
        transcription_status: 'pending'
      })
      mockTranscribeWithNativeModel.mockResolvedValue({
        output: {
          text: '',
          language: 'unknown',
          segments: []
        },
        provider: 'local-parakeet',
        model: 'parakeet-v3'
      })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      expect(mockInsertTranscript).toHaveBeenCalledWith(expect.objectContaining({
        recording_id: 'rec-123',
        full_text: '',
        word_count: 0,
        speakers: undefined,
        transcription_provider: 'local-parakeet',
        transcription_model: 'parakeet-v3'
      }))
      expect(mockUpdateQueueItem).toHaveBeenCalledWith('queue-1', 'completed')
      expect(mockUpdateRecordingStatus).toHaveBeenCalledWith('rec-123', 'complete')
      expect(mockUpdateQueueItem).not.toHaveBeenCalledWith('queue-1', 'failed', expect.anything())
    })

    it('stores timestamped transcript segments even when diarization returns no speakers', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'timed.wav',
        status: 'pending',
        attempts: 0,
        retry_count: 0
      }
      mockGetQueueItems.mockImplementation((status?: string) => {
        if (status === 'failed') return []
        if (status === 'pending') return [mockQueueItem]
        return []
      })
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'timed.wav',
        file_path: '/recordings/timed.wav',
        date_recorded: '2026-01-01T00:00:00.000Z',
        status: 'complete',
        transcription_status: 'pending'
      })
      mockTranscribeWithNativeModel.mockResolvedValue({
        output: {
          text: 'First segment. Second segment.',
          language: 'en',
          segments: [
            { start: 0.25, end: 2.5, text: 'First segment.' },
            { start: 2.75, end: 5.25, text: 'Second segment.' }
          ]
        },
        provider: 'local-parakeet',
        model: 'parakeet-v3'
      })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      expect(mockInsertTranscript).toHaveBeenCalledWith(expect.objectContaining({
        recording_id: 'rec-123',
        full_text: 'First segment. Second segment.',
        speakers: JSON.stringify([
          { speaker: undefined, start: 0.25, end: 2.5, text: 'First segment.' },
          { speaker: undefined, start: 2.75, end: 5.25, text: 'Second segment.' }
        ])
      }))
    })

    it('should not auto-retry failed queue rows for recordings that already have a transcript', async () => {
      const failedQueueItem = {
        id: 'queue-failed',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'failed',
        attempts: 1,
        retry_count: 0,
        completed_at: new Date(Date.now() - 60_000).toISOString()
      }
      mockGetQueueItems.mockImplementation((status?: string) => {
        if (status === 'failed') return [failedQueueItem]
        if (status === 'pending') return []
        return []
      })
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        transcription_status: 'complete'
      })
      mockGetTranscriptByRecordingId.mockReturnValue({ full_text: 'Already transcribed' })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      expect(mockUpdateQueueItem).not.toHaveBeenCalledWith('queue-failed', 'pending')
      expect(mockUpdateRecordingStatus).not.toHaveBeenCalledWith('rec-123', 'pending')
      expect(mockTranscribeWithNativeModel).not.toHaveBeenCalled()
    })

    it('should not auto-retry permanent audio format failures', async () => {
      const failedQueueItem = {
        id: 'queue-failed',
        recording_id: 'rec-123',
        filename: 'test.mp3',
        status: 'failed',
        attempts: 1,
        retry_count: 0,
        error_message: 'Error: Failed to detect audio format for test.mp3\nCaused by:\n    unsupported feature: core (probe): no suitable format reader found',
        completed_at: new Date(Date.now() - 60_000).toISOString()
      }
      mockGetQueueItems.mockImplementation((status?: string) => {
        if (status === 'failed') return [failedQueueItem]
        if (status === 'pending') return []
        return []
      })
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.mp3',
        file_path: '/recordings/test.mp3',
        transcription_status: 'error'
      })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      expect(mockUpdateQueueItem).not.toHaveBeenCalledWith('queue-failed', 'pending')
      expect(mockUpdateRecordingStatus).not.toHaveBeenCalledWith('rec-123', 'pending')
      expect(mockTranscribeWithNativeModel).not.toHaveBeenCalled()
    })

    it('should complete stale pending queue rows for recordings that already have a transcript', async () => {
      const pendingQueueItem = {
        id: 'queue-pending',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'pending',
        attempts: 1,
        retry_count: 0
      }
      mockGetQueueItems.mockImplementation((status?: string) => {
        if (status === 'failed') return []
        if (status === 'pending') return [pendingQueueItem]
        return []
      })
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        transcription_status: 'pending'
      })
      mockGetTranscriptByRecordingId.mockReturnValue({ full_text: 'Already transcribed' })

      const { processQueueManually } = await import('../transcription')

      await processQueueManually()

      expect(mockUpdateQueueProgress).toHaveBeenCalledWith('queue-pending', 100)
      expect(mockUpdateQueueItem).toHaveBeenCalledWith('queue-pending', 'completed')
      expect(mockUpdateRecordingStatus).toHaveBeenCalledWith('rec-123', 'complete')
      expect(mockTranscribeWithNativeModel).not.toHaveBeenCalled()
    })
  })
})
