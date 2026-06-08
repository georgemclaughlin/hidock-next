import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { OperationsPanel } from '../OperationsPanel'

// Mock stores
import { useAppStore, useDownloadQueue } from '@/store/useAppStore'
import { useTranscriptionStore, useTranscriptionStats } from '@/store/features/useTranscriptionStore'
import { useMeetingNotesQueueStore } from '@/store/features/useMeetingNotesQueueStore'

let notesStatusCallback: ((status: {
  recordingId: string
  status: 'queued' | 'generating' | 'complete' | 'skipped' | 'failed'
  queuedAt?: string
  startedAt?: string
  completedAt?: string
  error?: string
}) => void) | undefined

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn(),
  useDownloadQueue: vi.fn().mockReturnValue(new Map()),
  useDeviceSyncProgress: vi.fn().mockReturnValue(null),
  useDeviceSyncEta: vi.fn().mockReturnValue(null)
}))

vi.mock('@/store/features/useTranscriptionStore', () => ({
  useTranscriptionStore: vi.fn(),
  useTranscriptionStats: vi.fn()
}))

vi.mock('@/hooks/useOperations', () => ({
  useOperations: () => ({
    cancelAllDownloads: vi.fn(),
    cancelAllTranscriptions: vi.fn(),
    cancelTranscription: vi.fn()
  })
}))

function setupDefaultMocks() {
  useMeetingNotesQueueStore.getState().clear()
  notesStatusCallback = undefined
  vi.stubGlobal('electronAPI', {
    notes: {
      onStatusChanged: vi.fn((callback) => {
        notesStatusCallback = callback
        return vi.fn()
      }),
      enqueueForRecording: vi.fn().mockResolvedValue({
        success: true,
        data: { recordingId: 'rec-1', status: 'queued' }
      })
    }
  })

  vi.mocked(useAppStore).mockImplementation((selector: any) => {
    const state = {
      downloadQueue: new Map(),
      deviceSyncProgress: null,
      deviceSyncEta: null,
      unifiedRecordings: []
    }
    return typeof selector === 'function' ? selector(state) : state
  })

  vi.mocked(useTranscriptionStats).mockReturnValue({
    total: 0,
    completed: 0,
    failed: 0,
    processing: 0,
    pending: 0,
    aggregateProgress: 0
  })

  vi.mocked(useTranscriptionStore).mockImplementation((selector: any) => {
    const state = { queue: new Map() }
    return typeof selector === 'function' ? selector(state) : state
  })
}

describe('OperationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultMocks()
  })

  it('renders null when no operations are active', () => {
    const { container } = render(<OperationsPanel sidebarOpen={true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders download section when downloads are active', () => {
    const downloadQueue = new Map([
      ['dl-1', { filename: 'REC0001.WAV', progress: 50 }]
    ])
    vi.mocked(useDownloadQueue).mockReturnValue(downloadQueue as any)
    vi.mocked(useAppStore).mockImplementation((selector: any) => {
      const state = {
        downloadQueue,
        deviceSyncProgress: null,
        deviceSyncEta: null,
        unifiedRecordings: []
      }
      return typeof selector === 'function' ? selector(state) : state
    })

    render(<OperationsPanel sidebarOpen={true} />)

    expect(screen.getByText(/Downloads/)).toBeInTheDocument()
  })

  it('renders transcription section when transcriptions are pending', () => {
    vi.mocked(useTranscriptionStats).mockReturnValue({
      total: 2,
      completed: 0,
      failed: 0,
      processing: 1,
      pending: 1,
      aggregateProgress: 25
    })

    render(<OperationsPanel sidebarOpen={true} />)

    expect(screen.getByText(/Transcriptions/)).toBeInTheDocument()
  })

  it('hides cancel button when sidebar is collapsed', () => {
    const downloadQueue = new Map([
      ['dl-1', { filename: 'REC0001.WAV', progress: 50 }]
    ])
    vi.mocked(useDownloadQueue).mockReturnValue(downloadQueue as any)
    vi.mocked(useAppStore).mockImplementation((selector: any) => {
      const state = {
        downloadQueue,
        deviceSyncProgress: null,
        deviceSyncEta: null,
        unifiedRecordings: []
      }
      return typeof selector === 'function' ? selector(state) : state
    })

    render(<OperationsPanel sidebarOpen={false} />)

    // When collapsed, cancel buttons are hidden
    expect(screen.queryByText(/Cancel all downloads/)).not.toBeInTheDocument()
  })

  it('renders meeting summary operations from notes status events', () => {
    vi.mocked(useAppStore).mockImplementation((selector: any) => {
      const state = {
        downloadQueue: new Map(),
        deviceSyncProgress: null,
        deviceSyncEta: null,
        unifiedRecordings: [
          {
            id: 'rec-1',
            filename: '2026Jun06-133830-Rec24.mp3',
            title: 'Roadmap Review'
          }
        ]
      }
      return typeof selector === 'function' ? selector(state) : state
    })

    render(<OperationsPanel sidebarOpen={true} />)

    act(() => {
      notesStatusCallback?.({
        recordingId: 'rec-1',
        status: 'generating',
        startedAt: '2026-06-07T18:00:00.000Z'
      })
    })

    expect(screen.getByText(/Summaries \(1/)).toBeInTheDocument()
    expect(screen.getByText('Roadmap Review')).toBeInTheDocument()
  })
})
