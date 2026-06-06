
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Settings } from '../Settings'

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()
const mockDownloadTranscriptionModel = vi.fn()

// Mock the stores
vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      syncCalendar: mockSyncCalendar,
      calendarSyncing: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
  useCalendarSyncing: vi.fn(() => false)
}))

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: {
        calendar: {
          icsUrl: '',
          syncEnabled: false,
          syncIntervalMinutes: 15,
          lastSyncAt: null
        },
        transcription: {
          provider: 'local' as const,
          localEngine: 'parakeet' as const,
          localCommand: '',
          localModel: 'whisper-small',
          parakeetPythonCommand: '',
          parakeetModel: 'parakeet-v3',
          autoTranscribe: false,
          language: 'auto'
        },
        chat: { provider: 'ollama' as const, ollamaModel: 'llama3.2', maxContextChunks: 10 },
        embeddings: { provider: 'ollama' as const, ollamaBaseUrl: 'http://localhost:11434' }
      },
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      configLoading: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  })
}))

// Mock HealthCheck component
vi.mock('@/components/HealthCheck', () => ({
  HealthCheck: () => <div data-testid="health-check">Health Check</div>
}))

// Mock Electron API
global.window.electronAPI = {
  config: {
    get: vi.fn().mockResolvedValue({
      success: true,
      data: {
        calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15 },
        transcription: {
          provider: 'local',
          localEngine: 'parakeet',
          localCommand: '',
          localModel: 'whisper-small',
          parakeetPythonCommand: '',
          parakeetModel: 'parakeet-v3',
          autoTranscribe: false,
          language: 'auto'
        },
        chat: { provider: 'ollama', ollamaModel: 'llama3.2', maxContextChunks: 10 },
        embeddings: { provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434' }
      }
    }),
    updateSection: vi.fn().mockResolvedValue({ success: true })
  },
  storage: {
    getInfo: vi.fn().mockResolvedValue({
      success: true,
      data: {
        dataPath: '/data',
        recordingsPath: '/recordings',
        transcriptsPath: '/transcripts',
        cachePath: '/cache',
        databasePath: '/db',
        totalSizeBytes: 1024000,
        recordingsCount: 5
      }
    }),
    openFolder: vi.fn()
  },
  recordings: {
    downloadParakeetModel: vi.fn(),
    getTranscriptionModels: vi.fn().mockResolvedValue([
      {
        id: 'parakeet-v3',
        name: 'Parakeet V3',
        description: 'CPU-optimized Parakeet V3 INT8 model.',
        size_mb: 456,
        is_downloaded: false,
        engine_type: 'parakeet'
      },
      {
        id: 'whisper-small',
        name: 'Whisper Small',
        description: 'CPU-capable Whisper model with modest resource usage.',
        size_mb: 465,
        is_downloaded: false,
        engine_type: 'whisper'
      }
    ]),
    downloadTranscriptionModel: mockDownloadTranscriptionModel
  }
} as any

beforeEach(() => {
  vi.clearAllMocks()
  mockDownloadTranscriptionModel.mockResolvedValue({
    success: true,
    model: 'parakeet-v3',
    message: 'Parakeet V3 is downloaded for local transcription.'
  })
})

describe('Settings Page', () => {
  it('should render settings sections', async () => {
    render(<Settings />)

    expect(screen.getByText('Local Transcription')).toBeInTheDocument()
    expect(screen.getByText('Local Assistant')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
  })

  it('should render transcription settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Local transcription engine')).toBeInTheDocument()
    expect(screen.getByLabelText('Parakeet model')).toBeInTheDocument()
    expect(screen.getByLabelText('Download parakeet model')).toBeInTheDocument()
  })

  it('should download the configured Parakeet model', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByLabelText('Download parakeet model'))

    await waitFor(() => {
      expect(mockDownloadTranscriptionModel).toHaveBeenCalledWith(
        'parakeet',
        'parakeet-v3'
      )
    })
  })

  it('should render local assistant settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Ollama base URL')).toBeInTheDocument()
    expect(screen.getByLabelText('RAG context window size')).toBeInTheDocument()
  })

  it('should render save buttons for each section', async () => {
    render(<Settings />)

    const saveButtons = screen.getAllByLabelText(/Save.*settings/)
    expect(saveButtons.length).toBe(2) // Transcription and Chat
  })

  it('should render storage section', async () => {
    render(<Settings />)

    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Local data storage information')).toBeInTheDocument()
  })

  it('should render health check component', async () => {
    render(<Settings />)

    expect(screen.getByTestId('health-check')).toBeInTheDocument()
  })
})
