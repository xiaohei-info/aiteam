/** 工作台文件预览用的纯函数：CSV 解析、HTML / SVG 的安全渲染。 */

/** RFC 4180 风格的 CSV 解析（引号、转义引号、CRLF），只取前 maxRows 行，跳过空行。 */
export function parseCsv(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endRow = () => {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    field = ''
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (source[index + 1] === '"') { field += '"'; index += 1 }
      else quoted = false
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      endRow()
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true }
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) endRow()
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows }
}

// 与应用 CSP 叠加生效：预览页只能用内联样式和 data: 图片/字体，不访问任何外部地址。
const HTML_PREVIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">'

/** HTML 预览文档：CSP 放在 doctype 之后，解析器会把它放进 head，不改变渲染模式。 */
export function sandboxedHtml(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0]
  return doctype ? `${doctype}${HTML_PREVIEW_CSP}${html.slice(doctype.length)}` : `${HTML_PREVIEW_CSP}${html}`
}

/** SVG 只以图片方式渲染：不执行脚本，也不加载外部资源。 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
