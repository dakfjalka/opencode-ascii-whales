/**
 * ASCII 锦鲤 · ported from the koi pond animation at daoho.dev (Dao Ho's
 * homepage), adapted to the terminal the same way whales.ts adapts the
 * original sharks: canvas pixels become a fixed cell grid, canvas alpha
 * becomes color mixed toward the background, DOM avoid-boxes become the
 * composer/logo regions the host reports through setGlass().
 *
 * Everything else is a direct port: 20-node spines with a traveling tail
 * wave, weighted koi varieties (kohaku / sanke / tancho) with ellipse
 * markings, per-cell supersampling and lighting, feeding (pellets, rushing,
 * gulps, bites), expanding ripples, diffusing wake, and soft shadows.
 *
 * The pond lives in "pixel" space (CW x CH per cell) so the source's
 * absolute distances (rush radius 650, curiosity 300, speeds in px/s)
 * carry over unchanged.
 */

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

function smooth(e: number, t: number, x: number) {
  const k = clamp((x - e) / (t - e), 0, 1)
  return k * k * (3 - 2 * k)
}

function angleDiff(from: number, to: number) {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

/** Deterministic 0..1 hash (the site's L). */
function hash(a: number, b: number, c: number) {
  let r = Math.imul(0 | a, 374761393) ^ Math.imul(0 | b, 668265263) ^ Math.imul(0 | c, 1442695041)
  r = Math.imul(r ^ r >>> 13, 1274126177)
  return ((r ^= r >>> 16) >>> 0) / 4294967296
}

/** Bilinear value noise (the site's W). */
function vnoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = smooth(0, 1, x - xi), fy = smooth(0, 1, y - yi)
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed)
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

type RGB = [number, number, number]
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0]
const shade = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0, Math.min(255, c[2] * k) | 0]
const pack = (c: RGB) => c[0] << 16 | c[1] << 8 | c[2]
const pick = (ramp: RGB[], k: number): RGB => {
  const i = clamp(k, 0, 1) * (ramp.length - 1), j = Math.min(ramp.length - 2, Math.floor(i))
  return mix(ramp[j]!, ramp[j + 1]!, i - j)
}

interface Palette {
  bg: RGB; white: RGB; red: RGB; black: RGB; fin: RGB; eye: RGB; water: RGB
  shadow: RGB; shadowAlpha: number; pellet: RGB; alpha: number; depthFloor: number
  tile: [number, number]; hi: RGB[]; ink: number
}

/** Dark palette (the site's D) — bg is overridden by the terminal theme. */
const DARK: Palette = {
  bg: [26, 25, 33], white: [236, 228, 218], red: [232, 96, 56], black: [92, 90, 108],
  fin: [214, 206, 198], eye: [20, 20, 26], water: [255, 247, 240],
  shadow: [0, 0, 0], shadowAlpha: 0.55, pellet: [236, 170, 92],
  alpha: 0.8, depthFloor: 0.4, tile: [0.68, 0.98],
  hi: [[112, 22, 24], [168, 34, 28], [214, 58, 30], [240, 96, 34], [250, 138, 52], [255, 178, 96]],
  ink: 0.42,
}
/** Light palette (the site's _). */
const LIGHT: Palette = {
  bg: [245, 244, 241], white: [112, 108, 104], red: [204, 62, 28], black: [36, 33, 40],
  fin: [138, 132, 126], eye: [24, 22, 26], water: [38, 37, 35],
  shadow: [60, 58, 56], shadowAlpha: 0.2, pellet: [176, 108, 40],
  alpha: 0.9, depthFloor: 0.55, tile: [0.78, 0.55],
  hi: [[138, 24, 22], [184, 38, 24], [222, 62, 28], [238, 100, 38], [244, 140, 66], [248, 176, 116]],
  ink: 0.45,
}

const GLYPHS = "t%SX8@"
const SUB = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75]
// Physics at 30 Hz — the pond renders at ~15 fps, so this is indistinguishable
// from the site's 60 Hz loop at half the cost.
const STEP = 1 / 30

/** Half-width of the body along the spine (the site's B). */
function halfWidth(s: number) {
  if (s < 0.12) return 0.11 * Math.pow(Math.sin(s / 0.12 * Math.PI / 2), 0.55)
  if (s < 0.3) return 0.11 + 0.025 * smooth(0.12, 0.3, s)
  return 0.033 + 0.102 * (1 - smooth(0.3, 0.74, s))
}

/** Direction glyph for thin lines / ring fronts (the site's U). */
function dirGlyph(dx: number, dy: number) {
  const l = Math.hypot(dx, dy) || 1
  if (Math.abs(dy) < 0.38 * l) return "-"
  if (Math.abs(dx) < 0.38 * l) return "|"
  return dx * dy > 0 ? "\\" : "/"
}

interface Koi {
  id: number; variety: "kohaku" | "sanke" | "tancho"; length: number
  nodes: Float32Array; heading: number; speed: number; phase: number; turn: number
  wander: number; curiosity: number; depth: number; depthTarget: number; depthMax: number
  nextDive: number; nextSurface: number; nextWake: number; beat: number; rush: number
  food: Pellet | null; burstUntil: number; nextBurst: number; finPhase: number
  startle: number; fleeX: number; fleeY: number; gulp: number
}
interface Pellet { x: number; y: number; born: number; landAt: number; landed: boolean; vx: number; vy: number }
interface Ripple { x: number; y: number; born: number; strength: number }
interface Bite { x: number; y: number; born: number }
export interface AvoidBox { left: number; top: number; right: number; bottom: number }
interface Marking { s: number; v: number; rs: number; rv: number }

export interface KoiAppearance {
  dark: boolean
  bg: string
  opacity: number
  /** Speed multiplier, 1 = the source site. */
  speed: number
  /** Global wake strength multiplier. */
  wake: number
  /** Water/wake tint; empty string keeps the palette's own. */
  color: string
}

const rippleLife = (r: Ripple) => 2.2 + 1.6 * r.strength

export class KoiEngine {
  // appearance
  private dark = true
  private palette: Palette = DARK
  private bgRgb: RGB = [26, 25, 33]
  private opacity = 1
  private speedMul = 1
  private wakeMul = 1
  private waterOverride: RGB | null = null

  // cell space (pixels are cells * CW/CH)
  private cols = 0
  private rows = 0
  private cw = 10
  private ch = 12
  private W = 0
  private H = 0

  // world
  private time = 0
  private koi: Koi[] = []
  private pellets: Pellet[] = []
  private bites: Bite[] = []
  private ripples: Ripple[] = []
  private lastFeed = -Infinity
  private avoid: AvoidBox[] = []
  private nextAutoFeed = 30
  private seeded = false

  // renderer state
  private energy = new Float32Array(0)
  private energyTmp = new Float32Array(0)
  private glyph = new Uint16Array(0)
  private fgColor = new Uint32Array(0)
  private fgAlpha = new Float32Array(0)
  private tileColor = new Uint32Array(0)
  private tileAlpha = new Float32Array(0)
  private cellShadow = new Uint8Array(0)
  private cellDim = new Float32Array(0)
  private spine = new Float32Array(40)
  private arc = new Float32Array(20)
  private arcTotal = 1
  private flareLeft = 1
  private flareRight = 1
  private hit = { flag: 0, across: 1, du: 1, da: 0 }
  private hitS = 0
  private hitV = 0
  private hitDist = 0
  private hitTx = 1
  private hitTy = 0
  private hitSeg = 0
  private markingCache = new Map<number, { red: Marking[]; black: Marking[] }>()
  private hexCache = new Map<number, string>()
  /** Body-glyph intensity: 1 = the site, 0 = pure color tiles. */
  private glyphFade = 1

  constructor(opts: { dark?: boolean; bg?: string; opacity?: number; speed?: number; size?: number; wake?: number; color?: string; gridScale?: number } = {}) {
    this.gridScale = clamp(opts.gridScale ?? 1, 0.3, 3)
    this.sizeScale = clamp(opts.size ?? 1, 0.2, 5)
    this.speedMul = clamp(opts.speed ?? 1, 0.1, 4)
    this.setAppearance({
      dark: opts.dark ?? true,
      bg: opts.bg ?? "#1a1a21",
      opacity: opts.opacity ?? 1,
      wake: opts.wake ?? 1,
      color: opts.color ?? "",
    })
  }

  setAppearance(a: { dark: boolean; bg: string; opacity: number; wake: number; color: string; glyph?: number }) {
    this.dark = a.dark
    this.palette = a.dark ? DARK : LIGHT
    this.bgRgb = parseHex(a.bg) ?? (a.dark ? [26, 25, 33] : [245, 244, 241])
    this.palette = { ...(a.dark ? DARK : LIGHT), bg: this.bgRgb }
    this.opacity = clamp(a.opacity, 0.15, 1)
    this.wakeMul = clamp(a.wake, 0, 4)
    this.waterOverride = a.color ? parseHex(a.color) : null
    if (a.glyph !== undefined) this.glyphFade = clamp(a.glyph, 0, 1)
  }

  /** Composer/logo regions reported by the host become avoid boxes. */
  setGlass(regions: { x: number; y: number; w: number; h: number }[]) {
    this.avoid = regions.map((r) => ({
      left: r.x * this.cw,
      top: r.y * this.ch,
      right: (r.x + r.w) * this.cw,
      bottom: (r.y + r.h) * this.ch,
    }))
    this.updateDim()
  }

  setMode(_mode: "glyphs" | "blocks") {}

  resize(cols: number, rows: number) {
    const first = this.cols === 0
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.cw = clamp(Math.round(10 / this.gridScale), 6, 16)
    this.ch = this.cw + 2
    this.W = this.cols * this.cw
    this.H = this.rows * this.ch
    const n = this.cols * this.rows
    this.energy = new Float32Array(n)
    this.energyTmp = new Float32Array(n)
    this.glyph = new Uint16Array(n)
    this.fgColor = new Uint32Array(n)
    this.fgAlpha = new Float32Array(n)
    this.tileColor = new Uint32Array(n)
    this.tileAlpha = new Float32Array(n)
    this.cellShadow = new Uint8Array(n)
    this.cellDim = new Float32Array(n).fill(1)
    if (first) this.seed()
    else for (const k of this.koi) {
      k.nodes[0] = clamp(k.nodes[0], 20, this.W - 20)
      k.nodes[1] = clamp(k.nodes[1], 20, this.H - 20)
    }
  }

  /** Fast-forward so the pond opens already populated (the site's drawStill). */
  settle() {
    if (this.time < 4) for (let i = 0; i < 240; i++) this.stepWorld(STEP)
  }

  /** Drop a scatter of pellets; defaults to a spot in the open middle. */
  feed(x = this.W * rand(0.3, 0.7), y = this.H * rand(0.25, 0.55)) {
    this.lastFeed = this.time
    this.ripples.push({ x, y, born: this.time, strength: 0.35 })
    const count = Math.min(5 + Math.floor(3 * Math.random()), 24 - this.pellets.length)
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU), r = 34 * Math.sqrt(Math.random()), v = rand(2, 6)
      this.pellets.push({
        x: x + Math.cos(a) * r * 1.3, y: y + Math.sin(a) * r,
        born: this.time, landAt: rand(0.15, 0.45), landed: false,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      })
    }
  }

  // ------------------------------------------------------------ world

  private seed() {
    this.seeded = true
    const base = clamp(0.5 * Math.min(this.W, this.H), 170, 420)
    const count = clamp(Math.round(this.W * this.H / 24e4), 3, 6)
    const extra = this.W >= 1024 ? 2 : 0
    this.koi = []
    for (let i = 0; i < count + extra; i++) {
      const shallow = i >= count
      const length = base * (shallow ? rand(0.32, 0.45) : rand(0.6, 1)) * this.sizeScale
      const depthMax = shallow ? 0.72 : 1
      const heading = rand(0, TAU)
      const x = rand(0.1 * this.W, 0.9 * this.W)
      const y = rand(0.1 * this.H, 0.9 * this.H)
      const nodes = new Float32Array(40)
      const seg = length / 19
      for (let e = 0; e < 20; e++) {
        nodes[2 * e] = x - Math.cos(heading) * seg * e
        nodes[2 * e + 1] = y - Math.sin(heading) * seg * e
      }
      this.koi.push({
        id: i + 1,
        variety: pickVariety(),
        length: length,
        nodes,
        heading,
        speed: 20,
        phase: rand(0, TAU),
        turn: 0,
        wander: 0,
        curiosity: rand(0.35, 1),
        depth: rand(0.5, depthMax),
        depthTarget: rand(0.5, depthMax),
        depthMax,
        nextDive: rand(6, 18),
        nextSurface: rand(3, 14),
        nextWake: rand(0, 2),
        beat: 0,
        rush: 0,
        food: null,
        burstUntil: 0,
        nextBurst: rand(0, 3),
        finPhase: rand(0, TAU),
        startle: 0,
        fleeX: 0,
        fleeY: 0,
        gulp: 0,
      })
    }
  }

  /** The plugin's size setting, normalised so 1.2 (its default) = the site. */
  private sizeScale = 1
  /** Cell-size scale from the plugin's grid setting (1 = the site's ~10px cells). */
  private gridScale = 1

  private stepWorld(e: number) {
    this.time += e
    for (const k of this.koi) this.stepKoi(k, e)
    const t = this.time
    if (this.time >= this.nextAutoFeed && this.avoidAutoFeed()) {
      this.feed()
      this.nextAutoFeed = this.time + rand(30, 60)
    }
    this.pellets = this.pellets.filter((p) => t - p.born < 14)
    for (const p of this.pellets) {
      if (!p.landed) {
        if (t - p.born < p.landAt) continue
        p.landed = true
        this.ripples.push({ x: p.x, y: p.y, born: t, strength: 0.1 })
        for (const k of this.koi) {
          if (Math.hypot(k.nodes[0] - p.x, k.nodes[1] - p.y) < 650) k.rush = 1
        }
        continue
      }
      const damp = Math.exp(-0.2 * e)
      p.vx *= damp
      p.vy *= damp
      p.x += p.vx * e
      p.y += p.vy * e
    }
    this.ripples = this.ripples.filter((r) => t - r.born < rippleLife(r))
    this.bites = this.bites.filter((b) => t - b.born < 0.45)
  }

  private avoidAutoFeed() {
    return this.pellets.length === 0
  }

  private stepKoi(k: Koi, t: number) {
    const { width: W, height: H, time: now } = this
    const len = k.length
    const nodes = k.nodes
    let hx = nodes[0]
    let hy = nodes[1]
    let dx = Math.cos(k.heading)
    let dy = Math.sin(k.heading)

    k.wander = clamp(k.wander + (Math.random() - 0.5) * t * 2.4, -0.9, 0.9)
    dx += 0.6 * Math.cos(k.heading + k.wander)
    dy += 0.6 * Math.sin(k.heading + k.wander)

    const food = this.pickFood(k, hx, hy, Math.max(1.6 * len + 220, k.rush > 0 ? 650 : 0))
    const feeding = now - this.lastFeed < 2
    let fleeing = false
    let chasing = false
    let curious = false
    let near = 0

    if (food) {
      const fx = food.x - hx, fy = food.y - hy, d = Math.hypot(fx, fy) || 1
      dx += fx / d * 3
      dy += fy / d * 3
      chasing = true
      near = clamp(1 - d / (1.2 * len), 0, 1)
    }

    if (fleeing) {
      // (startle needs a pointer, which the TUI has none — kept for parity)
    } else if (food) {
      // already steering above
    }

    // separation + weak alignment with the other koi
    for (const other of this.koi) {
      if (other === k) continue
      const ox = other.nodes[0], oy = other.nodes[1]
      if (Math.abs(ox - hx) > 2 * len || Math.abs(oy - hy) > 2 * len) continue
      for (let e = 0; e < 20; e += 3) {
        const sx = hx - other.nodes[2 * e]
        const sy = hy - other.nodes[2 * e + 1]
        const d = Math.hypot(sx, sy)
        const min = (len + other.length) * (food ? 0.12 : 0.28)
        if (d < min && d > 0.001) {
          const push = (1 - d / min) * 2.4
          dx += sx / d * push
          dy += sy / d * push
        }
      }
      if (!chasing && Math.hypot(ox - hx, oy - hy) < 1.6 * len) {
        dx += 0.18 * Math.cos(other.heading)
        dy += 0.18 * Math.sin(other.heading)
      }
    }

    // steer away from avoid boxes (composer, logo)
    const push = { x: 0, y: 0 }
    this.avoidForce(hx, hy, 0.4 * len, push)
    dx += push.x * (chasing || curious ? 0.5 : 1.8)
    dy += push.y * (chasing || curious ? 0.5 : 1.8)

    // steer back when the head nears the pond edge
    const outside = Math.max(-hx, hx - W, -hy, hy - H)
    if (outside > -(0.25 * len)) {
      const steer = 3.5 * clamp((outside + 0.25 * len) / (0.5 * len), 0, 1)
      const cx = W / 2 - hx, cy = H / 2 - hy, d = Math.hypot(cx, cy) || 1
      dx += cx / d * steer
      dy += cy / d * steer
    }

    const want = Math.atan2(dy, dx)
    const base = chasing ? 1.9 + near : curious ? 1.2 : 0.7
    const maxTurn = (1 + 0.6 * k.rush) * Math.min(fleeing ? 3 : base, k.speed / len * 4) * t
    k.heading += clamp(angleDiff(k.heading, want), -maxTurn, maxTurn)
    k.turn += (clamp(angleDiff(k.heading, want), -maxTurn, maxTurn) / t - k.turn) * Math.min(1, 3 * t)

    if (now > k.nextBurst && now > k.burstUntil) {
      k.burstUntil = now + rand(0.7, 1.6)
      k.nextBurst = k.burstUntil + rand(0.8, 2.5)
    }
    const active = chasing || now < k.burstUntil
    k.beat += ((active ? 1 : 0) - k.beat) * Math.min(1, 3 * t)

    if (k.beat > 0.6 && k.depth > 0.65 && now > k.nextWake) {
      this.ripples.push({ x: nodes[34], y: nodes[35], born: now, strength: 0.25 + 0.2 * k.depth })
      k.nextWake = now + rand(0.8, 1.6) / k.beat
    }
    k.rush = Math.max(0, k.rush - 0.7 * t)

    const cruise = 12 + 0.05 * len
    const targetSpeed =
      (1 + 0.8 * k.rush) *
      (chasing ? cruise * (1.9 + near) : active ? cruise * (curious ? 1.6 : 1.35) : 0.85 * cruise) *
      this.speedMul
    k.speed += (targetSpeed - k.speed) * Math.min(1, t * (active ? 1.6 + 3 * k.rush : 0.35))
    k.phase += t * (0.6 + k.beat * (2.2 + k.speed / 11))
    k.finPhase += 2.4 * t
    k.gulp += ((chasing && near > 0.55 ? 1 : 0) - k.gulp) * Math.min(1, 6 * t)

    if (now > k.nextDive) {
      k.depthTarget = rand(0.5, k.depthMax)
      k.nextDive = now + rand(8, 20)
    }
    k.depth += ((chasing ? 1 : k.depthTarget) - k.depth) * Math.min(1, t * (chasing ? 0.8 : 0.15))

    nodes[0] += Math.cos(k.heading) * k.speed * t
    nodes[1] += Math.sin(k.heading) * k.speed * t

    // spine follows the head, at most 0.16 rad of bend per segment
    const seg = len / 19
    let prevAngle = k.heading + Math.PI
    for (let e = 1; e < 20; e++) {
      const px = nodes[(e - 1) * 2], py = nodes[(e - 1) * 2 + 1]
      let a = Math.atan2(nodes[2 * e + 1] - py, nodes[2 * e] - px)
      a = prevAngle + clamp(angleDiff(prevAngle, a), -0.16, 0.16)
      nodes[2 * e] = px + Math.cos(a) * seg
      nodes[2 * e + 1] = py + Math.sin(a) * seg
      prevAngle = a
    }

    // eat pellets near the mouth; otherwise surface now and then
    const mouth = 0.08 * len + 6
    const before = this.pellets.length
    this.pellets = this.pellets.filter((p) => !p.landed || (p.x - nodes[0]) ** 2 + (p.y - nodes[1]) ** 2 > mouth * mouth)
    if (this.pellets.length < before) {
      this.ripples.push({ x: nodes[0], y: nodes[1], born: now, strength: 0.6 })
      this.bites.push({ x: nodes[0], y: nodes[1], born: now })
      k.nextSurface = now + rand(6, 16)
    } else if (now > k.nextSurface) {
      this.ripples.push({ x: nodes[0], y: nodes[1], born: now, strength: 0.3 })
      k.nextSurface = now + rand(8, 20)
    }
  }

  private pickFood(k: Koi, x: number, y: number, radius: number) {
    if (k.food && !this.pellets.includes(k.food)) k.food = null
    const nearest = this.nearestPellet(x, y, radius)
    if (!k.food) return (k.food = nearest)
    const d = Math.hypot(k.food.x - x, k.food.y - y)
    if (d > 1.3 * radius) k.food = nearest
    else if (nearest && Math.hypot(nearest.x - x, nearest.y - y) < 0.5 * d) k.food = nearest
    return k.food
  }

  private nearestPellet(x: number, y: number, radius: number) {
    let best: Pellet | null = null
    let bestD = radius * radius
    for (const p of this.pellets) {
      if (!p.landed) continue
      const d = (p.x - x) ** 2 + (p.y - y) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }

  /** Repulsion from avoid boxes (the site's inline avoid IIFE). */
  private avoidForce(x: number, y: number, radius: number, out: { x: number; y: number }) {
    out.x = 0
    out.y = 0
    for (const box of this.avoid) {
      let ex = x - clamp(x, box.left, box.right)
      let ey = y - clamp(y, box.top, box.bottom)
      let d = Math.hypot(ex, ey)
      if (d > radius) continue
      if (d < 0.001) {
        const sides = [box.left - x, x - box.right, box.top - y, y - box.bottom]
        const k = sides.indexOf(Math.max(...sides))
        ex = k === 0 ? -1 : k === 1 ? 1 : 0
        ey = k === 2 ? -1 : k === 3 ? 1 : 0
        d = 0
      }
      const l = Math.hypot(ex, ey) || 1
      out.x += ex / l * (1 - d / radius)
      out.y += ey / l * (1 - d / radius)
    }
  }

  // ------------------------------------------------------------ raster

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw), r = Math.floor(y / this.ch)
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c
  }

  private updateDim() {
    const { cols, rows, cw, ch } = this
    this.cellDim.fill(1)
    const margin = 4 * cw
    for (const box of this.avoid) {
      const c0 = Math.max(0, Math.floor((box.left - margin) / cw))
      const c1 = Math.min(cols - 1, Math.floor((box.right + margin) / cw))
      const r0 = Math.max(0, Math.floor((box.top - margin) / ch))
      const r1 = Math.min(rows - 1, Math.floor((box.bottom + margin) / ch))
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw + cw / 2, y = r * ch + ch / 2
          const dist = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom))
          const i = r * cols + c
          this.cellDim[i] = Math.min(this.cellDim[i]!, 0.15 + 0.85 * smooth(0, margin, dist))
        }
      }
    }
  }

  /** Closest point on the spine + body/fin classification (the site's sample). */
  private sample(px: number, py: number, len: number, from = 0, to = 18) {
    const spine = this.spine
    let bestD2 = Infinity
    let s = 0
    let side = 1
    let tailOver = 0
    let headOver = 0
    let perp = 0
    for (let i = from; i <= to; i++) {
      const ax = spine[2 * i]!, ay = spine[2 * i + 1]!
      const ux = spine[(i + 1) * 2]! - ax
      const uy = spine[(i + 1) * 2 + 1]! - ay
      const len2 = ux * ux + uy * uy || 1
      const m = ((px - ax) * ux + (py - ay) * uy) / len2
      const t = clamp(m, 0, 1)
      const d2 = (px - ax - ux * t) ** 2 + (py - ay - uy * t) ** 2
      if (d2 < bestD2) {
        const segLen = Math.sqrt(len2)
        bestD2 = d2
        s = (this.arc[i]! + t * segLen) / this.arcTotal
        side = ux * (py - ay) - uy * (px - ax) >= 0 ? 1 : -1
        tailOver = i === 18 ? Math.max(0, m - 1) * segLen : 0
        headOver = i === 0 ? Math.max(0, -m) * segLen : 0
        perp = Math.abs(ux * (py - ay) - uy * (px - ax)) / segLen
        this.hitTx = ux / segLen
        this.hitTy = uy / segLen
        this.hitSeg = i
      }
    }
    const dist = Math.sqrt(bestD2)
    this.hitDist = dist
    this.hitS = s
    this.hitV = dist * side
    const flare = side > 0 ? this.flareLeft : this.flareRight
    return this.classify(s, dist / len, tailOver / len, flare, this.hit, headOver / len, perp / len)
  }

  /** Body / eye / dorsal / caudal / fin / barbel classification. */
  private classify(s: number, v: number, tailOver: number, flare: number, hit: { flag: number; across: number; du: number; da: number }, headOver: number, perp: number) {
    hit.flag = 0
    hit.across = 1
    hit.du = 1
    hit.da = 0
    if (headOver > 0) {
      // barbels ahead of the head
      if (headOver < 0.05 && Math.abs(perp - (0.045 + 0.7 * headOver)) < 0.016) {
        hit.flag = 5
        return true
      }
      return false
    }
    const hw = halfWidth(s)
    if (s <= 0.74 && v <= hw) {
      const across = v / hw
      hit.across = across
      if (s > 0.055 && s < 0.1 && across > 0.5 && across < 0.85) hit.flag = 3
      else if (s > 0.28 && s < 0.6 && across < 0.14) hit.flag = 4
      else hit.flag = 1
      return true
    }
    if (s > 0.68 && tailOver <= 0) {
      const radius = (0.03 + 0.15 * Math.pow(smooth(0.7, 1, s), 0.8)) * flare
      if (v <= radius && s <= 0.86 + v / radius * 0.14) {
        hit.flag = 2
        hit.da = v / radius * 0.8
        return true
      }
    }
    return this.finTest(s, v, 0.19, 0.85 + 0.5 * (flare - 1), 0.066 * flare, 0.04, hit) ||
      this.finTest(s, v, 0.47, 0.75, 0.036, 0.018, hit)
  }

  private finTest(s: number, v: number, at: number, angle: number, rx: number, ry: number, hit: { flag: number; across: number; du: number; da: number }) {
    const lift = 0.85 * halfWidth(at)
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const du = s - at, da = v - lift
    if (((du * cos + da * sin - rx) / rx) ** 2 + ((-du * sin + da * cos) / ry) ** 2 > 1) return false
    hit.flag = 2
    hit.du = du
    hit.da = da
    return true
  }

  private skin(k: Koi, s: number, vAbs: number, across: number): RGB {
    const p = this.palette
    const vFrac = vAbs / k.length
    if (across > 0.9 || s > 0.74) return p.white
    const jitter = (vnoise(14 * s + k.id, 30 * vFrac, k.id + 3) - 0.5) * 0.6
    const m = this.markings(k)
    for (const e of m.black) if (this.markHit(e, s, vFrac, jitter)) return p.black
    for (const e of m.red) if (this.markHit(e, s, vFrac, jitter)) return p.red
    return p.white
  }

  private markHit(m: Marking, s: number, v: number, jitter: number) {
    return ((s - m.s) / m.rs) ** 2 + ((v - m.v) / m.rv) ** 2 < 1 + jitter
  }

  private markings(k: Koi) {
    let m = this.markingCache.get(k.id)
    if (!m) {
      m = buildMarkings(k)
      this.markingCache.set(k.id, m)
    }
    return m
  }

  private rasterizeKoi(k: Koi, time: number) {
    const { spine, arc, cw, ch, cols, rows, glyph, fgColor, fgAlpha, tileColor, tileAlpha, palette: p } = this
    const len = k.length
    const nodes = k.nodes
    const waveAmp = 0.3 + 1.1 * k.beat

    // spine with the traveling tail wave applied sideways
    for (let i = 0; i < 20; i++) {
      const r = i / 19
      const a = Math.max(0, i - 1), b = Math.min(19, i + 1)
      let nx = nodes[2 * a]! - nodes[2 * b]!
      let ny = nodes[2 * a + 1]! - nodes[2 * b + 1]!
      const l = Math.hypot(nx, ny) || 1
      nx /= l
      ny /= l
      const off = 0.04 * len * (0.05 + 0.95 * Math.pow(r, 2.2)) * waveAmp * Math.sin(k.phase - 4.6 * r)
      spine[2 * i] = nodes[2 * i]! - ny * off
      spine[2 * i + 1] = nodes[2 * i + 1]! + nx * off
    }
    arc[0] = 0
    for (let i = 1; i < 20; i++) {
      arc[i] = arc[i - 1]! + Math.hypot(spine[2 * i]! - spine[(i - 1) * 2]!, spine[2 * i + 1]! - spine[(i - 1) * 2 + 1]!)
    }
    this.arcTotal = arc[19]! || 1

    const flareBase = 1 - 0.25 * k.beat
    const flutter = 0.18 * (1 - k.beat) * Math.sin(k.finPhase)
    const turnBias = clamp(0.6 * k.turn, -0.35, 0.35)
    this.flareLeft = flareBase + flutter - turnBias
    this.flareRight = flareBase - flutter + turnBias

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < 20; i++) {
      minX = Math.min(minX, spine[2 * i]!)
      maxX = Math.max(maxX, spine[2 * i]!)
      minY = Math.min(minY, spine[2 * i + 1]!)
      maxY = Math.max(maxY, spine[2 * i + 1]!)
    }
    const pad = 0.26 * len
    const c0 = Math.max(0, Math.floor((minX - pad) / cw))
    const c1 = Math.min(cols - 1, Math.floor((maxX + pad) / cw))
    const r0 = Math.max(0, Math.floor((minY - pad) / ch))
    const r1 = Math.min(rows - 1, Math.floor((maxY + pad) / ch))
    if (c0 > c1 || r0 > r1) return

    const diag = Math.hypot(cw, ch)
    const shadowDx = Math.round(0.07 * len * k.depth / cw) + 1
    const shadowDy = Math.round(0.05 * len * k.depth / ch) + 1
    const alpha = p.alpha * (p.depthFloor + (1 - p.depthFloor) * k.depth) * this.opacity
    const [tileLo, tileHi] = p.tile
    const hit = this.hit

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const x = col * cw
        const y = row * ch
        const center = this.sample(x + cw / 2, y + ch / 2, len)
        if (!center && this.hitDist > len * (this.hitS > 0.4 && this.hitS < 0.62 ? 0.15 : 0.25) + diag) {
          col += Math.max(0, Math.floor((this.hitDist - 0.25 * len - diag) / cw))
          continue
        }
        const segLo = Math.max(0, this.hitSeg - 2)
        const segHi = Math.min(18, this.hitSeg + 2)
        let flag = hit.flag
        let across = hit.across
        let s = this.hitS
        let v = this.hitV
        let tx = this.hitTx
        let ty = this.hitTy
        let coverage = center ? 1 : 0
        let offX = 0
        let offY = 0
        const ridge = center && flag !== 2 && flag !== 5 && s > 0.04 && s < 0.72 && halfWidth(s) * len - this.hitDist > 0.35 * diag
        if (ridge) coverage = 5
        if (!ridge) {
          for (let e = 0; e < SUB.length; e += 2) {
            if (this.sample(x + SUB[e]! * cw, y + SUB[e + 1]! * ch, len, segLo, segHi)) {
              offX += (SUB[e]! - 0.5) * cw
              offY += (SUB[e + 1]! - 0.5) * ch
              if (coverage === 0) {
                flag = hit.flag
                across = hit.across
                s = this.hitS
                v = this.hitV
                tx = this.hitTx
                ty = this.hitTy
              }
              coverage++
            }
          }
        }
        if (coverage === 0) continue
        this.hitTx = tx
        this.hitTy = ty
        const share = coverage / 5
        const side = v >= 0 ? 1 : -1
        const idx = row * cols + col
        const dither = 4294967295 * hash(Math.round(90 * s), Math.round(v / (0.8 * cw)), k.id) >>> 0
        const solid = center && share >= 0.6
        let ch0 = " "
        let color = p.fin
        let a = alpha
        let tile: RGB | null = null
        let tileA = 0

        if (flag === 5) {
          ch0 = dirGlyph(-tx - side * ty * 0.7, -ty + side * tx * 0.7)
          color = shade(mix(p.bg, p.fin, 0.9), p.ink + 0.3)
        } else if (flag === 3 && solid) {
          tile = mix(p.bg, p.eye, 0.85)
          tileA = alpha
          ch0 = "o"
          color = mix(p.bg, p.white, 0.9)
        } else if (flag === 2) {
          tile = mix(p.bg, p.fin, 0.55)
          tileA = 0.45 * alpha * share
          if (dither % 2 === 0) {
            ch0 = "."
            a = alpha * 0.6 * share
          }
        } else {
          const skinC = this.skin(k, s, v, across)
          const light = side * (0.6 * ty - 0.8 * tx) * across
          const lum = clamp(0.22 + 0.5 * Math.sqrt(1 - across * across) + 0.18 * light, 0, 1)
          if (skinC === p.red) {
            const w1 = (hash(k.id, 5, 17) - 0.5) * 0.3
            const w2 = (vnoise(9 * s + k.id, v / len * 18, k.id + 21) - 0.5) * 0.25
            const shimmer = Math.max(0, Math.sin(11 * s - 1.8 * time + k.id) - 0.7) / 0.3
            tile = pick(p.hi, 0.15 + 0.8 * lum + w1 + w2 + 0.35 * shimmer)
          } else {
            tile = mix(p.bg, skinC, tileLo + (tileHi - tileLo) * lum)
          }
          if (coverage === 5) {
            const sr = row + shadowDy, sc = col + shadowDx
            if (sr < rows && sc < cols) this.cellShadow[sr * cols + sc] = 1
            tileA = alpha
            if (s < 0.035 && across < 0.6 && k.gulp > 0.5) {
              ch0 = "o"
              color = p.eye
            } else {
              ch0 = GLYPHS[clamp(Math.round((1 - lum) * 4) + (dither >>> 4) % 3, 0, GLYPHS.length - 1)]!
              color = shade(tile, p.ink)
              if (skinC === p.white) a = alpha * 0.6
              const tick = Math.floor(1.4 * time + dither % 997 / 97)
              if (hash(dither, tick, 7) < 0.03) tile = mix(tile, p.bg, 0.45)
            }
          } else {
            tileA = alpha * share * 0.55
            if (Math.hypot(offX, offY) > 0.2 * cw && dither % 3 === 0) {
              ch0 = "."
              color = shade(tile, p.ink)
            }
          }
        }
        if (ch0 !== " ") {
          a *= this.glyphFade
          if (a < 0.04) ch0 = " "
        }
        if (ch0 !== " " || tileA !== 0) {
          tileColor[idx] = tile ? pack(tile) : 0
          this.tileAlpha[idx] = tileA
          glyph[idx] = ch0.charCodeAt(0)
          fgColor[idx] = pack(color)
          fgAlpha[idx] = a
        }
      }
    }
  }

  private depositWake() {
    for (const k of this.koi) {
      for (let e = 16; e < 20; e++) {
        const i = this.cellIndex(k.nodes[2 * e]!, k.nodes[2 * e + 1]!)
        if (i >= 0) this.energy[i] = Math.min(1.5, this.energy[i]! + (0.035 + 0.0012 * k.speed) * this.wakeMul)
      }
    }
  }

  private diffuse(dt: number) {
    const { cols, rows } = this
    const decay = Math.exp(-1.1 * dt)
    const src = this.energy
    const dst = this.energyTmp
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const l = c > 0 ? src[i - 1]! : src[i]!
        const rt = c < cols - 1 ? src[i + 1]! : src[i]!
        const u = r > 0 ? src[i - cols]! : src[i]!
        const d = r < rows - 1 ? src[i + cols]! : src[i]!
        dst[i] = (4 * src[i]! + l + rt + u + d) * 0.125 * decay
      }
    }
    this.energy = dst
    this.energyTmp = src
  }

  /** One animation tick; dtMs is real elapsed time in milliseconds. */
  tick(dtMs: number): FrameRows {
    if (this.cols === 0) return []
    let dt = Math.min(dtMs / 1000, 0.1)
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < 4) {
      this.stepWorld(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === 4) this.acc = 0
    this.render(dt)
    return this.emit()
  }
  private acc = 0

  private render(dt: number) {
    const { cols, rows } = this
    if (cols === 0 || rows === 0) return
    this.glyph.fill(0)
    this.tileAlpha.fill(0)
    this.cellShadow.fill(0)
    const sorted = [...this.koi].sort((a, b) => a.depth - b.depth)
    for (const k of sorted) this.rasterizeKoi(k, this.time)
    this.depositWake()
    this.diffuse(dt)
    this.overlay(dt)
  }

  /** Shadows, wake, ripples and pellets — only into empty cells (the site's draw* passes). */
  private overlay(dt: number) {
    const { cols, rows, glyph, cellShadow, energy } = this
    const p = this.palette
    const water = this.waterOverride ?? p.water
    const dim = this.cellDim

    // shadows under nothing: ":" where the koi left no glyph
    for (let i = 0; i < cellShadow.length; i++) {
      if (cellShadow[i] && !glyph[i]) {
        glyph[i] = 58 // ":"
        this.fgColor[i] = pack(p.shadow)
        this.fgAlpha[i] = p.shadowAlpha * dim[i]!
      }
    }
    // wake dots
    for (let i = 0; i < energy.length; i++) {
      const e = energy[i]!
      if (e < 0.22 || glyph[i] || cellShadow[i]) continue
      glyph[i] = (e > 0.5 ? 45 : 46) // "-" : "."
      this.fgColor[i] = pack(water)
      this.fgAlpha[i] = 0.35 * Math.min(1, (e - 0.22) * 1.4) * dim[i]!
    }
    // ripples
    for (const r of this.ripples) {
      const age = this.time - r.born
      const fade = Math.pow(1 - age / rippleLife(r), 1.5) * r.strength
      for (let ring = 0; ring < 2; ring++) {
        const radius = 52 * Math.max(0, age - 0.45 * ring) * (0.7 + 0.5 * r.strength)
        if (radius < 2) continue
        const band = 0.6 * this.cw
        const c0 = Math.max(0, Math.floor((r.x - radius - this.cw) / this.cw))
        const c1 = Math.min(cols - 1, Math.floor((r.x + radius + this.cw) / this.cw))
        const r0 = Math.max(0, Math.floor((r.y - radius - this.ch) / this.ch))
        const r1 = Math.min(rows - 1, Math.floor((r.y + radius + this.ch) / this.ch))
        const a = fade * (ring === 0 ? 0.55 : 0.3)
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            const i = row * cols + col
            if (glyph[i]) continue
            const dx = col * this.cw + this.cw / 2 - r.x
            const dy = row * this.ch + this.ch / 2 - r.y
            if (Math.abs(Math.hypot(dx, dy) - radius) > band) continue
            glyph[i] = (ring === 1 ? 46 : dirGlyph(-dy, dx).charCodeAt(0))
            this.fgColor[i] = pack(water)
            this.fgAlpha[i] = a * dim[i]!
          }
        }
      }
    }
    // pellets
    for (const pellet of this.pellets) {
      const age = this.time - pellet.born
      if (!pellet.landed) {
        const t = age / pellet.landAt
        const i = this.cellIndex(pellet.x, pellet.y - (1 - t) * this.ch * 1.5)
        if (i < 0 || glyph[i]) continue
        glyph[i] = (t < 0.5 ? 39 : 46) // "'" : "."
        this.fgColor[i] = pack(p.pellet)
        this.fgAlpha[i] = p.alpha * (0.5 + 0.4 * t) * this.opacity * dim[i]!
        continue
      }
      const i = this.cellIndex(pellet.x, pellet.y)
      if (i < 0 || glyph[i]) continue
      const fade = smooth(9, 14, age)
      const pulse = 0.8 + 0.2 * Math.sin(3 * age + pellet.x)
      glyph[i] = (fade > 0.55 ? 46 : 111) // "." : "o"
      this.fgColor[i] = pack(p.pellet)
      this.fgAlpha[i] = p.alpha * pulse * (1 - 0.85 * fade) * this.opacity * dim[i]!
    }
    // bites splash over everything
    for (const b of this.bites) {
      const i = this.cellIndex(b.x, b.y)
      if (i < 0) continue
      const t = (this.time - b.born) / 0.45
      const g = t < 0.35 ? "*" : t < 0.7 ? "+" : "."
      glyph[i] = g.charCodeAt(0)
      this.fgColor[i] = pack(p.pellet)
      this.fgAlpha[i] = Math.min(1, 1.6 * p.alpha) * (1 - t * t)
    }
  }

  // ------------------------------------------------------------ output

  private hex(packed: number) {
    let s = this.hexCache.get(packed)
    if (!s) {
      s = "#" + packed.toString(16).padStart(6, "0")
      this.hexCache.set(packed, s)
    }
    return s
  }

  private emit(): FrameRows {
    const { cols, rows, glyph, fgColor, fgAlpha, tileColor, tileAlpha, cellDim } = this
    const bg = this.bgRgb
    const out: FrameRows = []
    for (let r = 0; r < rows; r++) {
      const row: FrameRun[] = []
      let text = ""
      let fg = ""
      let bgc: string | undefined
      let open = false
      const flush = () => {
        if (text) row.push({ text, fg, bg: bgc })
        text = ""
      }
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const code = glyph[i]!
        const dim = cellDim[i]!
        const tA = tileAlpha[i]! * dim
        const tile = tA > 0.12 && tileColor[i] ? this.hex(pack(mix(bg, unpack(tileColor[i]!), Math.min(1, tA)))) : undefined
        let ch: string | null = null
        let fgc: string | undefined
        if (code && code !== 32) {
          const a = fgAlpha[i]! * dim
          if (a > 0.03) {
            ch = String.fromCharCode(code)
            fgc = this.hex(pack(mix(bg, unpack(fgColor[i]!), Math.min(1, a))))
          }
        }
        if (!ch && !tile) {
          if (open) {
            flush()
            open = false
            fg = ""
            bgc = undefined
          }
          text += " "
          continue
        }
        const nextFg = ch ? fgc! : ""
        const nextBg = tile
        if (!open || nextFg !== fg || (nextBg ?? "") !== (bgc ?? "")) {
          flush()
          fg = nextFg
          bgc = nextBg
          open = true
        }
        text += ch ?? " "
      }
      flush()
      out.push(row)
    }
    return out
  }
}

// little plugin-facing types kept identical to the whales engine's output
type FrameRun = { text: string; fg: string; bg?: string }
type FrameRows = readonly (readonly FrameRun[])[]

function unpack(packed: number): RGB {
  return [packed >>> 16 & 255, packed >>> 8 & 255, packed & 255]
}

function parseHex(s: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [n >>> 16 & 255, n >>> 8 & 255, n & 255]
}

function pickVariety(): Koi["variety"] {
  const table: [Koi["variety"], number][] = [["kohaku", 3], ["sanke", 2], ["tancho", 1]]
  let r = Math.random() * table.reduce((n, [, w]) => n + w, 0)
  for (const [v, w] of table) if ((r -= w) <= 0) return v
  return "kohaku"
}

/** Variety-specific red/black patches in (spine-fraction, across) space. */
function buildMarkings(k: Koi): { red: Marking[]; black: Marking[] } {
  const h = (n: number) => hash(k.id, n, 41)
  if (k.variety === "tancho") {
    return { red: [{ s: 0.11, v: 0, rs: 0.05, rv: 0.055 }], black: [] }
  }
  const red: Marking[] = []
  if (h(0) < 0.75) {
    red.push({ s: 0.1, v: (h(1) - 0.5) * 0.03, rs: 0.055 + 0.03 * h(2), rv: 0.11 })
  }
  const patches = 2 + Math.floor(2 * h(3))
  for (let i = 0; i < patches; i++) {
    const span = 0.42 / patches
    red.push({
      s: 0.25 + span * (i + 0.5) + (h(10 + i) - 0.5) * span * 0.3,
      v: (h(20 + i) - 0.5) * 0.05,
      rs: span * (0.32 + 0.12 * h(30 + i)),
      rv: 0.09 + 0.05 * h(40 + i),
    })
  }
  const black: Marking[] = []
  if (k.variety === "sanke") {
    const spots = 4 + Math.floor(3 * h(50))
    for (let i = 0; i < spots; i++) {
      black.push({
        s: 0.24 + 0.44 * h(60 + i),
        v: (h(70 + i) - 0.5) * 0.16,
        rs: 0.022,
        rv: 0.026,
      })
    }
  }
  return { red, black }
}
