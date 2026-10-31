import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const ASSET_REWRITES = [
  [/^assets\/styles\/topdown-soft\//, 'assets/office/topdown/'],
  [/^assets\/aifred\/office\//, 'assets/office/'],
  [/^assets\/icon_office_/, 'assets/office/icon_office_'],
]

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function resolveOfficeEditorDir(aiteamRoot) {
  try {
    const req = createRequire(path.join(aiteamRoot, 'package.json'))
    const pkgJsonPath = req.resolve('office-map-edit-tool/package.json')
    return path.dirname(pkgJsonPath)
  } catch {
    return path.resolve(aiteamRoot, '../office-map-edit-tool')
  }
}

export function ensureEmployeeRuntimeBundle(editorDir) {
  const bundlePath = path.join(editorDir, 'assets/runtime/employees.js')
  const buildScript = path.join(editorDir, 'scripts/build-employee-runtime.mjs')
  if (existsSync(bundlePath) || !existsSync(buildScript)) return
  spawnSync(process.execPath, [buildScript], { cwd: editorDir, stdio: 'inherit' })
}

function stripForbiddenFileChars(input) {
  return Array.from(input, (ch) => {
    const code = ch.charCodeAt(0)
    if (code <= 0x1f || '<>:"/\\|?*'.includes(ch)) return '-'
    return ch
  }).join('')
}

export function sanitizeMapFileName(rawName) {
  if (typeof rawName !== 'string') throw new Error('文件名无效')
  const trimmed = rawName.trim()
  if (!trimmed) throw new Error('请输入保存文件名')
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('文件名不能包含路径分隔符')
  }
  const withoutExt = trimmed
    .replace(/\.office-map\.json$/i, '')
    .replace(/\.json$/i, '')
  const stem = stripForbiddenFileChars(withoutExt).trim()
  if (!stem || stem === '.' || stem === '..') throw new Error('文件名无效')
  if (stem.toLowerCase() === 'manifest') throw new Error('manifest.json 为系统索引文件，请换一个名称')
  if (stem.length > 100) throw new Error('文件名不能超过 100 个字符')
  return `${stem}.json`
}

function rewriteAssetSrc(src) {
  if (typeof src !== 'string') return src
  for (const [pattern, replacement] of ASSET_REWRITES) {
    if (pattern.test(src)) return src.replace(pattern, replacement)
  }
  return src
}

function pointInBounds(point, bounds) {
  return (
    bounds &&
    typeof bounds.x === 'number' &&
    typeof bounds.y === 'number' &&
    typeof bounds.width === 'number' &&
    typeof bounds.height === 'number' &&
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

export function normalizeMapForSharedStorage(inputMap) {
  const map = structuredClone(inputMap)
  if (map.background && typeof map.background.src === 'string') {
    map.background.src = rewriteAssetSrc(map.background.src)
  }
  if (Array.isArray(map.assets)) {
    for (const asset of map.assets) {
      if (asset && typeof asset.src === 'string') {
        asset.src = rewriteAssetSrc(asset.src)
      }
    }
  }
  if (Array.isArray(map.spots) && Array.isArray(map.rooms)) {
    const nonWorkRooms = map.rooms.filter((room) => room && room.type !== 'work' && room.bounds)
    for (const spot of map.spots) {
      if (!spot || spot.roomId) continue
      const matched = nonWorkRooms.find((room) => pointInBounds(spot, room.bounds))
      if (matched?.id) {
        spot.roomId = matched.id
      }
    }
  }
  return map
}

function isValidOfficeMapObject(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    typeof data.schema === 'string' &&
    data.schema.startsWith('office-map/') &&
    typeof data.width === 'number' &&
    typeof data.height === 'number' &&
    Array.isArray(data.assets) &&
    Array.isArray(data.elements) &&
    Array.isArray(data.zones),
  )
}

async function readManifestSafe(mapDir) {
  try {
    const raw = await readFile(path.join(mapDir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function syncReferencedTopdownAssets(normalizedMap, { publicDir, editorDir }) {
  if (!publicDir || !editorDir || !Array.isArray(normalizedMap.assets)) return
  for (const asset of normalizedMap.assets) {
    const src = asset?.src
    if (typeof src !== 'string' || !src.startsWith('assets/office/topdown/')) continue
    const targetPath = path.join(publicDir, src)
    if (existsSync(targetPath)) continue
    const fileName = src.slice('assets/office/topdown/'.length)
    if (fileName.includes('..') || fileName.includes('/')) continue
    const sourcePath = path.join(editorDir, 'assets/styles/topdown-soft', fileName)
    if (!existsSync(sourcePath)) continue
    await mkdir(path.dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
  }
}

export async function listSharedMaps(mapDir) {
  await mkdir(mapDir, { recursive: true })
  const manifest = await readManifestSafe(mapDir)
  const entries = await readdir(mapDir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'manifest.json') continue
    const fullPath = path.join(mapDir, entry.name)
    try {
      const [raw, info] = await Promise.all([readFile(fullPath, 'utf8'), stat(fullPath)])
      const parsed = JSON.parse(raw)
      if (!isValidOfficeMapObject(parsed)) continue
      files.push({
        file: entry.name,
        name: parsed.name || entry.name.replace(/\.json$/i, ''),
        updatedAt: info.mtime.toISOString(),
        width: parsed.width,
        height: parsed.height,
        elements: parsed.elements?.length ?? 0,
        seats: parsed.seats?.length ?? 0,
      })
    } catch {
      // Ignore malformed JSON files in directory listing
    }
  }

  files.sort((a, b) => {
    if (a.file === 'office-10-person.json') return -1
    if (b.file === 'office-10-person.json') return 1
    return a.file.localeCompare(b.file, 'zh-CN')
  })

  const configuredActive = typeof manifest.activeMap === 'string' ? manifest.activeMap : 'office-10-person.json'
  const activeFile = files.some((item) => item.file === configuredActive)
    ? configuredActive
    : (files[0]?.file ?? 'office-10-person.json')

  const activeEntry = files.find((item) => item.file === activeFile)
  const updatedAt = manifest.updatedAt || activeEntry?.updatedAt || new Date(0).toISOString()

  return { activeFile, updatedAt, files }
}

export async function readSharedMap(mapDir, rawFileName) {
  const file = sanitizeMapFileName(rawFileName)
  const fullPath = path.join(mapDir, file)
  let raw
  try {
    raw = await readFile(fullPath, 'utf8')
  } catch {
    throw new Error(`找不到地图配置文件：${file}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`地图配置文件不是合法 JSON：${file}`)
  }
  if (!isValidOfficeMapObject(parsed)) {
    throw new Error(`不是有效的 office-map 配置：${file}`)
  }
  return { file, map: normalizeMapForSharedStorage(parsed) }
}

export async function saveSharedMap(mapDir, { file, map, setActive = true, publicDir, editorDir }) {
  const fileName = sanitizeMapFileName(file)
  if (!isValidOfficeMapObject(map)) {
    throw new Error('地图配置格式无效，无法保存')
  }
  await mkdir(mapDir, { recursive: true })
  const normalized = normalizeMapForSharedStorage(map)
  await syncReferencedTopdownAssets(normalized, { publicDir, editorDir })
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`
  const targetPath = path.join(mapDir, fileName)
  await writeFile(targetPath, serialized, 'utf8')
  const mapBuffer = Buffer.from(serialized, 'utf8')

  const existingManifest = await readManifestSafe(mapDir)
  const updatedAt = new Date().toISOString()
  const activeFile = setActive ? fileName : (existingManifest.activeMap || fileName)
  const nextManifest = {
    ...existingManifest,
    generatedAt: updatedAt,
    updatedAt,
    activeMap: activeFile,
    source: `office-editor/${fileName}`,
    map: {
      target: `assets/office/map/${fileName}`,
      bytes: mapBuffer.length,
      sha256: sha256(mapBuffer),
    },
    schema: normalized.schema,
    elements: normalized.elements.length,
    seats: normalized.seats?.length ?? 0,
  }
  await writeFile(path.join(mapDir, 'manifest.json'), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')

  return {
    ok: true,
    file: fileName,
    activeFile,
    updatedAt,
    path: `assets/office/map/${fileName}`,
    map: normalized,
  }
}

export async function setActiveSharedMap(mapDir, rawFileName) {
  const { file, map } = await readSharedMap(mapDir, rawFileName)
  const existingManifest = await readManifestSafe(mapDir)
  const updatedAt = new Date().toISOString()
  const nextManifest = {
    ...existingManifest,
    updatedAt,
    activeMap: file,
    map: {
      ...(existingManifest.map || {}),
      target: `assets/office/map/${file}`,
    },
    schema: map.schema,
    elements: map.elements.length,
    seats: map.seats?.length ?? 0,
  }
  await writeFile(path.join(mapDir, 'manifest.json'), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  return { ok: true, activeFile: file, updatedAt }
}

function resolveOpenCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

export function openInSystemBrowser(url) {
  if (typeof url !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(url)) {
    throw new Error('仅允许在系统浏览器打开本机编辑器地址')
  }
  const { command, args } = resolveOpenCommand(process.platform, url)
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}

function readRequestBody(req, maxBytes = 45 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('请求体超过大小限制'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求 JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function resolveAliasedEditorFile(relPath, { publicDir, editorDir }) {
  const cleanRel = relPath.replace(/^\/+/, '')
  if (cleanRel.includes('..')) return null

  // Map shared assets between editor paths and AITeam/public/assets paths
  if (cleanRel === '' || cleanRel === 'index.html') {
    return path.join(editorDir, 'index.html')
  }
  if (cleanRel === 'examples/office-10-person.json') {
    const templateExample = path.join(editorDir, 'examples/office-10-person.json')
    if (existsSync(templateExample)) return templateExample
    const sharedExample = path.join(publicDir, 'assets/office/map/office-10-person.json')
    if (existsSync(sharedExample)) return sharedExample
  }
  if (cleanRel.startsWith('assets/aifred/office/')) {
    const sub = cleanRel.slice('assets/aifred/office/'.length)
    const candidate = path.join(publicDir, 'assets/office', sub)
    if (existsSync(candidate)) return candidate
  }
  if (cleanRel.startsWith('assets/aifred/characters/')) {
    const sub = cleanRel.slice('assets/aifred/characters/'.length)
    const candidate = path.join(publicDir, 'assets/characters', sub)
    if (existsSync(candidate)) return candidate
  }
  if (cleanRel.startsWith('assets/styles/topdown-soft/') && cleanRel.endsWith('.png')) {
    const sub = cleanRel.slice('assets/styles/topdown-soft/'.length)
    const candidate = path.join(publicDir, 'assets/office/topdown', sub)
    if (existsSync(candidate)) return candidate
  }
  if (cleanRel.startsWith('assets/office/')) {
    const candidate = path.join(publicDir, cleanRel)
    if (existsSync(candidate)) return candidate
    if (cleanRel.startsWith('assets/office/topdown/')) {
      const sub = cleanRel.slice('assets/office/topdown/'.length)
      const fallback = path.join(editorDir, 'assets/styles/topdown-soft', sub)
      if (existsSync(fallback)) return fallback
    }
    const sub = cleanRel.slice('assets/office/'.length)
    const fallbackAifred = path.join(editorDir, 'assets/aifred/office', sub)
    if (existsSync(fallbackAifred)) return fallbackAifred
    const fallbackRoot = path.join(editorDir, 'assets', sub)
    if (existsSync(fallbackRoot)) return fallbackRoot
  }
  if (/^assets\/icon_office_\d+\.png$/.test(cleanRel)) {
    const sub = cleanRel.slice('assets/'.length)
    const candidate = path.join(publicDir, 'assets/office', sub)
    if (existsSync(candidate)) return candidate
  }

  const directEditorFile = path.join(editorDir, cleanRel)
  if (existsSync(directEditorFile)) return directEditorFile

  const directPublicFile = path.join(publicDir, cleanRel)
  if (existsSync(directPublicFile)) return directPublicFile

  return null
}

export function createOfficeEditorMiddleware({
  mapDir,
  publicDir,
  editorDir,
  mountPrefix = '/office-editor',
  defaultOrigin = 'http://localhost:1420',
}) {
  ensureEmployeeRuntimeBundle(editorDir)

  return async function officeEditorMiddleware(req, res, next) {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://localhost')
      const pathname = decodeURIComponent(parsedUrl.pathname)

      // 1. Shared JSON directory API routes
      if (pathname === '/__office-editor/api/maps' && req.method === 'GET') {
        const result = await listSharedMaps(mapDir)
        sendJson(res, 200, result)
        return
      }
      if (pathname.startsWith('/__office-editor/api/maps/') && req.method === 'GET') {
        const rawFile = pathname.slice('/__office-editor/api/maps/'.length)
        const result = await readSharedMap(mapDir, rawFile)
        sendJson(res, 200, result)
        return
      }
      if (pathname === '/__office-editor/api/maps' && (req.method === 'POST' || req.method === 'PUT')) {
        const body = await readRequestBody(req)
        const result = await saveSharedMap(mapDir, { ...body, publicDir, editorDir })
        sendJson(res, 200, result)
        return
      }
      if (pathname === '/__office-editor/api/active-map' && req.method === 'POST') {
        const body = await readRequestBody(req)
        const result = await setActiveSharedMap(mapDir, body.file)
        sendJson(res, 200, result)
        return
      }
      if (pathname === '/__office-editor/api/open-browser' && req.method === 'POST') {
        const body = await readRequestBody(req)
        const { activeFile } = await listSharedMaps(mapDir)
        const targetFile = body.file ? sanitizeMapFileName(body.file) : activeFile
        const hostHeader = req.headers.host ? `http://${req.headers.host}` : defaultOrigin
        const baseOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(body.origin || '')
          ? body.origin
          : hostHeader
        const prefix = mountPrefix ? `${mountPrefix.replace(/\/$/, '')}/` : '/'
        const targetUrl = `${baseOrigin}${prefix}?file=${encodeURIComponent(targetFile)}`
        openInSystemBrowser(targetUrl)
        sendJson(res, 200, { ok: true, url: targetUrl, file: targetFile })
        return
      }

      // 2. Fallback for /assets/office/topdown/* directly from office-map-edit-tool package
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        pathname.startsWith('/assets/office/topdown/') &&
        !pathname.includes('..')
      ) {
        const publicAsset = path.join(publicDir, pathname.slice(1))
        if (!existsSync(publicAsset)) {
          const sub = pathname.slice('/assets/office/topdown/'.length)
          const pkgAsset = path.join(editorDir, 'assets/styles/topdown-soft', sub)
          if (existsSync(pkgAsset)) {
            const data = await readFile(pkgAsset)
            const ext = path.extname(pkgAsset).toLowerCase()
            res.writeHead(200, {
              'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
              'Cache-Control': 'no-cache',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(req.method === 'HEAD' ? undefined : data)
            return
          }
        }
      }

      // 3. Editor static files & aliased assets served directly from office-map-edit-tool package
      if (mountPrefix && pathname === mountPrefix) {
        const search = parsedUrl.search || ''
        res.writeHead(302, { Location: `${mountPrefix}/${search}` })
        res.end()
        return
      }

      let editorRelPath = null
      if (mountPrefix && pathname.startsWith(`${mountPrefix}/`)) {
        editorRelPath = pathname.slice(mountPrefix.length + 1)
      } else if (!mountPrefix) {
        editorRelPath = pathname.slice(1)
      }

      if (editorRelPath !== null && (req.method === 'GET' || req.method === 'HEAD')) {
        const resolved = resolveAliasedEditorFile(editorRelPath, { publicDir, editorDir })
        if (resolved) {
          const data = await readFile(resolved)
          const ext = path.extname(resolved).toLowerCase()
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(req.method === 'HEAD' ? undefined : data)
          return
        }
        if (mountPrefix) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }
      }

      if (typeof next === 'function') {
        next()
        return
      }
      res.writeHead(404).end('Not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message })
    }
  }
}

async function copyDirectoryRecursive(srcDir, destDir) {
  if (!existsSync(srcDir)) return
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}

export async function bundleOfficeEditorStaticFiles({ editorDir, outDir }) {
  if (!editorDir || !existsSync(editorDir)) return
  ensureEmployeeRuntimeBundle(editorDir)
  const targetRoot = path.join(outDir, 'office-editor')
  await mkdir(targetRoot, { recursive: true })

  const singleFiles = ['index.html', 'assets/samples.json']
  for (const rel of singleFiles) {
    const src = path.join(editorDir, rel)
    if (existsSync(src)) {
      const dest = path.join(targetRoot, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(src, dest)
    }
  }

  const directories = ['src', 'examples', 'assets/runtime', 'assets/styles', 'assets/crops']
  for (const relDir of directories) {
    await copyDirectoryRecursive(path.join(editorDir, relDir), path.join(targetRoot, relDir))
  }
}

export function officeEditorVitePlugin({ aiteamRoot }) {
  const publicDir = path.join(aiteamRoot, 'public')
  const mapDir = path.join(publicDir, 'assets/office/map')
  const editorDir = resolveOfficeEditorDir(aiteamRoot)

  return {
    name: 'aifred-office-map-editor',
    configureServer(server) {
      server.middlewares.use(
        createOfficeEditorMiddleware({
          mapDir,
          publicDir,
          editorDir,
          mountPrefix: '/office-editor',
          defaultOrigin: 'http://localhost:1420',
        }),
      )
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        createOfficeEditorMiddleware({
          mapDir,
          publicDir,
          editorDir,
          mountPrefix: '/office-editor',
          defaultOrigin: 'http://localhost:4173',
        }),
      )
    },
    async writeBundle(outputOptions) {
      const outDir = outputOptions?.dir
        ? path.resolve(aiteamRoot, outputOptions.dir)
        : path.join(aiteamRoot, 'dist')
      await bundleOfficeEditorStaticFiles({ editorDir, outDir })
    },
  }
}
