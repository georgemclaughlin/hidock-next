/**
 * RAG (Retrieval Augmented Generation) Service
 * Combines vector search with LLM to answer questions about meetings
 */

import { getVectorStore, SearchResult, VectorDocument, cosineSimilarity } from './vector-store'
import { getOllamaService, OllamaChatMessage } from './ollama'
import { getEmbeddingService } from './embeddings'
import type { EmbeddingResult } from './embeddings'
import { getDatabase, queryOne, escapeLikePattern } from './database'
import { Result, success, error } from '../types/api'

interface ChatContext {
  meetingId?: string
  conversationHistory: OllamaChatMessage[]
}

interface RAGResponse {
  answer: string
  sources: Array<{
    content: string
    meetingId?: string
    subject?: string
    timestamp?: string
    score: number
  }>
  error?: string
}

type GlobalKnowledgeResult = {
  id: unknown
  title: unknown
  summary: unknown
  capturedAt: unknown
  sourceRecordingId?: unknown
  semanticScore?: number
}

type GlobalSearchResponse = {
  knowledge: any[]
  people: any[]
  projects: any[]
  warnings?: string[]
}

type SemanticKnowledgeSearchResult = {
  results: GlobalKnowledgeResult[]
  warnings: string[]
}

type RankedKnowledgeResult = GlobalKnowledgeResult & {
  lexicalRank: number
}

const ACTIVE_RECORDING_SQL = "COALESCE(r.location, '') != 'deleted' AND COALESCE(r.status, '') != 'deleted'"
const ACTIVE_KNOWLEDGE_CAPTURE_SQL = "kc.deleted_at IS NULL AND COALESCE(kc.storage_tier, '') != 'deleted'"
const ACTIVE_CAPTURE_SOURCE_SQL = `(kc.source_recording_id IS NULL OR (r.id IS NOT NULL AND ${ACTIVE_RECORDING_SQL}))`

const SYSTEM_PROMPT = `You are a helpful meeting assistant that answers questions based on meeting transcripts.

Your capabilities:
- Summarize discussions and decisions from meetings
- Find action items and follow-ups mentioned in meetings
- Identify key topics and themes across meetings
- Answer specific questions about what was discussed

Guidelines:
- Only answer based on the meeting transcripts provided as context
- If the context doesn't contain relevant information, say so honestly
- Be concise but thorough
- Reference specific meetings when relevant
- If asked about something not in the transcripts, acknowledge the limitation

Context from meeting transcripts will be provided with each question.`

// B-CHAT-006: Token estimation and history trimming utilities
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function trimHistoryByTokens(
  history: OllamaChatMessage[],
  maxTokens: number = 4096
): OllamaChatMessage[] {
  let totalTokens = 0
  const trimmed: OllamaChatMessage[] = []

  // Walk backwards through history, keeping most recent messages first
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content)
    if (totalTokens + msgTokens > maxTokens) break
    totalTokens += msgTokens
    trimmed.unshift(history[i])
  }

  return trimmed
}

// B-CHAT-002: LRU session cache with max size eviction
const MAX_SESSIONS = 50

class LRUSessionCache {
  private cache: Map<string, ChatContext> = new Map()
  private accessOrder: string[] = [] // Most recently accessed at end

  get(sessionId: string): ChatContext | undefined {
    const context = this.cache.get(sessionId)
    if (context) {
      // Move to end (most recently used)
      this.accessOrder = this.accessOrder.filter(id => id !== sessionId)
      this.accessOrder.push(sessionId)
    }
    return context
  }

  set(sessionId: string, context: ChatContext): void {
    // If already exists, just update
    if (this.cache.has(sessionId)) {
      this.cache.set(sessionId, context)
      this.accessOrder = this.accessOrder.filter(id => id !== sessionId)
      this.accessOrder.push(sessionId)
      return
    }

    // Evict LRU entries if at capacity
    while (this.cache.size >= MAX_SESSIONS && this.accessOrder.length > 0) {
      const lruKey = this.accessOrder.shift()!
      this.cache.delete(lruKey)
      console.log(`[RAG] LRU evicted session: ${lruKey}`)
    }

    this.cache.set(sessionId, context)
    this.accessOrder.push(sessionId)
  }

  delete(sessionId: string): boolean {
    this.accessOrder = this.accessOrder.filter(id => id !== sessionId)
    return this.cache.delete(sessionId)
  }

  get size(): number {
    return this.cache.size
  }
}

class RAGService {
  private contexts: LRUSessionCache = new LRUSessionCache()
  // B-CHAT-005: Active AbortControllers for cancellable requests
  private activeControllers: Map<string, AbortController> = new Map()

  async isReady(): Promise<{ ready: boolean; reason?: string }> {
    const ollama = getOllamaService()
    const vectorStore = getVectorStore()

    const ollamaAvailable = await ollama.isAvailable()
    if (!ollamaAvailable) {
      return { ready: false, reason: 'Ollama is not running. Start Ollama to use the chat feature.' }
    }

    const docCount = vectorStore.getDocumentCount()
    if (docCount === 0) {
      return {
        ready: false,
        reason: 'No meeting transcripts indexed yet. Record some meetings first.'
      }
    }

    return { ready: true }
  }

  async initialize(): Promise<boolean> {
    const ollama = getOllamaService()
    const vectorStore = getVectorStore()

    // Check if Ollama is available
    const available = await ollama.isAvailable()
    if (!available) {
      console.log('Ollama not available, RAG service will be limited')
      return false
    }

    // Ensure the chat model is available. Embeddings are handled by the local sidecar by default.
    const chatReady = await ollama.ensureChatModel()
    if (!chatReady) {
      console.log('Required Ollama chat model not available')
      return false
    }

    // Initialize vector store
    await vectorStore.initialize()

    console.log('RAG service initialized')
    return true
  }

  async chat(
    sessionId: string,
    message: string,
    meetingFilter?: string
  ): Promise<RAGResponse> {
    const ollama = getOllamaService()
    const vectorStore = getVectorStore()

    // Validate that sessionId corresponds to a valid conversation
    try {
      const conversation = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [sessionId])
      if (!conversation) {
        console.error(`RAG chat: Invalid conversation ID ${sessionId}`)
        return {
          answer: '',
          sources: [],
          error: 'Invalid conversation ID. Please create a new conversation.'
        }
      }
    } catch (error) {
      console.error('RAG chat: Failed to validate conversation:', error)
      return {
        answer: '',
        sources: [],
        error: 'Failed to validate conversation. Please try again.'
      }
    }

    // B-CHAT-005: Create AbortController for this request
    // Cancel any existing in-flight request for this session
    const existingController = this.activeControllers.get(sessionId)
    if (existingController) {
      existingController.abort()
    }
    const controller = new AbortController()
    this.activeControllers.set(sessionId, controller)

    // Get or create session context (LRU cache)
    let context = this.contexts.get(sessionId)
    if (!context) {
      context = { conversationHistory: [] }
      this.contexts.set(sessionId, context)
    }

    // Apply meeting filter if specified
    if (meetingFilter) {
      context.meetingId = meetingFilter
    }

    // Search for relevant context
    let searchResults: SearchResult[]
    if (context.meetingId) {
      // Search within specific meeting
      const docs = await vectorStore.searchByMeeting(context.meetingId)
      const queryEmbedding = await getEmbeddingService().generateEmbedding(message, 'query')
      if (queryEmbedding) {
        // Re-rank by actual query relevance using cosine similarity
        searchResults = docs.map((doc) => {
          return { document: doc, score: this.scoreDocumentAgainstQuery(doc, queryEmbedding) }
        })
        // Sort by actual relevance
        searchResults.sort((a, b) => b.score - a.score)
      } else {
        searchResults = docs.map((doc) => ({ document: doc, score: 0.5 }))
      }
      searchResults = searchResults.slice(0, 5)
    } else {
      // Global search
      searchResults = await vectorStore.search(message, 5)
    }

    // --- Added: Fetch explicit conversation context ---
    const pinnedContextParts: string[] = []
    try {
      const db = getDatabase()
      if (db) {
        // Get knowledge captures attached to this conversation
        const contextRes = db.exec('SELECT knowledge_capture_id FROM conversation_context WHERE conversation_id = ?', [sessionId])
        if (contextRes && contextRes.length > 0 && contextRes[0].values && contextRes[0].values.length > 0) {
          const kcIds = contextRes[0].values.map(v => v[0] as string)
          for (const id of kcIds) {
            // Fetch the full transcript for each pinned knowledge capture
            const transcriptRes = db.exec(`
              SELECT t.full_text, k.title 
              FROM transcripts t
              JOIN knowledge_captures k ON k.source_recording_id = t.recording_id
              WHERE k.id = ?
            `, [id])
            
            if (transcriptRes && transcriptRes.length > 0 && transcriptRes[0].values && transcriptRes[0].values.length > 0) {
              const [text, title] = transcriptRes[0].values[0] as [string, string]
              pinnedContextParts.push(`[PINNED CONTEXT: ${title}]\n${text}`)
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch pinned context:', error)
    }
    // ------------------------------------------------

    // Build context from search results
    const contextParts: string[] = []
    const sources: RAGResponse['sources'] = []

    for (const result of searchResults) {
      if (result.score < 0.3) continue // Skip low-relevance results

      const { document: doc, score } = result
      const meetingInfo = doc.metadata.subject
        ? `Meeting: ${doc.metadata.subject}`
        : doc.metadata.meetingId
          ? `Meeting ID: ${doc.metadata.meetingId}`
          : 'Unknown meeting'

      const dateInfo = doc.metadata.timestamp
        ? ` (${new Date(doc.metadata.timestamp).toLocaleDateString()})`
        : ''

      contextParts.push(`[${meetingInfo}${dateInfo}]\n${doc.content}`)
      sources.push({
        content: doc.content.substring(0, 200) + (doc.content.length > 200 ? '...' : ''),
        meetingId: doc.metadata.meetingId,
        subject: doc.metadata.subject,
        timestamp: doc.metadata.timestamp,
        score
      })
    }

    // Combine pinned context and search results
    const allContextParts = [...pinnedContextParts, ...contextParts]

    // Prepare messages
    const contextText =
      allContextParts.length > 0
        ? `Here are relevant excerpts from meeting transcripts and pinned knowledge base items:\n\n${allContextParts.join('\n\n---\n\n')}`
        : 'No relevant meeting transcripts found for this query.'

    const userMessage = `Context:\n${contextText}\n\nQuestion: ${message}`

    // B-CHAT-006: Build messages for LLM with token-aware trimming
    const trimmedHistory = trimHistoryByTokens(context.conversationHistory, 4096)
    const messages: OllamaChatMessage[] = [
      ...trimmedHistory,
      { role: 'user', content: userMessage }
    ]

    // Add raw message to conversation history (after building messages to avoid duplicate)
    context.conversationHistory.push({ role: 'user', content: message })

    // B-CHAT-005: Generate response with abort signal support
    const answer = await ollama.chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.7,
      maxTokens: 1024,
      signal: controller.signal
    })

    if (!answer) {
      return {
        answer: '',
        sources: [],
        error: 'Failed to generate response. Please try again.'
      }
    }

    // Add assistant response to history
    context.conversationHistory.push({ role: 'assistant', content: answer })

    // B-CHAT-006: Token-aware history pruning replaces simple slice
    // Keep the history manageable but let trimHistoryByTokens do the real work at query time
    if (context.conversationHistory.length > 40) {
      context.conversationHistory = context.conversationHistory.slice(-20)
    }

    // B-CHAT-005: Clean up controller after successful completion
    this.activeControllers.delete(sessionId)

    return { answer, sources }
  }

  async summarizeMeeting(meetingId: string): Promise<string | null> {
    const ollama = getOllamaService()
    const vectorStore = getVectorStore()

    // Get all chunks for this meeting
    const docs = await vectorStore.searchByMeeting(meetingId)
    if (docs.length === 0) {
      return null
    }

    // Combine chunks
    const transcript = docs.map((d) => d.content).join('\n\n')

    // Get meeting info
    const db = getDatabase()
    const meetingRows = db.exec('SELECT subject FROM meetings WHERE id = ?', [meetingId])
    const subject = meetingRows[0]?.values[0]?.[0] as string | undefined

    const prompt = `Please provide a concise summary of this meeting${subject ? ` about "${subject}"` : ''}. Include:
1. Main topics discussed
2. Key decisions made
3. Action items (if any)
4. Important points or conclusions

Meeting transcript:
${transcript.substring(0, 8000)}` // Limit context size

    return ollama.generate(prompt)
  }

  async findActionItems(meetingId?: string): Promise<string | null> {
    const ollama = getOllamaService()
    const vectorStore = getVectorStore()

    let docs
    if (meetingId) {
      docs = await vectorStore.searchByMeeting(meetingId)
    } else {
      // Search for action item related content across all meetings
      const results = await vectorStore.search(
        'action items tasks to-do follow up assigned responsibility deadline',
        10
      )
      docs = results.map((r) => r.document)
    }

    if (docs.length === 0) {
      return 'No meeting transcripts found.'
    }

    const transcript = docs.map((d) => d.content).join('\n\n')

    const prompt = `Extract all action items, tasks, and follow-ups from these meeting transcripts. For each item include:
- What needs to be done
- Who is responsible (if mentioned)
- Deadline (if mentioned)

Format as a numbered list.

Meeting transcripts:
${transcript.substring(0, 8000)}`

    return ollama.generate(prompt)
  }

  /**
   * Remove the last N messages from a session's conversation history.
   * Used during retry to strip the failed user message and any partial assistant response
   * without losing all prior context.
   */
  removeLastMessages(sessionId: string, count: number): number {
    const context = this.contexts.get(sessionId)
    if (!context || count <= 0) return 0

    const toRemove = Math.min(count, context.conversationHistory.length)
    context.conversationHistory.splice(-toRemove)
    return toRemove
  }

  clearSession(sessionId: string): void {
    this.contexts.delete(sessionId)
    // Also cancel any in-flight request for this session
    const controller = this.activeControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.activeControllers.delete(sessionId)
    }
  }

  // B-CHAT-005: Cancel in-flight RAG request for a session
  cancelRequest(sessionId: string): boolean {
    const controller = this.activeControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.activeControllers.delete(sessionId)
      return true
    }
    return false
  }

  getStats(): {
    documentCount: number
    meetingCount: number
    sessionCount: number
  } {
    const vectorStore = getVectorStore()
    return {
      documentCount: vectorStore.getDocumentCount(),
      meetingCount: vectorStore.getMeetingCount(),
      sessionCount: this.contexts.size
    }
  }

  private scoreDocumentAgainstQuery(doc: VectorDocument, queryEmbedding: EmbeddingResult): number {
    if (!doc.embedding || doc.embedding.length !== queryEmbedding.embedding.length) {
      return 0.5
    }
    if (doc.embeddingProvider && doc.embeddingProvider !== queryEmbedding.provider) {
      return 0.5
    }
    if (doc.embeddingModel && doc.embeddingModel !== queryEmbedding.model) {
      return 0.5
    }

    return cosineSimilarity(queryEmbedding.embedding, doc.embedding)
  }

  private findKnowledgeCaptureForVectorDoc(doc: VectorDocument): GlobalKnowledgeResult | null {
    const recordingId = doc.metadata.recordingId
    const meetingId = doc.metadata.meetingId
    if (!recordingId && !meetingId) return null

    if (recordingId && meetingId) {
      const row = queryOne<any>(`
        SELECT kc.id, kc.title, kc.summary, kc.captured_at, kc.source_recording_id
        FROM knowledge_captures kc
        LEFT JOIN recordings r ON r.id = kc.source_recording_id
        WHERE (kc.source_recording_id = ? OR kc.meeting_id = ?)
          AND ${ACTIVE_KNOWLEDGE_CAPTURE_SQL}
          AND ${ACTIVE_CAPTURE_SOURCE_SQL}
        ORDER BY CASE WHEN kc.source_recording_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `, [recordingId, meetingId, recordingId])
      if (row) {
        return {
          id: row.id,
          title: row.title,
          summary: row.summary || doc.content.substring(0, 240),
          capturedAt: row.captured_at,
          sourceRecordingId: row.source_recording_id
        }
      }
    }

    if (recordingId) {
      const row = queryOne<any>(`
        SELECT kc.id, kc.title, kc.summary, kc.captured_at, kc.source_recording_id
        FROM knowledge_captures kc
        LEFT JOIN recordings r ON r.id = kc.source_recording_id
        WHERE kc.source_recording_id = ?
          AND ${ACTIVE_KNOWLEDGE_CAPTURE_SQL}
          AND ${ACTIVE_CAPTURE_SOURCE_SQL}
        LIMIT 1
      `, [recordingId])
      if (row) {
        return {
          id: row.id,
          title: row.title,
          summary: row.summary || doc.content.substring(0, 240),
          capturedAt: row.captured_at,
          sourceRecordingId: row.source_recording_id
        }
      }
    }

    if (meetingId) {
      const row = queryOne<any>(`
        SELECT kc.id, kc.title, kc.summary, kc.captured_at, kc.source_recording_id
        FROM knowledge_captures kc
        LEFT JOIN recordings r ON r.id = kc.source_recording_id
        WHERE kc.meeting_id = ?
          AND ${ACTIVE_KNOWLEDGE_CAPTURE_SQL}
          AND ${ACTIVE_CAPTURE_SOURCE_SQL}
        LIMIT 1
      `, [meetingId])
      if (row) {
        return {
          id: row.id,
          title: row.title,
          summary: row.summary || doc.content.substring(0, 240),
          capturedAt: row.captured_at,
          sourceRecordingId: row.source_recording_id
        }
      }
    }

    return null
  }

  private findRecordingForVectorDoc(doc: VectorDocument): GlobalKnowledgeResult | null {
    const recordingId = doc.metadata.recordingId
    if (!recordingId) return null

    const row = queryOne<any>(`
      SELECT
        r.id,
        COALESCE(m.subject, r.filename, 'Recording') AS title,
        t.summary,
        t.full_text,
        COALESCE(r.date_recorded, t.created_at) AS captured_at
      FROM recordings r
      LEFT JOIN transcripts t ON t.recording_id = r.id
      LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE r.id = ?
        AND ${ACTIVE_RECORDING_SQL}
      LIMIT 1
    `, [recordingId])

    if (!row) return null

    return {
      id: row.id,
      title: row.title,
      summary: row.summary || doc.content || this.buildSearchSnippet(row.full_text, []),
      capturedAt: row.captured_at,
      sourceRecordingId: row.id
    }
  }

  private buildSearchSnippet(text: unknown, terms: string[], maxLength = 240): string {
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value) return ''

    const lowerValue = value.toLowerCase()
    const firstMatch = terms.reduce((best, term) => {
      const index = lowerValue.indexOf(term.toLowerCase())
      if (index === -1) return best
      return best === -1 ? index : Math.min(best, index)
    }, -1)

    const start = firstMatch === -1 ? 0 : Math.max(0, firstMatch - 80)
    const end = Math.min(value.length, start + maxLength)
    const snippet = value.slice(start, end).trim()

    return `${start > 0 ? '... ' : ''}${snippet}${end < value.length ? ' ...' : ''}`
  }

  private getKnowledgeResultKey(result: GlobalKnowledgeResult): unknown {
    return result.sourceRecordingId ?? result.id
  }

  private buildRankedLikeClauses(
    terms: string[],
    columns: Array<{ sql: string; weight: number }>
  ): { whereSql: string; rankSql: string; params: Array<string | number> } {
    const whereParams: Array<string | number> = []
    const rankParams: Array<string | number> = []
    const termClauses: string[] = []
    const rankParts: string[] = []

    for (const term of terms) {
      const likeVal = `%${escapeLikePattern(term)}%`

      termClauses.push(`(${columns.map((column) => {
        whereParams.push(likeVal)
        return `${column.sql} LIKE ? ESCAPE '\\'`
      }).join(' OR ')})`)

      rankParts.push(`MAX(${columns.map((column) => {
        rankParams.push(likeVal)
        return `CASE WHEN ${column.sql} LIKE ? ESCAPE '\\' THEN ${column.weight} ELSE 0 END`
      }).join(', ')})`)
    }

    return {
      whereSql: termClauses.join(' OR '),
      rankSql: `(${rankParts.join(' + ')})`,
      params: [...rankParams, ...whereParams]
    }
  }

  private searchKnowledgeLexical(terms: string[], limit: number): GlobalKnowledgeResult[] {
    const db = getDatabase()
    const captureSearch = this.buildRankedLikeClauses(terms, [
      { sql: 'kc.title', weight: 3 },
      { sql: 'kc.summary', weight: 2 },
      { sql: 'm.subject', weight: 3 },
      { sql: 'r.filename', weight: 2 },
      { sql: 't.summary', weight: 2 },
      { sql: 't.full_text', weight: 1 }
    ])
    const captureRows = db.exec(`
      SELECT
        kc.id,
        kc.title,
        kc.summary,
        kc.captured_at,
        kc.source_recording_id,
        t.full_text,
        ${captureSearch.rankSql} AS match_rank
      FROM knowledge_captures kc
      LEFT JOIN transcripts t ON t.recording_id = kc.source_recording_id
      LEFT JOIN recordings r ON r.id = kc.source_recording_id
      LEFT JOIN meetings m ON m.id = COALESCE(kc.meeting_id, r.meeting_id)
      WHERE ${captureSearch.whereSql}
        AND ${ACTIVE_KNOWLEDGE_CAPTURE_SQL}
        AND ${ACTIVE_CAPTURE_SOURCE_SQL}
      GROUP BY kc.id
      ORDER BY match_rank DESC, kc.captured_at DESC
      LIMIT ?
    `, [...captureSearch.params, limit])

    const transcriptSearch = this.buildRankedLikeClauses(terms, [
      { sql: 'm.subject', weight: 3 },
      { sql: 'r.filename', weight: 2 },
      { sql: 't.summary', weight: 2 },
      { sql: 't.full_text', weight: 1 }
    ])
    const transcriptRows = db.exec(`
      SELECT
        t.recording_id AS id,
        COALESCE(m.subject, r.filename, 'Recording') AS title,
        t.summary,
        COALESCE(r.date_recorded, t.created_at) AS captured_at,
        t.recording_id AS source_recording_id,
        t.full_text,
        ${transcriptSearch.rankSql} AS match_rank
      FROM transcripts t
      JOIN recordings r ON r.id = t.recording_id
      LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE (${transcriptSearch.whereSql})
        AND t.recording_id IS NOT NULL
        AND ${ACTIVE_RECORDING_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_captures kc
          WHERE kc.source_recording_id = t.recording_id
            AND ${ACTIVE_KNOWLEDGE_CAPTURE_SQL}
        )
      ORDER BY match_rank DESC, captured_at DESC
      LIMIT ?
    `, [...transcriptSearch.params, limit])

    const rankedResults: RankedKnowledgeResult[] = []

    if (captureRows.length > 0) {
      rankedResults.push(...captureRows[0].values.map(v => ({
        id: v[0],
        title: v[1],
        summary: v[2] || this.buildSearchSnippet(v[5], terms),
        capturedAt: v[3],
        sourceRecordingId: v[4],
        lexicalRank: Number(v[6]) || 0
      })))
    }

    if (transcriptRows.length > 0) {
      rankedResults.push(...transcriptRows[0].values.map(v => ({
        id: v[0],
        title: v[1],
        summary: v[2] || this.buildSearchSnippet(v[5], terms),
        capturedAt: v[3],
        sourceRecordingId: v[4],
        lexicalRank: Number(v[6]) || 0
      })))
    }

    rankedResults.sort((a, b) => {
      if (b.lexicalRank !== a.lexicalRank) return b.lexicalRank - a.lexicalRank
      return new Date(String(b.capturedAt || 0)).getTime() - new Date(String(a.capturedAt || 0)).getTime()
    })

    const merged = new Map<unknown, GlobalKnowledgeResult>()
    for (const result of rankedResults) {
      const key = this.getKnowledgeResultKey(result)
      if (!merged.has(key)) {
        const { lexicalRank: _lexicalRank, ...knowledgeResult } = result
        merged.set(key, knowledgeResult)
      }
    }

    return Array.from(merged.values()).slice(0, limit)
  }

  private async semanticKnowledgeSearch(query: string, limit: number): Promise<SemanticKnowledgeSearchResult> {
    try {
      const vectorStore = getVectorStore()
      await vectorStore.initialize()
      const stats = vectorStore.getIndexStats()
      if (stats.documentCount > 0 && stats.currentModelDocumentCount === 0 && stats.incompatibleDocumentCount > 0) {
        return {
          results: [],
          warnings: [
            `Semantic search is unavailable because ${stats.incompatibleDocumentCount} indexed chunks use a different embedding provider or model. Rebuild the search index in Settings.`
          ]
        }
      }

      const semanticResults = await vectorStore.search(query, limit, { throwOnEmbeddingFailure: true })
      const knowledgeById = new Map<unknown, GlobalKnowledgeResult>()

      for (const result of semanticResults) {
        const capture = this.findKnowledgeCaptureForVectorDoc(result.document) ?? this.findRecordingForVectorDoc(result.document)
        if (!capture) continue

        const key = this.getKnowledgeResultKey(capture)
        if (knowledgeById.has(key)) continue

        knowledgeById.set(key, {
          ...capture,
          semanticScore: result.score
        })
      }

      return {
        results: Array.from(knowledgeById.values()),
        warnings: []
      }
    } catch (err) {
      console.warn('RAGService:semanticKnowledgeSearch failed; falling back to lexical search:', err)
      const message = err instanceof Error ? err.message : 'Unknown semantic search error'
      return {
        results: [],
        warnings: [`Semantic search unavailable: ${message}`]
      }
    }
  }

  private mergeKnowledgeResults(
    lexical: GlobalKnowledgeResult[],
    semantic: GlobalKnowledgeResult[],
    limit: number
  ): GlobalKnowledgeResult[] {
    if (semantic.length === 0) return lexical.slice(0, limit)

    const lexicalBudget = Math.max(1, Math.ceil(limit * 0.7))
    const ordered = [
      ...lexical.slice(0, lexicalBudget),
      ...semantic,
      ...lexical.slice(lexicalBudget)
    ]
    const merged = new Map<unknown, GlobalKnowledgeResult>()

    for (const result of ordered) {
      const key = this.getKnowledgeResultKey(result)
      if (!merged.has(key)) {
        merged.set(key, result)
      }
    }

    return Array.from(merged.values()).slice(0, limit)
  }

  /**
   * Perform a global search across all entities.
   * B-EXP-003: Multi-term LIKE search with ranking by match count
   * (FTS5 is NOT available in sql.js WASM, so we use improved multi-term LIKE).
   */
  async globalSearch(query: string, limit = 5): Promise<Result<GlobalSearchResponse>> {
    try {
      const db = getDatabase()

      // B-EXP-003: Multi-term LIKE search with ranking
      // B-CHAT-007: Explicit columns instead of SELECT *
      const terms = query.trim().split(/\s+/).filter((t) => t.length > 0)

      if (terms.length === 0) {
        return success({ knowledge: [], people: [], projects: [] })
      }

      // For single-term queries, use simpler approach
      if (terms.length === 1) {
        const escaped = escapeLikePattern(terms[0])
        const likeQuery = `%${escaped}%`

        const knowledge = this.searchKnowledgeLexical(terms, limit)
        const semanticKnowledge = await this.semanticKnowledgeSearch(query, limit)
        const mergedKnowledge = this.mergeKnowledgeResults(knowledge, semanticKnowledge.results, limit)

        const peopleRows = db.exec(`
          SELECT id, name, email, type FROM contacts
          WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\'
          LIMIT ?
        `, [likeQuery, likeQuery, likeQuery, likeQuery, limit])

        const people = peopleRows.length > 0 ? peopleRows[0].values.map(v => ({
          id: v[0],
          name: v[1],
          email: v[2],
          type: v[3]
        })) : []

        const projectRows = db.exec(`
          SELECT id, name, description, status FROM projects
          WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
          LIMIT ?
        `, [likeQuery, likeQuery, limit])

        const projects = projectRows.length > 0 ? projectRows[0].values.map(v => ({
          id: v[0],
          name: v[1],
          status: v[3]
        })) : []

        return success({
          knowledge: mergedKnowledge,
          people,
          projects,
          warnings: semanticKnowledge.warnings
        })
      }

      // Multi-term search: match ANY term, rank by how many terms matched
      const buildMultiTermQuery = (
        table: string,
        columns: string[],
        selectCols: string,
        limitVal: number
      ): { sql: string; params: Array<string | number> } => {
        const whereParams: Array<string | number> = []
        const rankParams: Array<string | number> = []
        const termClauses: string[] = []
        const matchCountParts: string[] = []

        for (const term of terms) {
          const escaped = escapeLikePattern(term)
          const likeVal = `%${escaped}%`

          const colClauses = columns.map((col) => {
            whereParams.push(likeVal)
            return `${col} LIKE ? ESCAPE '\\'`
          })
          termClauses.push(`(${colClauses.join(' OR ')})`)

          const countExpr = columns.map((col) => {
            rankParams.push(likeVal)
            return `CASE WHEN ${col} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`
          })
          matchCountParts.push(`MAX(${countExpr.join(', ')})`)
        }

        const whereClause = termClauses.join(' OR ')
        const rankExpr = `(${matchCountParts.join(' + ')})`

        const sql = `SELECT ${selectCols}, ${rankExpr} AS match_rank FROM ${table} WHERE ${whereClause} ORDER BY match_rank DESC LIMIT ?`
        return { sql, params: [...rankParams, ...whereParams, limitVal] }
      }

      // 1. Search knowledge captures with explicit columns + multi-term ranking
      const knowledge = this.searchKnowledgeLexical(terms, limit)
      const semanticKnowledge = await this.semanticKnowledgeSearch(query, limit)
      const mergedKnowledge = this.mergeKnowledgeResults(knowledge, semanticKnowledge.results, limit)

      // 2. Search people with explicit columns + multi-term ranking
      const pq = buildMultiTermQuery('contacts', ['name', 'email', 'company', 'role'], 'id, name, email, type', limit)
      const peopleRows = db.exec(pq.sql, pq.params)
      const people = peopleRows.length > 0 ? peopleRows[0].values.map(v => ({
        id: v[0],
        name: v[1],
        email: v[2],
        type: v[3]
      })) : []

      // 3. Search projects with explicit columns + multi-term ranking
      const prq = buildMultiTermQuery('projects', ['name', 'description'], 'id, name, description, status', limit)
      const projectRows = db.exec(prq.sql, prq.params)
      const projects = projectRows.length > 0 ? projectRows[0].values.map(v => ({
        id: v[0],
        name: v[1],
        status: v[3]
      })) : []

      return success({
        knowledge: mergedKnowledge,
        people,
        projects,
        warnings: semanticKnowledge.warnings
      })
    } catch (err) {
      console.error('RAGService:globalSearch error:', err)
      return error('DATABASE_ERROR', 'Global search failed', err)
    }
  }
}

// Singleton instance
let ragInstance: RAGService | null = null

export function getRAGService(): RAGService {
  if (!ragInstance) {
    ragInstance = new RAGService()
  }
  return ragInstance
}

export function resetRAGService(): void {
  ragInstance = null
}

export { RAGService }
export type { RAGResponse, ChatContext }
