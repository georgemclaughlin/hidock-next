import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeviceDisconnectBanner } from '../DeviceDisconnectBanner'

describe('DeviceDisconnectBanner', () => {
  const defaultProps = {
    show: true,
    isReconnecting: false,
    onNavigateToDevice: vi.fn()
  }

  it('does not say downloads are paused when no downloads are active', () => {
    render(<DeviceDisconnectBanner {...defaultProps} hasPausedDownloads={false} />)

    expect(screen.getByText('Device disconnected')).toBeInTheDocument()
    expect(screen.queryByText(/downloads have been paused/i)).not.toBeInTheDocument()
    expect(screen.getByText(/downloaded recordings remain available/i)).toBeInTheDocument()
  })

  it('shows paused download copy when downloads remain queued', () => {
    render(<DeviceDisconnectBanner {...defaultProps} hasPausedDownloads />)

    expect(screen.getByText(/downloads have been paused/i)).toBeInTheDocument()
  })

  it('keeps reconnecting copy while reconnecting', () => {
    render(
      <DeviceDisconnectBanner
        {...defaultProps}
        isReconnecting
        hasPausedDownloads
      />
    )

    expect(screen.getByText('Reconnecting to device...')).toBeInTheDocument()
    expect(screen.getByText(/please wait while we reconnect/i)).toBeInTheDocument()
  })
})
