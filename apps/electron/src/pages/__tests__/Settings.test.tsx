
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Settings } from '../Settings'

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()

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
          localCommand: 'whisper',
          localModel: 'base',
          parakeetPythonCommand: 'python',
          parakeetModel: 'nvidia/parakeet-tdt-0.6b-v2',
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
          localCommand: 'whisper',
          localModel: 'base',
          parakeetPythonCommand: 'python',
          parakeetModel: 'nvidia/parakeet-tdt-0.6b-v2',
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
  }
} as any

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(screen.getByLabelText('Parakeet Python command')).toBeInTheDocument()
    expect(screen.getByLabelText('Parakeet model')).toBeInTheDocument()
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
