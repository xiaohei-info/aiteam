import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  bundleOfficeEditorStaticFiles,
  listSharedMaps,
  normalizeMapForSharedStorage,
  readSharedMap,
  resolveOfficeEditorDir,
  sanitizeMapFileName,
  saveSharedMap,
  setActiveSharedMap,
} from '../scripts/office-editor-middleware.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('OfficeStatus 页面已移除右上角 LIVE 标，并替换为打开浏览器的办公室编辑器入口', async () => {
  const source = await readFile(path.join(root, 'src/pages/OfficeStatus/index.tsx'), 'utf8')
  assert.doesNotMatch(source, /connectionLabel|'LIVE'|"LIVE"/, '原有的 LIVE 标应已移除')
  assert.match(source, /data-testid="office-map-editor-entry"/, '应包含右上角办公室编辑器入口')
  assert.match(source, /target="_blank"/, 'Web 环境点击应在新标签页打开浏览器编辑器')
  assert.match(source, /openOfficeMapEditor\(activeMapFile\)/, 'Tauri 桌面环境点击应调用系统浏览器打开编辑器')
  assert.match(source, /编辑办公室/, '入口按钮文案应清晰标识编辑办公室')
})

test('办公室风格固定为商务风：页面不提供地图/风格切换入口，也不跟随共用配置的 activeFile', async () => {
  const source = await readFile(path.join(root, 'src/pages/OfficeStatus/index.tsx'), 'utf8')
  const roster = await readFile(path.join(root, 'src/pages/OfficeStatus/officeRoster.ts'), 'utf8')
  assert.match(roster, /export const OFFICE_MAP_FILE = 'office-10-person-business\.json'/)
  assert.match(roster, /\/assets\/office\/map\/\$\{encodeURIComponent\(OFFICE_MAP_FILE\)\}/, '常驻场景只加载商务风地图')
  assert.match(source, /import \{ OFFICE_MAP_FILE \} from '\.\/officeRoster'/)
  assert.doesNotMatch(source, /选择办公室地图配置|<select|setActiveOfficeMap|setActiveMapFile/, '不应再有切换地图的下拉框')
  const host = await readFile(path.join(root, 'src/components/OfficeRuntimeHost.tsx'), 'utf8')
  assert.doesNotMatch(host, /\.activeFile/, '只跟随共用配置的更新时间，不跟随 activeFile')
  assert.ok(existsSync(path.join(root, 'public/assets/office/map/office-10-person-business.json')), '商务风地图必须存在')
})

test('AIFred 通过 pnpm 依赖直接引用 office-map-edit-tool 仓库且无需拷贝 public/office-editor', async () => {
  const pkgRaw = await readFile(path.join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  assert.ok(
    pkg.devDependencies?.['office-map-edit-tool'] || pkg.dependencies?.['office-map-edit-tool'],
    'package.json 应声明对 office-map-edit-tool 的依赖引用',
  )
  assert.equal(
    existsSync(path.join(root, 'public/office-editor')),
    false,
    '不应在 AITeam/public/ 下冗余拷贝整份 office-editor 代码',
  )

  const resolvedEditorDir = resolveOfficeEditorDir(root)
  const [resolvedReal, expectedReal, toolHtml, toolApp] = await Promise.all([
    realpath(resolvedEditorDir),
    realpath(path.join(root, '../office-map-edit-tool')),
    readFile(path.join(resolvedEditorDir, 'index.html'), 'utf8'),
    readFile(path.join(resolvedEditorDir, 'src/app.js'), 'utf8'),
  ])
  assert.equal(resolvedReal, expectedReal, 'resolveOfficeEditorDir 应解析到 office-map-edit-tool 仓库目录')
  assert.match(toolHtml, /id="save-map"/, '顶栏应提供保存按钮')
  assert.match(toolHtml, /id="save-name-dialog"/, '应提供新建布局保存文件名弹窗')
  assert.match(toolHtml, /id="shared-map-select"/, '应提供共用目录配置切换下拉框')
  assert.match(toolApp, /\/__office-editor\/api\/maps/, '编辑器应连接共用目录 API')
})

test('sanitizeMapFileName 规范化文件名并拦截非法路径与 manifest.json', () => {
  assert.equal(sanitizeMapFileName('office-10-person'), 'office-10-person.json')
  assert.equal(sanitizeMapFileName('office-10-person.json'), 'office-10-person.json')
  assert.equal(sanitizeMapFileName('自定义布局.office-map.json'), '自定义布局.json')
  assert.throws(() => sanitizeMapFileName(''), /请输入保存文件名/)
  assert.throws(() => sanitizeMapFileName('../secret.json'), /路径分隔符/)
  assert.throws(() => sanitizeMapFileName('manifest.json'), /manifest\.json/)
})

test('共用 JSON 目录：更新当前导入文件、新建布局命名保存与切换激活配置', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'aifred-office-map-test-'))
  try {
    const sampleRaw = await readFile(path.join(root, 'public/assets/office/map/office-10-person.json'), 'utf8')
    const sampleMap = JSON.parse(sampleRaw)
    await writeFile(path.join(tempDir, 'office-10-person.json'), sampleRaw, 'utf8')

    // 1. 列出共用目录配置
    const initialList = await listSharedMaps(tempDir)
    assert.equal(initialList.activeFile, 'office-10-person.json')
    assert.equal(initialList.files.length, 1)

    // 2. 保存更新当前导入的配置文件（不新建文件，直接覆盖原文件）
    const modifiedCurrent = structuredClone(sampleMap)
    modifiedCurrent.name = '10人办公室（已更新）'
    const updatedRes = await saveSharedMap(tempDir, {
      file: 'office-10-person.json',
      map: modifiedCurrent,
      setActive: true,
    })
    assert.equal(updatedRes.ok, true)
    assert.equal(updatedRes.file, 'office-10-person.json')
    const reloadedCurrent = await readSharedMap(tempDir, 'office-10-person.json')
    assert.equal(reloadedCurrent.map.name, '10人办公室（已更新）')

    // 3. 新建布局输入保存名后写入同个共用目录，并成为当前激活配置
    const newLayout = structuredClone(sampleMap)
    newLayout.name = '20人新布局'
    newLayout.assets = [
      { id: 'asset-1', name: '地板', src: 'assets/styles/topdown-soft/floor-mineral.png', tileable: true },
      { id: 'asset-2', name: '办公椅', src: 'assets/aifred/office/chair.png' },
    ]
    newLayout.elements = []
    newLayout.seats = []
    const newRes = await saveSharedMap(tempDir, {
      file: 'office-20-new',
      map: newLayout,
      setActive: true,
    })
    assert.equal(newRes.file, 'office-20-new.json')
    assert.equal(newRes.activeFile, 'office-20-new.json')
    // 素材路径自动转为 AIFred 前端可直接读取的 assets/office/... 路径
    assert.equal(newRes.map.assets[0].src, 'assets/office/topdown/floor-mineral.png')
    assert.equal(newRes.map.assets[1].src, 'assets/office/chair.png')

    const afterNewList = await listSharedMaps(tempDir)
    assert.equal(afterNewList.activeFile, 'office-20-new.json')
    assert.equal(afterNewList.files.length, 2)

    // 4. 切换回原配置
    const switchRes = await setActiveSharedMap(tempDir, 'office-10-person.json')
    assert.equal(switchRes.activeFile, 'office-10-person.json')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('normalizeMapForSharedStorage 自动为落在房间内的活动点补齐 roomId', () => {
  const input = {
    schema: 'office-map/v1.1',
    id: 'test-map',
    name: '测试地图',
    width: 1600,
    height: 1200,
    assets: [],
    elements: [],
    zones: [],
    rooms: [
      { id: 'room-meeting-a', name: '会议室 A', type: 'meeting', capacity: 6, bounds: { x: 0, y: 0, width: 512, height: 368 } },
    ],
    spots: [
      { id: 'spot-1', name: '会议室 1', kind: 'meeting', x: 176, y: 320, enabled: true },
      { id: 'spot-2', name: '过道 1', kind: 'corridor', x: 600, y: 500, enabled: true },
    ],
  }
  const normalized = normalizeMapForSharedStorage(input)
  assert.equal(normalized.spots[0].roomId, 'room-meeting-a')
  assert.equal(normalized.spots[1].roomId, undefined)
})

test('打包支持：Pixi CSP 兼容配置与 Tauri 本地办公室编辑器桥接齐全', async () => {
  const [loadMapSrc, loadAssetsSrc, rustLibSrc, rustEditorSrc] = await Promise.all([
    readFile(path.join(root, 'src/scene/office/officeMap/loadOfficeMap.ts'), 'utf8'),
    readFile(path.join(root, 'src/scene/office/loadOfficeAssets.ts'), 'utf8'),
    readFile(path.join(root, 'src-tauri/src/lib.rs'), 'utf8'),
    readFile(path.join(root, 'src-tauri/src/office_editor.rs'), 'utf8'),
  ])

  assert.match(loadMapSrc, /import 'pixi\.js\/unsafe-eval'/, 'loadOfficeMap 应启用 pixi.js/unsafe-eval 以兼容打包 CSP')
  assert.match(loadAssetsSrc, /import 'pixi\.js\/unsafe-eval'/, 'loadOfficeAssets 应启用 pixi.js/unsafe-eval 以兼容打包 CSP')
  assert.match(loadMapSrc, /preferCreateImageBitmap:\s*false/, 'loadOfficeMap 应禁用 fetch(data:) 的 ImageBitmap 路径')
  assert.match(loadMapSrc, /open_office_map_editor/, 'loadOfficeMap 应在打包 Tauri 环境调用 open_office_map_editor')
  assert.match(rustLibSrc, /office_editor::open_office_map_editor/, 'Tauri invoke_handler 应注册 open_office_map_editor')
  assert.match(rustEditorSrc, /\/__office-editor\/api\/maps/, 'Tauri 本地编辑器服务应提供共用地图 API')

  const tempOut = await mkdtemp(path.join(tmpdir(), 'aifred-office-editor-dist-'))
  try {
    const editorDir = resolveOfficeEditorDir(root)
    await bundleOfficeEditorStaticFiles({ editorDir, outDir: tempOut })
    assert.equal(existsSync(path.join(tempOut, 'office-editor/index.html')), true)
    assert.equal(existsSync(path.join(tempOut, 'office-editor/src/app.js')), true)
    assert.equal(existsSync(path.join(tempOut, 'office-editor/assets/runtime/employees.js')), true)
    assert.equal(existsSync(path.join(root, 'public/office-editor')), false)
  } finally {
    await rm(tempOut, { recursive: true, force: true })
  }
})

