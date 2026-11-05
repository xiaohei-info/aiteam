import { Code, FileImage, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import { extensionOf, type ProjectFile } from './projects'

export default function FileIcon({ file, size = 16 }: { file: Pick<ProjectFile, 'name' | 'format'>; size?: number }) {
  const extension = extensionOf(file.name)
  const props = { size, strokeWidth: 1.8, 'aria-hidden': true } as const
  if (file.format === 'svg' || file.format === 'image') return <FileImage {...props} />
  if (file.format === 'html' || file.format === 'code') return <Code {...props} />
  if (file.format === 'csv' || extension === 'xlsx' || extension === 'xls') return <FileSpreadsheet {...props} />
  if (extension === 'pptx' || extension === 'ppt') return <Presentation {...props} />
  return <FileText {...props} />
}
