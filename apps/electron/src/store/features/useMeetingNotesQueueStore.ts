import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

export type MeetingNotesGenerationResult = {
  generated: boolean
  skippedReason?: string
  titleSuggestion?: string
  summary?: string
}

export type MeetingNotesQueueStatus = {
  recordingId: string
  status: 'queued' | 'generating' | 'complete' | 'skipped' | 'failed'
  queuedAt?: string
  startedAt?: string
  completedAt?: string
  result?: MeetingNotesGenerationResult
  error?: string
}

type MeetingNotesQueueStats = {
  pending: number
  processing: number
  failed: number
}

interface MeetingNotesQueueStore {
  statuses: Map<string, MeetingNotesQueueStatus>
  upsertStatus: (status: MeetingNotesQueueStatus) => void
  clear: () => void
}

function isVisibleOperation(status: MeetingNotesQueueStatus): boolean {
  return status.status === 'queued' || status.status === 'generating' || status.status === 'failed'
}

function sortNewestFirst(a: MeetingNotesQueueStatus, b: MeetingNotesQueueStatus): number {
  const aTime = a.startedAt ?? a.queuedAt ?? a.completedAt ?? ''
  const bTime = b.startedAt ?? b.queuedAt ?? b.completedAt ?? ''
  return bTime.localeCompare(aTime)
}

export const useMeetingNotesQueueStore = create<MeetingNotesQueueStore>((set) => ({
  statuses: new Map(),

  upsertStatus: (status) => {
    set((state) => {
      const statuses = new Map(state.statuses)
      statuses.set(status.recordingId, status)
      return { statuses }
    })
  },

  clear: () => set({ statuses: new Map() })
}))

export const useMeetingNotesQueueStatus = (recordingId: string) => {
  return useMeetingNotesQueueStore((state) => state.statuses.get(recordingId) ?? null)
}

export const useMeetingNotesQueueItems = () => {
  return useMeetingNotesQueueStore(useShallow((state) => (
    Array.from(state.statuses.values())
      .filter(isVisibleOperation)
      .sort(sortNewestFirst)
  )))
}

export const useMeetingNotesQueueStats = () => {
  return useMeetingNotesQueueStore(useShallow((state) => {
    const stats: MeetingNotesQueueStats = { pending: 0, processing: 0, failed: 0 }

    state.statuses.forEach((item) => {
      if (item.status === 'failed') {
        stats.failed += 1
      } else if (item.status === 'generating') {
        stats.processing += 1
      } else if (item.status === 'queued') {
        stats.pending += 1
      }
    })

    return stats
  }))
}
