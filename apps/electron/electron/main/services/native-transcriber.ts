import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { getDataPath } from './config'

export type NativeTranscriptionEngine = 'parakeet' | 'whisper'

export interface NativeTranscriptionModel {
  id: string
  name: string
  description: string
  filename: string
  url: string
  sha256: string
  size_mb: number
  is_directory: boolean
  is_downloaded: boolean
  engine_type: NativeTranscriptionEngine
}

export interface NativeTranscriptSegment {
  text?: string
  start?: number
  end?: number
  speaker?: string
}

export interface NativeTranscriptOutput {
  text?: string
  language?: string
  segments?: NativeTranscriptSegment[]
}

export interface NativeTranscriptionResult {
  output: NativeTranscriptOutput
  provider: 'local-parakeet' | 'local-whisper'
  model: string
}

export interface NativeModelDownloadResult {
  success: boolean
  model: string
  message?: string
  error?: string
}

interface RunResult {
  stdout: string
  stderr: string
}

function sidecarBinaryName(): string {
  return process.platform === 'win32' ? 'hidock-transcriber.exe' : 'hidock-transcriber'
}

export function getNativeTranscriberPath(): string | null {
  const binaryName = sidecarBinaryName()
  const configuredPath = process.env.HIDOCK_TRANSCRIBER_PATH
  const appPath = app.getAppPath()

  const candidates = [
    configuredPath,
    join(process.resourcesPath, 'native', binaryName),
    join(process.cwd(), 'native', 'transcriber', 'target', 'release', binaryName),
    join(process.cwd(), 'native', 'transcriber', 'target', 'debug', binaryName),
    join(appPath, 'native', 'transcriber', 'target', 'release', binaryName),
    join(appPath, 'native', 'transcriber', 'target', 'debug', binaryName),
    resolve(__dirname, '../../native/transcriber/target/release', binaryName),
    resolve(__dirname, '../../native/transcriber/target/debug', binaryName)
  ].filter((value): value is string => Boolean(value))

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function isNativeTranscriberAvailable(): boolean {
  return getNativeTranscriberPath() !== null
}

function runNativeTranscriber(args: string[]): Promise<RunResult> {
  const binaryPath = getNativeTranscriberPath()
  if (!binaryPath) {
    throw new Error('Native transcription sidecar is not built. Run npm run build:transcriber from apps/electron.')
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPath, ['--data-dir', getDataPath(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      reject(new Error(`Failed to start native transcription sidecar "${binaryPath}": ${error.message}`))
    })

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      reject(new Error(stderr || stdout || `Native transcription sidecar exited with code ${code}`))
    })
  })
}

async function runNativeJson<T>(args: string[]): Promise<T> {
  const result = await runNativeTranscriber(args)
  if (!result.stdout) {
    throw new Error('Native transcription sidecar did not return JSON output')
  }

  return JSON.parse(result.stdout) as T
}

export function getNativeModelIdForEngine(
  engine: NativeTranscriptionEngine,
  configuredModel?: string
): string {
  if (engine === 'parakeet') {
    return 'parakeet-v3'
  }

  const model = (configuredModel || '').toLowerCase()
  if (model.includes('medium')) {
    return 'whisper-medium'
  }

  return 'whisper-small'
}

export async function listNativeTranscriptionModels(): Promise<NativeTranscriptionModel[]> {
  return runNativeJson<NativeTranscriptionModel[]>(['models'])
}

export async function getNativeTranscriptionModel(modelId: string): Promise<NativeTranscriptionModel | undefined> {
  const models = await listNativeTranscriptionModels()
  return models.find((model) => model.id === modelId)
}

export async function downloadNativeTranscriptionModel(modelId: string): Promise<NativeModelDownloadResult> {
  await runNativeJson<{ success: boolean; model_id: string }>(['download', modelId])
  const model = await getNativeTranscriptionModel(modelId)

  return {
    success: true,
    model: modelId,
    message: `${model?.name ?? modelId} is downloaded for local transcription.`
  }
}

export async function transcribeWithNativeModel(
  engine: NativeTranscriptionEngine,
  modelId: string,
  inputPath: string,
  outputPath: string,
  language: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<NativeTranscriptionResult> {
  const model = await getNativeTranscriptionModel(modelId)
  if (!model) {
    throw new Error(`Unknown native transcription model: ${modelId}`)
  }

  if (!model.is_downloaded) {
    throw new Error(`${model.name} is not downloaded. Open Settings and click Download Model before transcribing.`)
  }

  progressCallback?.('running native transcription', 20)
  await runNativeJson<{ success: boolean; output: string }>([
    'transcribe',
    '--model-id',
    modelId,
    '--input',
    inputPath,
    '--output',
    outputPath,
    '--language',
    language || 'auto'
  ])

  progressCallback?.('parsing transcript', 85)
  const output = JSON.parse(readFileSync(outputPath, 'utf8')) as NativeTranscriptOutput

  return {
    output,
    provider: engine === 'parakeet' ? 'local-parakeet' : 'local-whisper',
    model: model.id
  }
}
