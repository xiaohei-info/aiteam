import { Application, Assets, Container, Graphics } from 'pixi.js'
import { Spine } from '@esotericsoftware/spine-pixi-v8'
import { AIFRED_RESOURCE_ID, AIFRED_SKELETON, AIFRED_ATLAS, employeeAnimation } from './aifred-resources.js'

const TILE_WIDTH = 128, TILE_HEIGHT = 192, COLUMNS = 8, LIMIT = 64
// Offscreen atlas is composited into the existing editor canvas, in its actual
// element order. This avoids an always-on-top overlay hiding walls and tools.
export async function createEmployeeRuntime(onFrame) {
  const app = new Application()
  await app.init({ width: TILE_WIDTH * COLUMNS, height: TILE_HEIGHT, backgroundAlpha: 0, antialias: true, autoStart: false, preference: 'webgl', resolution: 1, preserveDrawingBuffer: true })
  const skeleton = 'editor-aifred-skeleton', atlas = 'editor-aifred-atlas'
  Assets.add({ alias: skeleton, src: new URL(AIFRED_SKELETON, document.baseURI).href })
  Assets.add({ alias: atlas, src: new URL(AIFRED_ATLAS, document.baseURI).href })
  await Assets.load([skeleton, atlas])
  const actors = new Map()
  let previous = '', frames = 0, active = false, lastTime = 0, raf = 0, paused = false
  function sync(seats) {
    const visible = seats.filter(s => s.employee?.enabled && s.employee.resourceId === AIFRED_RESOURCE_ID).slice(0, LIMIT)
    const signature = JSON.stringify(visible.map(s => [s.id, s.employee.skin, s.employee.animation, s.facing]))
    if (signature === previous) return
    previous = signature
    for (const actor of actors.values()) actor.container.destroy({ children: true })
    actors.clear()
    app.renderer.resize(TILE_WIDTH * COLUMNS, TILE_HEIGHT * Math.max(1, Math.ceil(visible.length / COLUMNS)))
    for (const [index, seat] of visible.entries()) {
      const container = new Container()
      const x = index % COLUMNS * TILE_WIDTH, y = Math.floor(index / COLUMNS) * TILE_HEIGHT
      container.position.set(x + TILE_WIDTH / 2, y + 160)
      const shadow = new Graphics().ellipse(0, 4, 22, 6).fill({ color: 0, alpha: 0.12 })
      container.addChild(shadow)
      const spine = Spine.from({ skeleton, atlas, scale: 0.32 * (144 * 0.58 * 1.1 / 200), autoUpdate: false })
      spine.skeleton.setSkinByName(seat.employee.skin)
      spine.skeleton.setSlotsToSetupPose()
      spine.state.data.defaultMix = 0.2
      spine.state.setAnimation(0, employeeAnimation(seat.employee, seat.facing), true)
      spine.update(0)
      container.addChild(spine); app.stage.addChild(container)
      actors.set(seat.id, { container, spine, x, y })
    }
    active = actors.size > 0
    app.renderer.render({ container: app.stage })
    if (active && !raf) raf = requestAnimationFrame(tick)
  }
  function tick(time) {
    raf = 0
    if (!active) { lastTime = 0; return }
    const delta = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0
    lastTime = time
    if (!paused && !document.hidden) {
      for (const actor of actors.values()) actor.spine.update(delta)
      app.renderer.render({ container: app.stage }); frames++; onFrame()
    }
    raf = requestAnimationFrame(tick)
  }
  return {
    sync,
    draw(ctx, seat, desk) {
      const actor = actors.get(seat.id)
      if (!actor) return
      const scale = desk.width / 144
      ctx.save(); ctx.globalAlpha = desk.opacity
      ctx.drawImage(app.canvas, actor.x, actor.y, TILE_WIDTH, TILE_HEIGHT, seat.x - TILE_WIDTH / 2 * scale, seat.y - 160 * scale, TILE_WIDTH * scale, TILE_HEIGHT * scale)
      ctx.restore()
    },
    pause(value) { paused = value },
    get stats() { return { count: actors.size, frames, limit: LIMIT, animations: [...actors.values()].map(a => a.spine.state.getCurrent(0)?.animation.name) } },
    destroy() { active = false; cancelAnimationFrame(raf); app.destroy(true, { children: true }) },
  }
}
