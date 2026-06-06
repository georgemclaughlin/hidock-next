import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Circle, CircleDashed, Clock, Loader2, RotateCcw, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { parseJsonArray, type Transcript } from '@/types'
import { type UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { useTranscriptionStore, type TranscriptionItem } from '@/store/features/useTranscriptionStore'

type StageStatus = 'not_started' | 'queued' | 'running' | 'complete' | 'skipped' | 'blocked' | 'failed'

type RecordingEmbeddingIndexStats = {
  recordingId: string
  documentCount: number
  currentModelDocumentCount: number
  incompatibleDocumentCount: number
  embeddingProvider: string
  embeddingModel: string
}

type PipelineStage = {
  id: 'transcribe' | 'diarize' | 'index' | 'summary'
  label: string
  status: StageStatus
  detail: string
  action?: {
    label: string
    onSelect: () => void
  }
}

type SpeakerSegment = {
  speaker?: string | null
  text?: string | null
}

interface ProcessingPipelineTrackerProps {
  recording: UnifiedRecording
  transcript?: Transcript
  onTranscribe?: () => void
  onOpenSettings?: () => void
}

function getStatusLabel(status: StageStatus): string {
  switch (status) {
    case 'complete':
      return 'Complete'
    case 'running':
      return 'Running'
    case 'queued':
      return 'Queued'
    case 'blocked':
      return 'Configure'
    case 'failed':
      return 'Failed'
    case 'skipped':
      return 'Skipped'
    default:
      return 'Pending'
  }
}

function getStatusIcon(status: StageStatus) {
  switch (status) {
    case 'complete':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
    case 'queued':
      return <Clock className="h-3.5 w-3.5 text-amber-600" />
    case 'blocked':
      return <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 text-red-600" />
    case 'skipped':
      return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground" />
  }
}

function getStatusClassName(status: StageStatus): string {
  switch (status) {
    case 'complete':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100'
    case 'running':
      return 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100'
    case 'queued':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100'
    case 'blocked':
      return 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100'
    case 'skipped':
      return 'border-muted bg-muted/50 text-muted-foreground'
    default:
      return 'border-border bg-background text-muted-foreground'
  }
}

function normalizeStage(stage?: string): string {
  return stage?.toLowerCase() ?? ''
}

function hasSpeakerSegments(transcript?: Transcript): boolean {
  return parseJsonArray<SpeakerSegment>(transcript?.speakers).some((segment) => Boolean(segment.speaker?.trim()))
}

function hasSummaryOutput(transcript?: Transcript): boolean {
  return Boolean(
    transcript?.summary?.trim() ||
    transcript?.action_items?.trim() ||
    transcript?.key_points?.trim()
  )
}

function buildStages(
  recording: UnifiedRecording,
  transcript: Transcript | undefined,
  item: TranscriptionItem | null,
  indexStats: RecordingEmbeddingIndexStats | null,
  onTranscribe?: () => void,
  onOpenSettings?: () => void
): PipelineStage[] {
  const stage = normalizeStage(item?.stage)
  const isQueued = item?.status === 'pending' || recording.transcriptionStatus === 'pending'
  const isProcessing = item?.status === 'processing' || recording.transcriptionStatus === 'processing'
  const isIndexing = isProcessing && (stage.includes('index') || (item?.progress ?? 0) >= 92)
  const isDiarizing = isProcessing && stage.includes('diar')
  const hasTranscript = Boolean(transcript?.full_text?.trim()) || recording.transcriptionStatus === 'complete'
  const hasDiarization = hasSpeakerSegments(transcript)
  const hasCurrentIndex = (indexStats?.currentModelDocumentCount ?? 0) > 0
  const hasIncompatibleIndex = (indexStats?.incompatibleDocumentCount ?? 0) > 0

  const transcribe: PipelineStage = (() => {
    if (recording.transcriptionStatus === 'error' || item?.status === 'failed') {
      return {
        id: 'transcribe',
        label: 'Transcribe',
        status: 'failed',
        detail: item?.error || 'Transcription failed.',
        action: onTranscribe ? { label: 'Retry transcription', onSelect: onTranscribe } : undefined
      }
    }

    if (!hasLocalPath(recording)) {
      return {
        id: 'transcribe',
        label: 'Transcribe',
        status: 'blocked',
        detail: 'Download the recording locally before transcription can run.'
      }
    }

    if (hasTranscript || isIndexing) {
      return {
        id: 'transcribe',
        label: 'Transcribe',
        status: 'complete',
        detail: transcript?.transcription_model
          ? `Transcript generated with ${transcript.transcription_model}.`
          : 'Raw transcript is available.'
      }
    }

    if (isQueued) {
      return {
        id: 'transcribe',
        label: 'Transcribe',
        status: 'queued',
        detail: 'Waiting for transcription to start.'
      }
    }

    if (isProcessing) {
      return {
        id: 'transcribe',
        label: 'Transcribe',
        status: 'running',
        detail: `${item?.stage || 'Transcribing audio'}${item?.progress != null ? ` (${Math.round(item.progress)}%)` : ''}.`
      }
    }

    return {
      id: 'transcribe',
      label: 'Transcribe',
      status: 'not_started',
      detail: 'Ready to transcribe.'
    }
  })()

  const diarize: PipelineStage = (() => {
    if (hasDiarization || isIndexing) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'complete',
        detail: hasDiarization ? 'Speaker segments are available.' : 'Diarization completed during transcription.'
      }
    }

    if (isDiarizing) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'running',
        detail: `${item?.stage || 'Separating speakers'}${item?.progress != null ? ` (${Math.round(item.progress)}%)` : ''}.`
      }
    }

    if (isProcessing && !isIndexing && transcribe.status === 'running') {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'queued',
        detail: 'Speaker labeling runs with local transcription.'
      }
    }

    if (hasTranscript) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'skipped',
        detail: 'No speaker labels were returned for this transcript.'
      }
    }

    return {
      id: 'diarize',
      label: 'Diarize',
      status: 'not_started',
      detail: 'Waiting for transcript audio processing.'
    }
  })()

  const index: PipelineStage = (() => {
    if (hasCurrentIndex) {
      return {
        id: 'index',
        label: 'Index',
        status: 'complete',
        detail: `${indexStats?.currentModelDocumentCount ?? 0} searchable chunk${indexStats?.currentModelDocumentCount === 1 ? '' : 's'} indexed.`
      }
    }

    if (isIndexing) {
      return {
        id: 'index',
        label: 'Index',
        status: 'running',
        detail: `${item?.stage || 'Indexing transcript'}${item?.progress != null ? ` (${Math.round(item.progress)}%)` : ''}.`
      }
    }

    if (hasIncompatibleIndex) {
      return {
        id: 'index',
        label: 'Index',
        status: 'blocked',
        detail: 'Search chunks exist for an older embedding model. Rebuild the index in Settings.',
        action: onOpenSettings ? { label: 'Open embedding settings', onSelect: onOpenSettings } : undefined
      }
    }

    if (hasTranscript) {
      return {
        id: 'index',
        label: 'Index',
        status: 'blocked',
        detail: 'No searchable embedding chunks were found for this transcript.',
        action: onOpenSettings ? { label: 'Open embedding settings', onSelect: onOpenSettings } : undefined
      }
    }

    return {
      id: 'index',
      label: 'Index',
      status: 'not_started',
      detail: 'Waiting for transcript text.'
    }
  })()

  const summary: PipelineStage = (() => {
    if (hasSummaryOutput(transcript)) {
      return {
        id: 'summary',
        label: 'Summarize',
        status: 'complete',
        detail: 'Summary or extracted follow-ups are available.'
      }
    }

    if (!hasTranscript) {
      return {
        id: 'summary',
        label: 'Summarize',
        status: 'not_started',
        detail: 'Waiting for transcript text.'
      }
    }

    return {
      id: 'summary',
      label: 'Summarize',
      status: 'blocked',
      detail: 'Automatic meeting summaries need a configured local assistant model.',
      action: onOpenSettings ? { label: 'Open assistant settings', onSelect: onOpenSettings } : undefined
    }
  })()

  return [transcribe, diarize, index, summary]
}

function StageButton({ stage }: { stage: PipelineStage }) {
  const content = (
    <div
      className={cn(
        'flex h-full min-h-[58px] w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        stage.action ? 'hover:bg-accent hover:text-accent-foreground cursor-pointer' : '',
        getStatusClassName(stage.status)
      )}
      title={stage.detail}
    >
      <div className="mt-0.5 shrink-0">{getStatusIcon(stage.status)}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold">{stage.label}</span>
          <span className="shrink-0 rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal">
            {getStatusLabel(stage.status)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs opacity-80">{stage.detail}</p>
      </div>
    </div>
  )

  if (!stage.action) return content

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="w-full text-left">
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>{stage.label}</DropdownMenuLabel>
        <div className="px-2 pb-2 text-xs text-muted-foreground">{stage.detail}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={stage.action.onSelect}>
          {stage.status === 'failed' ? (
            <RotateCcw className="mr-2 h-4 w-4" />
          ) : (
            <Settings className="mr-2 h-4 w-4" />
          )}
          {stage.action.label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProcessingPipelineTracker({
  recording,
  transcript,
  onTranscribe,
  onOpenSettings
}: ProcessingPipelineTrackerProps) {
  const transcriptionItem = useTranscriptionStore((state) => {
    for (const item of state.queue.values()) {
      if (item.recordingId === recording.id) return item
    }
    return null
  })
  const [indexStats, setIndexStats] = useState<RecordingEmbeddingIndexStats | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadIndexStats() {
      try {
        const result = await window.electronAPI?.embeddings?.getRecordingIndexStats?.(recording.id)
        if (!cancelled && result?.success) {
          setIndexStats(result.data)
        }
      } catch {
        if (!cancelled) setIndexStats(null)
      }
    }

    setIndexStats(null)
    void loadIndexStats()

    return () => {
      cancelled = true
    }
  }, [recording.id, recording.transcriptionStatus, transcript?.id])

  const stages = useMemo(
    () => buildStages(recording, transcript, transcriptionItem, indexStats, onTranscribe, onOpenSettings),
    [recording, transcript, transcriptionItem, indexStats, onTranscribe, onOpenSettings]
  )

  return (
    <section className="rounded-md border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Processing</h3>
        <span className="text-xs text-muted-foreground">
          {stages.filter((stage) => stage.status === 'complete').length}/{stages.length} complete
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => (
          <StageButton key={stage.id} stage={stage} />
        ))}
      </div>
    </section>
  )
}
