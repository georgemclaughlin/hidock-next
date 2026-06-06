import { getConfig } from './config'
import { getOllamaService } from './ollama'
import {
  generateNativeEmbeddings,
  getNativeEmbeddingModelId,
  NativeEmbeddingInputType
} from './native-transcriber'

export type EmbeddingInputType = NativeEmbeddingInputType
export type EmbeddingRuntimeProvider = 'native-fastembed' | 'ollama'

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

const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text'

function getConfiguredEmbeddingProvider(): 'native' | 'ollama' {
  const config = getConfig()
  return config.embeddings?.provider === 'ollama' ? 'ollama' : 'native'
}

function getConfiguredNativeModel(): string {
  const config = getConfig()
  return getNativeEmbeddingModelId(config.embeddings?.nativeModel)
}

function getConfiguredOllamaModel(): string {
  const config = getConfig()
  return config.embeddings?.ollamaModel || DEFAULT_OLLAMA_EMBEDDING_MODEL
}

function prepareOllamaEmbeddingText(
  text: string,
  inputType: EmbeddingInputType,
  model: string
): string {
  const trimmed = text.trim()
  if (!model.toLowerCase().includes('nomic')) {
    return trimmed
  }

  const prefix = inputType === 'query' ? 'search_query: ' : 'search_document: '
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`
}

class EmbeddingService {
  getModelMetadata(): EmbeddingModelMetadata {
    if (getConfiguredEmbeddingProvider() === 'ollama') {
      return {
        provider: 'ollama',
        model: getConfiguredOllamaModel()
      }
    }

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

    if (getConfiguredEmbeddingProvider() === 'ollama') {
      return this.generateOllamaEmbeddings(texts, inputType)
    }

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

  private async generateOllamaEmbeddings(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<(EmbeddingResult | null)[]> {
    const model = getConfiguredOllamaModel()
    const preparedTexts = texts.map((text) => prepareOllamaEmbeddingText(text, inputType, model))
    const embeddings = await getOllamaService().generateEmbeddings(preparedTexts)

    return embeddings.map((embedding) => {
      if (!embedding) return null

      return {
        embedding,
        provider: 'ollama',
        model,
        dimensions: embedding.length
      }
    })
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
