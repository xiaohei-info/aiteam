import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAvatarUrl } from '../src/lib/avatarUrl.ts'

test('avatar URL adds the service domain to a server path', () => {
  assert.equal(
    resolveAvatarUrl('/api/agent/employees/employee-1/avatar/content', 'https://api.example.test/'),
    'https://api.example.test/api/agent/employees/employee-1/avatar/content',
  )
})

test('avatar URL keeps an already absolute URL unchanged', () => {
  assert.equal(
    resolveAvatarUrl('https://cdn.example.test/avatar.png', 'https://api.example.test'),
    'https://cdn.example.test/avatar.png',
  )
})

test('avatar URL upgrades protocol-relative CDN addresses without duplicating the API host', () => {
  assert.equal(
    resolveAvatarUrl('//cdn.example.test/avatar.png', 'https://api.example.test'),
    'https://cdn.example.test/avatar.png',
  )
})

test('avatar URL treats blank values as unavailable', () => {
  assert.equal(resolveAvatarUrl('  ', 'https://api.example.test'), null)
  assert.equal(resolveAvatarUrl(null, 'https://api.example.test'), null)
})
