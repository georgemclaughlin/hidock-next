import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ProcessingPipelineTracker } from '../ProcessingPipelineTracker'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { AppConfig, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'

const mockGetNotesStatus = vi.fn().mockResolvedValue({ success: true, data: null })
const mockOnNotesStatusChanged = vi.fn(() => vi.fn())

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: '1.0.0',
    storage: { dataPath: '/data', maxRecordingsGB: 10 },
    privacy: { localOnly: true, allowRemoteOllama: false },
    calendar: {
      icsUrl: '',
      syncEnabled: false,
      syncIntervalMinutes: 15,
      lastSyncAt: null
    },
    transcription: {
      provider: 'local',
      localEngine: 'parakeet',
      autoTranscribe: false,
      language: 'auto',
      localCommand: '',
      localModel: 'whisper-small',
      parakeetPythonCommand: '',
      parakeetModel: 'parakeet-v3',
      diarizationEnabled: true
    },
    embeddings: {
      nativeModel: 'bge-small-en-v1.5-q',
      chunkSize: 500,
      chunkOverlap: 50
    },
    notes: {
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'llama3.2',
      thinkingEnabled: true,
      autoGenerate: true
    },
    device: {
      autoConnect: false,
      autoDownload: false
    },
    ui: {
      theme: 'system',
      defaultView: 'week',
      startOfWeek: 1,
      calendarView: 'week',
      hideEmptyMeetings: false,
      showListView: true,
      officeHoursStart: 8,
      officeHoursEnd: 17,
      workDays: [1, 2, 3, 4, 5]
    },
    ...overrides
  }
}

function makeRecording(overrides: Partial<UnifiedRecording> = {}): UnifiedRecording {
  return {
    id: 'rec-1',
    filename: 'meeting.wav',
    size: 1024,
    duration: 60,
    dateRecorded: new Date('2026-06-06T12:00:00Z'),
    transcriptionStatus: 'complete',
    location: 'local-only',
    localPath: '/recordings/meeting.wav',
    syncStatus: 'synced',
    ...overrides
  } as UnifiedRecording
}

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: 'transcript-1',
    recording_id: 'rec-1',
    full_text: 'This transcript is complete.',
    language: 'en',
    summary: null,
    action_items: null,
    topics: null,
    key_points: null,
    sentiment: null,
    speakers: null,
    word_count: 4,
    transcription_provider: 'local-parakeet',
    transcription_model: 'parakeet-v3',
    title_suggestion: null,
    question_suggestions: null,
    created_at: '2026-06-06T12:00:00Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: makeConfig(),
    configLoading: false,
    configReady: true
  })

  Object.defineProperty(window, 'electronAPI', {
    value: {
      embeddings: {
        getRecordingIndexStats: vi.fn().mockResolvedValue({
          success: true,
          data: {
            recordingId: 'rec-1',
            documentCount: 0,
            currentModelDocumentCount: 0,
            incompatibleDocumentCount: 0,
            embeddingProvider: 'native-fastembed',
            embeddingModel: 'bge-small-en-v1.5-q'
          }
        })
      },
      notes: {
        getStatus: mockGetNotesStatus,
        onStatusChanged: mockOnNotesStatusChanged
      }
    },
    writable: true,
    configurable: true
  })
})

describe('ProcessingPipelineTracker', () => {
  it('shows summarize as ready when the local notes URL is configured', () => {
    render(<ProcessingPipelineTracker recording={makeRecording()} transcript={makeTranscript()} />)

    const summaryStage = screen.getByText('Summarize').closest('.group')
    expect(summaryStage).not.toBeNull()
    expect(within(summaryStage as HTMLElement).getByText('Ready')).toBeInTheDocument()
  })

  it('shows summarize as configure when the local notes URL is missing', () => {
    const config = makeConfig()
    useConfigStore.setState({
      config: {
        ...config,
        notes: {
          ...config.notes,
          ollamaBaseUrl: ''
        }
      }
    })

    render(<ProcessingPipelineTracker recording={makeRecording()} transcript={makeTranscript()} />)

    const summaryStage = screen.getByText('Summarize').closest('.group')
    expect(summaryStage).not.toBeNull()
    expect(within(summaryStage as HTMLElement).getByText('Configure')).toBeInTheDocument()
  })

  it('shows summarize as running while notes are generating', async () => {
    mockGetNotesStatus.mockResolvedValueOnce({
      success: true,
      data: {
        recordingId: 'rec-1',
        status: 'generating'
      }
    })

    render(<ProcessingPipelineTracker recording={makeRecording()} transcript={makeTranscript()} />)

    const summaryStage = screen.getByText('Summarize').closest('.group')
    expect(summaryStage).not.toBeNull()
    expect(await within(summaryStage as HTMLElement).findByText('Running')).toBeInTheDocument()
  })

  it('shows diarization as skipped when disabled', () => {
    const config = makeConfig()
    useConfigStore.setState({
      config: {
        ...config,
        transcription: {
          ...config.transcription,
          diarizationEnabled: false
        }
      }
    })

    render(<ProcessingPipelineTracker recording={makeRecording()} transcript={makeTranscript()} />)

    const diarizeStage = screen.getByText('Diarize').closest('.group')
    expect(diarizeStage).not.toBeNull()
    expect(within(diarizeStage as HTMLElement).getByText('Skipped')).toBeInTheDocument()
  })
})
