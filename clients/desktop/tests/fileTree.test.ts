import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFileTree, type FileTreeNode } from '../src/lib/fileTree.ts'

type File = { id: string; filename: string; path?: string | null }

function outline(nodes: FileTreeNode<File>[], depth = 0): string[] {
  return nodes.flatMap(node => node.type === 'folder'
    ? [`${'  '.repeat(depth)}${node.name}/ (${node.count})`, ...outline(node.children, depth + 1)]
    : [`${'  '.repeat(depth)}${node.name} #${node.file.id}`])
}

test('files nest by path, folders first, names in natural order', () => {
  const files: File[] = [
    { id: '1', filename: 'README.md', path: 'README.md' },
    { id: '2', filename: 'README.md', path: 'game/README.md' },
    { id: '3', filename: 'game.js', path: 'game/js/game.js' },
    { id: '4', filename: 'audio.js', path: 'game/js/audio.js' },
    { id: '5', filename: 'step10.md', path: 'step10.md' },
    { id: '6', filename: 'step2.md', path: 'step2.md' },
    { id: '7', filename: 'app.py', path: 'tool/app.py' },
  ]
  assert.deepEqual(outline(buildFileTree(files)), [
    'game/ (3)',
    '  js/ (2)',
    '    audio.js #4',
    '    game.js #3',
    '  README.md #2',
    'tool/ (1)',
    '  app.py #7',
    'README.md #1',
    'step2.md #6',
    'step10.md #5',
  ])
})

test('files without a path stay at the top level under their name', () => {
  const files: File[] = [
    { id: 'upload', filename: 'photo.png', path: null },
    { id: 'legacy', filename: 'notes.md' },
    { id: 'nested', filename: 'plan.md', path: '产品经理/docs/plan.md' },
  ]
  assert.deepEqual(outline(buildFileTree(files)), [
    '产品经理/ (1)',
    '  docs/ (1)',
    '    plan.md #nested',
    'notes.md #legacy',
    'photo.png #upload',
  ])
  assert.deepEqual(buildFileTree([]), [])
})
