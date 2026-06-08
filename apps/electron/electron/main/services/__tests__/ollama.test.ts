import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    notes: {
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'custom-notes-model',
      thinkingEnabled: true
    },
    privacy: {
      localOnly: true,
      allowRemoteOllama: false
    }
  }))
}))

vi.mock('../privacy', () => ({
  canUseOllamaUrl: vi.fn(() => true)
}))

import { OllamaService } from '../ollama'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe('OllamaService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the configured notes model and thinking option to Ollama chat', async () => {
    let receivedBody = ''
    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/chat')
      expect(request.method).toBe('POST')

      request.on('data', (chunk) => {
        receivedBody += chunk.toString('utf8')
      })

      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        response.write(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', thinking: 'ignored reasoning' },
            done: false
          }) + '\n')
        response.write(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', content: '{"summary":' },
            done: false
          }) + '\n')
        response.end(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', content: '"done"}' },
            done: true
          }) + '\n')
      })
    })

    const port = await listen(server)

    try {
      const service = new OllamaService(`http://127.0.0.1:${port}`, 'custom-notes-model', true)
      const result = await service.generate('Summarize this', 'Return JSON')

      expect(result).toBe('{"summary":"done"}')

      const body = JSON.parse(receivedBody)
      expect(body.model).toBe('custom-notes-model')
      expect(body.think).toBe(true)
      expect(body.stream).toBe(true)
      expect(body.options).toEqual({ temperature: 0.2 })
      expect(body.messages).toEqual([
        { role: 'system', content: 'Return JSON' },
        { role: 'user', content: 'Summarize this' }
      ])
    } finally {
      await close(server)
    }
  })
})
