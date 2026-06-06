import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { getRAGService, resetRAGService } from '../rag'

vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => ({
    isAvailable: vi.fn().mockResolvedValue(true),
    ensureChatModel: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockResolvedValue('AI Response')
  }))
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(true),
    getIndexStats: vi.fn().mockReturnValue({
      documentCount: 0,
      meetingCount: 0,
      currentModelDocumentCount: 0,
      incompatibleDocumentCount: 0,
      embeddingProvider: 'native-fastembed',
      embeddingModel: 'bge-small-en-v1.5-q'
    }),
    search: vi.fn().mockResolvedValue([])
  }))
}))

vi.mock('../embeddings', () => ({
  getEmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: [0.1, 0.2],
      provider: 'native-fastembed',
      model: 'bge-small-en-v1.5-q',
      dimensions: 2
    })
  }))
}))

let dbInstance: any = null

vi.mock('../database', () => ({
  getDatabase: () => dbInstance,
  queryOne: vi.fn((sql: string, params: any[]) => {
    if (!dbInstance) return undefined
    const result = dbInstance.exec(sql, params)
    if (result.length === 0 || result[0].values.length === 0) return undefined
    const columns = result[0].columns
    const values = result[0].values[0]
    const row: any = {}
    columns.forEach((col: string, index: number) => {
      row[col] = values[index]
    })
    return row
  }),
  escapeLikePattern: vi.fn((pattern: string) => pattern.replace(/[%_\\]/g, '\\$&'))
}))

describe('RAGService globalSearch', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetRAGService()

    const SQL = await initSqlJs()
    dbInstance = new SQL.Database()
    dbInstance.run(`
      CREATE TABLE knowledge_captures (
        id TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        captured_at TEXT,
        source_recording_id TEXT,
        meeting_id TEXT,
        storage_tier TEXT DEFAULT 'hot',
        deleted_at TEXT
      );
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        recording_id TEXT,
        full_text TEXT NOT NULL,
        summary TEXT,
        created_at TEXT
      );
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        date_recorded TEXT NOT NULL,
        meeting_id TEXT,
        location TEXT DEFAULT 'local-only',
        status TEXT DEFAULT 'ready'
      );
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        subject TEXT
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        type TEXT,
        company TEXT,
        role TEXT
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        status TEXT
      );
    `)
  })

  afterEach(() => {
    dbInstance?.close()
    dbInstance = null
  })

  it('returns transcript-only external recordings when the exact term is in full_text', async () => {
    dbInstance.run(`
      INSERT INTO recordings (id, filename, date_recorded)
      VALUES ('rec-dialogue', 'DIALOGUE.ogg', '2026-06-06T01:02:00.000Z')
    `)
    dbInstance.run(`
      INSERT INTO transcripts (id, recording_id, full_text, created_at)
      VALUES (
        'transcript-dialogue',
        'rec-dialogue',
        'I was watching the Boston Marathon and the thought started there.',
        '2026-06-06T01:05:00.000Z'
      )
    `)

    const result = await getRAGService().globalSearch('Boston', 10)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.knowledge).toEqual([
      expect.objectContaining({
        id: 'rec-dialogue',
        title: 'DIALOGUE.ogg',
        sourceRecordingId: 'rec-dialogue'
      })
    ])
    expect(result.data.knowledge[0].summary).toContain('Boston Marathon')
  })

  it('does not return transcript rows for deleted recordings', async () => {
    dbInstance.run(`
      INSERT INTO recordings (id, filename, date_recorded, location, status)
      VALUES ('rec-deleted', 'deleted-dialogue.ogg', '2026-06-06T01:02:00.000Z', 'deleted', 'deleted')
    `)
    dbInstance.run(`
      INSERT INTO transcripts (id, recording_id, full_text, created_at)
      VALUES (
        'transcript-deleted',
        'rec-deleted',
        'I was watching the Boston Marathon and the thought started there.',
        '2026-06-06T01:05:00.000Z'
      )
    `)

    const result = await getRAGService().globalSearch('Boston', 10)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.knowledge).toEqual([])
  })
})
