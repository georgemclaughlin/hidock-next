import { AppConfig, getConfig } from './config'

export function isLocalOnlyMode(config: AppConfig = getConfig()): boolean {
  return config.privacy?.localOnly === true
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

export function canUseOllamaUrl(value: string, config: AppConfig = getConfig()): boolean {
  if (!config.privacy) return true
  if (!isLocalOnlyMode(config)) return true
  if (config.privacy.allowRemoteOllama === true) return true
  return isLoopbackUrl(value)
}
