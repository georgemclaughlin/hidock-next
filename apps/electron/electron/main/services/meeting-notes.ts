import { getConfig } from './config'
import { getOllamaService } from './ollama'
import {
  getMeetingById,
  getRecordingById,
  getTranscriptByRecordingId,
  updateKnowledgeCaptureTitle,
  updateTranscriptAnalysis
} from './database'

type GeneratedMeetingNotes = {
  title_suggestion?: string
  meeting_type?: string
  summary?: string
  key_points?: string[]
  action_items?: Array<string | {
    owner?: string
    assignee?: string
    task?: string
    description?: string
    due_date?: string
    dueDate?: string
  }>
  topics?: string[]
  question_suggestions?: string[]
}

export type MeetingNotesGenerationResult = {
  generated: boolean
  skippedReason?: string
  titleSuggestion?: string
  summary?: string
}

const SYSTEM_PROMPT = `You write concise, useful meeting notes from recorder transcripts.
Return strict JSON only. Do not wrap the JSON in Markdown.`

function truncateTranscript(text: string, maxChars = 50000): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars).trim()
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1))
    }
    throw new Error('Ollama response did not contain valid JSON')
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function formatActionItems(value: GeneratedMeetingNotes['action_items']): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (!item || typeof item !== 'object') return ''

      const task = asString(item.task) || asString(item.description)
      if (!task) return ''

      const owner = asString(item.owner) || asString(item.assignee)
      const dueDate = asString(item.due_date) || asString(item.dueDate)
      return [
        owner ? `${owner}: ${task}` : task,
        dueDate ? `(due ${dueDate})` : ''
      ].filter(Boolean).join(' ')
    })
    .filter(Boolean)
}

function buildSummaryMarkdown(notes: GeneratedMeetingNotes): string | undefined {
  const sections: string[] = []
  const title = asString(notes.title_suggestion)
  const meetingType = asString(notes.meeting_type)
  const summary = asString(notes.summary)
  const keyPoints = asStringArray(notes.key_points)
  const actionItems = formatActionItems(notes.action_items)

  if (title) sections.push(`# ${title}`)
  if (meetingType) sections.push(`Type: ${meetingType}`)
  if (summary) sections.push(summary)
  if (keyPoints.length > 0) {
    sections.push(`Key Points\n${keyPoints.map((point) => `- ${point}`).join('\n')}`)
  }
  if (actionItems.length > 0) {
    sections.push(`Action Items\n${actionItems.map((item) => `- ${item}`).join('\n')}`)
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function buildPrompt(options: {
  transcript: string
  recordingFilename: string
  meetingSubject?: string
  meetingDate?: string
}): string {
  return `Create polished meeting notes for this transcript.

Return this exact JSON shape:
{
  "title_suggestion": "3-8 word clear meeting title",
  "meeting_type": "one concise type such as status update, planning, decision review, customer call, interview, one-on-one, incident review, training, or general",
  "summary": "short executive summary in plain text",
  "key_points": ["important discussion point"],
  "action_items": [{"owner": "name if stated", "task": "specific task", "due_date": "date if stated"}],
  "topics": ["topic"],
  "question_suggestions": ["useful follow-up question"]
}

Use only facts supported by the transcript. If an owner or due date is not stated, omit that field.

Recording file: ${options.recordingFilename}
${options.meetingSubject ? `Calendar subject: ${options.meetingSubject}` : ''}
${options.meetingDate ? `Meeting date: ${options.meetingDate}` : ''}

Transcript:
${truncateTranscript(options.transcript)}`
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
    return { generated: false, skippedReason: 'Transcript already has generated notes.' }
  }

  const meeting = recording.meeting_id ? getMeetingById(recording.meeting_id) : undefined
  const ollama = getOllamaService()
  const available = await ollama.isAvailable()
  if (!available) {
    return { generated: false, skippedReason: 'Ollama is not available.' }
  }

  const response = await ollama.generate(
    buildPrompt({
      transcript: transcript.full_text,
      recordingFilename: recording.filename,
      meetingSubject: meeting?.subject,
      meetingDate: recording.date_recorded
    }),
    SYSTEM_PROMPT,
    { temperature: 0.2, maxTokens: 1800 }
  )

  if (!response) {
    return { generated: false, skippedReason: 'Ollama did not return notes.' }
  }

  const parsed = extractJsonObject(response) as GeneratedMeetingNotes
  const titleSuggestion = asString(parsed.title_suggestion)
  const summary = buildSummaryMarkdown(parsed)
  const topics = asStringArray(parsed.topics)
  const keyPoints = asStringArray(parsed.key_points)
  const actionItems = formatActionItems(parsed.action_items)
  const questions = asStringArray(parsed.question_suggestions)

  updateTranscriptAnalysis(recordingId, {
    summary: summary ?? asString(parsed.summary) ?? null,
    action_items: actionItems.length > 0 ? JSON.stringify(actionItems) : null,
    topics: topics.length > 0 ? JSON.stringify(topics) : null,
    key_points: keyPoints.length > 0 ? JSON.stringify(keyPoints) : null,
    title_suggestion: titleSuggestion ?? null,
    question_suggestions: questions.length > 0 ? JSON.stringify(questions) : null
  })

  if (titleSuggestion) {
    updateKnowledgeCaptureTitle(recordingId, titleSuggestion)
  }

  return {
    generated: true,
    titleSuggestion,
    summary: summary ?? asString(parsed.summary)
  }
}
