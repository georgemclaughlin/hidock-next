import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const transcriberDir = join(appDir, 'native', 'transcriber')

function getCmakeHelp() {
  try {
    return execFileSync('cmake', ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

function configureWindowsCmakeGenerator(env) {
  if (process.platform !== 'win32' || env.CMAKE_GENERATOR) return

  const help = getCmakeHelp()
  const visualStudioGenerators = [
    'Visual Studio 17 2022',
    'Visual Studio 16 2019',
    'Visual Studio 15 2017'
  ]
  const generator = visualStudioGenerators.find((candidate) => help.includes(candidate))

  if (generator) {
    env.CMAKE_GENERATOR = generator
    env.CMAKE_GENERATOR_PLATFORM = env.CMAKE_GENERATOR_PLATFORM || 'x64'
    console.log(`Using CMake generator: ${generator} (${env.CMAKE_GENERATOR_PLATFORM})`)
    return
  }

  if (help.includes('Ninja')) {
    env.CMAKE_GENERATOR = 'Ninja'
    console.log('Using CMake generator: Ninja')
  }
}

const env = { ...process.env }
configureWindowsCmakeGenerator(env)

const command = process.platform === 'win32' ? 'cmd.exe' : 'cargo'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'cargo build --release']
  : ['build', '--release']
const result = spawnSync(command, args, {
  cwd: transcriberDir,
  env,
  stdio: 'inherit'
})

if (result.error) {
  console.error(`Failed to start Cargo: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
