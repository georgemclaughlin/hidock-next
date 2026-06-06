import { ipcMain } from 'electron'
import {
  downloadNativeEmbeddingModel,
  listNativeEmbeddingModels
} from '../services/native-transcriber'
import { getVectorStore } from '../services/vector-store'
import { success, error, Result } from '../types/api'
import type { NativeEmbeddingDownloadResult, NativeEmbeddingModel } from '../services/native-transcriber'
import type { VectorIndexStats, VectorReindexResult } from '../services/vector-store'

export function registerEmbeddingHandlers(): void {
  ipcMain.handle('embeddings:listModels', async (): Promise<Result<NativeEmbeddingModel[]>> => {
    try {
      return success(await listNativeEmbeddingModels())
    } catch (err) {
      console.error('embeddings:listModels error:', err)
      return error('INTERNAL_ERROR', 'Failed to list native embedding models', err)
    }
  })

  ipcMain.handle(
    'embeddings:downloadModel',
    async (_event, modelId: string): Promise<Result<NativeEmbeddingDownloadResult>> => {
      try {
        if (!modelId || typeof modelId !== 'string') {
          return error('VALIDATION_ERROR', 'Embedding model ID is required')
        }

        return success(await downloadNativeEmbeddingModel(modelId))
      } catch (err) {
        console.error('embeddings:downloadModel error:', err)
        return error('INTERNAL_ERROR', 'Failed to download native embedding model', err)
      }
    }
  )

  ipcMain.handle('embeddings:getIndexStats', async (): Promise<Result<VectorIndexStats>> => {
    try {
      const vectorStore = getVectorStore()
      await vectorStore.initialize()
      return success(vectorStore.getIndexStats())
    } catch (err) {
      console.error('embeddings:getIndexStats error:', err)
      return error('INTERNAL_ERROR', 'Failed to load embedding index stats', err)
    }
  })

  ipcMain.handle('embeddings:reindexTranscripts', async (): Promise<Result<VectorReindexResult>> => {
    try {
      const vectorStore = getVectorStore()
      await vectorStore.initialize()
      return success(await vectorStore.reindexAllTranscripts())
    } catch (err) {
      console.error('embeddings:reindexTranscripts error:', err)
      return error('INTERNAL_ERROR', 'Failed to reindex transcript embeddings', err)
    }
  })

  console.log('Embedding IPC handlers registered')
}
