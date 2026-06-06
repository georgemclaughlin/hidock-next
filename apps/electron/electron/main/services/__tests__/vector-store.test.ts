/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { VectorStore } from '../vector-store'

const embeddingMocks = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  getModelMetadata: vi.fn()
}))

let dbInstance: any = null

vi.mock('../database', () => ({
  getDatabase: () => dbInstance
}))

vi.mock('../embeddings', () => ({
  getEmbeddingService: () => ({
    generateEmbedding: embeddingMocks.generateEmbedding,
    generateEmbeddings: embeddingMocks.generateEmbeddings,
    getModelMetadata: embeddingMocks.getModelMetadata
  })
}))

describe('VectorStore embedding metadata', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const SQL = await initSqlJs()
    dbInstance = new SQL.Database()
    embeddingMocks.getModelMetadata.mockReturnValue({
      provider: 'native-fastembed',
      model: 'bge-small-en-v1.5-q'
    })
    embeddingMocks.generateEmbeddings.mockImplementation(async (texts: string[]) => (
      texts.map(() => ({
        embedding: [1, 0],
        provider: 'native-fastembed',
        model: 'bge-small-en-v1.5-q',
        dimensions: 2
      }))
    ))
  })

  it('persists provider, model, and dimensions for indexed chunks', async () => {
    embeddingMocks.generateEmbedding.mockResolvedValue({
      embedding: [1, 0],
      provider: 'native-fastembed',
      model: 'bge-small-en-v1.5-q',
      dimensions: 2
    })

    const store = new VectorStore()
    await store.initialize()
    await store.addDocument('pricing discussion', {
      recordingId: 'rec-1',
      chunkIndex: 0,
      subject: 'Roadmap'
    })

    const rows = dbInstance.exec(`
      SELECT embedding_provider, embedding_model, embedding_dimensions
      FROM vector_embeddings
      WHERE recording_id = 'rec-1'
    `)

    expect(rows[0].values[0]).toEqual(['native-fastembed', 'bge-small-en-v1.5-q', 2])
  })

  it('does not compare vectors from a different embedding provider or model', async () => {
    embeddingMocks.generateEmbedding
      .mockResolvedValueOnce({
        embedding: [1, 0],
        provider: 'native-fastembed',
        model: 'bge-small-en-v1.5-q',
        dimensions: 2
      })
      .mockResolvedValueOnce({
        embedding: [1, 0],
        provider: 'ollama',
        model: 'nomic-embed-text',
        dimensions: 2
      })

    const store = new VectorStore()
    await store.initialize()
    await store.addDocument('pricing discussion', {
      recordingId: 'rec-1',
      chunkIndex: 0
    })

    const results = await store.search('pricing', 5)

    expect(results).toEqual([])
  })

  it('reindexes all persisted transcripts with the current embedding model', async () => {
    dbInstance.run(`
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        recording_id TEXT,
        full_text TEXT NOT NULL
      )
    `)
    dbInstance.run(`
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        date_recorded TEXT NOT NULL,
        meeting_id TEXT
      )
    `)
    dbInstance.run(`
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL
      )
    `)
    dbInstance.run("INSERT INTO meetings (id, subject) VALUES ('meeting-1', 'Roadmap')")
    dbInstance.run(`
      INSERT INTO recordings (id, filename, date_recorded, meeting_id)
      VALUES ('rec-1', 'roadmap.wav', '2026-01-01T12:00:00.000Z', 'meeting-1')
    `)
    dbInstance.run(`
      INSERT INTO transcripts (id, recording_id, full_text)
      VALUES ('transcript-1', 'rec-1', 'Pricing discussion. Launch plan.')
    `)

    const store = new VectorStore()
    await store.initialize()
    const result = await store.reindexAllTranscripts()

    expect(result).toMatchObject({
      totalTranscripts: 1,
      reindexedTranscripts: 1,
      indexedChunks: 1,
      skipped: 0,
      failed: []
    })

    const rows = dbInstance.exec(`
      SELECT recording_id, embedding_provider, embedding_model
      FROM vector_embeddings
      WHERE recording_id = 'rec-1'
    `)
    expect(rows[0].values[0]).toEqual(['rec-1', 'native-fastembed', 'bge-small-en-v1.5-q'])
  })
})
