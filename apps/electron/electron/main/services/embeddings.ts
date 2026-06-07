import {
  generateNativeEmbeddings,
  getNativeEmbeddingModelId,
  NativeEmbeddingInputType
} from './native-transcriber'
import { getConfig } from './config'

export type EmbeddingInputType = NativeEmbeddingInputType
export type EmbeddingRuntimeProvider = 'native-fastembed'

export interface EmbeddingResult {
  embedding: number[]
  provider: EmbeddingRuntimeProvider
  model: string
  dimensions: number
}

export interface EmbeddingModelMetadata {
  provider: EmbeddingRuntimeProvider
  model: string
  dimensions?: number
}

function getConfiguredNativeModel(): string {
  const config = getConfig()
  return getNativeEmbeddingModelId(config.embeddings?.nativeModel)
}

class EmbeddingService {
  getModelMetadata(): EmbeddingModelMetadata {
    return {
      provider: 'native-fastembed',
      model: getConfiguredNativeModel()
    }
  }

  async generateEmbedding(
    text: string,
    inputType: EmbeddingInputType = 'document'
  ): Promise<EmbeddingResult | null> {
    const [result] = await this.generateEmbeddings([text], inputType)
    return result ?? null
  }

  async generateEmbeddings(
    texts: string[],
    inputType: EmbeddingInputType = 'document'
  ): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return []

    return this.generateNativeFastEmbeddings(texts, inputType)
  }

  private async generateNativeFastEmbeddings(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<(EmbeddingResult | null)[]> {
    try {
      const model = getConfiguredNativeModel()
      const result = await generateNativeEmbeddings(texts, inputType, model)

      return texts.map((_, index) => {
        const embedding = result.embeddings[index]
        if (!embedding) return null

        return {
          embedding,
          provider: result.provider,
          model: result.model_id,
          dimensions: result.dimensions || embedding.length
        }
      })
    } catch (error) {
      console.error('[Embeddings] Native embedding generation failed:', error)
      return texts.map(() => null)
    }
  }
}

let embeddingServiceInstance: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new EmbeddingService()
  }
  return embeddingServiceInstance
}

export { EmbeddingService }
