/**
 * Real-composition test: the plugin mounts into a real `@deepseek-ai/cordis`
 * `Context`, registers its route, records turns through real event dispatch,
 * and releases the route and listeners when its fiber disposes.
 *
 * The unit suite drives plain-object fakes, which cannot show whether a
 * registration is released; the Web client reloads profile rows on every
 * edit, so a leaked route would make the next mount throw on the duplicate.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'

import { ROUTE, apply, inject, stateDir } from '../index.js'

const HOME = join(import.meta.dirname, '..', '.scratch', 'composition')
process.env.DSH_HOME = HOME

/** The web server seam: one route per path, released with the consumer. */
class WebServerSeam extends Service {
  routes = new Map()

  constructor(ctx) {
    super(ctx, 'webServer')
  }

  register(route) {
    return this.ctx.effect(() => {
      if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      this.routes.set(route.path, route)
      return () => { this.routes.delete(route.path) }
    })
  }
}

/** A seam that only has to exist for the inject list to resolve. */
const presence = (name, body = {}) => class extends Service {
  constructor(ctx) {
    super(ctx, name)
    Object.assign(this, body)
  }
}

function compose() {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const ctx = new Context()
  const web = new WebServerSeam(ctx)
  new (presence('sessionController'))(ctx)
  new (presence('goals'))(ctx)
  new (presence('sessions', { get: () => undefined }))(ctx)
  new (presence('sessionPersistence'))(ctx)
  return { ctx, web }
}

test('the plugin mounts into a real Cordis context and releases its route', async () => {
  const { ctx, web } = compose()
  const fiber = await ctx.plugin({ name: 'resume-all', inject, apply }, {})
  assert.deepEqual([...web.routes.keys()], [ROUTE])

  await fiber.dispose()
  assert.deepEqual([...web.routes.keys()], [], 'the route is released with the fiber')

  const again = await ctx.plugin({ name: 'resume-all', inject, apply }, {})
  assert.deepEqual([...web.routes.keys()], [ROUTE], 'a remount registers cleanly')
  await again.dispose()
})

test('turn events reach the plugin through real dispatch, and stop after dispose', async () => {
  const { ctx } = compose()
  const fiber = await ctx.plugin({ name: 'resume-all', inject, apply }, {})
  const live = () => JSON.parse(readFileSync(join(stateDir(), `live-${process.pid}.json`), 'utf8')).live

  ctx.emit('session/event', { id: 's1', header: { cwd: '/w' } }, { type: 'turn/start', data: {} })
  assert.equal(live().s1.turn, true)

  await fiber.dispose()
  ctx.emit('session/event', { id: 's2', header: { cwd: '/w' } }, { type: 'turn/start', data: {} })
  assert.equal(live().s2, undefined, 'a disposed plugin records nothing')
})
