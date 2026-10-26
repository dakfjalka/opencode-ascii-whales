/**
 * Terminal engine, adapted from dsh-ascii-whales vendor/ascii-sharks/engine.ts
 * (upstream: stackedlol/ascii-sharks).
 *
 * The fixed-timestep loop is carried over verbatim: accumulate real time
 * scaled by the speed multiplier, step the world at a fixed 1/60s with the
 * tail beat calibrated back to wall time (STEP * 0.65 / speed), cap catch-up
 * steps, and render with the scaled dt. Only the driver differs: a terminal
 * timer calls tick() instead of requestAnimationFrame, and the DOM observers
 * (visibility, reduced motion, pointer input) have no terminal equivalent.
 */
import { AsciiRenderer, type FrameRows } from "./renderer.ts"
import { World, type SharkSpec } from "./world.ts"

const STEP = 1 / 60
const MAX_STEPS = 4

export interface OceanAppearance {
  readonly dark: boolean
  readonly speed: number
  readonly wake: number
  readonly color: string
  readonly colorfulShimmer: boolean
  readonly eyeColor: "primary" | "black" | "white"
  readonly bodySwing: number
  readonly turnAgility: number
  readonly tailFrequency: number
  readonly opacity: number
  readonly bg: string
}

export class OceanEngine {
  private world: World
  private renderer: AsciiRenderer
  private acc = 0
  private last: FrameRows = []
  private appearance: OceanAppearance
  private fishCount?: number

  constructor(
    sharks: SharkSpec[],
    appearance: OceanAppearance,
    fishCount?: number,
    gridScale = 1,
  ) {
    this.appearance = appearance
    this.fishCount = fishCount
    this.world = new World(sharks, fishCount)
    this.renderer = new AsciiRenderer(appearance.dark, gridScale, appearance.wake)
    this.applyAppearance()
  }

  private applyAppearance() {
    const a = this.appearance
    this.world.turnAgility = a.turnAgility
    this.world.tailFrequency = a.tailFrequency
    this.renderer.bodySwing = a.bodySwing
    this.renderer.setTheme(a.dark, a.wake, a.color, a.colorfulShimmer, a.eyeColor, a.bg, a.opacity)
  }

  setAppearance(appearance: OceanAppearance) {
    this.appearance = appearance
    this.applyAppearance()
  }

  /** "glyphs" on home, "blocks" (pure color tiles, no characters) on session pages. */
  setMode(mode: "glyphs" | "blocks") {
    this.renderer.setMode(mode)
  }

  /** Frosted-glass regions in screen cells (composer box, logo). */
  setGlass(regions: { x: number; y: number; w: number; h: number }[]) {
    this.renderer.setGlass(regions)
  }

  resize(cols: number, rows: number) {
    this.renderer.resize(cols, rows)
    this.world.resize(this.renderer.width, this.renderer.height, this.renderer.cellWidth, this.renderer.cellHeight)
  }

  /** Warm the ecosystem so the first visible frame is mid-swim, as drawStill does. */
  settle() {
    for (let i = 0; i < 240; i++) this.world.step(STEP, (STEP * 0.65) / this.appearance.speed)
  }

  /** One animation tick; dtMs is real elapsed time in milliseconds. */
  tick(dtMs: number): FrameRows {
    const dt = Math.min(0.1, dtMs / 1000)
    const speed = this.appearance.speed
    this.acc += dt * speed
    let steps = 0
    const maxSteps = Math.ceil(MAX_STEPS * Math.max(1, speed))
    while (this.acc >= STEP && steps < maxSteps) {
      // Keep tail rhythm in wall time, calibrated to the original 0.65x cruise.
      this.world.step(STEP, (STEP * 0.65) / speed)
      this.acc -= STEP
      steps++
    }
    if (steps === maxSteps) this.acc = 0
    this.last = this.renderer.render(this.world, dt * speed)
    return this.last
  }

  frame(): FrameRows {
    return this.last
  }
}
