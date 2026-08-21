import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = new URL('..', import.meta.url)
const require = createRequire(import.meta.url)

function read(rel) {
  return fs.readFileSync(new URL(rel, root), 'utf8')
}

test('package manifest is installable and declares both bundle and web client', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.name, 'dsh-plugin-subagent-delete')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-slots',
  ])
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.equal(pkg.types, 'src/index.d.ts')
  for (const file of pkg.files) {
    assert.ok(fs.existsSync(new URL(file, root)), `packaged file missing: ${file}`)
  }
})

test('cordis patch and client bundle contain no leftover debug output', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /dsh-plugin-subagent-delete/)
  const host = read('src/index.js')
  const client = read('lib/client.js')
  for (const [label, source] of [['host', host], ['client', client]]) {
    assert.doesNotMatch(source, /marker-debug|\[subagent-delete-client\]/, `${label} source has debug leftovers`)
  }
  assert.match(client, /byId\[id\]\.parentId/, 'client detector reads the public parentId field')
  assert.match(host, /setTimeout\(resolve, 250\)/, 'marker stays announced across a client notifier flush')
})

test('source maps are not packed into the client bundle', () => {
  const client = read('lib/client.js')
  assert.doesNotMatch(client, /sourceMappingURL/)
})
