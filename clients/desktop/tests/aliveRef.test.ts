// 守卫：开发版开着 React.StrictMode，挂载→卸载→再挂载。用 ref 标记“组件还在”时，只在卸载回调里置 false、
// 挂载时不置回 true，会让之后所有请求结果都被丢弃，页面永远停在加载中（「方案」页签曾因此一直转圈）。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name)
  return entry.isDirectory() ? files(file) : /\.tsx?$/.test(entry.name) ? [file] : []
})

export function aliveRefProblems(source: string): string[] {
  // 只在 cleanup 里置 false 的写法：useEffect(() => () => { x.current = false }, ...)
  return [...source.matchAll(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*(\w+)\.current\s*=\s*false/g)].map((m) => m[1])
}

test('卸载时置 false 的 ref，挂载时必须置回 true', () => {
  const problems = files(src).flatMap((file) => aliveRefProblems(readFileSync(file, 'utf8')).map((name) => `${path.relative(src, file)}: ${name}`))
  assert.deepEqual(problems, [])
})

test('守卫能识别错误写法，放过正确写法', () => {
  assert.deepEqual(aliveRefProblems('useEffect(() => () => { alive.current = false }, [])'), ['alive'])
  assert.deepEqual(aliveRefProblems('useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])'), [])
})
