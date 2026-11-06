/** Folder view over conversation files, built from the `/`-separated `path` the Agent records. */

export interface FileTreeFolder<T> {
  type: 'folder'
  name: string
  /** Full folder path from the conversation root, used as a stable React key. */
  path: string
  /** Number of files anywhere below this folder. */
  count: number
  children: FileTreeNode<T>[]
}

export interface FileTreeFile<T> {
  type: 'file'
  name: string
  file: T
}

export type FileTreeNode<T> = FileTreeFolder<T> | FileTreeFile<T>

interface TreeInput {
  filename: string
  path?: string | null
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/**
 * Folders first, then files, each by name. A file without a path (uploads, or artifacts saved
 * before paths were recorded) sits at the top level under its file name.
 */
export function buildFileTree<T extends TreeInput>(files: readonly T[]): FileTreeNode<T>[] {
  const root: FileTreeFolder<T> = { type: 'folder', name: '', path: '', count: 0, children: [] }
  for (const file of files) {
    const segments = (file.path ?? '').split('/').filter(Boolean)
    const folders = segments.slice(0, -1)
    let parent = root
    parent.count += 1
    for (const name of folders) {
      const path = parent.path ? `${parent.path}/${name}` : name
      let folder = parent.children.find((node): node is FileTreeFolder<T> => node.type === 'folder' && node.name === name)
      if (!folder) {
        folder = { type: 'folder', name, path, count: 0, children: [] }
        parent.children.push(folder)
      }
      folder.count += 1
      parent = folder
    }
    parent.children.push({ type: 'file', name: segments[segments.length - 1] ?? file.filename, file })
  }
  sortTree(root)
  return root.children
}

function sortTree<T>(folder: FileTreeFolder<T>): void {
  folder.children.sort((a, b) => a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1)
  for (const child of folder.children) if (child.type === 'folder') sortTree(child)
}
