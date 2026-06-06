import { describe, it, expect } from 'vitest'
import { USB_PRODUCT_IDS, USB_VENDOR_IDS } from '../jensen'

describe('USB connect device filter', () => {
  function matchesSupportedDevice(
    vendorId: number,
    productId: number,
    productName: string | undefined
  ): boolean {
    if (!USB_VENDOR_IDS.includes(vendorId)) return false
    if (Object.values(USB_PRODUCT_IDS).includes(productId)) return true
    return productName?.toLowerCase().includes('jensen') ?? false
  }

  it('matches known vendor and product IDs', () => {
    expect(matchesSupportedDevice(USB_VENDOR_IDS[0], USB_PRODUCT_IDS.H1, undefined)).toBe(true)
    expect(matchesSupportedDevice(USB_VENDOR_IDS[1], USB_PRODUCT_IDS.P1_MINI_ALT, '')).toBe(true)
  })

  it('matches the protocol marker case-insensitively for known vendors', () => {
    expect(matchesSupportedDevice(USB_VENDOR_IDS[0], 0xffff, 'Jensen H1')).toBe(true)
    expect(matchesSupportedDevice(USB_VENDOR_IDS[0], 0xffff, 'jensen p1')).toBe(true)
  })

  it('rejects unrelated devices', () => {
    expect(matchesSupportedDevice(0x1234, USB_PRODUCT_IDS.H1, 'Jensen H1')).toBe(false)
    expect(matchesSupportedDevice(USB_VENDOR_IDS[0], 0xffff, 'Webcam')).toBe(false)
    expect(matchesSupportedDevice(USB_VENDOR_IDS[0], 0xffff, undefined)).toBe(false)
  })

  it('does not use generic product-name matching in the source filter', async () => {
    const fs = await import('fs')
    const path = await import('path')

    const sourceFile = path.join(__dirname, '..', 'jensen.ts')
    const source = fs.readFileSync(sourceFile, 'utf-8')

    expect(source).toContain("name.includes('jensen')")
    expect(source).not.toContain("name.includes('recorder')")
  })
})
