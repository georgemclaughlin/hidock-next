/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { VectorStore } from '../vector-store'

const embeddingMocks = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
  getModelMetadata: vi.fn()
}))

let dbInstance: any = null

vi.mock('../database', () => ({
  getDatabase: () => dbInstance
}))

vi.mock('../embeddings', () => ({
  getEmbeddingService: () => ({
    generateEmbedding: embeddingMocks.generateEmbedding,
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
})
