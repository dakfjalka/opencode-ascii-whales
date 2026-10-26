/**
 * Terminal cell renderer, adapted from dsh-ascii-whales
 * vendor/ascii-sharks/renderer.ts (upstream: stackedlol/ascii-sharks).
 *
 * The rasterization math — supersampled silhouette sampling (sampleShark),
 * the travelling body wave and fin banking (rasterizeSharks), wake diffusion,
 * fish bucketing, glyph palettes and per-cell lighting — is carried over
 * verbatim. Only the drawing backend changes: instead of canvas fillRect
 * (colored block) + fillText (glyph), each cell is written as a terminal
 * cell with a background color and a foreground glyph, which is the same
 * visual model. Alpha colors are blended toward the terminal background.
 *
 * Cell aspect: cells match the upstream 8×12 grid (cw = 8 * scale). Everything
 * else runs in the original pixel space.
 */
import { clamp, hash3, smoothstep } from "./math.ts"
import { SHARK_NODES, type Shark, type SharkKind, type World } from "./world.ts"

import { humpback, orca, orcaPatch, orcaFlipper, humpbackFlipper, whaleFlukes } from "./whales.ts"

const ALPHA_LEVELS = 6
const FISH_ALPHAS = [0.28, 0.42, 0.58, 0.74, 0.9]

// Dot colour classes: blue, green, red, pale; the last entry is the cyan wake.
const DOT_RGB: [number, number, number][] = [
  [77, 107, 254],
  [65, 91, 218],
  [110, 148, 255],
  [160, 186, 255],
  [88, 141, 255],
]
const DOT_BASE_ALPHA = [1, 1, 1, 1, 1]
const WAKE = DOT_RGB.length - 1
const COLORFUL_ACCENTS = ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"]

// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const GLYPHS = {
  ascii: { skin: ":;t%SX8#@", fin: "%;tS:", ridge: "@8%", edgeHeavy: ":;", edgeLight: ".',`", mark: "#%@", eye: "o", fish: "-" },
  hanzi: { skin: "水川汐沙浪海潮鲸深", fin: "鳍", ridge: "鳍", edgeHeavy: "丿丨", edgeLight: "丶一", mark: "鲸海潮", eye: "目", fish: "鱼鲤鲭鲱" },
}

const FLAG_BODY = 1
const FLAG_EDGE = 2
const FLAG_FIN = 3
const FLAG_RIDGE = 4
const FLAG_EYE = 5
/** Dark skin markings: tiger bars, zebra-shark spots. */
const FLAG_MARK = 6
const FLAG_WHITE = 7

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72]

/** Classic top-down half-width at s ∈ [0, 1] (snout → tail), as a fraction of length. */
function classicHalfWidth(s: number) {
  if (s < 0.13) return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95)
  if (s < 0.3) return 0.09 + 0.016 * smoothstep(0.13, 0.3, s)
  if (s < 0.84) return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25)
  const k = (s - 0.84) / 0.16
  return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI)
}

/** Body outline and fin layout per species. All values are fractions of length. */
interface SharkShape {
  halfWidth: (s: number) => number
  /** Pectoral fin: leading root, trailing root, tip position along the body, and reach. */
  pectoral: [number, number, number, number]
  /** Notched (falcate) trailing edge on the pectorals. */
  falcate: boolean
  /** Pelvic fins: leading root, trailing root, tip, reach. */
  pelvic: [number, number, number, number]
  /** Forked caudal fin reach, or 0 when the tail is a ribbon (zebra shark). */
  caudal: number
  dorsal: [number, number]
  secondDorsal: [number, number]
  /**
   * Hammerheads' cephalofoil: half-span, how far its tips sweep back, its depth, and the
   * notch in the middle of the front edge. All fractions of length; absent for other sharks.
   */
  head?: { span: number; sweep: number; depth: number; notch: number }
  /** null when the eyes sit somewhere else (hammerhead: on the cephalofoil tips). */
  eye: [number, number] | null
  gills: [number, number]
  /** Skin colour multipliers (r, g, b). */
  tint: [number, number, number]
}

const SHAPES: Record<SharkKind, SharkShape> = {
  // DSH adaptation: rounded whale head, broad back, long flippers and paired tail flukes.
  whale: humpback,
  orca,
  classic: {
    halfWidth: classicHalfWidth,
    pectoral: [0.15, 0.43, 0.55, 0.26],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.085,
    dorsal: [0.33, 0.47],
    secondDorsal: [0.71, 0.76],
    eye: [0.1, 0.14],
    gills: [0.19, 0.29],
    tint: [0.92, 0.97, 1.05],
  },
  hammerhead: {
    halfWidth: (s) => {
      if (s < 0.06) return 0.045
      if (s < 0.3) return 0.045 + 0.061 * smoothstep(0.06, 0.3, s)
      return classicHalfWidth(s) * 0.92
    },
    head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
    pectoral: [0.17, 0.4, 0.5, 0.22],
    falcate: true,
    pelvic: [0.56, 0.63, 0.67, 0.075],
    caudal: 0.11,
    dorsal: [0.28, 0.44],
    secondDorsal: [0.7, 0.74],
    eye: null,
    gills: [0.16, 0.26],
    tint: [0.96, 0.98, 0.9],
  },
  tiger: {
    halfWidth: (s) => {
      if (s < 0.13) return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45)
      if (s < 0.3) return 0.1 + 0.014 * smoothstep(0.13, 0.3, s)
      if (s < 0.84) return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2)
      const k = (s - 0.84) / 0.16
      return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI)
    },
    pectoral: [0.15, 0.42, 0.53, 0.25],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.095,
    dorsal: [0.33, 0.46],
    secondDorsal: [0.71, 0.75],
    eye: [0.08, 0.12],
    gills: [0.19, 0.28],
    tint: [1.02, 0.95, 0.84],
  },
  zebra: {
    halfWidth: (s) => {
      if (s < 0.1) return 0.075 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.7)
      if (s < 0.28) return 0.075 + 0.025 * smoothstep(0.1, 0.28, s)
      if (s < 0.55) return 0.022 + 0.078 * Math.pow(1 - (s - 0.28) / 0.27, 1.1)
      const k = (s - 0.55) / 0.45
      return 0.022 * (1 - k * k) + 0.012 * Math.sin(k * Math.PI)
    },
    pectoral: [0.12, 0.3, 0.36, 0.19],
    falcate: false,
    pelvic: [0.42, 0.48, 0.51, 0.065],
    caudal: 0,
    dorsal: [0.36, 0.44],
    secondDorsal: [0.49, 0.53],
    eye: [0.06, 0.09],
    gills: [0.13, 0.2],
    tint: [1.08, 0.97, 0.74],
  },
  greathammer: {
    halfWidth: (s) => {
      if (s < 0.05) return 0.04
      if (s < 0.3) return 0.04 + 0.07 * smoothstep(0.05, 0.3, s)
      return classicHalfWidth(s) * 0.95
    },
    head: { span: 0.21, sweep: 0.006, depth: 0.085, notch: 0.014 },
    pectoral: [0.16, 0.38, 0.49, 0.24],
    falcate: true,
    pelvic: [0.55, 0.62, 0.67, 0.085],
    caudal: 0.13,
    dorsal: [0.24, 0.45],
    secondDorsal: [0.68, 0.74],
    eye: null,
    gills: [0.15, 0.25],
    tint: [0.86, 0.93, 1.02],
  },
  mako: {
    halfWidth: (s) => {
      if (s < 0.17) return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5)
      if (s < 0.32) return 0.088 + 0.012 * smoothstep(0.17, 0.32, s)
      if (s < 0.86) return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45)
      const k = (s - 0.86) / 0.14
      return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI)
    },
    pectoral: [0.18, 0.4, 0.5, 0.21],
    falcate: true,
    pelvic: [0.58, 0.64, 0.68, 0.06],
    caudal: 0.13,
    dorsal: [0.34, 0.45],
    secondDorsal: [0.76, 0.79],
    eye: [0.11, 0.15],
    gills: [0.2, 0.3],
    tint: [0.78, 0.9, 1.2],
  },
  thresher: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.07 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.75)
      if (s < 0.2) return 0.07 + 0.02 * smoothstep(0.08, 0.2, s)
      if (s < 0.48) return 0.012 + 0.078 * Math.pow(1 - (s - 0.2) / 0.28, 1.3)
      // The whip: thin, with a slight sickle swell before it tapers out.
      const k = (s - 0.48) / 0.52
      return 0.012 * (1 - k) + 0.006 * Math.sin(k * Math.PI * 0.9) + 0.002
    },
    pectoral: [0.12, 0.27, 0.36, 0.2],
    falcate: true,
    pelvic: [0.37, 0.41, 0.44, 0.045],
    caudal: 0,
    dorsal: [0.24, 0.32],
    secondDorsal: [0.45, 0.47],
    eye: [0.05, 0.1],
    gills: [0.11, 0.18],
    tint: [1.0, 0.9, 1.08],
  },
  nurse: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.085 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.4)
      if (s < 0.3) return 0.085 + 0.02 * smoothstep(0.08, 0.3, s)
      if (s < 0.72) return 0.022 + 0.083 * Math.pow(1 - (s - 0.3) / 0.42, 1.1)
      const k = (s - 0.72) / 0.28
      return 0.022 * (1 - k * k) + 0.014 * Math.sin(k * Math.PI)
    },
    pectoral: [0.16, 0.34, 0.4, 0.17],
    falcate: false,
    pelvic: [0.45, 0.52, 0.55, 0.075],
    caudal: 0,
    dorsal: [0.5, 0.58],
    secondDorsal: [0.63, 0.69],
    eye: [0.05, 0.075],
    gills: [0.14, 0.22],
    tint: [1.1, 0.96, 0.76],
  },
}

const KINDS = Object.keys(SHAPES) as SharkKind[]

function inTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

// ---------------------------------------------------------------- terminal colors

const hex = (r: number, g: number, b: number) =>
  "#" + ((clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255))
    .toString(16)
    .padStart(6, "0")

export interface FrameRun {
  readonly text: string
  readonly fg: string
  readonly bg?: string
}
export type FrameRows = readonly FrameRun[][]

/**
 * Draws the World as a grid of terminal cells. One terminal cell = one canvas
 * cell of the original: whale skin keeps its colored background block with a
 * contrast glyph on top; fish, wakes and heat are blended foreground glyphs.
 */
export class AsciiRenderer {
  bodySwing = 1
  private width = 0
  private height = 0
  private cw = 8
  private ch = 16
  private cols = 0
  private rows = 0
  private rgb = [77, 107, 254]
  private bgRgb: [number, number, number] = [10, 10, 10]
  private opacity = 1
  private eyeColor = ""
  private accents: string[] = []

  private dotKind = new Uint8Array(0) // 0 none, 1 blue, 2 green, 3 red, 4 pale
  private dotPhase = new Float32Array(0)
  private dotFreq = new Float32Array(0)
  private energy = new Float32Array(0)
  private energyTmp = new Float32Array(0)
  private heat = new Float32Array(0)
  private bucketOf = new Uint8Array(0)
  private bucketOrder = new Int32Array(0)
  private bucketCounts = new Int32Array(DOT_RGB.length * ALPHA_LEVELS + 1)

  private sharkFlag = new Uint8Array(0)
  private sharkShade = new Float32Array(0)
  private sharkKey = new Uint32Array(0)
  private sharkDepth = new Float32Array(0)
  private sharkKind = new Uint8Array(0)
  private sharkGlyph = new Uint16Array(0)
  /** Cells darkened by a shark's shadow on the seabed. */
  private sharkShadow = new Uint8Array(0)
  private spine = new Float32Array(SHARK_NODES * 2)
  private arc = new Float32Array(SHARK_NODES)
  private arcTotal = 1
  private shape = SHAPES.classic
  private sharkId = 0
  private finTipLeft = 0
  private finTipRight = 0
  // Scratch outputs of sampleShark(), to avoid allocating per sample.
  private hitFlag = 0
  private hitShade = 0
  private hitS = 0
  private hitV = 0
  private hitDist = 0

  /** Cells holding a fish this frame (frame stamp); dots skip them. */
  private fishStamp = new Uint32Array(0)
  private frameId = 0
  /** Fish cells bucketed by brightness. */
  private fishBuckets: number[][] = FISH_ALPHAS.map(() => [])
  private fishStyles = FISH_ALPHAS.map(() => "#000000")

  // Terminal cell output buffers.
  private outCh: string[] = []
  private outFg: string[] = []
  private outBg: (string | undefined)[] = []
  private bodyLUT: string[] = []
  private wakeStyles: string[] = []
  private screenCols = 0
  private colOffset = 0
  /** "glyphs" (home) draws the character mosaic; "blocks" (session pages) draws pure color tiles. */
  private mode: "glyphs" | "blocks" = "glyphs"
  /** Frosted-glass regions (screen cells): painted as a blurred, lightened backing. */
  private glass: { x: number; y: number; w: number; h: number }[] = []
  private frostStyles = { tile: "#141c2e", glow: "#96a8cc" }

  private dark = false
  private gridScale = 1
  private wake = 1
  private glyphMode: "ascii" | "hanzi" = "ascii"
  /**
   * Terminal fonts have far thinner strokes than the canvas's 600-weight
   * glyphs, so an undimmed body block turns each cell into a solid slab.
   * The block is pulled toward the terminal background so the glyph carries
   * the cell and the block reads as a subtle tile tint, matching the
   * original's character-driven texture.
   */
  private blockDim = 0.35

  constructor(dark = false, gridScale = 1, wake = 1, glyphMode: "ascii" | "hanzi" = "ascii") {
    this.dark = dark
    this.gridScale = gridScale
    this.wake = wake
    this.glyphMode = glyphMode
  }

  get cellWidth() {
    return this.cw
  }

  get cellHeight() {
    return this.ch
  }

  setMode(mode: "glyphs" | "blocks") {
    this.mode = mode
  }

  setGlass(regions: { x: number; y: number; w: number; h: number }[]) {
    this.glass = regions
  }

  setTheme(
    dark: boolean,
    wake = this.wake,
    color?: string,
    colorfulShimmer = false,
    eyeColor: "primary" | "black" | "white" = "primary",
    bg = "#0a0a0a",
    opacity = 1,
  ) {
    this.dark = dark
    this.wake = wake
    this.opacity = clamp(opacity, 0, 1)
    if (color) this.rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    this.bgRgb = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)) as [number, number, number]
    this.eyeColor = eyeColor === "primary" ? "" : eyeColor === "black" ? "#000000" : "#ffffff"
    const fish = this.rgb.map((c) => Math.round(dark ? c * 0.6 + 102 : c * 0.7))
    // Alpha colors blend toward the terminal background instead of compositing.
    const blend = (c: number[], alpha: number) =>
      hex(
        c[0]! * alpha + this.bgRgb[0]! * (1 - alpha),
        c[1]! * alpha + this.bgRgb[1]! * (1 - alpha),
        c[2]! * alpha + this.bgRgb[2]! * (1 - alpha),
      )
    this.fishStyles = FISH_ALPHAS.map((a) => blend(fish, a * this.opacity))
    this.accents = colorfulShimmer
      ? COLORFUL_ACCENTS
      : [0, 0.2, 0.6, -0.1, 0.35, -0.2, 0.5].map((lift) =>
          hex(...this.rgb.map((c) => (lift >= 0 ? c + (255 - c) * lift : c * (1 + lift)) as number),
        ))
    this.wakeStyles = []
    for (let l = 0; l < ALPHA_LEVELS; l++) this.wakeStyles.push(blend(fish, ((l + 1) / ALPHA_LEVELS) * this.opacity))
    // bodyColor over all levels used by drawSharks (0..255), folded with opacity.
    this.bodyLUT = []
    for (let level = 0; level <= 255; level++) this.bodyLUT.push(this.bodyColor(level))
  }

  /** Preserve upstream contrast from black to white, with the selected color at level 120. */
  private bodyColor(level: number) {
    const light = clamp((level - 120) / (level < 120 ? 120 : 135), -1, 1)
    const mixed = this.rgb.map((c) => (light < 0 ? c * (1 + light) : c + (255 - c) * light)) as number[]
    for (let i = 0; i < 3; i++) {
      const v = mixed[i]! * this.opacity + this.bgRgb[i]! * (1 - this.opacity)
      mixed[i] = v * (1 - this.blockDim) + this.bgRgb[i]! * this.blockDim
    }
    return hex(mixed[0]!, mixed[1]!, mixed[2]!)
  }

  resize(screenCols: number, rows: number) {
    // Cell size matches the upstream cellSize (cw = 8*scale, ch = cw*1.45).
    // Terminal cells are 1:2 so whales render slightly chunkier than on the
    // original canvas — the upstream 8×12 grid keeps their bodies dense.
    this.cw = Math.max(1, Math.round(8 * this.gridScale))
    this.ch = Math.round(this.cw * 1.45)
    // The patrol orbit stretches with W/minSide, so on very wide terminals
    // whales would hug the left/right edges. Frame the world at the original
    // hero's aspect ratio (~740×516) and center it; the sides stay dark.
    const ASPECT = 1.45
    this.screenCols = Math.max(1, Math.floor(screenCols))
    const worldCols = Math.max(1, Math.min(this.screenCols, Math.round(rows * 2 * ASPECT)))
    this.colOffset = (this.screenCols - worldCols) >> 1
    this.cols = worldCols
    this.rows = Math.max(1, Math.floor(rows))
    this.width = this.cols * this.cw
    this.height = this.rows * this.ch

    const n = this.cols * this.rows
    this.dotKind = new Uint8Array(n)
    this.dotPhase = new Float32Array(n)
    this.dotFreq = new Float32Array(n)
    this.energy = new Float32Array(n)
    this.energyTmp = new Float32Array(n)
    this.heat = new Float32Array(n)
    this.bucketOf = new Uint8Array(n)
    this.bucketOrder = new Int32Array(n)
    this.sharkFlag = new Uint8Array(n)
    this.sharkShade = new Float32Array(n)
    this.sharkKey = new Uint32Array(n)
    this.sharkDepth = new Float32Array(n)
    this.sharkKind = new Uint8Array(n)
    this.sharkGlyph = new Uint16Array(n)
    this.sharkShadow = new Uint8Array(n)
    this.fishStamp = new Uint32Array(n)
    this.outCh = new Array(n)
    this.outFg = new Array(n)
    this.outBg = new Array(n)

    for (let i = 0; i < n; i++) {
      const col = i % this.cols
      const row = (i / this.cols) | 0
      // No ambient dots: the grid stays dark. Only the cyan wake lights cells.
      this.dotKind[i] = 0
      this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2
      this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1
    }
  }

  render(world: World, dt: number): FrameRows {
    if (this.cols === 0) return []
    const t = world.time

    this.consumeEvents(world)
    this.rasterizeSharks(world.sharks, t)
    this.depositWake(world)
    this.diffuse(dt)

    this.markFish(world)
    return this.paint(t)
  }

  // ── simulation → field ──────────────────────────────────────────────

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw)
    const r = Math.floor(y / this.ch)
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1
    return r * this.cols + c
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw)
    const r0 = Math.floor(y / this.ch)
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue
        const d = Math.hypot(c - c0, (r - r0) * 1.4)
        if (d > radius + 0.5) continue
        const i = r * this.cols + c
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)))
      }
    }
  }

  private consumeEvents(world: World) {
    for (const e of world.events) {
      if (e.kind === "eat") {
        this.stamp(this.heat, e.x, e.y, 2, 1)
        this.stamp(this.energy, e.x, e.y, 3, 0.9)
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4)
      }
    }
    world.events.length = 0
  }

  private depositWake(world: World) {
    const { energy } = this
    for (const f of world.fish) {
      if (!f.alive) continue
      const i = this.cellIndex(f.x, f.y)
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03)
    }
    for (const sh of world.sharks) {
      // The tail sweeps the most water.
      for (let k = SHARK_NODES - 6; k < SHARK_NODES; k++) {
        const i = this.cellIndex(sh.nodes[k * 2], sh.nodes[k * 2 + 1])
        if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.05 + sh.speed * 0.0012)
      }
    }
  }

  /** Blur + decay so wakes spread out like ripples and fade. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp, heat } = this
    const decay = Math.exp(-dt * 1.5)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const l = c > 0 ? energy[i - 1] : energy[i]
        const rt = c < cols - 1 ? energy[i + 1] : energy[i]
        const u = r > 0 ? energy[i - cols] : energy[i]
        const d = r < rows - 1 ? energy[i + cols] : energy[i]
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay
      }
    }
    this.energy = tmp
    this.energyTmp = energy
    const heatDecay = Math.exp(-dt * 2.2)
    for (let i = 0; i < heat.length; i++) heat[i] *= heatDecay
  }

  // ── sharks ──────────────────────────────────────────────────────────

  /**
   * Classify one point against the current shark (spine/arc already built).
   * Body coordinates: s along the spine (0 snout → 1 tail), v across it.
   * Writes hit* fields and returns whether the point is on the shark.
   */
  private sampleShark(px: number, py: number, L: number) {
    const { spine, arc } = this
    const N = SHARK_NODES
    let best = Infinity
    let bestS = 0
    let bestSign = 1
    let bestNx = 0
    let bestNy = 0
    for (let k = 0; k < N - 1; k++) {
      const ax = spine[k * 2]
      const ay = spine[k * 2 + 1]
      const sx = spine[(k + 1) * 2] - ax
      const sy = spine[(k + 1) * 2 + 1] - ay
      const len2 = sx * sx + sy * sy || 1
      const u = clamp(((px - ax) * sx + (py - ay) * sy) / len2, 0, 1)
      const qx = ax + sx * u
      const qy = ay + sy * u
      const d2 = (px - qx) ** 2 + (py - qy) ** 2
      if (d2 < best) {
        best = d2
        const len = Math.sqrt(len2)
        bestS = (arc[k] + u * len) / this.arcTotal
        bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1
        bestNx = (-sy / len) * bestSign
        bestNy = (sx / len) * bestSign
      }
    }

    const a = Math.sqrt(best)
    const s = bestS
    const u = s * L
    const shape = this.shape
    const w = shape.halfWidth(s) * L
    this.hitDist = a
    this.hitS = s
    this.hitV = a * bestSign

    const head = this.shape.head
    if (head && u < L * (head.sweep + head.depth + head.notch)) {
      // Cephalofoil: a wide wing across the snout, its tips swept back toward the eyes,
      // and on a great hammerhead a shallow notch in the middle of the front edge.
      const span = L * head.span
      const r = a / span
      const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14)
      // Full depth almost to the tips, so the wing reads as a solid bar rather than a thin line.
      const depth = L * head.depth * (1 - 0.2 * r * r * r * r)
      if (r <= 1 && u >= front && u <= front + depth) {
        this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0)
        return true
      }
    }

    if (a <= w && ((shape !== humpback && shape !== orca) || s <= 0.945)) {
      const across = a / (w || 1)
      // Rounded back lit from the top-left; flanks fall off into shadow.
      const facing = (bestNx * -0.6 + bestNy * -0.8) * across
      let shade = 0.58 - across * across * 0.42 + facing * 0.26
      let flag = FLAG_BODY
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
        // First dorsal fin, catching the light.
        flag = FLAG_RIDGE
        shade = 1
      } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
        shade = Math.max(shade, 0.82)
      } else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
        flag = FLAG_EYE
        shade = 0
      } else if (shape === orca && orcaPatch(s, across)) {
        flag = FLAG_WHITE
      } else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
        // Five gill slits.
        if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45
      } else if (s < 0.05) {
        // Pale snout tip.
        shade = Math.max(shade, 0.7)
      } else if (shape === SHAPES.zebra && s > 0.08 && s < 0.55 && (across < 0.1 || Math.abs(across - 0.6) < 0.08)) {
        // Zebra sharks carry pale ridges down the back.
        shade = Math.max(shade, 0.8)
      } else if (this.marked(s, a * bestSign, L, across)) {
        flag = FLAG_MARK
      }
      this.hitFlag = flag
      this.hitShade = shade
      return true
    }

    const tip = bestSign > 0 ? this.finTipRight : this.finTipLeft
    const [p0, p1, p2] = shape.pectoral
    if (
      (shape === humpback ? humpbackFlipper(s, a, tip) : shape === orca ? orcaFlipper(s, a, tip) : inTriangle(u, a, L * p0, 0, L * p1, 0, L * p2, tip)) &&
      // Falcate (sickle) fins get a concave trailing edge.
      !(shape.falcate && inTriangle(u, a, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
    ) {
      this.hitFlag = this.marked(s, a * bestSign, L, 0) ? FLAG_MARK : FLAG_FIN
      this.hitShade = 0.38 + 0.22 * (1 - clamp(a / tip, 0, 1))
      return true
    }
    const [v0, v1, v2, vr] = shape.pelvic
    if (
      (vr > 0 && inTriangle(u, a, L * v0, 0, L * v1, 0, L * v2, L * vr)) ||
      // Forked caudal fin.
      ((shape === humpback || shape === orca) ? whaleFlukes(s, a / L)
        : shape.caudal > 0 && inTriangle(u, a, L * 0.86, 0, L * 0.95, 0, L, L * shape.caudal))
    ) {
      this.hitFlag = FLAG_FIN
      this.hitShade = 0.36
      return true
    }
    return false
  }

  /** Whether a body point (s along, v across) falls on a dark marking. */
  private marked(s: number, v: number, L: number, across: number) {
    if (this.shape === SHAPES.tiger) {
      // Wavy vertical bars over the back half, fading out toward the head.
      if (s < 0.2 || s > 0.9 || across > 0.85) return false
      const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5)
      const bar = Math.sin(s * Math.PI * 2 * 9 + wobble)
      return bar > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s)
    }
    if (this.shape === SHAPES.zebra) {
      // Leopard spots on a jittered grid, so they ride along with the skin.
      if (s < 0.07) return false
      const gu = (s * L) / (L * 0.06)
      const gv = v / (L * 0.045)
      const cu = Math.floor(gu)
      const cv = Math.floor(gv)
      const jx = hash3(cu, cv, this.sharkId) * 0.5 + 0.25
      const jy = hash3(cu, cv, this.sharkId + 11) * 0.5 + 0.25
      return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.08
    }
    return false
  }

  /**
   * Build a smooth, undulating render spine from the sim spine, then
   * supersample every cell in the shark's bounding box against the shape.
   * Fully covered cells become solid skin; partial cells become edge glyphs.
   */
  private rasterizeSharks(sharks: Shark[], t: number) {
    const { sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkShadow, spine, arc, cw, ch, cols, rows } = this
    sharkFlag.fill(0)
    sharkShadow.fill(0)
    this.sharkGlyph.fill(0)

    for (const sh of sharks) {
      const L = sh.length
      const N = SHARK_NODES
      const n = sh.nodes
      const swim = clamp(sh.speed / 60, 0.4, 1.4)
      this.shape = SHAPES[sh.kind]
      this.sharkId = sh.id
      const kindIndex = KINDS.indexOf(sh.kind)
      const secretCells = this.glyphMode === "hanzi" && (sh.kind === "whale" || sh.kind === "orca") && sh.id === 1 ? [-1, -1, -1, -1] : null
      const secretDistances = [Infinity, Infinity, Infinity, Infinity]

      // Travelling body wave, growing toward the tail.
      for (let k = 0; k < N; k++) {
        const s = k / (N - 1)
        const a = Math.max(0, k - 1)
        const b = Math.min(N - 1, k + 1)
        let tx = n[a * 2] - n[b * 2]
        let ty = n[a * 2 + 1] - n[b * 2 + 1]
        const tl = Math.hypot(tx, ty) || 1
        tx /= tl
        ty /= tl
        const amp = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim * this.bodySwing
        const off = amp * Math.sin(sh.phase - s * 5.2)
        spine[k * 2] = n[k * 2] - ty * off
        spine[k * 2 + 1] = n[k * 2 + 1] + tx * off
      }
      arc[0] = 0
      for (let k = 1; k < N; k++) {
        arc[k] =
          arc[k - 1] +
          Math.hypot(spine[k * 2] - spine[(k - 1) * 2], spine[k * 2 + 1] - spine[(k - 1) * 2 + 1])
      }
      this.arcTotal = arc[N - 1] || 1

      // Bank into turns: the inside fin foreshortens, the outside one spreads.
      const bank = clamp(sh.turn * 0.45, -0.35, 0.35)
      const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5)
      const reachFin = this.shape.pectoral[3]
      this.finTipRight = L * reachFin * flex * (1 - bank)
      this.finTipLeft = L * reachFin * flex * (1 + bank)

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let k = 0; k < N; k++) {
        minX = Math.min(minX, spine[k * 2])
        maxX = Math.max(maxX, spine[k * 2])
        minY = Math.min(minY, spine[k * 2 + 1])
        maxY = Math.max(maxY, spine[k * 2 + 1])
      }
      const reach = Math.max(L * 0.36, this.finTipLeft, this.finTipRight)
      const c0 = Math.max(0, Math.floor((minX - reach) / cw))
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw))
      const r0 = Math.max(0, Math.floor((minY - reach) / ch))
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch))
      if (c0 > c1 || r0 > r1) continue

      const skipBeyond = reach + Math.hypot(cw, ch)
      const shadowDc = Math.round((L * 0.035) / cw) + 1
      const shadowDr = Math.round((L * 0.02) / ch) + 1

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw
          const y = r * ch
          const centerHit = this.sampleShark(x + cw / 2, y + ch / 2, L)
          if (!centerHit && this.hitDist > skipBeyond) continue
          const flag = this.hitFlag
          const shade = this.hitShade
          const s = this.hitS
          const v = this.hitV

          let hits = centerHit ? 1 : 0
          for (let k = 0; k < SUBSAMPLES.length; k += 2) {
            if (this.sampleShark(x + SUBSAMPLES[k]! * cw, y + SUBSAMPLES[k + 1]! * ch, L)) hits++
          }
          if (hits === 0) continue
          const coverage = hits / 5

          const i = r * cols + c
          // Body-anchored key so each glyph rides along with the skin.
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0
          sharkKey[i] = key
          sharkDepth[i] = sh.depth
          sharkKind[i] = kindIndex

          if (centerHit && coverage >= 0.6) {
            sharkFlag[i] = flag
            if (this.glyphMode === "hanzi" && (sh.kind === "whale" || sh.kind === "orca")) {
              // s and v follow the bent spine, so anatomical labels swim with the body.
              const glyph = flag === FLAG_EYE ? "目"
                : flag === FLAG_FIN ? (s >= 0.84 ? "尾" : "鳍")
                : flag === FLAG_RIDGE ? "鳍"
                : s < 0.1 ? "吻"
                : s < 0.6 && Math.abs(v) < this.shape.halfWidth(s) * L * 0.32 ? "背" : ""
              this.sharkGlyph[i] = glyph ? glyph.charCodeAt(0) : 0
              if (secretCells && !glyph && flag === FLAG_BODY && v > 0 && s >= 0.28 && s < 0.64) {
                const slot = Math.min(3, Math.floor((s - 0.28) / 0.09))
                const distance = ((s - (0.325 + slot * 0.09)) * L) ** 2 + (v - this.shape.halfWidth(s) * L * 0.6) ** 2
                if (distance < secretDistances[slot]!) { secretDistances[slot] = distance; secretCells[slot] = i }
              }
            } else this.sharkGlyph[i] = 0
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06
            sharkShade[i] = clamp(shade + flicker, 0, 1)
            const sc = c + shadowDc
            const sr = r + shadowDr
            if (sc < cols && sr < rows) sharkShadow[sr * cols + sc] = 1
          } else {
            sharkFlag[i] = FLAG_EDGE
            this.sharkGlyph[i] = 0
            sharkShade[i] = coverage
          }
        }
      }
      // A quiet signature on one whale's flank; only show it when all four cells fit.
      if (secretCells?.every((i) => i >= 0)) {
        for (let k = 0; k < 4; k++) this.sharkGlyph[secretCells[k]!] = "深度求索".charCodeAt(k)
      }
    }
  }

  // ── fish ────────────────────────────────────────────────────────────

  /**
   * Snap each fish to a cell and bucket it by brightness: far fish are dim,
   * near fish brighter, and turning or panicking fish glint. Nearer fish
   * claim a cell first when two land in the same one.
   */
  private markFish(world: World) {
    const { fishStamp, fishBuckets, sharkFlag } = this
    const frame = ++this.frameId
    for (const bucket of fishBuckets) bucket.length = 0
    for (let pass = 0; pass < 2; pass++) {
      for (const f of world.fish) {
        if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass) continue
        const i = this.cellIndex(f.x, f.y)
        if (i < 0 || fishStamp[i] === frame || sharkFlag[i]) continue
        fishStamp[i] = frame
        const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1)
        const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm)
        fishBuckets[clamp(Math.floor(v * FISH_ALPHAS.length), 0, FISH_ALPHAS.length - 1)]!.push(i)
      }
    }
  }

  // ── terminal paint ────────────────────────────────────────────────────

  /**
   * One pass over the cell grid, painting in the original's z-order:
   * sharks (background block + contrast glyph) over fish over heat over wake
   * dots. Glyph and color selection mirror drawSharks/drawFish/drawHeat/
   * drawDots cell for cell.
   */
  private paint(t: number): FrameRows {
    const { cols, rows, sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkGlyph, energy, fishStamp, frameId } = this
    const glyphs = GLYPHS[this.glyphMode]
    const blocks = this.mode === "blocks"
    const outCh = this.outCh
    const outFg = this.outFg
    const outBg = this.outBg
    const n = cols * rows
    outCh.fill(undefined)
    outFg.fill(undefined)
    outBg.fill(undefined)

    // Wake dots and heat ripples (the ambient dot field stays dark, as in DSH).
    for (let i = 0; i < n; i++) {
      const e = energy[i] * this.wake
      if (e > 0.45) {
        const level = clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1)
        if (blocks) {
          outCh[i] = " "
          outBg[i] = this.wakeStyles[level]!
        } else {
          outCh[i] = "·"
          outFg[i] = this.wakeStyles[level]!
        }
      }
    }
    if (!blocks) {
      for (let i = 0; i < this.heat.length; i++) {
        const h = this.heat[i]!
        if (h < 0.08) continue
        const a = Math.min(1, h * 1.6) * this.opacity
        outCh[i] = h > 0.6 ? "*" : "·"
        outFg[i] = hex(
          this.rgb[0]! * a + this.bgRgb[0]! * (1 - a),
          this.rgb[1]! * a + this.bgRgb[1]! * (1 - a),
          this.rgb[2]! * a + this.bgRgb[2]! * (1 - a),
        )
      }
    }

    // Fish: one glyph (or tile) per cell, bucketed brightness.
    for (let b = 0; b < this.fishBuckets.length; b++) {
      const bucket = this.fishBuckets[b]!
      const style = this.fishStyles[b]!
      for (const i of bucket) {
        if (blocks) {
          outCh[i] = " "
          outBg[i] = style
        } else {
          outCh[i] = glyphs.fish[i % glyphs.fish.length]!
          outFg[i] = style
        }
      }
    }

    // Sharks on top.
    for (let i = 0; i < n; i++) {
      const flag = sharkFlag[i]
      if (!flag) continue
      const key = sharkKey[i]
      const shade = sharkShade[i]
      const dim = 0.7 + 0.3 * sharkDepth[i]!
      const [tr, tg, tb] = SHAPES[KINDS[sharkKind[i]!]!].tint

      // Colours re-roll on a staggered clock so the hide shimmers.
      const tick = Math.floor(t * 2.4 + (key % 997) / 97)
      const roll = hash3(key, tick, 7)

      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: glyphs in glyph mode, a dim tile in
        // blocks mode so the outline survives without characters.
        const set = shade >= 0.5 ? glyphs.edgeHeavy : glyphs.edgeLight
        const g = (70 + shade * 80) * dim
        outCh[i] = blocks ? " " : set[(key >>> 8) % set.length]!
        if (blocks) outBg[i] = this.bodyLUT[clamp(Math.round(g * 0.55), 0, 255)]!
        else outFg[i] = roll < 0.07 ? this.accents[key % this.accents.length]! : this.bodyLUT[clamp(Math.round(g), 0, 255)]!
        continue
      }

      let level: number
      let glyph: string
      if (flag === FLAG_RIDGE) {
        level = 226
        glyph = glyphs.ridge[(key >>> 8) % glyphs.ridge.length]!
      } else if (flag === FLAG_EYE) {
        level = 46 + shade * 160
        glyph = glyphs.eye
      } else if (flag === FLAG_MARK) {
        level = 24 + shade * 22
        glyph = glyphs.mark[(key >>> 8) % glyphs.mark.length]!
      } else if (flag === FLAG_FIN) {
        level = 40 + shade * 120
        glyph = glyphs.fin[(key >>> 8) % glyphs.fin.length]!
      } else {
        level = 46 + shade * 160
        const jitter = ((key >>> 4) % 3) - 1
        glyph = glyphs.skin[clamp(Math.floor((1 - shade) * (glyphs.skin.length - 0.01)) + jitter, 0, glyphs.skin.length - 1)]!
      }
      level *= dim
      if (sharkGlyph[i]) glyph = String.fromCharCode(sharkGlyph[i]!)
      // Tinted per species; the classic tint is a cool blue-grey, like a back seen through deep water.
      outBg[i] = flag === FLAG_WHITE ? "#f5f5f0" : flag === FLAG_EYE && this.eyeColor ? this.eyeColor : this.bodyLUT[clamp(Math.round(level), 0, 255)]!

      if (blocks) {
        outCh[i] = " "
        continue
      }

      let color: string
      if (flag === FLAG_WHITE) color = "#181818"
      else if (flag === FLAG_EYE && this.eyeColor) color = this.eyeColor === "#000000" ? "#ffffff" : "#181818"
      else if (flag === FLAG_EYE) color = shade > 0.55 ? "#181818" : "#eeeeee"
      else if (flag === FLAG_MARK) color = `#${((clamp(Math.round(70 * tr), 0, 255) << 16) | (clamp(Math.round(70 * tg), 0, 255) << 8) | clamp(Math.round(70 * tb), 0, 255)).toString(16).padStart(6, "0")}`
      else if (roll < 0.09) color = this.accents[key % this.accents.length]!
      else if (roll < 0.13) color = "#ffffff"
      else color = shade > 0.55 ? "#181818" : "#eeeeee"
      outCh[i] = glyph
      outFg[i] = color
    }

    this.paintGlass()

    // Group into runs of consecutive (fg, bg). Rows are padded back out to
    // screen width: colOffset leading cells frame the world on wide terminals.
    // Empty cells stay transparent (a span's bg would tint its spaces), so a
    // backgrounded run closes at the first gap and the gap is emitted as its
    // own plain-space run — every cell lands on its exact column.
    const rowsOut: FrameRun[][] = []
    for (let r = 0; r < rows; r++) {
      const row: FrameRun[] = []
      let text = this.colOffset > 0 ? " ".repeat(this.colOffset) : ""
      let fg = ""
      let bg: string | undefined
      let open = false
      const flush = () => {
        if (text) row.push({ text, fg, bg: bg ? bg : undefined })
        text = ""
      }
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const ch = outCh[i]
        if (ch === undefined) {
          if (open) {
            flush()
            open = false
            fg = ""
            bg = undefined
          }
          text += " "
          continue
        }
        const cfg = outFg[i] ?? "#888888"
        const cbg = outBg[i]
        if (!open || cfg !== fg || (cbg ?? "") !== (bg ?? "")) {
          flush()
          fg = cfg
          bg = cbg
          open = true
        }
        text += ch
      }
      flush()
      // Every row is emitted, empty or not: dropping blank rows would shift
      // all later content up and detach the ocean from its true position.
      rowsOut.push(row)
    }
    return rowsOut
  }

  /**
   * Frosted-glass backing. For each region (the composer box, the logo) the
   * ocean's own content is blurred and lifted toward a pale tone, so anything
   * translucent drawn on top — a glass theme's composer background, or nothing
   * at all for the background-less logo — reads as etched glass.
   */
  private paintGlass() {
    if (this.glass.length === 0) return
    const parse = (s: string): [number, number, number] => [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
    ]
    const mixTo = (c: [number, number, number], t: [number, number, number], k: number) =>
      hex(c[0]! + (t[0]! - c[0]!) * k, c[1]! + (t[1]! - c[1]!) * k, c[2]! + (t[2]! - c[2]!) * k)

    const glow = parse(this.dark ? "#aebfe8" : "#ffffff")
    const base = this.dark ? 0.5 : 0.6

    for (const g of this.glass) {
      const x0 = Math.max(0, g.x)
      const y0 = Math.max(0, g.y)
      const x1 = Math.min(this.cols - 1, g.x + g.w - 1)
      const y1 = Math.min(this.rows - 1, g.y + g.h - 1)
      if (x1 < x0 || y1 < y0) continue

      // Snapshot the region's own content before overwriting it.
      const content: { x: number; y: number; rgb: [number, number, number]; w: number }[] = []
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          const i = r * this.cols + c
          if (this.outBg[i]) content.push({ x: c, y: r, rgb: parse(this.outBg[i]!), w: 1.5 })
          else if (this.outCh[i]) content.push({ x: c, y: r, rgb: parse(this.outFg[i] ?? "#888888"), w: 0.6 })
        }
      }

      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          // Blurred backdrop: distance-weighted average of nearby content.
          let br = this.bgRgb[0]!
          let bg = this.bgRgb[1]!
          let bb = this.bgRgb[2]!
          let wsum = 1
          for (const s of content) {
            const d = Math.hypot((s.x - c) / 2.2, s.y - r)
            if (d > 5) continue
            const w = s.w / (1 + d * d * 0.4)
            br += s.rgb[0]! * w
            bg += s.rgb[1]! * w
            bb += s.rgb[2]! * w
            wsum += w
          }
          const blur: [number, number, number] = [br / wsum, bg / wsum, bb / wsum]
          const edge = c === x0 || c === x1 || r === y0 || r === y1 ? 0.35 : 1
          const k = base * edge
          const i = r * this.cols + c
          this.outCh[i] = " "
          this.outBg[i] = mixTo(mixTo(blur, glow, 0.45), this.bgRgb, 1 - k)
          this.outFg[i] = this.outBg[i]!
        }
      }
    }
  }

}
