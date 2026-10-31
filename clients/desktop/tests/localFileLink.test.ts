import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { isLocalFileUrl, localPathFromHref, pathBasename, pickArtifactForPath } from '../src/lib/localFileLink.ts'

const DOC = '/Users/edy/Documents/需求/campus.md'

test('file://, computer:// and absolute paths resolve to the decoded path', () => {
  assert.equal(localPathFromHref(`file://${DOC}`), DOC)
  assert.equal(localPathFromHref(`computer://${DOC}`), DOC)
  assert.equal(localPathFromHref('file://localhost/tmp/a.md'), '/tmp/a.md')
  assert.equal(localPathFromHref(encodeURI(DOC)), DOC)
  assert.equal(localPathFromHref(encodeURI(`file://${DOC}`)), DOC)
  assert.equal(localPathFromHref('file:///C:/Users/me/a.md'), 'C:/Users/me/a.md')
  assert.equal(localPathFromHref('C:\\Users\\me\\a.md'), 'C:\\Users\\me\\a.md')
})

test('web links, anchors and unsafe schemes are not local file links', () => {
  for (const href of ['https://example.com/a.md', 'http://127.0.0.1:1/x', 'mailto:a@b.c', '#top', 'javascript:alert(1)', '//evil.example/x', 'relative/a.md', '']) {
    assert.equal(isLocalFileUrl(href), false, href)
    assert.equal(localPathFromHref(href), null, href)
  }
  assert.equal(localPathFromHref(undefined), null)
})

test('markdown keeps local file hrefs that react-markdown would otherwise empty, and still blocks javascript:', () => {
  const render = (md: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    urlTransform: (url: string) => isLocalFileUrl(url) ? url : defaultUrlTransform(url),
    components: { a: ({ href, children }: { href?: string; children?: React.ReactNode }) => React.createElement('a', { 'data-path': localPathFromHref(href) ?? '', 'data-href': href ?? '' }, children) },
  }, md))

  for (const scheme of ['file://', 'computer://', '']) {
    const html = render(`[打开文档](${scheme}${DOC})`)
    assert.match(html, /data-path="\/Users\/edy\/Documents\/需求\/campus\.md"/, scheme)
  }
  assert.match(render('[x](javascript:alert(1))'), /data-href=""/)
  assert.match(render('[x](https://example.com/a)'), /data-path="" data-href="https:\/\/example\.com\/a"/)
  // The previous default drops these schemes entirely.
  assert.match(renderToStaticMarkup(React.createElement(ReactMarkdown, null, `[x](file://${DOC})`)), /<a href="">/)
})

test('a path is matched to the newest generated file with the same name', () => {
  const files = [
    { id: 'old', filename: 'campus.md', created_at: '2026-10-18T10:00:00Z' },
    { id: 'new', filename: 'campus.md', created_at: '2026-10-18T12:00:00Z' },
    { id: 'other', filename: 'other.md', created_at: '2026-10-18T13:00:00Z' },
    { id: 'upper', filename: 'README.MD', created_at: '2026-10-18T09:00:00Z' },
  ]
  assert.equal(pickArtifactForPath(files, DOC)?.id, 'new')
  assert.equal(pickArtifactForPath(files, '/srv/x/readme.md')?.id, 'upper')
  assert.equal(pickArtifactForPath(files, '/srv/x/missing.md'), null)
  assert.equal(pickArtifactForPath(files, '/'), null)
  assert.equal(pathBasename('C:\\Users\\me\\a.md'), 'a.md')
})
