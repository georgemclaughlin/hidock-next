/**
 * Outputs IPC Handlers
 *
 * Handles simple text output utilities using the Result pattern.
 */

import { ipcMain, clipboard, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { success, error, Result } from '../types/api'

export function registerOutputsHandlers(): void {
  /**
   * Copy content to clipboard
   */
  ipcMain.handle(
    'outputs:copyToClipboard',
    async (_, content: unknown): Promise<Result<void>> => {
      try {
        if (typeof content !== 'string') {
          return error('VALIDATION_ERROR', 'Content must be a string')
        }

        clipboard.writeText(content)
        return success(undefined)
      } catch (err) {
        console.error('outputs:copyToClipboard error:', err)
        return error('INTERNAL_ERROR', 'Failed to copy to clipboard', err)
      }
    }
  )

  /**
   * Save content to file
   */
  ipcMain.handle(
    'outputs:saveToFile',
    async (event, content: unknown, suggestedName?: unknown): Promise<Result<string>> => {
      try {
        if (typeof content !== 'string') {
          return error('VALIDATION_ERROR', 'Content must be a string')
        }

        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          return error('INTERNAL_ERROR', 'No window found')
        }

        const defaultName = typeof suggestedName === 'string'
          ? suggestedName
          : `output-${new Date().toISOString().slice(0, 10)}.md`

        const result = await dialog.showSaveDialog(win, {
          defaultPath: defaultName,
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'Text', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })

        if (result.canceled || !result.filePath) {
          return error('VALIDATION_ERROR', 'Save cancelled by user')
        }

        writeFileSync(result.filePath, content, 'utf-8')
        return success(result.filePath)
      } catch (err) {
        console.error('outputs:saveToFile error:', err)
        return error('INTERNAL_ERROR', 'Failed to save file', err)
      }
    }
  )

  console.log('Output IPC handlers registered')
}
