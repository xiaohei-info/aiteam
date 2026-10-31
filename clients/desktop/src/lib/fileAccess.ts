import { invoke, isTauri } from '@tauri-apps/api/core'
import { withFileAccessRecovery } from './fileAccessPolicy'

export interface FileAccessStatus {
  startup_seen: boolean
  directories: string[]
  platform: string
  suggested_root: string
}
export interface FileAccessSelection {
  directories: string[]
  status: FileAccessStatus
}
export interface FileAccessRecoveryRequest {
  path: string
  error: unknown
  resolve: (retry: boolean) => void
}

export const FILE_ACCESS_CHANGED = 'aifred:file-access-changed'
let recoveryHandler: ((request: FileAccessRecoveryRequest) => void) | null = null
let recoveryInFlight: Promise<boolean> | null = null

export function registerFileAccessRecovery(handler: (request: FileAccessRecoveryRequest) => void) {
  recoveryHandler = handler
  return () => { if (recoveryHandler === handler) recoveryHandler = null }
}

function recover(path: string, error: unknown): Promise<boolean> {
  if (!recoveryHandler) return Promise.resolve(false)
  if (recoveryInFlight) return recoveryInFlight
  const handler = recoveryHandler
  recoveryInFlight = new Promise<boolean>((resolve) => handler({ path, error, resolve }))
    .finally(() => { recoveryInFlight = null })
  return recoveryInFlight
}

export function invokeWithFileAccess<T>(command: string, args: Record<string, unknown>, path: string): Promise<T> {
  return withFileAccessRecovery(() => invoke<T>(command, args), (error) => recover(path, error))
}

export async function getFileAccessStatus(): Promise<FileAccessStatus | null> {
  return isTauri() ? invoke<FileAccessStatus>('local_file_access_status') : null
}

export async function selectFileAccessDirectories(defaultPath?: string): Promise<FileAccessSelection> {
  const selection = await invoke<FileAccessSelection>('select_file_access_directories', { defaultPath: defaultPath ?? null })
  window.dispatchEvent(new Event(FILE_ACCESS_CHANGED))
  return selection
}

export async function revokeFileAccess(directory?: string): Promise<FileAccessStatus> {
  const status = await invoke<FileAccessStatus>('revoke_file_access', { directory: directory ?? null })
  window.dispatchEvent(new Event(FILE_ACCESS_CHANGED))
  return status
}

export function dismissFileAccessStartup() {
  return invoke<void>('dismiss_file_access_startup')
}

export function openFilePrivacySettings() {
  return invoke<void>('open_file_privacy_settings')
}
