/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  vectorInitialize: vi.fn(),
  vectorGetIndexStats: vi.fn(),
  vectorSearch: vi.fn()
}))

let dbInstance: any = null

vi.mock('../database', () => ({
  getDatabase: () => dbInstance,
  queryOne: mocks.queryOne,
  escapeLikePattern: (value: string) => value.replace(/[\\%_]/g, '\\$&')
}))

vi.mock('../vector-store', () => ({
  getVectorStore: () => ({
    initialize: mocks.vectorInitialize,
    getIndexStats: mocks.vectorGetIndexStats,
    search: mocks.vectorSearch
  })
}))

import { KnowledgeSearchService } from '../knowledge-search'

async function createSearchDatabase() {
  const SQL = await initSqlJs()
  const db = new SQL.Database()

  db.run(`
    CREATE TABLE knowledge_captures (
      id TEXT PRIMARY KEY,
      title TEXT,
      summary TEXT,
      captured_at TEXT,
      source_recording_id TEXT,
      meeting_id TEXT,
      deleted_at TEXT,
      storage_tier TEXT
    )
  `)
  db.run(`
    CREATE TABLE recordings (
      id TEXT PRIMARY KEY,
      filename TEXT,
      date_recorded TEXT,
      meeting_id TEXT,
      location TEXT DEFAULT 'local-only',
      status TEXT DEFAULT 'ready'
    )
  `)
  db.run(`
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY,
      recording_id TEXT,
      full_text TEXT,
      summary TEXT,
      title_suggestion TEXT,
      created_at TEXT
    )
  `)
  db.run(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      subject TEXT
    )
  `)
  db.run(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      company TEXT,
      role TEXT,
      type TEXT
    )
  `)
  db.run(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      status TEXT
    )
  `)

  return db
}

describe('KnowledgeSearchService', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    dbInstance = await createSearchDatabase()
    mocks.vectorInitialize.mockResolvedValue(undefined)
    mocks.vectorGetIndexStats.mockReturnValue({
      documentCount: 0,
      currentModelDocumentCount: 0,
      incompatibleDocumentCount: 0
    })
    mocks.vectorSearch.mockResolvedValue([])
  })

  it('searches generated transcript titles and returns them for highlighting', async () => {
    dbInstance.run(`
      INSERT INTO recordings (id, filename, date_recorded)
      VALUES ('rec-1', '2026Jun07-120000-Rec01.mp3', '2026-06-07T12:00:00.000Z')
    `)
    dbInstance.run(`
      INSERT INTO transcripts (id, recording_id, full_text, summary, title_suggestion, created_at)
      VALUES (
        'transcript-1',
        'rec-1',
        'The group discussed launch timing.',
        '# Launch Plan\n\nThe group discussed launch timing.',
        'Generated Launch Plan',
        '2026-06-07T12:05:00.000Z'
      )
    `)
    dbInstance.run(`
      INSERT INTO knowledge_captures (id, title, summary, captured_at, source_recording_id)
      VALUES (
        'capture-1',
        '2026Jun07-120000-Rec01.mp3',
        NULL,
        '2026-06-07T12:05:00.000Z',
        'rec-1'
      )
    `)

    const result = await new KnowledgeSearchService().globalSearch('launch', 5)

    expect(result.success).toBe(true)
    expect((result as any).data.knowledge[0]).toMatchObject({
      id: 'capture-1',
      title: 'Generated Launch Plan',
      summary: '# Launch Plan\n\nThe group discussed launch timing.',
      sourceRecordingId: 'rec-1'
    })
  })

  it('returns generated titles for transcript-only results', async () => {
    dbInstance.run(`
      INSERT INTO recordings (id, filename, date_recorded)
      VALUES ('rec-2', 'customer-call.wav', '2026-06-07T13:00:00.000Z')
    `)
    dbInstance.run(`
      INSERT INTO transcripts (id, recording_id, full_text, summary, title_suggestion, created_at)
      VALUES (
        'transcript-2',
        'rec-2',
        'The customer reviewed onboarding concerns.',
        '# Customer Onboarding\n\nThe customer reviewed onboarding concerns.',
        'Customer Onboarding Review',
        '2026-06-07T13:05:00.000Z'
      )
    `)

    const result = await new KnowledgeSearchService().globalSearch('onboarding', 5)

    expect(result.success).toBe(true)
    expect((result as any).data.knowledge[0]).toMatchObject({
      id: 'rec-2',
      title: 'Customer Onboarding Review',
      summary: '# Customer Onboarding\n\nThe customer reviewed onboarding concerns.',
      sourceRecordingId: 'rec-2'
    })
  })
})
