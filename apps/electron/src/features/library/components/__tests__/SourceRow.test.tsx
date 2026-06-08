import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceRow } from '../SourceRow'
import { useMeetingNotesQueueStore } from '@/store/features/useMeetingNotesQueueStore'
import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'

const baseRecording: UnifiedRecording = {
  id: 'rec-1',
  filename: '2026Jun06-133830-Rec25.mp3',
  localPath: '/recordings/2026Jun06-133830-Rec25.mp3',
  location: 'local-only',
  syncStatus: 'synced',
  size: 1024,
  duration: 120,
  dateRecorded: new Date('2026-06-06T13:38:30.000Z'),
  transcriptionStatus: 'complete'
}

const baseTranscript: Transcript = {
  id: 'transcript-1',
  recording_id: 'rec-1',
  full_text: 'The team reviewed the roadmap.',
  language: 'en',
  summary: null,
  action_items: null,
  topics: null,
  key_points: null,
  sentiment: null,
  speakers: null,
  word_count: 6,
  transcription_provider: 'local',
  transcription_model: 'parakeet',
  title_suggestion: null,
  question_suggestions: null,
  created_at: '2026-06-06T14:00:00.000Z'
}

function renderRow(transcript: Transcript | undefined = baseTranscript) {
  return render(
    <SourceRow
      recording={baseRecording}
      transcript={transcript}
      isPlaying={false}
      onPlay={vi.fn()}
      onStop={vi.fn()}
    />
  )
}

describe('SourceRow', () => {
  beforeEach(() => {
    useMeetingNotesQueueStore.getState().clear()
  })

  it('shows a missing summary indicator for transcribed recordings without a summary', () => {
    renderRow()

    expect(screen.getByLabelText('Summary not generated')).toBeInTheDocument()
  })

  it('shows summary generation status from the notes queue', () => {
    useMeetingNotesQueueStore.getState().upsertStatus({
      recordingId: 'rec-1',
      status: 'generating',
      startedAt: '2026-06-07T18:00:00.000Z'
    })

    renderRow()

    expect(screen.getByLabelText('Summary generating')).toBeInTheDocument()
  })

  it('shows a generated summary indicator when summary markdown exists', () => {
    renderRow({
      ...baseTranscript,
      summary: '# Roadmap Review\n\nThe team reviewed priorities.'
    })

    expect(screen.getByLabelText('Summary generated')).toBeInTheDocument()
  })
})
