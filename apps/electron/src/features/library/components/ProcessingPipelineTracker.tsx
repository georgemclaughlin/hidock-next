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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseJsonArray, type Transcript } from '@/types'
import { type UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useTranscriptionStore, type TranscriptionItem } from '@/store/features/useTranscriptionStore'

type StageStatus = 'not_started' | 'queued' | 'running' | 'ready' | 'complete' | 'skipped' | 'blocked' | 'failed'

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
  variant?: 'section' | 'popover'
}

function getStatusLabel(status: StageStatus): string {
  switch (status) {
    case 'complete':
      return 'Complete'
    case 'running':
      return 'Running'
    case 'queued':
      return 'Queued'
    case 'ready':
      return 'Ready'
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
      return <CheckCircle2 className="h-3.5 w-3.5" />
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />
    case 'queued':
      return <Clock className="h-3.5 w-3.5" />
    case 'ready':
      return <Circle className="h-3.5 w-3.5" />
    case 'blocked':
      return <AlertCircle className="h-3.5 w-3.5" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5" />
    case 'skipped':
      return <CircleDashed className="h-3.5 w-3.5" />
    default:
      return <Circle className="h-3.5 w-3.5" />
  }
}

function getStatusClassName(status: StageStatus): string {
  switch (status) {
    case 'complete':
      return 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
    case 'running':
      return 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300'
    case 'queued':
      return 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    case 'ready':
      return 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300'
    case 'blocked':
      return 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    case 'failed':
      return 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
    case 'skipped':
      return 'border-muted bg-muted text-muted-foreground'
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
  isSummaryConfigured: boolean,
  diarizationEnabled: boolean,
  onTranscribe?: () => void,
  onOpenSettings?: () => void
): PipelineStage[] {
  const stage = normalizeStage(item?.stage)
  const isQueued = item?.status === 'pending' || recording.transcriptionStatus === 'pending'
  const isProcessing = item?.status === 'processing' || recording.transcriptionStatus === 'processing'
  const isIndexing = isProcessing && (stage.includes('index') || (item?.progress ?? 0) >= 92)
  const isDiarizing = isProcessing && stage.includes('diar')
  const isFinalizing = isProcessing && (stage.includes('final') || stage.includes('pars'))
  const isAfterTranscription = isDiarizing || isFinalizing || isIndexing
  const isAfterDiarization = isFinalizing || isIndexing
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

    if (hasTranscript || isAfterTranscription) {
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
    if (hasDiarization) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'complete',
        detail: 'Speaker segments are available.'
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

    if (!diarizationEnabled) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'skipped',
        detail: 'Speaker diarization is disabled in Settings.',
        action: onOpenSettings ? { label: 'Open transcription settings', onSelect: onOpenSettings } : undefined
      }
    }

    if (isAfterDiarization) {
      return {
        id: 'diarize',
        label: 'Diarize',
        status: 'complete',
        detail: 'Diarization completed during transcription.'
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

    if (isSummaryConfigured) {
      return {
        id: 'summary',
        label: 'Summarize',
        status: 'ready',
        detail: 'Local assistant is configured for generated summaries when that stage is enabled.'
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
        'group mx-auto flex min-w-0 max-w-28 flex-col items-center gap-0.5 rounded-md px-1.5 py-1 text-center transition-colors',
        stage.action ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground' : ''
      )}
      title={stage.detail}
    >
      <div
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-sm',
          getStatusClassName(stage.status)
        )}
      >
        {getStatusIcon(stage.status)}
      </div>
      <div className="max-w-full">
        <div className="truncate text-[11px] font-semibold leading-tight text-foreground">{stage.label}</div>
        <div className="truncate text-[9px] font-medium uppercase leading-tight tracking-normal text-muted-foreground">
          {getStatusLabel(stage.status)}
        </div>
      </div>
    </div>
  )

  if (!stage.action) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          <p>{stage.detail}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="w-full min-w-0 text-left">
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

function StageStep({ stage }: { stage: PipelineStage }) {
  return (
    <div
      className="group mx-auto flex min-w-0 max-w-28 flex-col items-center gap-0.5 rounded-md px-1.5 py-1 text-center"
      title={stage.detail}
    >
      <div
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-sm',
          getStatusClassName(stage.status)
        )}
      >
        {getStatusIcon(stage.status)}
      </div>
      <div className="max-w-full">
        <div className="truncate text-[11px] font-semibold leading-tight text-foreground">{stage.label}</div>
        <div className="truncate text-[9px] font-medium uppercase leading-tight tracking-normal text-muted-foreground">
          {getStatusLabel(stage.status)}
        </div>
      </div>
    </div>
  )
}

function getFocusStage(stages: PipelineStage[]): PipelineStage {
  return (
    stages.find((stage) => stage.status === 'running') ||
    stages.find((stage) => stage.status === 'queued') ||
    stages.find((stage) => stage.status === 'failed') ||
    stages.find((stage) => stage.status === 'blocked') ||
    stages.find((stage) => stage.status === 'ready') ||
    stages.find((stage) => stage.status !== 'complete') ||
    stages[stages.length - 1]
  )
}

function PipelineStepper({
  stages,
  interactive
}: {
  stages: PipelineStage[]
  interactive: boolean
}) {
  return (
    <div className="grid grid-cols-4 items-start gap-1">
      {stages.map((stage, index) => (
        <div key={stage.id} className="relative min-w-0">
          {index < stages.length - 1 && (
            <div className="absolute left-1/2 right-[-50%] top-4 h-px bg-border" />
          )}
          <div className="relative z-10">
            {interactive ? <StageButton stage={stage} /> : <StageStep stage={stage} />}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ProcessingPipelineTracker({
  recording,
  transcript,
  onTranscribe,
  onOpenSettings,
  variant = 'section'
}: ProcessingPipelineTrackerProps) {
  const transcriptionItem = useTranscriptionStore((state) => {
    for (const item of state.queue.values()) {
      if (item.recordingId === recording.id) return item
    }
    return null
  })
  const [indexStats, setIndexStats] = useState<RecordingEmbeddingIndexStats | null>(null)
  const isSummaryConfigured = useConfigStore((state) => Boolean(state.config?.embeddings.ollamaBaseUrl?.trim()))
  const diarizationEnabled = useConfigStore((state) => state.config?.transcription?.diarizationEnabled !== false)

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
    () => buildStages(recording, transcript, transcriptionItem, indexStats, isSummaryConfigured, diarizationEnabled, onTranscribe, onOpenSettings),
    [recording, transcript, transcriptionItem, indexStats, isSummaryConfigured, diarizationEnabled, onTranscribe, onOpenSettings]
  )
  const completedStageCount = stages.filter((stage) => stage.status === 'complete').length

  if (variant === 'popover') {
    const focusStage = getFocusStage(stages)

    return (
      <div className="w-80 rounded-md bg-popover p-3 text-popover-foreground">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Processing</h3>
          <span className="text-xs text-muted-foreground">
            {completedStageCount}/{stages.length} complete
          </span>
        </div>
        <PipelineStepper stages={stages} interactive={false} />
        <div className="mt-3 rounded-md bg-muted/50 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">{focusStage.label}</span>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              {getStatusLabel(focusStage.status)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{focusStage.detail}</p>
        </div>
      </div>
    )
  }

  return (
    <section className="rounded-md border bg-background px-3 py-2">
      <div className="mb-0.5 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Processing</h3>
        <span className="text-xs text-muted-foreground">
          {completedStageCount}/{stages.length} complete
        </span>
      </div>
      <TooltipProvider>
        <PipelineStepper stages={stages} interactive />
      </TooltipProvider>
    </section>
  )
}
