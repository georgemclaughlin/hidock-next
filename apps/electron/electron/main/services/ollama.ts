/**
 * Ollama Service
 * Generation-only client for local meeting notes.
 */

import { getConfig } from './config'
import { canUseOllamaUrl } from './privacy'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import type { IncomingMessage } from 'http'

const DEFAULT_OLLAMA_BASE_URL = ''
const DEFAULT_NOTES_MODEL = 'llama3.2'

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaChatResponse {
  model: string
  message?: Partial<OllamaChatMessage> & { thinking?: string }
  done: boolean
  error?: string
}

type OllamaGenerationOptions = {
  temperature?: number
  maxTokens?: number
  think?: boolean
  signal?: AbortSignal
  timeoutMs?: number
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
    options: OllamaGenerationOptions = {}
  ): Promise<string | null> {
    const messages: OllamaChatMessage[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    return this.chat(messages, options)
  }

  async chat(
    messages: OllamaChatMessage[],
    options: OllamaGenerationOptions = {}
  ): Promise<string | null> {
    if (!this.baseUrl.trim()) return null

    try {
      const payload = {
        model: this.notesModel,
        messages,
        stream: true,
        think: options.think ?? this.thinkingEnabled,
        options: {
          temperature: options.temperature ?? 0.2,
          ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {})
        }
      }

      return await this.postStreamingChat(payload, options.signal, options.timeoutMs ?? 45 * 60 * 1000)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[Ollama] Generation request was cancelled')
        return null
      }
      console.error('Failed to generate with Ollama:', error)
      return null
    }
  }

  private async postStreamingChat(
    payload: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<string | null> {
    const url = new URL('/api/chat', this.baseUrl)
    const body = JSON.stringify(payload)
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest

    return new Promise((resolve, reject) => {
      let settled = false
      let abortHandler: (() => void) | undefined

      const finish = (error?: Error, value?: string | null): void => {
        if (settled) return
        settled = true
        if (abortHandler) signal?.removeEventListener('abort', abortHandler)
        if (error) {
          reject(error)
          return
        }
        resolve(value ?? null)
      }

      const request = requestFn(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (response) => this.readStreamingChatResponse(response, finish)
      )

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)} seconds`))
      })
      request.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))

      abortHandler = () => {
        const error = new Error('Ollama generation request was cancelled')
        error.name = 'AbortError'
        request.destroy(error)
      }

      if (signal?.aborted) {
        abortHandler()
        return
      }

      signal?.addEventListener('abort', abortHandler, { once: true })
      request.write(body)
      request.end()
    })
  }

  private readStreamingChatResponse(
    response: IncomingMessage,
    finish: (error?: Error, value?: string | null) => void
  ): void {
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

    if ((response.statusCode ?? 500) >= 400) {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const message = Buffer.concat(chunks).toString('utf8') || response.statusMessage || 'Ollama chat request failed'
        finish(new Error(`Ollama chat error ${response.statusCode}: ${message}`))
      })
      response.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
      return
    }

    const processBuffer = (flush: boolean): boolean => {
      const lines = buffer.split(/\r?\n/)
      buffer = flush ? '' : lines.pop() ?? ''
      const completeLines = flush ? lines.filter((line) => line.trim()) : lines

      for (const line of completeLines) {
        if (readLine(line)) {
          finish(undefined, content || null)
          response.destroy()
          return true
        }
      }

      return false
    }

    response.on('data', (chunk: Buffer) => {
      try {
        buffer += decoder.decode(chunk, { stream: true })
        processBuffer(false)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        response.destroy()
      }
    })
    response.on('end', () => {
      try {
        buffer += decoder.decode()
        if (!processBuffer(true)) {
          finish(undefined, content || null)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    response.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
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
