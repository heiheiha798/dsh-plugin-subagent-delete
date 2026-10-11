#!/usr/bin/env node
// Verify the plugin's host half against PUBLISHED dsh packages.
//
//   node scripts/verify-published-dsh.mjs [version]
//   npm run verify:dsh                 # default version below
//
// The local checkout's `lib/` artifacts can lag its source, so this probe
// installs the requested published `@deepseek-ai/dsh-*` release into a temp
// directory, copies `src/index.js` beside it, and drives the plugin through the
// real ToolRuntime (see scripts/contract/published-probe.mjs).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.2.1-alpha.2'
const CORDIS_VERSION = '4.0.5-alpha.1'

// dsh-tools peer dependencies: the probe composes the real registry, so every
// peer must resolve from the temp install.
const PEERS = [
  'dsh-llm',
  'dsh-agent',
  'dsh-session',
  'dsh-scope',
  'dsh-system-prompt',
  'dsh-user-approval',
  'dsh-sandbox',
  'dsh-sandbox-policy',
  'dsh-working-directory',
  'dsh-ptc-runtime',
]

const version = process.argv[2] ?? process.env.DSH_VERSION ?? DEFAULT_VERSION
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-published-'))

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', cwd: dir, ...options })
}

try {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-subagent-delete-contract',
    private: true,
    type: 'module',
  }, null, 2))
  fs.mkdirSync(path.join(dir, 'plugin'), { recursive: true })
  fs.copyFileSync(path.join(root, 'src', 'index.js'), path.join(dir, 'plugin', 'index.js'))
  fs.copyFileSync(
    path.join(root, 'scripts', 'contract', 'published-probe.mjs'),
    path.join(dir, 'published-probe.mjs'),
  )

  console.log(`installing @deepseek-ai/dsh-*@${version} into ${dir}`)
  run('npm', [
    'install', '--no-audit', '--no-fund', '--loglevel=error',
    `@deepseek-ai/dsh-tools@${version}`,
    `@deepseek-ai/cordis@${CORDIS_VERSION}`,
    ...PEERS.map((name) => `@deepseek-ai/${name}@${version}`),
  ])
  run(process.execPath, ['published-probe.mjs'])
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
