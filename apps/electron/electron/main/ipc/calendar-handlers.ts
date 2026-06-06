import { ipcMain } from 'electron'
import { getConfig } from '../services/config'
import { getLastSyncTime, CalendarSyncResult } from '../services/calendar-sync'

let syncInterval: NodeJS.Timeout | null = null

function calendarSyncRemovedResult(): CalendarSyncResult {
  return {
    success: false,
    meetingsCount: 0,
    error: 'External calendar sync has been removed from this local-only fork.',
    errorCategory: 'validation'
  }
}

export function registerCalendarHandlers(): void {
  // Sync calendar now
  // AUD2-010: Verify sync result and catch unexpected errors at the IPC boundary
  ipcMain.handle('calendar:sync', async (): Promise<CalendarSyncResult> => {
    return calendarSyncRemovedResult()
  })

  // Clear all meetings and perform a fresh sync
  // AUD2-010: Same verification pattern as calendar:sync
  ipcMain.handle('calendar:clear-and-sync', async (): Promise<CalendarSyncResult> => {
    return calendarSyncRemovedResult()
  })

  // Get last sync time
  ipcMain.handle('calendar:get-last-sync', async () => {
    return getLastSyncTime()
  })

  // Set ICS URL
  ipcMain.handle('calendar:set-url', async (_, url: unknown) => {
    void url
    return { success: false, error: 'External calendar sync has been removed from this local-only fork.' }
  })

  // Toggle auto-sync
  ipcMain.handle('calendar:toggle-auto-sync', async (_, enabled: unknown) => {
    void enabled
    stopAutoSync()
    return { success: false, error: 'External calendar auto-sync has been removed from this local-only fork.' }
  })

  // Set sync interval
  ipcMain.handle('calendar:set-interval', async (_, minutes: unknown) => {
    void minutes
    return { success: false, error: 'External calendar sync has been removed from this local-only fork.' }
  })

  // Get calendar settings
  ipcMain.handle('calendar:get-settings', async () => {
    return getConfig().calendar
  })

}

/**
 * CS-010: Initialize calendar auto-sync after DB is ready.
 * Must be called explicitly from index.ts after initializeDatabase(),
 * NOT as a side-effect of registerCalendarHandlers().
 */
export function initializeCalendarAutoSync(): void {
  stopAutoSync()
}

/**
 * Stop the calendar auto-sync interval.
 * B-CAL-002: Exported so it can be called during app quit cleanup.
 */
export function stopAutoSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
    console.log('Calendar auto-sync stopped')
  }
}
