#!/usr/bin/env node
/**
 * Build an installable tarball of this plugin, optionally under a different
 * package name for a personal-scope release.
 *
 * `pnpm pack` inside the workspace rewrites `workspace:` ranges in
 * `dependencies` and `peerDependencies` but leaves them in `devDependencies`,
 * and installing such a tarball into a profile fails with
 * ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL. This stages a copy outside the
 * workspace whose manifest rewrites every workspace range to the concrete
 * workspace version and drops `devDependencies` (a consumer never installs
 * them), then packs the staged copy.
 *
 * The client bundle keys itself by package name at build time (`__ModuleLoader__
 * .load({ id })` and the injected style-tag ids). `--name` therefore rewrites
 * that name throughout the built artifacts and the bundle patch, so the packed
 * copy loads under the published name without a rebuild.
 *
 * Usage:
 *   node packages/client/ui-token-usage/scripts/pack-local.mjs
 *   node packages/client/ui-token-usage/scripts/pack-local.mjs --name @me/dsh-token-usage --version 0.1.0
 * @module @deepseek-ai/dsh-client-ui-token-usage/scripts/pack-local
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pkgDir, '../../..')
const { values } = parseArgs({ options: { name: { type: 'string' }, version: { type: 'string' } } })

/** Workspace package name → version, from every manifest a workspace range may name. */
const versions = new Map()
function remember(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') versions.set(manifest.name, manifest.version)
  } catch {
    // A directory without a readable manifest is not a workspace package.
  }
}

/** Whether a path is a directory, so README and AGENTS files beside packages are skipped. */
function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

for (const group of readdirSync(join(repo, 'packages'))) {
  const groupDir = join(repo, 'packages', group)
  if (!isDirectory(groupDir)) continue
  for (const name of readdirSync(groupDir)) remember(join(groupDir, name, 'package.json'))
}
for (const name of readdirSync(join(repo, 'vendor'))) remember(join(repo, 'vendor', name, 'package.json'))

/**
 * Rewrite one dependency section's workspace ranges to caret versions.
 * @param section - dependency section from the package manifest.
 * @returns the same entries with `workspace:` ranges resolved.
 * @throws when a workspace range names no readable workspace package.
 */
function rewriteSection(section) {
  return Object.fromEntries(Object.entries(section ?? {}).map(([name, range]) => {
    if (typeof range !== 'string' || !range.startsWith('workspace:')) return [name, range]
    const version = versions.get(name)
    if (version === undefined) throw new Error(`pack-local: no workspace version for ${name}`)
    return [name, `^${version}`]
  }))
}

const stage = join(tmpdir(), 'dsh-client-ui-token-usage-pack')
const out = join(repo, '.dsh-pack')
const staged = join(stage, 'package')
rmSync(stage, { recursive: true, force: true })
mkdirSync(staged, { recursive: true })
mkdirSync(out, { recursive: true })

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const sourceName = manifest.name
const targetName = values.name ?? sourceName
const targetVersion = values.version ?? manifest.version
delete manifest.devDependencies
delete manifest.scripts
manifest.name = targetName
manifest.version = targetVersion
manifest.dependencies = rewriteSection(manifest.dependencies)
manifest.peerDependencies = rewriteSection(manifest.peerDependencies)

for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml']) {
  cpSync(join(pkgDir, entry), join(staged, entry), { recursive: true })
}
if (existsSync(join(repo, 'LICENSE'))) cpSync(join(repo, 'LICENSE'), join(staged, 'LICENSE'))
writeFileSync(join(staged, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

if (targetName !== sourceName) {
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/client.js.map', 'cordis.patch.yml']) {
    const path = join(staged, file)
    if (!existsSync(path)) continue
    writeFileSync(path, readFileSync(path, 'utf8').split(sourceName).join(targetName))
  }
}

execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['pack', '--pack-destination', out], {
  cwd: staged,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
console.log(`pack-local: ${targetName}@${targetVersion} tarball written under ${out}`)
