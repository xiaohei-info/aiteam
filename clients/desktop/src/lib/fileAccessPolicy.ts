export type FileAccessErrorKind = 'authorization' | 'system' | null

export function fileAccessErrorKind(error: unknown): FileAccessErrorKind {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/LOCAL_OS_PERMISSION_DENIED|Permission denied|Operation not permitted/i.test(message)) return 'system'
  if (/LOCAL_ACCESS_REQUIRED|目录访问权限已失效|File access denied|Select the file or directory in the system picker first/i.test(message)) return 'authorization'
  return null
}

// Retry at most once after an explicit recovery action. Never repeat an upload
// or a write: this helper is used only around the native read/scan/open step.
export async function withFileAccessRecovery<T>(
  operation: () => Promise<T>,
  recover: (error: unknown) => Promise<boolean>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!fileAccessErrorKind(error) || !await recover(error)) throw error
    return operation()
  }
}
