import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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

export interface NativeModelDownloadProgress {
  model: string
  stage: string
  progress: number
  downloaded_bytes?: number
  total_bytes?: number
}

export type NativeEmbeddingInputType = 'document' | 'query'

export interface NativeEmbeddingModel {
  id: string
  name: string
  description: string
  dimensions: number
  provider: 'native-fastembed'
  is_downloaded: boolean
}

export interface NativeEmbeddingResult {
  model_id: string
  provider: 'native-fastembed'
  dimensions: number
  embeddings: number[][]
}

export interface NativeEmbeddingDownloadResult {
  success: boolean
  model_id: string
  provider: 'native-fastembed'
  dimensions: number
}

export interface NativeTranscriptionProgress {
  stage: string
  progress: number
  chunk_index?: number
  completed_chunks?: number
  total_chunks?: number
}

interface RunResult {
  stdout: string
  stderr: string
}

interface RunNativeTranscriberOptions {
  onProgress?: (progress: NativeModelDownloadProgress) => void
  onTranscriptionProgress?: (progress: NativeTranscriptionProgress) => void
}

const DOWNLOAD_PROGRESS_PREFIX = 'LR_PROGRESS '
const TRANSCRIPTION_PROGRESS_PREFIX = 'LR_TRANSCRIBE_PROGRESS '

function sidecarBinaryName(): string {
  return process.platform === 'win32' ? 'recorder-transcriber.exe' : 'recorder-transcriber'
}

export function getNativeTranscriberPath(): string | null {
  const binaryName = sidecarBinaryName()
  const configuredPath = process.env.RECORDER_TRANSCRIBER_PATH
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

export function getNativeTranscriberRequiredMessage(): string {
  return [
    'Native transcription sidecar is required but was not found.',
    'Run npm run build:transcriber from apps/electron in the same operating system that runs Local Recorder, then restart the app.'
  ].join(' ')
}

export function getRequiredNativeTranscriberPath(): string {
  const binaryPath = getNativeTranscriberPath()
  if (!binaryPath) {
    throw new Error(getNativeTranscriberRequiredMessage())
  }
  return binaryPath
}

export function assertNativeTranscriberAvailable(): string {
  return getRequiredNativeTranscriberPath()
}

function runNativeTranscriber(args: string[], options: RunNativeTranscriberOptions = {}): Promise<RunResult> {
  const binaryPath = getRequiredNativeTranscriberPath()

  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPath, ['--data-dir', getDataPath(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const stdoutChunks: Buffer[] = []
    const stderrLines: string[] = []
    let stderrRemainder = ''

    const handleStderrLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return

      if (trimmed.startsWith(DOWNLOAD_PROGRESS_PREFIX)) {
        try {
          options.onProgress?.(JSON.parse(trimmed.slice(DOWNLOAD_PROGRESS_PREFIX.length)) as NativeModelDownloadProgress)
          return
        } catch {
          stderrLines.push(line)
          return
        }
      }

      if (trimmed.startsWith(TRANSCRIPTION_PROGRESS_PREFIX)) {
        try {
          options.onTranscriptionProgress?.(
            JSON.parse(trimmed.slice(TRANSCRIPTION_PROGRESS_PREFIX.length)) as NativeTranscriptionProgress
          )
          return
        } catch {
          stderrLines.push(line)
          return
        }
      }

      stderrLines.push(line)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrRemainder += chunk.toString('utf8')
      const lines = stderrRemainder.split(/\r?\n/)
      stderrRemainder = lines.pop() ?? ''
      for (const line of lines) {
        handleStderrLine(line)
      }
    })

    child.on('error', (error) => {
      reject(new Error(`Failed to start native transcription sidecar "${binaryPath}": ${error.message}`))
    })

    child.on('close', (code) => {
      if (stderrRemainder) {
        handleStderrLine(stderrRemainder)
        stderrRemainder = ''
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = stderrLines.join('\n').trim()

      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      reject(new Error(stderr || stdout || `Native transcription sidecar exited with code ${code}`))
    })
  })
}

async function runNativeJson<T>(args: string[], options: RunNativeTranscriberOptions = {}): Promise<T> {
  const result = await runNativeTranscriber(args, options)
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

export async function downloadNativeTranscriptionModel(
  modelId: string,
  onProgress?: (progress: NativeModelDownloadProgress) => void
): Promise<NativeModelDownloadResult> {
  await runNativeJson<{ success: boolean; model_id: string }>(['download', modelId], { onProgress })
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
  progressCallback?: (stage: string, progress: number, nativeProgress?: NativeTranscriptionProgress) => void,
  diarizationEnabled: boolean = true
): Promise<NativeTranscriptionResult> {
  const model = await getNativeTranscriptionModel(modelId)
  if (!model) {
    throw new Error(`Unknown native transcription model: ${modelId}`)
  }

  if (!model.is_downloaded) {
    throw new Error(`${model.name} is not downloaded. Open Settings and click Download Model before transcribing.`)
  }

  progressCallback?.('starting native transcription', 8)
  await runNativeJson<{ success: boolean; output: string }>(
    [
      'transcribe',
      '--model-id',
      modelId,
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--language',
      language || 'auto',
      ...(diarizationEnabled ? [] : ['--disable-diarization'])
    ],
    {
      onTranscriptionProgress: (progress) => {
        progressCallback?.(progress.stage, progress.progress, progress)
      }
    }
  )

  progressCallback?.('parsing transcript', 85)
  const output = JSON.parse(readFileSync(outputPath, 'utf8')) as NativeTranscriptOutput

  return {
    output,
    provider: engine === 'parakeet' ? 'local-parakeet' : 'local-whisper',
    model: model.id
  }
}

export function getNativeEmbeddingModelId(configuredModel?: string): string {
  const model = (configuredModel || '').trim().toLowerCase()
  if (!model) return 'bge-small-en-v1.5-q'
  if (model === 'nomic-embed-text' || model === 'nomic-embed-text-v1.5') {
    return 'nomic-embed-text-v1.5-q'
  }
  if (model === 'bge-small' || model === 'bge-small-en-v1.5') {
    return 'bge-small-en-v1.5-q'
  }
  return model
}

export async function listNativeEmbeddingModels(): Promise<NativeEmbeddingModel[]> {
  return runNativeJson<NativeEmbeddingModel[]>(['embedding-models'])
}

export async function downloadNativeEmbeddingModel(modelId: string): Promise<NativeEmbeddingDownloadResult> {
  return runNativeJson<NativeEmbeddingDownloadResult>(['download-embedding', getNativeEmbeddingModelId(modelId)])
}

export async function generateNativeEmbeddings(
  texts: string[],
  inputType: NativeEmbeddingInputType,
  configuredModel?: string
): Promise<NativeEmbeddingResult> {
  if (texts.length === 0) {
    return {
      model_id: getNativeEmbeddingModelId(configuredModel),
      provider: 'native-fastembed',
      dimensions: 0,
      embeddings: []
    }
  }

  const modelId = getNativeEmbeddingModelId(configuredModel)
  const tempDir = mkdtempSync(join(tmpdir(), 'recorder-embeddings-'))
  const inputPath = join(tempDir, 'input.json')

  try {
    writeFileSync(inputPath, JSON.stringify({ texts }))
    return await runNativeJson<NativeEmbeddingResult>([
      'embed',
      '--model-id',
      modelId,
      '--input',
      inputPath,
      '--input-type',
      inputType
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
