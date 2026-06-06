import { useEffect, useState, useCallback, useMemo } from 'react'
import { Save, FolderOpen, RefreshCw, AlertCircle, Download, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
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

type ModelDownloadProgress = {
  model: string
  stage: string
  progress: number
  downloadedBytes?: number
  totalBytes?: number
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

export function Settings() {
  // SM-09 fix: Use granular selectors
  const { config, loadConfig, updateConfig, configLoading } = useConfigStore()
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null) // B-SET-002: Storage error state
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Local form state
  const chatProvider = 'ollama' as const
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [transcriptionEngine, setTranscriptionEngine] = useState<LocalTranscriptionEngine>('parakeet')
  const [transcriptionModel, setTranscriptionModel] = useState('whisper-small')
  const [parakeetModel, setParakeetModel] = useState('parakeet-v3')
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('auto')
  const [modelDownloading, setModelDownloading] = useState(false)
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress | null>(null)
  const [transcriptionModels, setTranscriptionModels] = useState<TranscriptionModelOption[]>([])
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

  const isTranscriptionDirty = useMemo(() => {
    if (!config) return false
    return (
      transcriptionEngine !== config.transcription.localEngine ||
      transcriptionModel !== config.transcription.localModel ||
      parakeetModel !== config.transcription.parakeetModel ||
      transcriptionLanguage !== config.transcription.language
    )
  }, [
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
    const previousOllamaUrl = config?.embeddings.ollamaBaseUrl || 'http://localhost:11434'
    const previousContextSize = config?.chat.maxContextChunks || RAG_DEFAULTS.MAX_CONTEXT_CHUNKS

    const chatUpdates = {
      provider: chatProvider,
      maxContextChunks: ragContextSize
    }

    const embeddingsUpdates = {
      ollamaBaseUrl: ollamaUrl
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

  const handleSaveTranscription = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    const previousModel = config?.transcription.localModel || 'whisper-small'
    const previousEngine = config?.transcription.localEngine || 'parakeet'
    const previousParakeetModel = config?.transcription.parakeetModel || 'parakeet-v3'
    const previousLanguage = config?.transcription.language || 'auto'

    const transcriptionUpdates: Partial<AppConfig['transcription']> = {
      provider: 'local' as const,
      localEngine: transcriptionEngine,
      localModel: transcriptionModel.trim(),
      parakeetModel: parakeetModel.trim(),
      language: transcriptionLanguage.trim() || 'auto'
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
          {/* Local Transcription Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Local Transcription</CardTitle>
              <CardDescription>Configure local speech-to-text for recordings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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

          {/* Chat Settings */}
          <Card>
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
