import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getMeetingById: vi.fn(),
  getRecordingById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  updateTranscriptAnalysis: vi.fn(),
  isAvailable: vi.fn(),
  chat: vi.fn()
}))

vi.mock('../config', () => ({
  getConfig: mocks.getConfig
}))

vi.mock('../database', () => ({
  getMeetingById: mocks.getMeetingById,
  getRecordingById: mocks.getRecordingById,
  getTranscriptByRecordingId: mocks.getTranscriptByRecordingId,
  updateKnowledgeCaptureTitle: mocks.updateKnowledgeCaptureTitle,
  updateTranscriptAnalysis: mocks.updateTranscriptAnalysis
}))

vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => ({
    isAvailable: mocks.isAvailable,
    chat: mocks.chat
  }))
}))

import { generateMeetingNotesForRecording } from '../meeting-notes'

describe('generateMeetingNotesForRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConfig.mockReturnValue({
      notes: {
        autoGenerate: true,
        ollamaBaseUrl: 'http://localhost:11434'
      }
    })
    mocks.getRecordingById.mockReturnValue({
      id: 'rec-1',
      filename: 'meeting.wav',
      meeting_id: 'meeting-1',
      date_recorded: '2026-06-07T12:00:00Z'
    })
    mocks.getMeetingById.mockReturnValue({
      id: 'meeting-1',
      subject: 'Roadmap Review'
    })
    mocks.getTranscriptByRecordingId.mockReturnValue({
      recording_id: 'rec-1',
      full_text: 'The team reviewed roadmap priorities and agreed to follow up on launch timing.',
      summary: null
    })
    mocks.isAvailable.mockResolvedValue(true)
  })

  it('generates title first, then markdown summary, and clears structured analysis fields', async () => {
    mocks.chat
      .mockResolvedValueOnce('Roadmap Review')
      .mockResolvedValueOnce('# Roadmap Review\n\nType: planning\n\n## Summary\n\nThe team reviewed roadmap priorities.')

    const result = await generateMeetingNotesForRecording('rec-1', { force: true })

    expect(result).toEqual({
      generated: true,
      titleSuggestion: 'Roadmap Review',
      summary: '# Roadmap Review\n\nType: planning\n\n## Summary\n\nThe team reviewed roadmap priorities.'
    })

    expect(mocks.chat).toHaveBeenCalledTimes(2)
    const titleMessages = mocks.chat.mock.calls[0][0]
    expect(mocks.chat.mock.calls[0][1]).toEqual({ temperature: 0.2, think: true })
    expect(titleMessages).toHaveLength(2)
    expect(titleMessages[1].content).toContain('Return only the title')
    expect(titleMessages[1].content).toContain('The team reviewed roadmap priorities')

    const summaryMessages = mocks.chat.mock.calls[1][0]
    expect(mocks.chat.mock.calls[1][1]).toEqual({ temperature: 0.2, think: true })
    expect(summaryMessages).toHaveLength(4)
    expect(summaryMessages[2]).toEqual({ role: 'assistant', content: 'Roadmap Review' })
    expect(summaryMessages[3].content).toContain('Return only Markdown')

    expect(mocks.updateTranscriptAnalysis).toHaveBeenCalledWith('rec-1', {
      summary: '# Roadmap Review\n\nType: planning\n\n## Summary\n\nThe team reviewed roadmap priorities.',
      action_items: null,
      topics: null,
      key_points: null,
      title_suggestion: 'Roadmap Review',
      question_suggestions: null
    })
    expect(mocks.updateKnowledgeCaptureTitle).toHaveBeenCalledWith('rec-1', 'Roadmap Review')
  })
})
