import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createOfficeEditorMiddleware } from '../desktop/scripts/office-editor-middleware.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const aiteamRoot = path.resolve(root, '../desktop')
const publicDir = path.join(aiteamRoot, 'public')
const mapDir = path.join(publicDir, 'assets/office/map')
const port = Number(process.env.PORT || 4174)

const middleware = createOfficeEditorMiddleware({
  mapDir,
  publicDir,
  editorDir: root,
  mountPrefix: '',
  defaultOrigin: `http://127.0.0.1:${port}`,
})

const server = http.createServer((req, res) => {
  void middleware(req, res)
})
server.listen(port, '127.0.0.1', () => console.log(`Office Map Editor: http://127.0.0.1:${server.address().port}`))
