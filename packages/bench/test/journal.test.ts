import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { contractJournal } from '../src/journal.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ROOM_TYPES = resolve(here, '../../../../web3-protocol/contracts/src/RoomTypes.sol')

/// The Solidity struct the submitted tuple is encoded against, read from the
/// tracked source rather than restated here. A field added, removed or renamed
/// on the contract side fails this test instead of reverting on seal
/// verification a full GPU run into an acceptance run.
function batchJournalFields(): Array<{ type: string; name: string }> {
  const source = readFileSync(ROOM_TYPES, 'utf8')
  const start = source.indexOf('struct BatchJournal {')
  assert.notEqual(start, -1, 'RoomTypes.sol no longer declares struct BatchJournal')
  const end = source.indexOf('\n    }', start)
  assert.notEqual(end, -1, 'the BatchJournal declaration is not terminated')
  const fields: Array<{ type: string; name: string }> = []
  for (const line of source.slice(start, end).split('\n').slice(1)) {
    const declaration = /^\s*([A-Za-z_][\w.]*)\s+([A-Za-z_]\w*);\s*$/u.exec(line)
    if (declaration) fields.push({ type: declaration[1]!, name: declaration[2]! })
  }
  assert.ok(fields.length > 40, 'the BatchJournal parse found implausibly few fields')
  return fields
}

const snakeCase = (name: string) => name.replace(/([A-Z])/gu, '_$1').toLowerCase()

function rawJournal(fields: Array<{ type: string; name: string }>): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field, index) => [
      snakeCase(field.name),
      field.type === 'bytes32'
        ? `0x${String(index).padStart(2, '0').repeat(32)}`.slice(0, 66)
        : field.type === 'bool'
          ? true
          : index + 1,
    ]),
  )
}

test('the journal mapping covers exactly the Solidity BatchJournal, in order', () => {
  const fields = batchJournalFields()
  const mapped = contractJournal(rawJournal(fields))
  assert.deepEqual(
    Object.keys(mapped),
    fields.map((field) => field.name),
  )
})

test('every journal field keeps the width the submitted tuple expects', () => {
  const fields = batchJournalFields()
  const mapped = contractJournal(rawJournal(fields)) as Record<string, unknown>
  for (const field of fields) {
    const observed = mapped[field.name]
    if (field.type === 'bytes32') {
      assert.equal(typeof observed, 'string', `${field.name} must stay a hex word`)
    } else if (field.type === 'bool') {
      assert.equal(typeof observed, 'boolean', `${field.name} must stay a boolean`)
    } else if (field.type.startsWith('uint')) {
      assert.equal(typeof observed, 'bigint', `${field.name} must widen to a bigint`)
    } else {
      // The one enum in the struct is encoded as a uint8 index, not a bigint.
      assert.equal(typeof observed, 'number', `${field.name} must stay an enum index`)
    }
  }
})

test('a journal missing any field is refused instead of encoding a zero word', () => {
  const fields = batchJournalFields()
  for (const field of ['post_state_root', 'batch_index', 'close']) {
    const raw = rawJournal(fields)
    delete raw[field]
    assert.throws(() => contractJournal(raw), new RegExp(`room journal is missing ${field}`, 'u'))
  }
  const nulled = rawJournal(fields)
  nulled.import_root = null
  assert.throws(() => contractJournal(nulled), /room journal is missing import_root/u)
})
