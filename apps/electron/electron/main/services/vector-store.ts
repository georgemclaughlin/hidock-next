/**
 * Vector Store Service
 * Simple in-memory vector store with SQLite persistence for meeting transcript embeddings
 */

import { getDatabase } from './database'
import { getEmbeddingService } from './embeddings'
import type { EmbeddingResult } from './embeddings'

interface VectorDocument {
  id: string
  content: string
  embedding: number[]
  embeddingProvider?: string
  embeddingModel?: string
  embeddingDimensions?: number
  metadata: {
    meetingId?: string
    recordingId?: string
    chunkIndex: number
    timestamp?: string
    subject?: string
  }
}

interface SearchResult {
  document: VectorDocument
  score: number
}

interface VectorIndexStats {
  documentCount: number
  meetingCount: number
  currentModelDocumentCount: number
  incompatibleDocumentCount: number
  embeddingProvider: string
  embeddingModel: string
}

interface VectorReindexResult {
  totalTranscripts: number
  reindexedTranscripts: number
  indexedChunks: number
  skipped: number
  failed: Array<{ recordingId: string; error: string }>
}

type TranscriptIndexMetadata = {
  meetingId?: string
  recordingId?: string
  timestamp?: string
  subject?: string
}

// Cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

function isComparableEmbedding(doc: VectorDocument, query: EmbeddingResult): boolean {
  if (doc.embedding.length !== query.embedding.length) return false
  if (doc.embeddingProvider && doc.embeddingProvider !== query.provider) return false
  if (doc.embeddingModel && doc.embeddingModel !== query.model) return false
  return true
}

// Split text into chunks for embedding
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = []
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)

  let currentChunk = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (currentChunk.length + trimmed.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      // Keep overlap from end of previous chunk
      const words = currentChunk.split(' ')
      const overlapWords = words.slice(-Math.ceil(overlap / 10))
      currentChunk = overlapWords.join(' ') + ' ' + trimmed
    } else {
      currentChunk += (currentChunk.length > 0 ? '. ' : '') + trimmed
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

class VectorStore {
  private documents: Map<string, VectorDocument> = new Map()
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return

    const db = getDatabase()

    // Create vector_embeddings table (separate from database.ts embeddings table)
    db.run(`
      CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        meeting_id TEXT,
        recording_id TEXT,
        chunk_index INTEGER,
        timestamp TEXT,
        subject TEXT,
        embedding_provider TEXT,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)

    this.ensureEmbeddingMetadataColumns()

    // Create index for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_meeting ON vector_embeddings(meeting_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_recording ON vector_embeddings(recording_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_model ON vector_embeddings(embedding_provider, embedding_model)`)

    // Load existing embeddings into memory
    await this.loadFromDatabase()

    this.initialized = true
    console.log(`Vector store initialized with ${this.documents.size} documents`)
  }

  private ensureEmbeddingMetadataColumns(): void {
    const db = getDatabase()
    const tableInfo = db.exec('PRAGMA table_info(vector_embeddings)')
    const columns = new Set((tableInfo[0]?.values ?? []).map((row) => row[1] as string))

    const missingColumns: Array<{ name: string; definition: string }> = [
      { name: 'embedding_provider', definition: 'embedding_provider TEXT' },
      { name: 'embedding_model', definition: 'embedding_model TEXT' },
      { name: 'embedding_dimensions', definition: 'embedding_dimensions INTEGER' }
    ].filter((column) => !columns.has(column.name))

    for (const column of missingColumns) {
      db.run(`ALTER TABLE vector_embeddings ADD COLUMN ${column.definition}`)
    }
  }

  private async loadFromDatabase(): Promise<void> {
    const db = getDatabase()
    const rows = db.exec('SELECT * FROM vector_embeddings')

    if (rows.length === 0) return

    const columns = rows[0].columns
    for (const row of rows[0].values) {
      const doc: Record<string, unknown> = {}
      columns.forEach((col, i) => {
        doc[col] = row[i]
      })

      const vectorDoc: VectorDocument = {
        id: doc['id'] as string,
        content: doc['content'] as string,
        embedding: JSON.parse(doc['embedding'] as string),
        embeddingProvider: doc['embedding_provider'] as string | undefined,
        embeddingModel: doc['embedding_model'] as string | undefined,
        embeddingDimensions: (doc['embedding_dimensions'] as number | undefined) ?? undefined,
        metadata: {
          meetingId: doc['meeting_id'] as string | undefined,
          recordingId: doc['recording_id'] as string | undefined,
          chunkIndex: doc['chunk_index'] as number,
          timestamp: doc['timestamp'] as string | undefined,
          subject: doc['subject'] as string | undefined
        }
      }

      this.documents.set(vectorDoc.id, vectorDoc)
    }
  }

  private insertEmbeddedDocument(
    content: string,
    metadata: VectorDocument['metadata'],
    embeddingResult: EmbeddingResult,
    batchTimestamp = Date.now()
  ): string {
    const id = `${metadata.recordingId || 'doc'}_${metadata.chunkIndex}_${batchTimestamp}`

    const doc: VectorDocument = {
      id,
      content,
      embedding: embeddingResult.embedding,
      embeddingProvider: embeddingResult.provider,
      embeddingModel: embeddingResult.model,
      embeddingDimensions: embeddingResult.dimensions,
      metadata
    }

    this.documents.set(id, doc)

    const db = getDatabase()
    db.run(
      `INSERT OR REPLACE INTO vector_embeddings
       (id, content, embedding, meeting_id, recording_id, chunk_index, timestamp, subject,
        embedding_provider, embedding_model, embedding_dimensions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        content,
        JSON.stringify(embeddingResult.embedding),
        metadata.meetingId || null,
        metadata.recordingId || null,
        metadata.chunkIndex,
        metadata.timestamp || null,
        metadata.subject || null,
        embeddingResult.provider,
        embeddingResult.model,
        embeddingResult.dimensions
      ]
    )

    return id
  }

  async addDocument(
    content: string,
    metadata: VectorDocument['metadata']
  ): Promise<string | null> {
    const embeddingService = getEmbeddingService()

    // Generate embedding
    const embeddingResult = await embeddingService.generateEmbedding(content, 'document')
    if (!embeddingResult) {
      console.error('Failed to generate embedding for document')
      return null
    }

    return this.insertEmbeddedDocument(content, metadata, embeddingResult)
  }

  async indexTranscript(
    transcript: string,
    metadata: TranscriptIndexMetadata,
    options: { force?: boolean } = {}
  ): Promise<number> {
    let existing: VectorDocument[] = []

    // Check if already indexed
    if (metadata.recordingId) {
      existing = Array.from(this.documents.values()).filter(
        (d) => d.metadata.recordingId === metadata.recordingId
      )
      if (existing.length > 0) {
        const embeddingModel = getEmbeddingService().getModelMetadata()
        const hasCurrentEmbeddings = existing.every(
          (doc) => doc.embeddingProvider === embeddingModel.provider && doc.embeddingModel === embeddingModel.model
        )

        if (hasCurrentEmbeddings && !options.force) {
          console.log(`Transcript ${metadata.recordingId} already indexed`)
          return 0
        }
      }
    }

    // Chunk the transcript
    const chunks = chunkText(transcript)
    if (chunks.length === 0) return 0

    const embeddingResults = await getEmbeddingService().generateEmbeddings(chunks, 'document')
    const indexedEmbeddings = embeddingResults
      .map((embeddingResult, index) => ({ embeddingResult, index }))
      .filter((item): item is { embeddingResult: EmbeddingResult; index: number } => Boolean(item.embeddingResult))

    if (indexedEmbeddings.length === 0) {
      console.error('Failed to generate embeddings for transcript')
      return 0
    }

    if (metadata.recordingId && existing.length > 0) {
      console.log(`Transcript ${metadata.recordingId} embeddings use an old model or were explicitly reindexed`)
      await this.deleteByRecording(metadata.recordingId)
    }

    let indexed = 0
    const batchTimestamp = Date.now()

    for (const { embeddingResult, index } of indexedEmbeddings) {
      this.insertEmbeddedDocument(chunks[index], {
        ...metadata,
        chunkIndex: index
      }, embeddingResult, batchTimestamp)
      indexed++
    }

    console.log(`Indexed ${indexed} chunks for transcript`)
    return indexed
  }

  async reindexAllTranscripts(): Promise<VectorReindexResult> {
    await this.initialize()

    const db = getDatabase()
    const rows = db.exec(`
      SELECT
        t.recording_id,
        t.full_text,
        r.date_recorded,
        r.filename,
        r.meeting_id,
        m.subject
      FROM transcripts t
      LEFT JOIN recordings r ON r.id = t.recording_id
      LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE t.full_text IS NOT NULL AND TRIM(t.full_text) != ''
      ORDER BY r.date_recorded DESC
    `)

    const result: VectorReindexResult = {
      totalTranscripts: rows[0]?.values.length ?? 0,
      reindexedTranscripts: 0,
      indexedChunks: 0,
      skipped: 0,
      failed: []
    }

    if (rows.length === 0) return result

    for (const row of rows[0].values) {
      const [recordingId, fullText, dateRecorded, filename, meetingId, meetingSubject] = row
      const transcript = typeof fullText === 'string' ? fullText.trim() : ''
      const recording = typeof recordingId === 'string' ? recordingId : undefined

      if (!recording || !transcript) {
        result.skipped++
        continue
      }

      try {
        const indexed = await this.indexTranscript(transcript, {
          recordingId: recording,
          meetingId: typeof meetingId === 'string' ? meetingId : undefined,
          timestamp: typeof dateRecorded === 'string' ? dateRecorded : undefined,
          subject: typeof meetingSubject === 'string'
            ? meetingSubject
            : typeof filename === 'string'
              ? filename
              : undefined
        }, { force: true })

        if (indexed > 0) {
          result.reindexedTranscripts++
          result.indexedChunks += indexed
        } else {
          result.skipped++
        }
      } catch (error) {
        result.failed.push({
          recordingId: recording,
          error: error instanceof Error ? error.message : 'Unknown reindexing error'
        })
      }
    }

    return result
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (this.documents.size === 0) return []

    const embeddingService = getEmbeddingService()

    // Generate query embedding
    const queryEmbedding = await embeddingService.generateEmbedding(query, 'query')
    if (!queryEmbedding) {
      console.error('Failed to generate query embedding')
      return []
    }

    // Calculate similarity scores
    const results: SearchResult[] = []

    for (const doc of this.documents.values()) {
      if (!isComparableEmbedding(doc, queryEmbedding)) continue
      const score = cosineSimilarity(queryEmbedding.embedding, doc.embedding)
      results.push({ document: doc, score })
    }

    // Sort by score descending and take top K
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async searchByMeeting(meetingId: string): Promise<VectorDocument[]> {
    return Array.from(this.documents.values())
      .filter((d) => d.metadata.meetingId === meetingId)
      .sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex)
  }

  async deleteByRecording(recordingId: string): Promise<number> {
    let deleted = 0
    const db = getDatabase()

    for (const [id, doc] of this.documents.entries()) {
      if (doc.metadata.recordingId === recordingId) {
        this.documents.delete(id)
        deleted++
      }
    }

    db.run('DELETE FROM vector_embeddings WHERE recording_id = ?', [recordingId])
    return deleted
  }

  /**
   * AI-06 FIX: Update meeting_id for all chunks belonging to a recording
   * Called when AI links a recording to a meeting after transcription
   */
  async updateMeetingIdForRecording(recordingId: string, meetingId: string, meetingSubject?: string): Promise<number> {
    let updated = 0
    const db = getDatabase()

    // Update in-memory documents
    for (const doc of this.documents.values()) {
      if (doc.metadata.recordingId === recordingId) {
        doc.metadata.meetingId = meetingId
        if (meetingSubject) {
          doc.metadata.subject = meetingSubject
        }
        updated++
      }
    }

    // Update in database
    if (meetingSubject) {
      db.run(
        'UPDATE vector_embeddings SET meeting_id = ?, subject = ? WHERE recording_id = ?',
        [meetingId, meetingSubject, recordingId]
      )
    } else {
      db.run(
        'UPDATE vector_embeddings SET meeting_id = ? WHERE recording_id = ?',
        [meetingId, recordingId]
      )
    }

    console.log(`Updated meeting_id for ${updated} vector chunks (recording ${recordingId} -> meeting ${meetingId})`)
    return updated
  }

  getDocumentCount(): number {
    return this.documents.size
  }

  getMeetingCount(): number {
    const meetingIds = new Set<string>()
    for (const doc of this.documents.values()) {
      if (doc.metadata.meetingId) {
        meetingIds.add(doc.metadata.meetingId)
      }
    }
    return meetingIds.size
  }

  getAllDocuments(): VectorDocument[] {
    return Array.from(this.documents.values())
  }

  getIndexStats(): VectorIndexStats {
    const currentModel = getEmbeddingService().getModelMetadata()
    let currentModelDocumentCount = 0
    let incompatibleDocumentCount = 0

    for (const doc of this.documents.values()) {
      if (doc.embeddingProvider === currentModel.provider && doc.embeddingModel === currentModel.model) {
        currentModelDocumentCount++
      } else {
        incompatibleDocumentCount++
      }
    }

    return {
      documentCount: this.getDocumentCount(),
      meetingCount: this.getMeetingCount(),
      currentModelDocumentCount,
      incompatibleDocumentCount,
      embeddingProvider: currentModel.provider,
      embeddingModel: currentModel.model
    }
  }
}

// Singleton instance
let vectorStoreInstance: VectorStore | null = null

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    vectorStoreInstance = new VectorStore()
  }
  return vectorStoreInstance
}

export { VectorStore, chunkText, cosineSimilarity }
export type { VectorDocument, SearchResult, VectorIndexStats, VectorReindexResult }
