import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKnowledgeService,
  ENTERPRISE_ENDPOINT,
  knowledgeBaseSourceLabel,
  knowledgeKey,
  knowledgeScopeLabel,
  knowledgeSourceConnection,
  knowledgeTarget,
  LEGACY_NAS_ID,
  MANAGER_UPLOAD_LIMIT,
  nasEndpoint,
  normalizeKnowledgeDocument,
  uploadKnowledgeBatch,
  validateKnowledgeUpload,
} from '../src/pages/KnowledgeBase/knowledgeService.ts'

const doc = { id: 'doc-1', display_name: '资料.md', file_name: '资料.md', file_type: 'text/markdown', file_size: 7, status: 'uploaded', can_retry: false, recovery_required: false, created_at: '2026-10-07T01:00:00Z' }
const LEGACY_NAS = nasEndpoint(LEGACY_NAS_ID)

test('removed device IDs cannot reach remote upload, binding, or retry transports', async () => {
  let requests = 0
  const service = createKnowledgeService(async () => { requests++; throw new Error('unexpected remote request') })
  assert.throws(() => knowledgeTarget('device:old-kb'), /本机副本知识库已移除/)
  assert.throws(() => knowledgeTarget('device:old-kb', 'local'), /本机副本知识库已移除/)
  await assert.rejects(service.upload('device:old-kb', new File(['text'], 'note.txt')), /本机副本知识库已移除/)
  await assert.rejects(service.bind('device:old-kb', 'employee-1'), /本机副本知识库已移除/)
  await assert.rejects(service.retry('device:old-kb', normalizeKnowledgeDocument(doc, 'device:old-kb')), /本机副本知识库已移除/)
  assert.equal(requests, 0)
})

test('Manager upload is multipart, scoped, and preserves server intake state', async () => {
  const service = createKnowledgeService(async (endpoint, path, init) => {
    assert.deepEqual(endpoint, ENTERPRISE_ENDPOINT)
    assert.equal(path, '/api/manager/knowledge-spaces/company%2Fspace/documents')
    assert.equal(init?.method, 'POST')
    assert.ok(init?.body instanceof FormData)
    assert.equal((init.body.get('file') as File).name, '资料.md')
    assert.equal(init.body.has('workspace'), false)
    return { data: doc }
  })
  const result = await service.upload(knowledgeKey(ENTERPRISE_ENDPOINT, 'company/space'), new File(['content'], '资料.md'))
  assert.equal(result.status, 'uploaded')
  assert.equal(result.canRetry, false)
  assert.equal(result.fileSize, 7)
  assert.equal(result.knowledgeBaseId, knowledgeKey(ENTERPRISE_ENDPOINT, 'company/space'))
})

test('NAS upload never falls through to Manager on failure and never sends local paths', async () => {
  let calls = 0
  const service = createKnowledgeService(async (endpoint, path, init) => {
    calls++
    assert.deepEqual(endpoint, LEGACY_NAS)
    assert.equal(path, '/api/knowledge-bases/same-id/documents')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.content_base64, btoa('hello'))
    assert.equal('local_path' in body, false)
    throw new Error('NAS offline')
  })
  await assert.rejects(service.upload(knowledgeKey(LEGACY_NAS, 'same-id'), new File(['hello'], 'test.txt')), /NAS offline/)
  assert.equal(calls, 1)
})

test('Manager enforces its 4 MiB boundary and empty file validation before networking', () => {
  assert.throws(() => validateKnowledgeUpload({ name: 'empty', size: 0 }, 'enterprise'), /空文件/)
  assert.throws(() => validateKnowledgeUpload({ name: 'big', size: MANAGER_UPLOAD_LIMIT + 1 }, 'enterprise'), /4 MiB/)
  assert.doesNotThrow(() => validateKnowledgeUpload({ name: 'exact', size: MANAGER_UPLOAD_LIMIT }, 'enterprise'))
  assert.doesNotThrow(() => validateKnowledgeUpload({ name: 'nas', size: MANAGER_UPLOAD_LIMIT + 1 }, 'local'))
})

test('batch keeps success, continues after failure, and retry only receives failed items', async () => {
  const files = ['one', 'two', 'three'].map(name => ({ file: new File(['text'], name) }))
  const progress: number[] = []
  const result = await uploadKnowledgeBatch(files, async item => {
    if (item.file.name === 'two') throw new Error('network')
    return normalizeKnowledgeDocument({ ...doc, id: item.file.name }, 'enterprise:space')
  }, index => progress.push(index))
  assert.deepEqual(result.uploaded.map(item => item.id), ['one', 'three'])
  assert.deepEqual(result.failed.map(item => item.item.file.name), ['two'])
  assert.equal(result.failed[0].error, 'network')
  assert.deepEqual(progress, [1, 2, 3])
})

test('Manager lists actual documents and actual expert bindings, excluding deleted documents', async () => {
  const service = createKnowledgeService(async (_endpoint, path) => {
    if (path.endsWith('/documents')) return { data: [doc, { ...doc, id: 'deleted', status: 'deleted' }] }
    if (path.endsWith('/bindings')) return { data: [{ resource_type: 'expert', resource_id: 'employee-1' }, { resource_type: 'member', resource_id: 'member-1' }] }
    return { data: [{ knowledge_space_id: 'same-id', display_name: '企业知识库' }] }
  })
  const bases = await service.listSource(ENTERPRISE_ENDPOINT)
  assert.equal(bases[0].id, 'enterprise:same-id')
  assert.equal(bases[0].docCount, 1)
  assert.deepEqual(bases[0].employeeBindings, [{ employeeId: 'employee-1', displayName: 'employee-1' }])
  assert.notEqual(knowledgeKey(LEGACY_NAS, 'same-id'), bases[0].id)
  assert.deepEqual(knowledgeTarget(knowledgeKey(LEGACY_NAS, '含/%路径')), { endpoint: LEGACY_NAS, id: '含/%路径' })
})

test('each NAS gets its own key namespace; the legacy single-NAS keys stay unchanged', () => {
  // Upload records and employee links saved before multi-NAS use these keys.
  assert.equal(knowledgeKey(LEGACY_NAS, 'kb'), 'local:kb')
  assert.deepEqual(knowledgeTarget('local:kb'), { endpoint: LEGACY_NAS, id: 'kb' })
  const branch = nasEndpoint('nas-1a2b')
  const key = knowledgeKey(branch, 'a:b/c')
  assert.equal(key, 'local:nas-1a2b:a%3Ab%2Fc')
  assert.deepEqual(knowledgeTarget(key), { endpoint: branch, id: 'a:b/c' })
  // A colon inside a legacy id is escaped, so it is never read as a NAS id.
  assert.deepEqual(knowledgeTarget(knowledgeKey(LEGACY_NAS, 'a:b')), { endpoint: LEGACY_NAS, id: 'a:b' })
  assert.notEqual(knowledgeKey(branch, 'same-id'), knowledgeKey(nasEndpoint('nas-other'), 'same-id'))
})

test('listing, upload, retry and binding go only to the NAS that owns the library', async () => {
  const calls: Array<{ nasId: string; path: string; body?: string }> = []
  const service = createKnowledgeService(async (endpoint, path, init) => {
    const nasId = endpoint.source === 'local' ? endpoint.nasId : 'manager'
    calls.push({ nasId, path, body: typeof init?.body === 'string' ? init.body : undefined })
    if (!init) {
      return { data: [
        { id: 'same-id', name: `${nasId} 资料`, files: [], employeeBindings: [{ employeeId: 'e1', displayName: '员工' }] },
        { id: 'other', name: 'other', files: [] },
      ] }
    }
    return path.includes('/documents') ? { data: doc } : null
  })
  const [onB] = await service.listSource(nasEndpoint('nas-b'))
  assert.equal(onB.id, 'local:nas-b:same-id')
  assert.equal(onB.nasId, 'nas-b')
  await service.upload(onB.id, new File(['x'], 'x.txt'))
  await service.retry(onB.id, normalizeKnowledgeDocument({ ...doc, can_retry: true }, onB.id))
  await service.bind('local:nas-b:other', 'e1')
  assert.deepEqual([...new Set(calls.map(call => call.nasId))], ['nas-b'])
  assert.equal(calls.at(-1)?.path, '/api/knowledge-permissions/e1')
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.body)), { knowledge_base_ids: ['same-id', 'other'] })
})

test('personal services keep existing levels readable; team and enterprise rows are marked for migration', async () => {
  const nas = createKnowledgeService(async () => ({ data: ['private', 'team', 'enterprise', undefined].map((level, index) => ({ id: `kb-${index}`, name: `库 ${index}`, level, files: [] })) }))
  const bases = await nas.listSource(LEGACY_NAS)
  // A row without a level is not defaulted to team, so it never shows a false migration hint.
  assert.deepEqual(bases.map(base => base.level), ['private', 'team', 'enterprise', undefined])
  assert.deepEqual(bases.map(knowledgeScopeLabel), ['仅本人', '团队级·待迁移', '企业级·待迁移', '仅本人'])
  assert.equal(knowledgeScopeLabel({ source: 'enterprise', level: 'private' }), '按岗位权限')
})

test('library source label names its personal service so several services stay distinguishable', () => {
  assert.equal(knowledgeBaseSourceLabel({ source: 'local', sourceName: '总部' }), '个人·总部')
  assert.equal(knowledgeBaseSourceLabel({ source: 'local' }), '个人')
  assert.equal(knowledgeBaseSourceLabel({ source: 'enterprise', sourceName: '总部' }), '企业')
})

test('source connection is unconfigured, checking, connected, or failed with the server message', () => {
  assert.deepEqual(knowledgeSourceConnection('  '), { state: 'unconfigured' })
  assert.deepEqual(knowledgeSourceConnection('https://nas.example.com/kb'), { state: 'checking', address: 'nas.example.com/kb' })
  assert.deepEqual(knowledgeSourceConnection('http://127.0.0.1:8783', { endpoint: LEGACY_NAS }), { state: 'connected', address: '127.0.0.1:8783' })
  assert.deepEqual(knowledgeSourceConnection('https://m.example.com', { endpoint: ENTERPRISE_ENDPOINT, error: '401' }), { state: 'error', address: 'm.example.com', message: '401' })
})

test('NAS association preserves existing links and only writes to NAS', async () => {
  const service = createKnowledgeService(async (endpoint, path, init) => {
    assert.deepEqual(endpoint, LEGACY_NAS)
    if (!init) return { data: [{ id: 'old', name: 'old', files: [], employeeBindings: [{ employeeId: 'e1', displayName: '员工' }] }] }
    assert.equal(path, '/api/knowledge-permissions/e1')
    assert.deepEqual(JSON.parse(String(init.body)), { knowledge_base_ids: ['old', 'new'] })
    return null
  })
  await service.bind('local:new', 'e1')
})

test('Manager association uses space binding, not NAS replacement permission API', async () => {
  const service = createKnowledgeService(async (endpoint, path, init) => {
    assert.deepEqual(endpoint, ENTERPRISE_ENDPOINT)
    assert.equal(path, '/api/manager/knowledge-spaces/space/bindings')
    assert.deepEqual(JSON.parse(String(init?.body)), { knowledge_space_id: 'space', resource_type: 'expert', resource_id: 'e1' })
    return { data: {} }
  })
  await service.bind('enterprise:space', 'e1')
})

test('Manager retry treats response as job and reads actual document; recovery blocks retry', async () => {
  let calls = 0
  const service = createKnowledgeService(async (_endpoint, path) => {
    calls++
    return path.endsWith('/retry') ? { data: { id: 'job-1' } } : { data: [doc] }
  })
  const file = normalizeKnowledgeDocument({ ...doc, can_retry: true }, 'enterprise:space')
  assert.equal((await service.retry('enterprise:space', file)).id, 'doc-1')
  assert.equal(calls, 2)
  await assert.rejects(service.retry('enterprise:space', { ...file, recoveryRequired: true }), /不能重试/)
  assert.equal(calls, 2)
})
