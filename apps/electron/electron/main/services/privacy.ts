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

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

export function isLocalNetworkUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return isLoopbackUrl(value) || isPrivateIPv4(hostname) || hostname.endsWith('.local')
  } catch {
    return false
  }
}

export function canUseOllamaUrl(value: string, config: AppConfig = getConfig()): boolean {
  if (!config.privacy) return true
  if (!isLocalOnlyMode(config)) return true
  if (config.privacy.allowRemoteOllama === true) return true
  return isLocalNetworkUrl(value)
}
