import { getConfig } from './config'
import { getOllamaService, type OllamaChatMessage } from './ollama'
import {
  getMeetingById,
  getRecordingById,
  getTranscriptByRecordingId,
  updateKnowledgeCaptureTitle,
  updateTranscriptAnalysis
} from './database'

export type MeetingNotesGenerationResult = {
  generated: boolean
  skippedReason?: string
  titleSuggestion?: string
  summary?: string
}

const SYSTEM_PROMPT = `You write concise, useful meeting summaries from recorder transcripts.
Use only facts supported by the transcript. Do not invent attendees, decisions, dates, or follow-ups.`

function truncateTranscript(text: string, maxChars = 50000): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars).trim()
}

function cleanPlainTextResponse(text: string, fallback?: string): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
    ?.replace(/^title:\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()

  return cleaned || fallback
}

function cleanMarkdownResponse(text: string, title: string): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  if (!cleaned) return undefined
  return cleaned.startsWith('#') ? cleaned : `# ${title}\n\n${cleaned}`
}

function buildTitlePrompt(options: {
  transcript: string
  recordingFilename: string
  meetingSubject?: string
  meetingDate?: string
}): string {
  return `Create a clear meeting title from this transcript.

Return only the title. Do not return JSON, Markdown, quotes, labels, or explanation.
Keep it 3-8 words. If the transcript is too thin, use the calendar subject or recording file name as context.

Recording file: ${options.recordingFilename}
${options.meetingSubject ? `Calendar subject: ${options.meetingSubject}` : ''}
${options.meetingDate ? `Meeting date: ${options.meetingDate}` : ''}

Transcript:
${truncateTranscript(options.transcript)}`
}

function buildSummaryPrompt(options: {
  title: string
  recordingFilename: string
  meetingSubject?: string
  meetingDate?: string
}): string {
  return `Write the meeting summary as polished Markdown.

Return only Markdown. Do not return JSON.
Use this style as a template, but omit sections that are not supported by the transcript:

# ${options.title}

Type: <one concise type, such as status update, planning, decision review, customer call, interview, one-on-one, incident review, training, or general>

## Summary
<one concise paragraph describing the meeting>

## Discussion
- <important topic, decision, detail, or context>
- <another important topic, decision, detail, or context>

## Follow-ups
- <follow-up, open question, or next step if stated or clearly implied>

Keep everything in the Markdown summary. Do not create separate action-item, key-point, topic, or question fields.
Use only facts supported by the transcript.

Recording file: ${options.recordingFilename}
${options.meetingSubject ? `Calendar subject: ${options.meetingSubject}` : ''}
${options.meetingDate ? `Meeting date: ${options.meetingDate}` : ''}`
}

export async function generateMeetingNotesForRecording(
  recordingId: string,
  options: { force?: boolean } = {}
): Promise<MeetingNotesGenerationResult> {
  const config = getConfig()
  if (!config.notes?.autoGenerate && !options.force) {
    return { generated: false, skippedReason: 'Automatic notes are disabled.' }
  }

  if (!config.notes?.ollamaBaseUrl?.trim()) {
    return { generated: false, skippedReason: 'Ollama URL is not configured.' }
  }

  const recording = getRecordingById(recordingId)
  if (!recording) {
    return { generated: false, skippedReason: 'Recording not found.' }
  }

  const transcript = getTranscriptByRecordingId(recordingId)
  if (!transcript?.full_text?.trim()) {
    return { generated: false, skippedReason: 'Transcript text is missing.' }
  }

  if (!options.force && transcript.summary?.trim()) {
    return { generated: false, skippedReason: 'Transcript already has a generated summary.' }
  }

  const meeting = recording.meeting_id ? getMeetingById(recording.meeting_id) : undefined
  const ollama = getOllamaService()
  const available = await ollama.isAvailable()
  if (!available) {
    return { generated: false, skippedReason: 'Ollama is not available.' }
  }

  const systemMessage: OllamaChatMessage = { role: 'system', content: SYSTEM_PROMPT }
  const titlePrompt = buildTitlePrompt({
    transcript: transcript.full_text,
    recordingFilename: recording.filename,
    meetingSubject: meeting?.subject,
    meetingDate: recording.date_recorded
  })
  const titleMessages: OllamaChatMessage[] = [
    systemMessage,
    { role: 'user', content: titlePrompt }
  ]

  const titleResponse = await ollama.chat(titleMessages, { temperature: 0.2, think: true })
  const titleSuggestion = titleResponse
    ? cleanPlainTextResponse(titleResponse, meeting?.subject || recording.filename)
    : undefined

  if (!titleSuggestion) {
    return { generated: false, skippedReason: 'Ollama did not return a meeting title.' }
  }

  const summaryMessages: OllamaChatMessage[] = [
    ...titleMessages,
    { role: 'assistant', content: titleSuggestion },
    {
      role: 'user',
      content: buildSummaryPrompt({
        title: titleSuggestion,
        recordingFilename: recording.filename,
        meetingSubject: meeting?.subject,
        meetingDate: recording.date_recorded
      })
    }
  ]

  const response = await ollama.chat(summaryMessages, { temperature: 0.2, think: true })
  const summary = response ? cleanMarkdownResponse(response, titleSuggestion) : undefined

  if (!summary) {
    return { generated: false, skippedReason: 'Ollama did not return a summary.' }
  }

  updateTranscriptAnalysis(recordingId, {
    summary,
    action_items: null,
    topics: null,
    key_points: null,
    title_suggestion: titleSuggestion ?? null,
    question_suggestions: null
  })

  if (titleSuggestion) {
    updateKnowledgeCaptureTitle(recordingId, titleSuggestion)
  }

  return {
    generated: true,
    titleSuggestion,
    summary
  }
}
