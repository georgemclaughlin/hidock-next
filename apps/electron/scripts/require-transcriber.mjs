import { existsSync } from 'node:fs'
import { join } from 'node:path'

const binaryName = process.platform === 'win32'
  ? 'recorder-transcriber.exe'
  : 'recorder-transcriber'
const binaryPath = join(process.cwd(), 'native', 'transcriber', 'target', 'release', binaryName)

if (!existsSync(binaryPath)) {
  console.error(`Required Rust transcription sidecar not found: ${binaryPath}`)
  console.error('Run npm run build:transcriber from apps/electron in this operating system.')
  process.exit(1)
}

console.log(`Rust transcription sidecar found: ${binaryPath}`)
