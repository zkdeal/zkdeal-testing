#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname)
const entries = []

function portable(path) {
  return path.split(sep).join('/').normalize('NFC')
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left.normalize('NFC')), Buffer.from(right.normalize('NFC')))
}

function walk(path) {
  const stat = lstatSync(path)
  const name = portable(relative(root, path))
  if (stat.isSymbolicLink()) throw new Error(`Kurtosis source symlinks are forbidden: ${name}`)
  if (stat.isFile()) {
    const bytes = readFileSync(path)
    entries.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    return
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported Kurtosis source entry: ${name}`)
  for (const child of readdirSync(path).sort(compare)) walk(join(path, child))
}

for (const source of ['package', 'scripts']) walk(join(root, source))
entries.sort((left, right) => compare(left.path, right.path))
const canonical = entries.map((entry) => `${entry.sha256} ${entry.bytes} ${entry.path}\n`).join('')
const digest = createHash('sha256').update(canonical).digest('hex')
process.stdout.write(`sha256:${digest}\n`)
