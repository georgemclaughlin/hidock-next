import { ipcMain } from 'electron'
import { getKnowledgeSearchService } from '../services/knowledge-search'

export function registerSearchHandlers(): void {
  ipcMain.handle(
    'search:global',
    async (_event, { query, limit }: { query: string; limit?: number }) => {
      return getKnowledgeSearchService().globalSearch(query, limit)
    }
  )

  console.log('Search IPC handlers registered')
}
