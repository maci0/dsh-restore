/**
 * Browser half: the stylesheet lifecycle. `apply` installs one tagged
 * `<style>` through `ctx.effect`, and running that effect's disposer, as a
 * plugin dispose does, removes it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let registration
globalThis.window = { __ModuleLoader__: { load: (spec) => { registration = spec } } }
try {
  // The test files share one module cache; the query gives this file its own evaluation.
  await import('../lib/client.js?style')
} finally {
  delete globalThis.window
}

/** A `document` with just the head a stylesheet is appended to. */
function createDocument() {
  const head = { children: [], append: (node) => { head.children.push(node) } }
  return {
    head,
    createElement: (tagName) => {
      const attributes = new Map()
      const node = {
        tagName: tagName.toUpperCase(),
        textContent: '',
        setAttribute: (name, value) => { attributes.set(name, String(value)) },
        getAttribute: (name) => attributes.get(name) ?? null,
        remove: () => { head.children = head.children.filter((child) => child !== node) },
      }
      return node
    },
  }
}

test('apply installs one tagged stylesheet and dispose removes it', () => {
  const exports = registration.factory(() => ({ createElement: () => null }))
  const disposers = []
  const document = createDocument()
  const styles = () => document.head.children.filter((node) =>
    node.tagName === 'STYLE' && node.getAttribute('data-plugin') === '@maci0/dsh-restore')
  globalThis.document = document
  try {
    exports.apply({
      effect: (callback) => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      slots: { inject: () => {} },
    })
  } finally {
    delete globalThis.document
  }

  assert.equal(styles().length, 1)
  assert.match(styles()[0].textContent, /\.restore-bar/u)
  for (const dispose of disposers.splice(0).reverse()) dispose()
  assert.equal(styles().length, 0)
})
