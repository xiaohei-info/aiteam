export interface KbFile {
  id: string
  knowledgeBaseId?: string
  canRetry?: boolean
  canDelete?: boolean
  recoveryRequired?: boolean
  name: string
  size: string
  type: string
  uploadedAt: string
  assetId?: string
  status?: 'ready' | 'error' | 'ingesting' | 'failed' | 'done' | 'active' | string
  chunks?: number
  errorMessage?: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  storageKey?: string
  previewUrl?: string
  localPath?: string
}

export interface KnowledgeEmployeeBinding {
  employeeId: string
  displayName: string
  roleName?: string
  status?: string
}

export interface KnowledgeBase {
  id: string
  icon: string
  name: string
  description?: string
  status?: string
  docCount: number
  updatedAt: string
  progress?: number
  files: KbFile[]
  employeeBindings?: KnowledgeEmployeeBinding[]
  // local is the legacy NAS namespace, not a local filesystem source.
  source?: 'enterprise' | 'local'
  /** NAS connection the library lives on; absent for Manager. */
  nasId?: string
  /** Display name of that NAS connection. */
  sourceName?: string
  directory?: string
  level?: 'private' | 'team' | 'enterprise'
  updatedFilesToday?: number
  uploadedUsersToday?: number
  accessPolicy?: 'private' | 'team' | 'enterprise'
}

export interface KnowledgeStats {
  totalBases: number
  totalDocs: number
  totalChunks: string
  storageUsed: string
  updatedFilesToday?: number
  uploadedUsersToday?: number
}

/** One NAS knowledge HTTP service; never a local filesystem URL. */
export interface NasConnectionConfig {
  id: string
  name: string
  url: string
  token: string
}

export interface KnowledgeSourceConfig {
  enterpriseUrl: string
  enterpriseToken: string
  nas: NasConnectionConfig[]
}

export interface KnowledgeEmployee {
  employeeId: string
  displayName: string
  roleName?: string
  status?: string
}

export interface KnowledgeSearchResult {
  answer: string
  citations: Array<{ title?: string; document_id?: string }>
  items: Array<{ title?: string; document_id?: string; snippet?: string }>
  query: string
}

export interface ScannedKnowledgeFile {
  name: string
  path: string
  size: number
  modified_at?: number
}

export interface LocalScanCache {
  files: ScannedKnowledgeFile[]
  scannedAt: string
  directories?: LocalScanDirectoryCache[]
}

export interface LocalScanDirectoryCache {
  directory: string
  files: ScannedKnowledgeFile[]
  scannedAt: string
}

export interface LocalScanAuthorization {
  directories: string[]
  authorizedAt: string
}

export interface LocalUploadedKnowledgeRecord {
  fileKey: string
  name: string
  path: string
  size: number
  knowledgeBaseIds: string[]
  uploadedAt: string
  documentId?: string
  assetId?: string
}

export interface KnowledgeFilePreview {
  name: string
  path: string
  size: number
  file_type: string
  content: string
  truncated: boolean
}

export interface KnowledgeDocumentPreview {
  mode: 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported'
  contentType: string
  fileType: string
  content?: string
  objectUrl?: string
  truncated?: boolean
}
