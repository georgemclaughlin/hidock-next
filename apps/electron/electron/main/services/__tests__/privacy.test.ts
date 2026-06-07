import { describe, expect, it, vi } from 'vitest'
import { canUseOllamaUrl, isLocalNetworkUrl } from '../privacy'

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    privacy: {
      localOnly: true,
      allowRemoteOllama: false
    }
  }))
}))

describe('privacy Ollama URL policy', () => {
  it('treats loopback and private-LAN Ollama URLs as local network endpoints', () => {
    expect(isLocalNetworkUrl('http://localhost:11434')).toBe(true)
    expect(isLocalNetworkUrl('http://127.0.0.1:11434')).toBe(true)
    expect(isLocalNetworkUrl('http://192.168.1.10:11434')).toBe(true)
    expect(isLocalNetworkUrl('http://10.0.0.5:11434')).toBe(true)
    expect(isLocalNetworkUrl('http://172.16.0.5:11434')).toBe(true)
    expect(isLocalNetworkUrl('http://ollama.local:11434')).toBe(true)
  })

  it('blocks public Ollama URLs in local-only mode unless remote Ollama is allowed', () => {
    const localOnlyConfig = {
      privacy: {
        localOnly: true,
        allowRemoteOllama: false
      }
    } as any

    const remoteAllowedConfig = {
      privacy: {
        localOnly: true,
        allowRemoteOllama: true
      }
    } as any

    expect(canUseOllamaUrl('http://192.168.1.10:11434', localOnlyConfig)).toBe(true)
    expect(canUseOllamaUrl('https://example.com:11434', localOnlyConfig)).toBe(false)
    expect(canUseOllamaUrl('https://example.com:11434', remoteAllowedConfig)).toBe(true)
  })
})
