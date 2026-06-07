/**
 * Ollama Service
 * Generation-only client for local meeting notes.
 */

import { getConfig } from './config'
import { canUseOllamaUrl } from './privacy'

const DEFAULT_OLLAMA_BASE_URL = ''
const DEFAULT_NOTES_MODEL = 'llama3.2'

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaChatResponse {
  model: string
  message?: Partial<OllamaChatMessage> & { thinking?: string }
  done: boolean
  error?: string
}

class OllamaService {
  private baseUrl: string
  private notesModel: string
  private thinkingEnabled: boolean

  constructor(
    baseUrl = DEFAULT_OLLAMA_BASE_URL,
    notesModel = DEFAULT_NOTES_MODEL,
    thinkingEnabled = true
  ) {
    this.baseUrl = baseUrl
    this.notesModel = notesModel
    this.thinkingEnabled = thinkingEnabled
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl.trim()) return false

    try {
      const response = await fetch(`${this.baseUrl}/api/version`)
      return response.ok
    } catch {
      return false
    }
  }

  async generate(
    prompt: string,
    systemPrompt?: string,
    options: {
      temperature?: number
      maxTokens?: number
      signal?: AbortSignal
      timeoutMs?: number
    } = {}
  ): Promise<string | null> {
    if (!this.baseUrl.trim()) return null

    try {
      const messages: OllamaChatMessage[] = []
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt })
      }
      messages.push({ role: 'user', content: prompt })

      const controller = new AbortController()
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const abortFromCaller = (): void => controller.abort()

      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort()
        } else {
          options.signal.addEventListener('abort', abortFromCaller, { once: true })
        }
      }

      timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 45 * 60 * 1000)

      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.notesModel,
          messages,
          stream: true,
          think: this.thinkingEnabled,
          options: {
            temperature: options.temperature ?? 0.2,
            num_predict: options.maxTokens ?? 1600
          }
        }),
        signal: controller.signal
      }

      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, fetchOptions)

        if (!response.ok) {
          console.error('Ollama chat error:', response.statusText)
          return null
        }

        return await this.readStreamingChatResponse(response)
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        options.signal?.removeEventListener('abort', abortFromCaller)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.log('[Ollama] Generation request was cancelled')
        return null
      }
      console.error('Failed to generate with Ollama:', error)
      return null
    }
  }

  private async readStreamingChatResponse(response: Response): Promise<string | null> {
    if (!response.body) {
      const data: OllamaChatResponse = await response.json()
      return data.message?.content ?? null
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''

    const readLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return false

      const data = JSON.parse(trimmed) as OllamaChatResponse
      if (data.error) {
        throw new Error(data.error)
      }

      if (data.message?.content) {
        content += data.message.content
      }

      return data.done === true
    }

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (readLine(line)) {
          await reader.cancel()
          return content || null
        }
      }

      if (done) break
    }

    if (buffer && readLine(buffer)) {
      return content || null
    }

    return content || null
  }
}

// Singleton instance
let ollamaInstance: OllamaService | null = null

export function resetOllamaService(): void {
  ollamaInstance = null
}

export function getOllamaService(): OllamaService {
  if (!ollamaInstance) {
    try {
      const config = getConfig()

      const legacyConfig = config as typeof config & {
        chat?: { ollamaModel?: string }
        embeddings?: { ollamaBaseUrl?: string }
      }
      const configuredBaseUrl =
        config.notes?.ollamaBaseUrl?.trim() ||
        legacyConfig.embeddings?.ollamaBaseUrl?.trim() ||
        DEFAULT_OLLAMA_BASE_URL
      const baseUrl = configuredBaseUrl && canUseOllamaUrl(configuredBaseUrl, config)
        ? configuredBaseUrl
        : DEFAULT_OLLAMA_BASE_URL
      const notesModel = config.notes?.ollamaModel || legacyConfig.chat?.ollamaModel || DEFAULT_NOTES_MODEL
      const thinkingEnabled = config.notes?.thinkingEnabled !== false

      if (configuredBaseUrl && baseUrl !== configuredBaseUrl) {
        console.warn('[Ollama] Remote Ollama URL blocked by local-only mode; Ollama is disabled until a loopback URL is configured')
      }

      console.log(`[Ollama] Initializing notes client: baseUrl=${baseUrl}, notesModel=${notesModel}, thinkingEnabled=${thinkingEnabled}`)

      ollamaInstance = new OllamaService(baseUrl, notesModel, thinkingEnabled)
    } catch (error) {
      console.warn('[Ollama] Failed to read config, using defaults:', error)
      ollamaInstance = new OllamaService()
    }
  }
  return ollamaInstance
}

export { OllamaService }
