/**
 * SourceReader Component
 *
 * Displays the selected recording in the center panel with:
 * - Audio playback controls
 * - Transcript viewer with timestamps
 * - Metadata display (editable when knowledgeCaptureId is present)
 *
 * Shows a placeholder message when no recording is selected.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { TranscriptViewer, type TranscriptViewerSegmentInput } from './TranscriptViewer'
import { AudioPlayer } from '@/components/AudioPlayer'
import { UnifiedRecording, hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import { Transcript, Meeting, parseJsonArray } from '@/types'
import { Calendar, Download, Trash2, Wand2, RefreshCw, Play, Pencil, Check, Edit2, Link, X, ExternalLink, FolderOpen, Copy, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem
} from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { RecordingLinkDialog } from '@/components/RecordingLinkDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { formatDateTime, formatDuration, formatBytes } from '@/lib/utils'

const CATEGORY_OPTIONS = [
  { value: 'meeting', label: 'Meeting' },
  { value: 'interview', label: 'Interview' },
  { value: '1:1', label: '1:1' },
  { value: 'brainstorm', label: 'Brainstorm' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
] as const

type TranscriptView = 'raw' | 'diarized'

function parseTranscriptSegments(json?: string | null): TranscriptViewerSegmentInput[] {
  return parseJsonArray<TranscriptViewerSegmentInput>(json)
    .filter((segment) => typeof segment.text === 'string' && segment.text.trim().length > 0)
}

function formatTimestamp(seconds?: number | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '00:00'
  }

  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function formatSegmentedTranscript(segments: TranscriptViewerSegmentInput[], fallback: string): string {
  if (segments.length === 0) {
    return fallback
  }

  return segments
    .map((segment) => {
      const speaker = segment.speaker?.trim()
      const prefix = speaker ? `${speaker}: ` : ''
      return `[${formatTimestamp(segment.start)}] ${prefix}${segment.text?.trim() ?? ''}`.trim()
    })
    .join('\n\n')
}

interface SourceReaderProps {
  recording: UnifiedRecording | null
  transcript?: Transcript
  meeting?: Meeting
  isPlaying?: boolean
  currentTimeMs?: number
  onPlay?: () => void
  onStop?: () => void
  onSeek?: (startMs: number, endMs?: number) => void
  // Action button callbacks
  onDownload?: () => void
  onTranscribe?: () => void
  onDelete?: () => void
  // State for button enabling/disabling
  deviceConnected?: boolean
  isDownloading?: boolean
  downloadProgress?: number
  isDeleting?: boolean
  // Navigation
  onNavigateToMeeting?: (meetingId: string) => void
  // Metadata editing callback
  onMetadataEdited?: () => void
}

export function SourceReader({
  recording,
  transcript,
  meeting,
  isPlaying = false,
  currentTimeMs = 0,
  onPlay,
  onStop,
  onSeek,
  onDownload,
  onTranscribe,
  onDelete,
  deviceConnected = false,
  isDownloading = false,
  downloadProgress,
  isDeleting = false,
  onNavigateToMeeting,
  onMetadataEdited
}: SourceReaderProps) {

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [isSavingTitle, setIsSavingTitle] = useState(false)

  // Category saving state
  const [isSavingCategory, setIsSavingCategory] = useState(false)

  // Meeting link dialog state
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)

  // Transcription warning state
  const [metadataEdited, setMetadataEdited] = useState(false)
  const [showTranscribeWarning, setShowTranscribeWarning] = useState(false)
  const [isCopyingTranscript, setIsCopyingTranscript] = useState(false)
  const [transcriptCopied, setTranscriptCopied] = useState(false)
  const [transcriptView, setTranscriptView] = useState<TranscriptView>('raw')
  const [audioPlayerExpanded, setAudioPlayerExpanded] = useState(false)
  const [detailsExpanded, setDetailsExpanded] = useState(false)

  const transcriptSegments = useMemo(
    () => parseTranscriptSegments(transcript?.speakers),
    [transcript?.speakers]
  )
  const hasDiarizedTranscript = useMemo(
    () => transcriptSegments.some((segment) => Boolean(segment.speaker?.trim())),
    [transcriptSegments]
  )

  const copiedTranscriptText = useMemo(() => {
    if (!transcript) return ''
    return transcriptView === 'diarized' && hasDiarizedTranscript
      ? formatSegmentedTranscript(transcriptSegments, transcript.full_text)
      : transcript.full_text
  }, [hasDiarizedTranscript, transcript, transcriptSegments, transcriptView])

  // Reset all state when recording changes
  useEffect(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
    setLinkDialogOpen(false)
    setMetadataEdited(false)
    setShowTranscribeWarning(false)
    setIsCopyingTranscript(false)
    setTranscriptCopied(false)
    setTranscriptView('raw')
    setAudioPlayerExpanded(false)
    setDetailsExpanded(false)
  }, [recording?.id])

  useEffect(() => {
    if (transcriptView === 'diarized' && !hasDiarizedTranscript) {
      setTranscriptView('raw')
    }
  }, [hasDiarizedTranscript, transcriptView])

  const handleCloseAudioPlayer = useCallback(() => {
    setAudioPlayerExpanded(false)
    onStop?.()
  }, [onStop])

  const handleSaveTitle = useCallback(async () => {
    if (!recording?.knowledgeCaptureId) return
    const trimmed = editedTitle.trim()
    if (!trimmed) {
      setEditedTitle(recording.title || recording.filename)
      toast.error('Title cannot be empty')
      return
    }
    if (trimmed === (recording.title || recording.filename)) {
      setIsEditingTitle(false)
      return
    }
    setIsSavingTitle(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { title: trimmed }
      )
      if (result.success) {
        setIsEditingTitle(false)
        setMetadataEdited(true)
        toast.success('Title updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save title')
      }
    } catch (err) {
      console.error('Failed to save title:', err)
      toast.error('Failed to save title')
    } finally {
      setIsSavingTitle(false)
    }
  }, [editedTitle, recording, onMetadataEdited])

  const handleCancelTitle = useCallback(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
  }, [])

  const handleCategoryChange = useCallback(async (newCategory: string) => {
    if (!recording?.knowledgeCaptureId) return
    if (newCategory === recording.category) return
    setIsSavingCategory(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { category: newCategory }
      )
      if (result.success) {
        setMetadataEdited(true)
        toast.success('Category updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save category')
      }
    } catch (err) {
      console.error('Failed to save category:', err)
      toast.error('Failed to save category')
    } finally {
      setIsSavingCategory(false)
    }
  }, [recording, onMetadataEdited])

  const handleRemoveMeetingLink = useCallback(async () => {
    if (!recording) return
    try {
      await window.electronAPI.recordings.selectMeeting(recording.id, null)
      setMetadataEdited(true)
      onMetadataEdited?.()
    } catch (err) {
      console.error('Failed to remove meeting link:', err)
      toast.error('Failed to remove meeting link')
    }
  }, [recording, onMetadataEdited])

  const handleTranscribeClick = useCallback(() => {
    if (metadataEdited) {
      setShowTranscribeWarning(true)
    } else {
      onTranscribe?.()
    }
  }, [metadataEdited, onTranscribe])

  const handleCopyTranscript = useCallback(async () => {
    const text = copiedTranscriptText.trim()
    if (!text) {
      toast.error('Copy failed', 'Transcript is empty')
      return
    }

    setIsCopyingTranscript(true)
    try {
      const result = await window.electronAPI.outputs.copyToClipboard(text)
      if (result.success) {
        setTranscriptCopied(true)
        toast.success('Copied', 'Transcript copied to clipboard')
        window.setTimeout(() => setTranscriptCopied(false), 2000)
      } else {
        toast.error('Copy failed', result.error.message || 'Failed to copy transcript')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to copy transcript'
      toast.error('Copy failed', message)
    } finally {
      setIsCopyingTranscript(false)
    }
  }, [copiedTranscriptText])

  if (!recording) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">No recording selected</p>
          <p className="text-sm">Select a recording from the list to view details</p>
        </div>
      </div>
    )
  }

  const canPlay = hasLocalPath(recording)
  const recordingTitle = recording.title || meeting?.subject || recording.filename
  const recordedAtText = (() => {
    const date = new Date(recording.dateRecorded)
    return !isNaN(date.getTime()) ? formatDateTime(date.toISOString()) : 'Unknown date'
  })()
  const compactMetadataParts = [
    recordedAtText,
    recording.duration ? formatDuration(recording.duration) : null,
    recording.size ? formatBytes(recording.size) : null,
    recording.location.replace('-', ' '),
    recording.transcriptionStatus
  ].filter((part): part is string => Boolean(part))

  const linkDialogRecording = {
    id: recording.id,
    filename: recording.filename,
    date_recorded: recording.dateRecorded instanceof Date
      ? recording.dateRecorded.toISOString()
      : String(recording.dateRecorded),
    duration_seconds: recording.duration ?? null
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Compact header keeps the transcript/status area high in the reader */}
      <div className="border-b">
        <div className="px-6 py-4 space-y-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveTitle()
                    if (e.key === 'Escape') handleCancelTitle()
                  }}
                  className="text-lg font-semibold h-auto py-1"
                  autoFocus
                  disabled={isSavingTitle}
                  aria-label="Recording title"
                />
                <Button variant="ghost" size="sm" onClick={handleSaveTitle} disabled={isSavingTitle} aria-label="Save title" title="Save (Enter)">
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancelTitle} disabled={isSavingTitle} aria-label="Cancel editing" title="Cancel (Escape)">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="group flex items-center gap-2">
                <h2 className="text-lg font-semibold truncate" title={recordingTitle}>
                  {recordingTitle}
                </h2>
                {recording.knowledgeCaptureId && (
                  <button
                    onClick={() => {
                      setIsEditingTitle(true)
                      setEditedTitle(recording.title || recording.filename)
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
                    aria-label="Edit title"
                    title="Edit title"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </button>
                )}
              </div>
            )}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {compactMetadataParts.map((part, index) => (
                  <span key={`${part}-${index}`} className={index >= 3 ? 'capitalize' : undefined}>
                    {index > 0 && <span className="mr-2 text-muted-foreground/60">/</span>}
                    {part}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {canPlay && onPlay && (
                isPlaying ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onStop}
                    className="gap-2"
                    title="Stop playback"
                  >
                    <X className="h-4 w-4" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onPlay}
                    className="gap-2"
                    title="Play recording"
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </Button>
                )
              )}

              {isDeviceOnly(recording) && onDownload && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDownload}
                  disabled={!deviceConnected || isDownloading}
                  className="gap-2"
                  title={!deviceConnected ? 'Device not connected' : 'Download recording from device'}
                >
                  {isDownloading ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      {downloadProgress !== undefined ? `${downloadProgress}%` : 'Downloading...'}
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      Download
                    </>
                  )}
                </Button>
              )}

              {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && onTranscribe && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTranscribeClick}
                  disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
                  className="gap-2"
                  title={
                    recording.transcriptionStatus === 'pending' ? 'Transcription queued' :
                    recording.transcriptionStatus === 'processing' ? 'Transcription in progress' :
                    'Start AI transcription'
                  }
                >
                  {recording.transcriptionStatus === 'processing' ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      In Progress
                    </>
                  ) : recording.transcriptionStatus === 'pending' ? (
                    <>
                      <RefreshCw className="h-4 w-4" />
                      Queued
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-4 w-4" />
                      Transcribe
                    </>
                  )}
                </Button>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetailsExpanded((expanded) => !expanded)}
                className="gap-2"
                aria-expanded={detailsExpanded}
                aria-controls="source-details-panel"
                title={detailsExpanded ? 'Hide details' : 'Show details'}
              >
                {detailsExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                Details
              </Button>

              {canPlay && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAudioPlayerExpanded((expanded) => !expanded)}
                  className="gap-2"
                  aria-expanded={audioPlayerExpanded}
                  aria-controls="source-audio-player-panel"
                  title={audioPlayerExpanded ? 'Hide waveform' : 'Show waveform'}
                >
                  {audioPlayerExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Waveform
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-2" title="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                    More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {hasLocalPath(recording) && (
                    <>
                      <DropdownMenuItem onSelect={() => { void window.electronAPI?.storage.openFile(recording.localPath) }}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => { void window.electronAPI?.storage.revealInFolder(recording.localPath) }}>
                        <FolderOpen className="mr-2 h-4 w-4" />
                        Reveal
                      </DropdownMenuItem>
                    </>
                  )}
                  {!meeting && !isDeviceOnly(recording) && (
                    <DropdownMenuItem onSelect={() => setLinkDialogOpen(true)}>
                      <Link className="mr-2 h-4 w-4" />
                      Link Meeting
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => onDelete()}
                        disabled={(isDeviceOnly(recording) && !deviceConnected) || isDeleting}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Linked Meeting */}
          {meeting && (
            <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2">
              <div
                className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => onNavigateToMeeting?.(meeting.id)}
              >
                <Calendar className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{meeting.subject}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(meeting.start_time)}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => { e.stopPropagation(); setLinkDialogOpen(true) }}
                title="Change linked meeting"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); handleRemoveMeetingLink() }}
                title="Remove meeting link"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {/* Device-only notice */}
          {isDeviceOnly(recording) && (
            <p className="text-xs text-muted-foreground italic">
              Download this capture to play it and generate a transcript.
            </p>
          )}

          {detailsExpanded && (
            <div id="source-details-panel" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 border-t pt-3 text-sm">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Date Recorded</p>
                <p>{recordedAtText}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Duration</p>
                <p>{recording.duration ? formatDuration(recording.duration) : 'Unknown'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Size</p>
                <p>{recording.size ? formatBytes(recording.size) : 'Unknown'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Quality</p>
                <p className="capitalize">{recording.quality || 'Standard'}</p>
              </div>
              {recording.knowledgeCaptureId ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Category</p>
                  <Select
                    value={recording.category || ''}
                    onValueChange={handleCategoryChange}
                    disabled={isSavingCategory}
                  >
                    <SelectTrigger className="h-7 text-sm w-[140px]">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : recording.category ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Category</p>
                  <p className="capitalize">{recording.category}</p>
                </div>
              ) : null}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Location</p>
                <p className="capitalize">{recording.location.replace('-', ' ')}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Transcription</p>
                <p className="capitalize">{recording.transcriptionStatus}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Filename</p>
                <p className="truncate" title={recording.filename}>{recording.filename}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {canPlay && audioPlayerExpanded && (
        <div id="source-audio-player-panel" className="border-b px-6 py-3 bg-background">
          <AudioPlayer
            key={recording.id}
            filename={recording.filename}
            onClose={handleCloseAudioPlayer}
          />
        </div>
      )}

      {/* Transcript Content */}
      <div className="flex-1 overflow-auto p-4">
        {transcript ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Transcript</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyTranscript}
                disabled={isCopyingTranscript}
                className="gap-2 shrink-0"
                aria-label="Copy transcript"
                title="Copy transcript"
              >
                {transcriptCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {transcriptCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <Tabs value={transcriptView} onValueChange={(value) => setTranscriptView(value as TranscriptView)}>
              <TabsList className="w-full">
                <TabsTrigger value="raw" className="flex-1">
                  Raw
                </TabsTrigger>
                <TabsTrigger
                  value="diarized"
                  className="flex-1"
                  disabled={!hasDiarizedTranscript}
                  title={hasDiarizedTranscript ? 'Show diarized transcript' : 'Diarized transcript not available'}
                >
                  Diarized
                </TabsTrigger>
              </TabsList>
              <TabsContent value="raw" className="mt-3">
                <TranscriptViewer
                  transcript={transcript.full_text}
                  currentTimeMs={currentTimeMs}
                  onSeek={onSeek || (() => {})}
                  showSummary={true}
                  showActionItems={true}
                  summary={transcript.summary ?? undefined}
                  actionItems={parseJsonArray<string>(transcript.action_items)}
                  transcriptLabel="Raw Transcript"
                />
              </TabsContent>
              <TabsContent value="diarized" className="mt-3">
                <TranscriptViewer
                  transcript={hasDiarizedTranscript ? transcript.full_text : ''}
                  segments={hasDiarizedTranscript ? transcriptSegments : []}
                  currentTimeMs={currentTimeMs}
                  onSeek={onSeek || (() => {})}
                  showSummary={false}
                  showActionItems={false}
                  transcriptLabel="Diarized Transcript"
                  emptyMessage="Diarized transcript not available for this recording."
                />
              </TabsContent>
            </Tabs>
          </div>
        ) : recording.transcriptionStatus === 'complete' ? (
          <div className="text-center text-muted-foreground py-8">
            <p>Transcript not available</p>
          </div>
        ) : recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing' ? (
          <div className="text-center text-muted-foreground py-8">
            <p>Transcription in progress...</p>
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <p>No transcript available</p>
            {canPlay && (
              <p className="text-sm mt-2">
                Click &quot;Transcribe&quot; to generate a transcript
              </p>
            )}
          </div>
        )}
      </div>

      {/* Meeting link dialog */}
      <RecordingLinkDialog
        recording={linkDialogOpen ? linkDialogRecording : null}
        meeting={meeting}
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onResolved={() => {
          // Note: RecordingLinkDialog calls both onResolved and onClose internally
          // Do NOT call setLinkDialogOpen(false) here to avoid double-close
          setMetadataEdited(true)
          onMetadataEdited?.()
        }}
      />

      {/* Transcription overwrite warning */}
      <ConfirmDialog
        open={showTranscribeWarning}
        onOpenChange={(open) => setShowTranscribeWarning(open)}
        title="Transcription may overwrite your edits"
        description="You've manually edited this recording's metadata. The AI transcription process may overwrite your title, category, and summary changes. Do you want to continue?"
        actionLabel="Continue"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          onTranscribe?.()
          setMetadataEdited(false)
          setShowTranscribeWarning(false)
        }}
      />
    </div>
  )
}
