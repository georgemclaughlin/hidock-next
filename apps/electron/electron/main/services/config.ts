import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

// CS-007: Encrypt sensitive config values (ICS URL) at rest using Electron safeStorage
function encryptSensitive(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable() && value) {
      return '__enc__' + safeStorage.encryptString(value).toString('base64')
    }
  } catch { /* fall through to plaintext */ }
  return value
}

function decryptSensitive(value: string): string {
  try {
    if (value.startsWith('__enc__') && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(7), 'base64'))
    }
  } catch { /* fall through to return as-is */ }
  return value
}

export interface AppConfig {
  version: string
  storage: {
    dataPath: string
    maxRecordingsGB: number
  }
  privacy: {
    localOnly: boolean
    allowRemoteOllama: boolean
  }
  calendar: {
    icsUrl: string
    syncEnabled: boolean
    syncIntervalMinutes: number
    lastSyncAt: string | null
  }
  transcription: {
    provider: 'local'
    localEngine: 'parakeet' | 'whisper'
    autoTranscribe: boolean
    language: string
    localCommand: string
    localModel: string
    parakeetPythonCommand: string
    parakeetModel: string
  }
  embeddings: {
    provider: 'native' | 'ollama'
    nativeModel: string
    ollamaBaseUrl: string
    ollamaModel: string
    chunkSize: number
    chunkOverlap: number
  }
  chat: {
    provider: 'ollama'
    ollamaModel: string
    maxContextChunks: number
  }
  device: {
    autoConnect: boolean
    autoDownload: boolean
  }
  ui: {
    theme: 'light' | 'dark' | 'system'
    defaultView: 'week' | 'month'
    startOfWeek: number
    calendarView: 'day' | 'workweek' | 'week' | 'month'
    hideEmptyMeetings: boolean
    showListView: boolean
  }
}

const DEFAULT_CONFIG: AppConfig = {
  version: '1.0.0',
  storage: {
    dataPath: join(app.getPath('home'), 'LocalRecorder'),
    maxRecordingsGB: 50
  },
  privacy: {
    localOnly: true,
    allowRemoteOllama: false
  },
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
    parakeetModel: 'parakeet-v3'
  },
  embeddings: {
    provider: 'native',
    nativeModel: 'bge-small-en-v1.5-q',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    chunkSize: 500,
    chunkOverlap: 50
  },
  chat: {
    provider: 'ollama',
    ollamaModel: 'llama3.2',
    maxContextChunks: 10
  },
  device: {
    autoConnect: true,
    autoDownload: true
  },
  ui: {
    theme: 'system',
    defaultView: 'week',
    startOfWeek: 1, // Monday
    calendarView: 'week',
    hideEmptyMeetings: true,
    showListView: false
  }
}

let config: AppConfig = { ...DEFAULT_CONFIG }

const LEGACY_DEFAULT_PARAKEET_MODELS = new Set([
  'nvidia/parakeet-tdt-0.6b-v2',
  'nvidia/parakeet-tdt-0.6b-v3'
])

function normalizeNativeWhisperModel(value?: string): string {
  const model = value?.trim().toLowerCase()
  if (model === 'whisper-medium' || model === 'medium') {
    return 'whisper-medium'
  }

  return 'whisper-small'
}

function normalizeNativeParakeetModel(value?: string): string {
  const model = value?.trim()
  if (!model || LEGACY_DEFAULT_PARAKEET_MODELS.has(model)) {
    return DEFAULT_CONFIG.transcription.parakeetModel
  }

  return model
}

function normalizeNativeEmbeddingModel(value?: string): string {
  const model = value?.trim().toLowerCase()
  if (!model) return DEFAULT_CONFIG.embeddings.nativeModel
  if (model === 'bge-small' || model === 'bge-small-en-v1.5') {
    return 'bge-small-en-v1.5-q'
  }
  if (model === 'nomic-embed-text' || model === 'nomic-embed-text-v1.5') {
    return 'nomic-embed-text-v1.5-q'
  }
  return model
}

function shouldMigrateLegacyEmbeddingProvider(savedConfig: Partial<AppConfig>): boolean {
  const embeddings = savedConfig.embeddings as Partial<AppConfig['embeddings']> | undefined
  return embeddings?.provider === 'ollama' && embeddings.nativeModel === undefined
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

function normalizeLocalOnlyConfig(value: AppConfig): AppConfig {
  const allowRemoteOllama = value.privacy?.allowRemoteOllama === true
  const ollamaBaseUrl = value.embeddings?.ollamaBaseUrl || DEFAULT_CONFIG.embeddings.ollamaBaseUrl
  const parakeetModel = normalizeNativeParakeetModel(value.transcription?.parakeetModel)
  const embeddingProvider = value.embeddings?.provider === 'ollama' ? 'ollama' : 'native'

  return {
    ...value,
    privacy: {
      localOnly: true,
      allowRemoteOllama
    },
    calendar: {
      ...value.calendar,
      icsUrl: '',
      syncEnabled: false
    },
    transcription: {
      provider: 'local',
      localEngine: value.transcription?.localEngine === 'whisper' ? 'whisper' : 'parakeet',
      autoTranscribe: value.transcription?.autoTranscribe === true,
      language: value.transcription?.language || DEFAULT_CONFIG.transcription.language,
      localCommand: DEFAULT_CONFIG.transcription.localCommand,
      localModel: normalizeNativeWhisperModel(value.transcription?.localModel),
      parakeetPythonCommand: DEFAULT_CONFIG.transcription.parakeetPythonCommand,
      parakeetModel
    },
    embeddings: {
      ...value.embeddings,
      provider: embeddingProvider,
      nativeModel: normalizeNativeEmbeddingModel(value.embeddings?.nativeModel),
      ollamaModel: value.embeddings?.ollamaModel || DEFAULT_CONFIG.embeddings.ollamaModel,
      chunkSize: value.embeddings?.chunkSize || DEFAULT_CONFIG.embeddings.chunkSize,
      chunkOverlap: value.embeddings?.chunkOverlap || DEFAULT_CONFIG.embeddings.chunkOverlap,
      ollamaBaseUrl: allowRemoteOllama || isLoopbackHttpUrl(ollamaBaseUrl)
        ? ollamaBaseUrl
        : DEFAULT_CONFIG.embeddings.ollamaBaseUrl
    },
    chat: {
      provider: 'ollama',
      ollamaModel: value.chat?.ollamaModel || DEFAULT_CONFIG.chat.ollamaModel,
      maxContextChunks: value.chat?.maxContextChunks || DEFAULT_CONFIG.chat.maxContextChunks
    }
  }
}

export function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function getDataPath(): string {
  return config.storage.dataPath
}

export async function initializeConfig(): Promise<void> {
  const configPath = getConfigPath()

  try {
    if (existsSync(configPath)) {
      const fileContent = readFileSync(configPath, 'utf-8')
      const savedConfig = JSON.parse(fileContent)
      // CS-007: Decrypt sensitive fields before loading into memory
      if (savedConfig.calendar?.icsUrl) {
        savedConfig.calendar.icsUrl = decryptSensitive(savedConfig.calendar.icsUrl)
      }
      // Merge with defaults to handle new fields
      const mergedConfig = deepMerge(DEFAULT_CONFIG, savedConfig)
      if (shouldMigrateLegacyEmbeddingProvider(savedConfig)) {
        mergedConfig.embeddings.provider = DEFAULT_CONFIG.embeddings.provider
      }
      config = normalizeLocalOnlyConfig(mergedConfig)
    } else {
      // Create config file with defaults
      await saveConfig(DEFAULT_CONFIG)
    }
  } catch (error) {
    console.error('Error loading config:', error)
    config = normalizeLocalOnlyConfig({ ...DEFAULT_CONFIG })
  }
}

export function getConfig(): AppConfig {
  return { ...config }
}

export function getConfigValue(path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) {
      return (value as Record<string, unknown>)[key]
    }
    return undefined
  }, config)
}

export async function saveConfig(newConfig: Partial<AppConfig>): Promise<void> {
  config = normalizeLocalOnlyConfig(deepMerge(config, newConfig))

  const configPath = getConfigPath()
  const configDir = join(configPath, '..')

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  // CS-007: Encrypt sensitive fields before writing to disk
  const toWrite = {
    ...config,
    calendar: {
      ...config.calendar,
      icsUrl: encryptSensitive(config.calendar.icsUrl)
    }
  }
  writeFileSync(configPath, JSON.stringify(toWrite, null, 2))
}

export async function updateConfig<K extends keyof AppConfig>(
  section: K,
  values: Partial<AppConfig[K]>
): Promise<void> {
  const updatedSection = { ...(config[section] as any), ...values }
  await saveConfig({ [section]: updatedSection } as Partial<AppConfig>)
}

// Deep merge utility
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key]
      const targetValue = result[key]

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue, sourceValue as Partial<typeof targetValue>)
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue as T[Extract<keyof T, string>]
      }
    }
  }

  return result
}
