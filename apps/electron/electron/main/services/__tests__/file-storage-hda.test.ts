/**
 * @vitest-environment node
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { basename } from 'path'

const testPaths = vi.hoisted(() => ({
  home: `${process.cwd()}/.tmp-local-recorder-hda-${Date.now()}-${Math.random().toString(16).slice(2)}`
}))

vi.mock('electron', () => {
  const electronMock = {
    app: {
      getPath: vi.fn(() => testPaths.home)
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Buffer) => value.toString())
    }
  }
  return {
    ...electronMock,
    default: electronMock
  }
})

import { initializeFileStorage, saveRecording } from '../file-storage'

describe('file-storage HDA handling', () => {
  beforeAll(async () => {
    await initializeFileStorage()
  })

  afterAll(() => {
    rmSync(testPaths.home, { recursive: true, force: true })
  })

  it('stores MPEG HDA payloads with an mp3 extension', async () => {
    const filePath = await saveRecording('recording.hda', Buffer.from([0xff, 0xf3, 0x40, 0x00]))

    expect(basename(filePath)).toBe('recording.mp3')
    expect(existsSync(filePath)).toBe(true)
  })

  it('stores RIFF HDA payloads with a wav extension', async () => {
    const filePath = await saveRecording('recording-riff.hda', Buffer.from('RIFF....WAVE', 'ascii'))

    expect(basename(filePath)).toBe('recording-riff.wav')
    expect(existsSync(filePath)).toBe(true)
  })
})
