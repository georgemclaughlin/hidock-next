import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('OllamaService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the configured notes model and thinking option to Ollama chat', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', thinking: 'ignored reasoning' },
            done: false
          }) + '\n'))
          controller.enqueue(encoder.encode(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', content: '{"summary":' },
            done: false
          }) + '\n'))
          controller.enqueue(encoder.encode(JSON.stringify({
            model: 'custom-notes-model',
            message: { role: 'assistant', content: '"done"}' },
            done: true
          }) + '\n'))
          controller.close()
        }
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    const service = new OllamaService('http://localhost:11434', 'custom-notes-model', true)
    const result = await service.generate('Summarize this', 'Return JSON')

    expect(result).toBe('{"summary":"done"}')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String)
      })
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('custom-notes-model')
    expect(body.think).toBe(true)
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'Return JSON' },
      { role: 'user', content: 'Summarize this' }
    ])
  })
})
