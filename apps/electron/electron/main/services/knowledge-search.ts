import { getVectorStore, VectorDocument } from './vector-store'
import { escapeLikePattern, getDatabase, queryOne } from './database'
import { error, Result, success } from '../types/api'

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

class KnowledgeSearchService {
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
            `Semantic search is unavailable because ${stats.incompatibleDocumentCount} indexed chunks use a different embedding model. Rebuild the search index in Settings.`
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
      console.warn('KnowledgeSearch: semantic search failed; falling back to lexical search:', err)
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

  async globalSearch(query: string, limit = 5): Promise<Result<GlobalSearchResponse>> {
    try {
      const db = getDatabase()
      const terms = query.trim().split(/\s+/).filter((t) => t.length > 0)

      if (terms.length === 0) {
        return success({ knowledge: [], people: [], projects: [] })
      }

      const knowledge = this.searchKnowledgeLexical(terms, limit)
      const semanticKnowledge = await this.semanticKnowledgeSearch(query, limit)
      const mergedKnowledge = this.mergeKnowledgeResults(knowledge, semanticKnowledge.results, limit)

      if (terms.length === 1) {
        const likeQuery = `%${escapeLikePattern(terms[0])}%`
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
          const likeVal = `%${escapeLikePattern(term)}%`

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

        return {
          sql: `SELECT ${selectCols}, ${rankExpr} AS match_rank FROM ${table} WHERE ${whereClause} ORDER BY match_rank DESC LIMIT ?`,
          params: [...rankParams, ...whereParams, limitVal]
        }
      }

      const peopleQuery = buildMultiTermQuery('contacts', ['name', 'email', 'company', 'role'], 'id, name, email, type', limit)
      const peopleRows = db.exec(peopleQuery.sql, peopleQuery.params)
      const people = peopleRows.length > 0 ? peopleRows[0].values.map(v => ({
        id: v[0],
        name: v[1],
        email: v[2],
        type: v[3]
      })) : []

      const projectQuery = buildMultiTermQuery('projects', ['name', 'description'], 'id, name, description, status', limit)
      const projectRows = db.exec(projectQuery.sql, projectQuery.params)
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
      console.error('KnowledgeSearch: global search failed:', err)
      return error('DATABASE_ERROR', 'Global search failed', err)
    }
  }
}

let knowledgeSearchInstance: KnowledgeSearchService | null = null

export function getKnowledgeSearchService(): KnowledgeSearchService {
  if (!knowledgeSearchInstance) {
    knowledgeSearchInstance = new KnowledgeSearchService()
  }
  return knowledgeSearchInstance
}

export { KnowledgeSearchService }
export type { GlobalSearchResponse }
