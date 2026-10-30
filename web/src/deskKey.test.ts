import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deskKey } from './deskKey.ts'

test('a Codinger on its own has the plain key', () => {
  assert.equal(deskKey('codinger.selected', undefined), 'codinger.selected')
})

test('two desks of one site keep apart', () => {
  assert.notEqual(deskKey('codinger.selected', '/desk/ada'), deskKey('codinger.selected', '/desk/bob'))
})
