import { makeMap, makeElement, templateOptions, validateMap } from './model.js'

const safeConfigSource = src => typeof src === 'string' && /^assets\/[a-zA-Z0-9_./-]+\.json$/.test(src) && !src.split('/').includes('..')

export async function loadStyles(fetchJSON) {
  const index = await fetchJSON('assets/styles/styles.json')
  if (!Array.isArray(index)) throw new Error('风格索引不是列表')
  const seen = new Set(), styles = [], errors = []
  for (const entry of index) {
    try {
      if (!entry || !/^[a-z0-9-]+$/.test(entry.id) || seen.has(entry.id) || typeof entry.name !== 'string') throw new Error('风格 ID 或名称无效')
      seen.add(entry.id)
      if (!safeConfigSource(entry.path)) throw new Error('风格路径无效')
      const config = await fetchJSON(entry.path)
      let items = config.elements
      if (config.source) {
        if (!safeConfigSource(config.source)) throw new Error('素材来源无效')
        const samples = await fetchJSON(config.source)
        items = samples.map(s => ({ id: `sample-${s.id}`, name: s.label, category: '原图样板', kind: 'image', src: `assets/crops/${s.id}.png`, width: s.rect[2], height: s.rect[3], blocksMovement: false }))
      }
      if (!Array.isArray(items) || items.length > 2000) throw new Error('风格素材清单无效')
      const ids = new Set()
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || item.category !== undefined && typeof item.category !== 'string') throw new Error('素材 ID、名称或分类无效')
        ids.add(item.id)
        const probe = makeMap()
        if (item.kind === 'image') probe.assets.push({ id: 'probe-asset', name: item.name, src: item.src, tileable: item.tileable ?? false })
        const options = templateOptions(item)
        if (item.kind === 'image') options.assetId = 'probe-asset'
        probe.elements.push(makeElement(item.name, item.kind, 100, 100, options))
        validateMap(probe)
      }
      styles.push({ id: entry.id, name: entry.name, desc: config.description || entry.description || '', hint: config.hint || config.description || entry.description || '', items, default: !!entry.default })
    } catch (error) {
      errors.push(`${entry?.name || '未知风格'}：${error.message}`)
    }
  }
  return { styles, errors }
}
