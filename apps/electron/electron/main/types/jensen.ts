/**
 * Shared Jensen protocol types.
 *
 * Keep these declarations independent from the main-process implementation so
 * renderer/preload typechecking does not pull in node-usb.
 */

export type DeviceModel = 'recorder-h1' | 'recorder-h1e' | 'recorder-p1' | 'recorder-p1-mini' | 'unknown'

export interface DeviceInfo {
  versionCode: string
  versionNumber: number
  serialNumber: string
  model: DeviceModel
}

export interface FileInfo {
  name: string
  createDate: string
  createTime: string
  time: Date | null
  duration: number
  version: number
  length: number
  signature: string
}

export interface CardInfo {
  used: number
  capacity: number
  free: number
  status: string
}

export interface DeviceSettings {
  autoRecord: boolean
  autoPlay: boolean
  notification?: boolean
  bluetoothTone?: boolean
}

export interface RealtimeSettings {
  enabled: boolean
  sampleRate?: number
  channels?: number
  bitDepth?: number
}

export interface RealtimeData {
  rest: number
  data: Uint8Array
}

export interface BatteryStatus {
  status: 'idle' | 'charging' | 'full'
  batteryLevel: number
  voltage?: number
}

export interface BluetoothDevice {
  name: string
  address: string
  rssi?: number
  paired?: boolean
}

export interface BluetoothStatus {
  connected: boolean
  deviceName?: string
  deviceAddress?: string
}
