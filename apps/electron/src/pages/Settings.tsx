import { useEffect, useState, useCallback, useMemo } from 'react'
import { Save, FolderOpen, RefreshCw, AlertCircle, Download, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { formatBytes } from '@/lib/utils'
import { HealthCheck } from '@/components/HealthCheck'
import { toast } from '@/components/ui/toaster'
import type { StorageInfo, AppConfig } from '@/types'

// RAG configuration constants — MAX_CONTEXT_CHUNKS must match config.ts default (10)
const RAG_DEFAULTS = {
  MAX_CONTEXT_CHUNKS: 10,
  MIN_CONTEXT_CHUNKS: 1,
  MAX_CONTEXT_CHUNKS_LIMIT: 20
} as const

type LocalTranscriptionEngine = AppConfig['transcription']['localEngine']

type TranscriptionModelOption = {
  id: string
  name: string
  description: string
  size_mb: number
  is_downloaded: boolean
  engine_type: LocalTranscriptionEngine
}

type EmbeddingProvider = AppConfig['embeddings']['provider']

type EmbeddingModelOption = {
  id: string
  name: string
  description: string
  dimensions: number
  provider: 'native-fastembed'
  is_downloaded: boolean
}

type EmbeddingIndexStats = {
  documentCount: number
  meetingCount: number
  currentModelDocumentCount: number
  incompatibleDocumentCount: number
  embeddingProvider: string
  embeddingModel: string
}

type EmbeddingReindexResult = {
  totalTranscripts: number
  reindexedTranscripts: number
  indexedChunks: number
  skipped: number
  failed: Array<{ recordingId: string; error: string }>
}

type ModelDownloadProgress = {
  model: string
  stage: string
  progress: number
  downloadedBytes?: number
  totalBytes?: number
}

type PipelineSettingStage = {
  label: string
  status: string
  description: string
  sectionId: string
}

const MODEL_DOWNLOAD_STAGE_LABELS: Record<string, string> = {
  starting: 'Preparing download',
  downloading: 'Downloading model',
  verifying: 'Verifying download',
  extracting: 'Installing model',
  ready: 'Model downloaded'
}

function formatModelDownloadStatus(progress: ModelDownloadProgress | null): string {
  if (!progress) return 'Preparing download'

  const label = MODEL_DOWNLOAD_STAGE_LABELS[progress.stage] ?? 'Downloading model'
  if (
    progress.stage === 'downloading' &&
    progress.downloadedBytes !== undefined &&
    progress.totalBytes !== undefined
  ) {
    return `${label} ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
  }

  return label
}

function PipelineSettingStageCard({
  stage,
  onSelect
}: {
  stage: PipelineSettingStage
  onSelect: (sectionId: string) => void
}) {
  const isReady = ['Ready', 'Configured', 'Bundled'].includes(stage.status)

  return (
    <button
      type="button"
      onClick={() => onSelect(stage.sectionId)}
      className="min-w-0 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{stage.label}</span>
        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal ${
          isReady ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        }`}>
          {stage.status}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{stage.description}</p>
    </button>
  )
}

export function Settings() {
  // SM-09 fix: Use granular selectors
  const { config, loadConfig, updateConfig, configLoading } = useConfigStore()
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null) // B-SET-002: Storage error state
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Local form state
  const chatProvider = 'ollama' as const
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [transcriptionEngine, setTranscriptionEngine] = useState<LocalTranscriptionEngine>('parakeet')
  const [transcriptionModel, setTranscriptionModel] = useState('whisper-small')
  const [parakeetModel, setParakeetModel] = useState('parakeet-v3')
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('auto')
  const [autoTranscribe, setAutoTranscribe] = useState(false)
  const [modelDownloading, setModelDownloading] = useState(false)
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress | null>(null)
  const [transcriptionModels, setTranscriptionModels] = useState<TranscriptionModelOption[]>([])
  const [embeddingProvider, setEmbeddingProvider] = useState<EmbeddingProvider>('native')
  const [nativeEmbeddingModel, setNativeEmbeddingModel] = useState('bge-small-en-v1.5-q')
  const [ollamaEmbeddingModel, setOllamaEmbeddingModel] = useState('nomic-embed-text')
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModelOption[]>([])
  const [embeddingModelDownloading, setEmbeddingModelDownloading] = useState(false)
  const [embeddingReindexing, setEmbeddingReindexing] = useState(false)
  const [embeddingIndexStats, setEmbeddingIndexStats] = useState<EmbeddingIndexStats | null>(null)
  const [lastEmbeddingReindex, setLastEmbeddingReindex] = useState<EmbeddingReindexResult | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  // C-CHAT: RAG context window — default matches config.ts (10)
  const [ragContextSize, setRagContextSize] = useState<number>(RAG_DEFAULTS.MAX_CONTEXT_CHUNKS)

  // Validation function for config values
  const validateConfig = useCallback((updates: Partial<AppConfig>): string | null => {
    // Embeddings settings validation
    if (updates.transcription) {
      if (updates.transcription.localEngine === 'whisper') {
        if (updates.transcription.localModel !== undefined && !updates.transcription.localModel.trim()) {
          return 'Whisper model is required'
        }
        if (updates.transcription.language !== undefined && !updates.transcription.language.trim()) {
          return 'Transcription language is required'
        }
      }
      if (updates.transcription.localEngine === 'parakeet') {
        if (updates.transcription.parakeetModel !== undefined && !updates.transcription.parakeetModel.trim()) {
          return 'Parakeet model is required'
        }
      }
    }

    if (updates.embeddings) {
      if (updates.embeddings.provider !== undefined && !['native', 'ollama'].includes(updates.embeddings.provider)) {
        return 'Embedding provider must be native or Ollama'
      }
      if (updates.embeddings.nativeModel !== undefined && !updates.embeddings.nativeModel.trim()) {
        return 'Native embedding model is required'
      }
      if (updates.embeddings.ollamaModel !== undefined && !updates.embeddings.ollamaModel.trim()) {
        return 'Ollama embedding model is required'
      }
      if (updates.embeddings.ollamaBaseUrl !== undefined) {
        const url = updates.embeddings.ollamaBaseUrl.trim()
        if (url && !url.startsWith('http')) {
          return 'Ollama URL must start with http:// or https://'
        }
      }
    }

    return null // Valid
  }, [])

  const isChatDirty = useMemo(() => {
    if (!config) return false
    return (
      ollamaUrl !== config.embeddings.ollamaBaseUrl ||
      ragContextSize !== config.chat.maxContextChunks
    )
  }, [config, ollamaUrl, ragContextSize])

  const isEmbeddingDirty = useMemo(() => {
    if (!config) return false
    return (
      embeddingProvider !== config.embeddings.provider ||
      nativeEmbeddingModel !== config.embeddings.nativeModel ||
      ollamaEmbeddingModel !== config.embeddings.ollamaModel
    )
  }, [config, embeddingProvider, nativeEmbeddingModel, ollamaEmbeddingModel])

  const isTranscriptionDirty = useMemo(() => {
    if (!config) return false
    return (
      transcriptionEngine !== config.transcription.localEngine ||
      transcriptionModel !== config.transcription.localModel ||
      parakeetModel !== config.transcription.parakeetModel ||
      transcriptionLanguage !== config.transcription.language ||
      autoTranscribe !== config.transcription.autoTranscribe
    )
  }, [
    autoTranscribe,
    config,
    transcriptionEngine,
    transcriptionModel,
    parakeetModel,
    transcriptionLanguage
  ])

  const parakeetModelOptions = useMemo(
    () => transcriptionModels.filter((model) => model.engine_type === 'parakeet'),
    [transcriptionModels]
  )
  const whisperModelOptions = useMemo(
    () => transcriptionModels.filter((model) => model.engine_type === 'whisper'),
    [transcriptionModels]
  )
  const availableTranscriptionEngines = useMemo<LocalTranscriptionEngine[]>(() => {
    if (transcriptionModels.length === 0) return ['parakeet', 'whisper']

    return [
      parakeetModelOptions.length > 0 ? 'parakeet' : null,
      whisperModelOptions.length > 0 ? 'whisper' : null
    ].filter((engine): engine is LocalTranscriptionEngine => Boolean(engine))
  }, [parakeetModelOptions.length, transcriptionModels.length, whisperModelOptions.length])
  const parakeetSelectOptions = parakeetModelOptions.length > 0
    ? parakeetModelOptions
    : [{
        id: 'parakeet-v3',
        name: 'Parakeet V3',
        description: 'CPU-optimized Parakeet V3 INT8 model.',
        size_mb: 456,
        is_downloaded: false,
        engine_type: 'parakeet' as const
      }]
  const whisperSelectOptions = whisperModelOptions.length > 0
    ? whisperModelOptions
    : [
        {
          id: 'whisper-small',
          name: 'Whisper Small',
          description: 'CPU-capable Whisper model with modest resource usage.',
          size_mb: 465,
          is_downloaded: false,
          engine_type: 'whisper' as const
        },
        {
          id: 'whisper-medium',
          name: 'Whisper Medium',
          description: 'More accurate Whisper model; slower on CPU.',
          size_mb: 469,
          is_downloaded: false,
          engine_type: 'whisper' as const
        }
      ]
  const selectedModelId = transcriptionEngine === 'whisper'
    ? transcriptionModel.trim()
    : parakeetModel.trim()
  const selectedTranscriptionModel = useMemo(
    () => transcriptionModels.find((model) => model.id === selectedModelId),
    [selectedModelId, transcriptionModels]
  )
  const selectedModelDownloaded = selectedTranscriptionModel?.is_downloaded ?? false
  const selectedModelSize = selectedTranscriptionModel
    ? formatBytes(selectedTranscriptionModel.size_mb * 1024 * 1024)
    : null
  const activeModelProgress = modelDownloadProgress?.model === selectedModelId
    ? modelDownloadProgress
    : null
  const downloadProgressValue = activeModelProgress?.progress ?? 0
  const downloadButtonLabel = modelDownloading
    ? 'Downloading Model'
    : selectedModelDownloaded
      ? 'Model Downloaded'
      : 'Download Model'
  const embeddingSelectOptions = embeddingModels.length > 0
    ? embeddingModels
    : [{
        id: 'bge-small-en-v1.5-q',
        name: 'BGE Small EN v1.5',
        description: 'Fast local English embedding model.',
        dimensions: 384,
        provider: 'native-fastembed' as const,
        is_downloaded: false
      }]
  const selectedEmbeddingModel = useMemo(
    () => embeddingModels.find((model) => model.id === nativeEmbeddingModel),
    [embeddingModels, nativeEmbeddingModel]
  )
  const selectedEmbeddingModelDownloaded = selectedEmbeddingModel?.is_downloaded ?? false
  const embeddingDownloadButtonLabel = embeddingModelDownloading
    ? 'Downloading Model'
    : selectedEmbeddingModelDownloaded
      ? 'Model Downloaded'
      : 'Download Model'
  const pipelineSettingStages = useMemo<PipelineSettingStage[]>(() => [
    {
      label: 'Transcribe',
      status: selectedModelDownloaded ? 'Ready' : 'Model required',
      description: autoTranscribe ? 'Auto-transcribe is enabled for new local recordings.' : 'Manual transcription is available after the model is downloaded.',
      sectionId: 'settings-stage-transcribe'
    },
    {
      label: 'Diarize',
      status: selectedModelDownloaded ? 'Bundled' : 'After transcribe',
      description: 'Speaker labels run with the selected local transcription model when segments are returned.',
      sectionId: 'settings-stage-transcribe'
    },
    {
      label: 'Index',
      status: embeddingProvider === 'native'
        ? selectedEmbeddingModelDownloaded
          ? 'Ready'
          : 'Model required'
        : 'Configured',
      description: `${embeddingIndexStats?.currentModelDocumentCount ?? 0} current chunks indexed for Explore search.`,
      sectionId: 'settings-stage-index'
    },
    {
      label: 'Summarize',
      status: ollamaUrl.trim() ? 'Ready' : 'URL required',
      description: ollamaUrl.trim()
        ? 'Local assistant is configured for generated summaries when that stage is enabled.'
        : 'Set an Ollama URL before generated summaries can run.',
      sectionId: 'settings-stage-summary'
    }
  ], [
    autoTranscribe,
    embeddingIndexStats?.currentModelDocumentCount,
    embeddingProvider,
    ollamaUrl,
    selectedEmbeddingModelDownloaded,
    selectedModelDownloaded
  ])

  // Stable loadConfig with useCallback for dependency array
  const loadConfigStable = useCallback(async () => {
    try {
      setLoadError(null)
      await loadConfig()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load settings'
      setLoadError(message)
      toast.error('Failed to Load Settings', message)
    }
  }, [loadConfig])

  useEffect(() => {
    loadConfigStable()
    loadStorageInfo()
    loadTranscriptionModels()
    loadEmbeddingModels()
    loadEmbeddingIndexStats()
  }, [loadConfigStable])

  useEffect(() => {
    const unsubscribe = window.electronAPI.recordings.onTranscriptionModelDownloadProgress?.((progress) => {
      setModelDownloadProgress(progress)
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (config) {
      setOllamaUrl(config.embeddings.ollamaBaseUrl)
      setTranscriptionEngine(config.transcription.localEngine)
      setTranscriptionModel(config.transcription.localModel)
      setParakeetModel(config.transcription.parakeetModel)
      setTranscriptionLanguage(config.transcription.language)
      setAutoTranscribe(config.transcription.autoTranscribe)
      setEmbeddingProvider(config.embeddings.provider)
      setNativeEmbeddingModel(config.embeddings.nativeModel)
      setOllamaEmbeddingModel(config.embeddings.ollamaModel)
      // C-CHAT: Load RAG context window size
      setRagContextSize(config.chat.maxContextChunks)
    }
  }, [config])

  useEffect(() => {
    if (transcriptionModels.length === 0) return

    if (!availableTranscriptionEngines.includes(transcriptionEngine) && availableTranscriptionEngines.length > 0) {
      setTranscriptionEngine(availableTranscriptionEngines[0])
    }
    if (parakeetModelOptions.length > 0 && !parakeetModelOptions.some((model) => model.id === parakeetModel)) {
      setParakeetModel(parakeetModelOptions[0].id)
    }
    if (whisperModelOptions.length > 0 && !whisperModelOptions.some((model) => model.id === transcriptionModel)) {
      setTranscriptionModel(whisperModelOptions[0].id)
    }
  }, [
    availableTranscriptionEngines,
    parakeetModel,
    parakeetModelOptions,
    transcriptionEngine,
    transcriptionModel,
    transcriptionModels.length,
    whisperModelOptions
  ])

  useEffect(() => {
    if (!modelDownloading) {
      setModelDownloadProgress(null)
    }
  }, [modelDownloading, selectedModelId])

  const loadTranscriptionModels = async () => {
    try {
      const models = await window.electronAPI.recordings.getTranscriptionModels()
      setTranscriptionModels(models)
    } catch (error) {
      console.error('Failed to load transcription models:', error)
    }
  }

  const loadEmbeddingModels = async () => {
    try {
      const result = await window.electronAPI.embeddings.listModels()
      if (result.success) {
        setEmbeddingModels(result.data)
      } else {
        console.error('Failed to load embedding models:', result.error)
      }
    } catch (error) {
      console.error('Failed to load embedding models:', error)
    }
  }

  const loadEmbeddingIndexStats = async () => {
    try {
      const result = await window.electronAPI.embeddings.getIndexStats()
      if (result.success) {
        setEmbeddingIndexStats(result.data)
      } else {
        console.error('Failed to load embedding index stats:', result.error)
      }
    } catch (error) {
      console.error('Failed to load embedding index stats:', error)
    }
  }

  const loadStorageInfo = async () => {
    try {
      setStorageError(null) // B-SET-002: Clear previous error
      setStorageLoading(true)
      const result = await window.electronAPI.storage.getInfo()
      if (result.success && result.data) {
        setStorageInfo(result.data)
      } else {
        // B-SET-002: Surface storage errors to user
        const errorMsg = result.error || 'Failed to load storage info'
        setStorageError(typeof errorMsg === 'string' ? errorMsg : String(errorMsg))
        console.error('Failed to load storage info:', result.error)
      }
    } catch (error) {
      // B-SET-002: Surface storage errors to user
      const errorMsg = error instanceof Error ? error.message : 'Failed to load storage info'
      setStorageError(errorMsg)
      console.error('Failed to load storage info:', error)
    } finally {
      setStorageLoading(false)
    }
  }

  const handleSaveChat = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousOllamaUrl = config?.embeddings.ollamaBaseUrl ?? ''
    const previousContextSize = config?.chat.maxContextChunks || RAG_DEFAULTS.MAX_CONTEXT_CHUNKS

    const chatUpdates = {
      provider: chatProvider,
      maxContextChunks: ragContextSize
    }

    const embeddingsUpdates = {
      ollamaBaseUrl: ollamaUrl.trim()
    }

    // Validate before save
    const validationError = validateConfig({
      chat: chatUpdates,
      embeddings: embeddingsUpdates
    } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      // Save both sections atomically using Promise.all to prevent partial state
      await Promise.all([
        updateConfig('chat', chatUpdates),
        updateConfig('embeddings', embeddingsUpdates)
      ])

      toast.success('Settings Saved', 'Local assistant settings updated')
    } catch (error) {
      // Rollback on error - both sections revert
      setOllamaUrl(previousOllamaUrl)
      setRagContextSize(previousContextSize)
      // Reload config from backend to ensure consistency after partial failure
      try { await loadConfig() } catch { /* best effort reload */ }

      const message = error instanceof Error ? error.message : 'Failed to save chat settings'
      toast.error('Save Failed', message)
      console.error('Failed to save chat settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const saveEmbeddingSettings = async (showToast = true): Promise<boolean> => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return false
    }

    const previousProvider = config?.embeddings.provider || 'native'
    const previousNativeModel = config?.embeddings.nativeModel || 'bge-small-en-v1.5-q'
    const previousOllamaModel = config?.embeddings.ollamaModel || 'nomic-embed-text'

    const embeddingsUpdates: Partial<AppConfig['embeddings']> = {
      provider: embeddingProvider,
      nativeModel: nativeEmbeddingModel.trim(),
      ollamaModel: ollamaEmbeddingModel.trim()
    }

    const validationError = validateConfig({
      embeddings: embeddingsUpdates
    } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return false
    }

    setSaving(true)
    try {
      await updateConfig('embeddings', embeddingsUpdates)
      await loadEmbeddingIndexStats()
      if (showToast) {
        toast.success('Settings Saved', 'Search embedding settings updated')
      }
      return true
    } catch (error) {
      setEmbeddingProvider(previousProvider)
      setNativeEmbeddingModel(previousNativeModel)
      setOllamaEmbeddingModel(previousOllamaModel)
      try { await loadConfig() } catch { /* best effort reload */ }

      const message = error instanceof Error ? error.message : 'Failed to save embedding settings'
      toast.error('Save Failed', message)
      console.error('Failed to save embedding settings:', error)
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEmbeddings = async () => {
    await saveEmbeddingSettings()
  }

  const handleSaveTranscription = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    const previousModel = config?.transcription.localModel || 'whisper-small'
    const previousEngine = config?.transcription.localEngine || 'parakeet'
    const previousParakeetModel = config?.transcription.parakeetModel || 'parakeet-v3'
    const previousLanguage = config?.transcription.language || 'auto'
    const previousAutoTranscribe = config?.transcription.autoTranscribe ?? false

    const transcriptionUpdates: Partial<AppConfig['transcription']> = {
      provider: 'local' as const,
      localEngine: transcriptionEngine,
      localModel: transcriptionModel.trim(),
      parakeetModel: parakeetModel.trim(),
      language: transcriptionLanguage.trim() || 'auto',
      autoTranscribe
    }

    const validationError = validateConfig({
      transcription: transcriptionUpdates
    } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      await updateConfig('transcription', transcriptionUpdates)
      toast.success('Settings Saved', 'Local transcription settings updated')
    } catch (error) {
      setTranscriptionEngine(previousEngine)
      setTranscriptionModel(previousModel)
      setParakeetModel(previousParakeetModel)
      setTranscriptionLanguage(previousLanguage)
      setAutoTranscribe(previousAutoTranscribe)
      try { await loadConfig() } catch { /* best effort reload */ }

      const message = error instanceof Error ? error.message : 'Failed to save transcription settings'
      toast.error('Save Failed', message)
      console.error('Failed to save transcription settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleOpenFolder = async (folder: 'recordings' | 'transcripts' | 'data') => {
    await window.electronAPI.storage.openFolder(folder)
  }

  const handleDownloadTranscriptionModel = async () => {
    if (modelDownloading) return

    const model = selectedModelId
    if (!model) {
      toast.error('Validation Error', `${transcriptionEngine === 'whisper' ? 'Whisper' : 'Parakeet'} model is required`)
      return
    }
    if (selectedModelDownloaded) return

    setModelDownloading(true)
    setModelDownloadProgress({ model, stage: 'starting', progress: 0 })
    try {
      const result = await window.electronAPI.recordings.downloadTranscriptionModel(transcriptionEngine, model)
      if (result.success) {
        setModelDownloadProgress((progress) => ({
          model,
          stage: 'ready',
          progress: 100,
          downloadedBytes: progress?.model === model ? progress.downloadedBytes : undefined,
          totalBytes: progress?.model === model ? progress.totalBytes : undefined
        }))
        setTranscriptionModels((models) => models.map((option) => (
          option.id === model ? { ...option, is_downloaded: true } : option
        )))
        await loadTranscriptionModels()
        toast.success('Model Ready', result.message || `Model "${model}" is ready for local transcription`)
      } else {
        toast.error('Model Download Failed', result.error || 'Failed to download transcription model')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download transcription model'
      toast.error('Model Download Failed', message)
      console.error('Failed to download transcription model:', error)
    } finally {
      setModelDownloading(false)
    }
  }

  const downloadEmbeddingModel = async (showToast = true): Promise<boolean> => {
    if (embeddingModelDownloading) return false
    if (embeddingProvider !== 'native') return true
    if (!nativeEmbeddingModel.trim()) {
      toast.error('Validation Error', 'Native embedding model is required')
      return false
    }
    if (selectedEmbeddingModelDownloaded) return true

    setEmbeddingModelDownloading(true)
    try {
      const result = await window.electronAPI.embeddings.downloadModel(nativeEmbeddingModel.trim())
      if (result.success) {
        setEmbeddingModels((models) => models.map((option) => (
          option.id === nativeEmbeddingModel ? { ...option, is_downloaded: true } : option
        )))
        await loadEmbeddingModels()
        if (showToast) {
          toast.success('Model Ready', `${nativeEmbeddingModel} is ready for local search`)
        }
        return true
      }

      toast.error('Model Download Failed', result.error?.message || 'Failed to download embedding model')
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download embedding model'
      toast.error('Model Download Failed', message)
      console.error('Failed to download embedding model:', error)
      return false
    } finally {
      setEmbeddingModelDownloading(false)
    }
  }

  const handleDownloadEmbeddingModel = async () => {
    await downloadEmbeddingModel()
  }

  const handleReindexEmbeddings = async () => {
    if (embeddingReindexing) return

    setLastEmbeddingReindex(null)
    setEmbeddingReindexing(true)
    try {
      if (isEmbeddingDirty) {
        const saved = await saveEmbeddingSettings(false)
        if (!saved) return
      }

      const downloaded = await downloadEmbeddingModel(false)
      if (!downloaded) return

      const result = await window.electronAPI.embeddings.reindexTranscripts()
      if (!result.success) {
        toast.error('Reindex Failed', result.error?.message || 'Failed to rebuild search index')
        return
      }

      setLastEmbeddingReindex(result.data)
      await loadEmbeddingIndexStats()
      const failedCount = result.data.failed.length
      const description = failedCount > 0
        ? `${result.data.indexedChunks} chunks indexed; ${failedCount} transcript${failedCount === 1 ? '' : 's'} failed`
        : `${result.data.indexedChunks} chunks indexed from ${result.data.reindexedTranscripts} transcript${result.data.reindexedTranscripts === 1 ? '' : 's'}`
      toast.success('Search Index Rebuilt', description)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rebuild search index'
      toast.error('Reindex Failed', message)
      console.error('Failed to rebuild search index:', error)
    } finally {
      setEmbeddingReindexing(false)
    }
  }

  const handleSelectPipelineStage = useCallback((sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }, [])

  // Loading state
  if (configLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mb-4" />
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    )
  }

  // Error state with retry
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to Load Settings</h2>
        <p className="text-muted-foreground mb-4 text-center max-w-md">{loadError}</p>
        <Button onClick={loadConfigStable}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Processing Pipeline</CardTitle>
              <CardDescription>Configure the stages shown on each recording.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {pipelineSettingStages.map((stage) => (
                  <PipelineSettingStageCard
                    key={stage.label}
                    stage={stage}
                    onSelect={handleSelectPipelineStage}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Local Transcription Settings */}
          <Card id="settings-stage-transcribe">
            <CardHeader>
              <CardTitle>Local Transcription</CardTitle>
              <CardDescription>Configure local speech-to-text for recordings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <label htmlFor="autoTranscribe" className="text-sm font-medium">Auto-transcribe</label>
                  <p className="text-xs text-muted-foreground">Queue new local recordings for transcription automatically.</p>
                </div>
                <Switch
                  id="autoTranscribe"
                  checked={autoTranscribe}
                  onCheckedChange={setAutoTranscribe}
                  disabled={saving || modelDownloading}
                  aria-label="Auto-transcribe recordings"
                />
              </div>

              <div>
                <label htmlFor="transcriptionEngine" className="text-sm font-medium">Engine</label>
                <Select
                  value={transcriptionEngine}
                  onValueChange={(value) => setTranscriptionEngine(value as LocalTranscriptionEngine)}
                  disabled={saving || modelDownloading}
                >
                  <SelectTrigger id="transcriptionEngine" aria-label="Local transcription engine" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTranscriptionEngines.includes('parakeet') && (
                      <SelectItem value="parakeet">Parakeet</SelectItem>
                    )}
                    {availableTranscriptionEngines.includes('whisper') && (
                      <SelectItem value="whisper">Whisper</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {transcriptionEngine === 'parakeet' ? (
                <>
                  <div>
                    <label htmlFor="parakeetModel" className="text-sm font-medium">Model</label>
                    <Select
                      value={parakeetModel}
                      onValueChange={setParakeetModel}
                      disabled={saving || modelDownloading}
                    >
                      <SelectTrigger id="parakeetModel" aria-label="Parakeet model" className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {parakeetSelectOptions.map((model) => (
                          <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="transcriptionModel" className="text-sm font-medium">Model</label>
                      <Select
                        value={transcriptionModel}
                        onValueChange={setTranscriptionModel}
                        disabled={saving || modelDownloading}
                      >
                        <SelectTrigger id="transcriptionModel" aria-label="Whisper model" className="mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {whisperSelectOptions.map((model) => (
                            <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label htmlFor="transcriptionLanguage" className="text-sm font-medium">Language</label>
                      <Input
                        id="transcriptionLanguage"
                        value={transcriptionLanguage}
                        onChange={(e) => setTranscriptionLanguage(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                        disabled={saving || modelDownloading}
                        aria-label="Transcription language"
                        aria-describedby="transcriptionLanguage-description"
                        className="mt-1"
                      />
                      <p id="transcriptionLanguage-description" className="text-xs text-muted-foreground mt-1">
                        Use auto or a Whisper language name/code
                      </p>
                    </div>
                  </div>
                </>
              )}

              <Button
                variant="outline"
                onClick={handleDownloadTranscriptionModel}
                disabled={saving || modelDownloading || selectedModelDownloaded}
                aria-label={selectedModelDownloaded ? `${transcriptionEngine} model downloaded` : `Download ${transcriptionEngine} model`}
              >
                {modelDownloading ? (
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                ) : selectedModelDownloaded ? (
                  <CheckCircle2 className="h-4 w-4 mr-2" aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4 mr-2" aria-hidden="true" />
                )}
                {downloadButtonLabel}
              </Button>

              {(modelDownloading || selectedTranscriptionModel) && (
                <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {selectedTranscriptionModel?.name ?? selectedModelId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {modelDownloading
                          ? formatModelDownloadStatus(activeModelProgress)
                          : selectedModelDownloaded
                            ? 'Ready for local transcription'
                            : selectedModelSize
                              ? `${selectedModelSize} download`
                              : 'Download required'}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {modelDownloading
                        ? `${Math.round(downloadProgressValue)}%`
                        : selectedModelDownloaded
                          ? 'Downloaded'
                          : 'Not downloaded'}
                    </span>
                  </div>
                  {modelDownloading && (
                    <Progress
                      value={downloadProgressValue}
                      aria-label="Model download progress"
                    />
                  )}
                </div>
              )}

              <Button
                onClick={handleSaveTranscription}
                disabled={saving || !isTranscriptionDirty}
                aria-label="Save transcription settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isTranscriptionDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Local Search Embeddings */}
          <Card id="settings-stage-index">
            <CardHeader>
              <CardTitle>Local Search Embeddings</CardTitle>
              <CardDescription>Configure embeddings for Explore and transcript search</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label htmlFor="embeddingProvider" className="text-sm font-medium">Provider</label>
                <Select
                  value={embeddingProvider}
                  onValueChange={(value) => setEmbeddingProvider(value as EmbeddingProvider)}
                  disabled={saving || embeddingModelDownloading || embeddingReindexing}
                >
                  <SelectTrigger id="embeddingProvider" aria-label="Embedding provider" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="native">Native Sidecar</SelectItem>
                    <SelectItem value="ollama">Ollama</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {embeddingProvider === 'native' ? (
                <div>
                  <label htmlFor="nativeEmbeddingModel" className="text-sm font-medium">Model</label>
                  <Select
                    value={nativeEmbeddingModel}
                    onValueChange={setNativeEmbeddingModel}
                    disabled={saving || embeddingModelDownloading || embeddingReindexing}
                  >
                    <SelectTrigger id="nativeEmbeddingModel" aria-label="Native embedding model" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {embeddingSelectOptions.map((model) => (
                        <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <label htmlFor="ollamaEmbeddingModel" className="text-sm font-medium">Ollama Embedding Model</label>
                  <Input
                    id="ollamaEmbeddingModel"
                    value={ollamaEmbeddingModel}
                    onChange={(e) => setOllamaEmbeddingModel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEmbeddings()}
                    disabled={saving || embeddingReindexing}
                    aria-label="Ollama embedding model"
                    className="mt-1"
                  />
                </div>
              )}

              {embeddingProvider === 'native' && (
                <Button
                  variant="outline"
                  onClick={handleDownloadEmbeddingModel}
                  disabled={saving || embeddingModelDownloading || embeddingReindexing || selectedEmbeddingModelDownloaded}
                  aria-label={selectedEmbeddingModelDownloaded ? 'Embedding model downloaded' : 'Download embedding model'}
                >
                  {embeddingModelDownloading ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                  ) : selectedEmbeddingModelDownloaded ? (
                    <CheckCircle2 className="h-4 w-4 mr-2" aria-hidden="true" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" aria-hidden="true" />
                  )}
                  {embeddingDownloadButtonLabel}
                </Button>
              )}

              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Current Chunks</p>
                    <p className="font-medium">{embeddingIndexStats?.currentModelDocumentCount ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Other Chunks</p>
                    <p className="font-medium">{embeddingIndexStats?.incompatibleDocumentCount ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Model</p>
                    <p className="truncate font-medium" title={embeddingIndexStats?.embeddingModel ?? nativeEmbeddingModel}>
                      {embeddingIndexStats?.embeddingModel ?? nativeEmbeddingModel}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <p className="font-medium">
                      {embeddingProvider === 'native'
                        ? selectedEmbeddingModelDownloaded
                          ? 'Downloaded'
                          : 'Not downloaded'
                        : 'Ollama'}
                    </p>
                  </div>
                </div>
                {selectedEmbeddingModel?.description && embeddingProvider === 'native' && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectedEmbeddingModel.description} {selectedEmbeddingModel.dimensions} dimensions.
                  </p>
                )}
                {lastEmbeddingReindex && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last rebuild: {lastEmbeddingReindex.indexedChunks} chunks, {lastEmbeddingReindex.failed.length} failed.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={handleSaveEmbeddings}
                  disabled={saving || embeddingModelDownloading || embeddingReindexing || !isEmbeddingDirty}
                  aria-label="Save embedding settings"
                >
                  <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                  {isEmbeddingDirty ? 'Save' : 'Saved'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleReindexEmbeddings}
                  disabled={saving || embeddingModelDownloading || embeddingReindexing}
                  aria-label="Rebuild transcript search index"
                >
                  <RefreshCw className={`h-4 w-4 mr-2${embeddingReindexing ? ' animate-spin' : ''}`} aria-hidden="true" />
                  {embeddingReindexing ? 'Rebuilding Index' : 'Rebuild Index'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Chat Settings */}
          <Card id="settings-stage-summary">
            <CardHeader>
              <CardTitle>Local Assistant</CardTitle>
              <CardDescription>Configure local Ollama for querying local transcripts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label htmlFor="ollamaUrl" className="text-sm font-medium">Ollama URL</label>
                <Input
                  id="ollamaUrl"
                  type="url"
                  placeholder="http://localhost:11434"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                  disabled={saving}
                  aria-label="Ollama base URL"
                  aria-describedby="ollamaUrl-description"
                  className="mt-1"
                />
                <p id="ollamaUrl-description" className="text-xs text-muted-foreground mt-1">
                  URL of your local Ollama server
                </p>
              </div>

              {/* C-CHAT: RAG Context Window Size */}
              <div>
                <label htmlFor="ragContextSize" className="text-sm font-medium">
                  RAG Context Window
                </label>
                <Input
                  id="ragContextSize"
                  type="number"
                  min={1}
                  max={20}
                  value={ragContextSize}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val)) {
                      setRagContextSize(Math.min(20, Math.max(1, val)))
                    }
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                  disabled={saving}
                  aria-label="RAG context window size"
                  aria-describedby="ragContextSize-description"
                  className="mt-1"
                />
                <p id="ragContextSize-description" className="text-xs text-muted-foreground mt-1">
                  Number of knowledge chunks to retrieve for context (1-20). Default: 10
                </p>
              </div>

              <Button
                onClick={handleSaveChat}
                disabled={saving || !isChatDirty}
                aria-label="Save chat settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isChatDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Storage */}
          <Card>
            <CardHeader>
              <CardTitle>Storage</CardTitle>
              <CardDescription>Local data storage information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Storage loading indicator */}
              {storageLoading && !storageInfo && (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Loading storage info...</span>
                </div>
              )}
              {/* B-SET-002: Storage error with retry button */}
              {storageError && (
                <div className="flex items-center gap-3 p-3 rounded-md bg-destructive/10 text-destructive border border-destructive/20">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1 text-sm">{storageError}</div>
                  <Button variant="outline" size="sm" onClick={loadStorageInfo}>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                </div>
              )}
              {storageInfo && (
                <>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Total Size</p>
                      <p className="font-medium">{formatBytes(storageInfo.totalSizeBytes)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Recordings</p>
                      <p className="font-medium">{storageInfo.recordingsCount} files</p>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Recordings</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.recordingsPath}>
                          {storageInfo.recordingsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('recordings')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Transcripts</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.transcriptsPath}>
                          {storageInfo.transcriptsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('transcripts')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Data</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.dataPath}>
                          {storageInfo.dataPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('data')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Health Check & Advanced Operations */}
          <HealthCheck />
        </div>
      </div>
    </div>
  )
}

export default Settings
