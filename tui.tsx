/**
 * ASCII 鲸鱼 · OpenCode — direct port of dsh-ascii-whales (DeepSeek Harness).
 *
 * The animation is the vendored upstream engine (stackedlol/ascii-sharks,
 * adapted by dsh-ascii-whales): boid fish schools, hunting whales on flexible
 * spines, supersampled cell rasterization with per-cell lighting, colored
 * body blocks with contrast glyphs, and a diffusing wake. Only the drawing
 * backend is new: terminal cells (fg glyph + bg block) instead of canvas.
 *
 * - Home: the full character ocean, retreating once a conversation starts.
 * - Session pages: the ocean stays as pure color tiles (no characters, so it
 *   never reads as page content), dimmed behind the transcript.
 *   Configure with /whales.
 * - Koi pond (/whales → 动画): a second engine ported from the koi at
 *   daoho.dev — spine-swimming koi with kohaku/sanke/tancho markings;
 *   /feed drops pellets and the koi rush over to eat.
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { OceanEngine, type OceanAppearance } from "./vendor/engine.ts"
import { KoiEngine } from "./vendor/koi.ts"

/** dsh-ascii-whales defaults (src/settings.mjs). */
interface Settings {
  readonly enabled: boolean
  /** Which ocean fills the home screen: whale pods or the koi pond. */
  readonly animation: "whales" | "koi"
  /** Koi body glyph intensity (strong → none = pure color tiles). */
  readonly glyph: "strong" | "soft" | "faint" | "none"
  readonly species: "humpback" | "orca"
  readonly count: number
  readonly size: number
  readonly speed: number
  readonly bodySwing: number
  readonly turnAgility: number
  readonly tailFrequency: number
  readonly fishCount: number
  readonly wake: number
  readonly gridScale: number
  readonly opacity: number
  /** Ocean on session pages, as pure color tiles. Default off. */
  readonly session: boolean
  readonly color: string
  readonly colorfulShimmer: boolean
  readonly eyeColor: "primary" | "black" | "white"
}

const DEFAULTS: Settings = {
  enabled: true,
  animation: "koi",
  glyph: "soft",
  species: "humpback",
  count: 3,
  size: 1.2,
  speed: 0.65,
  bodySwing: 0.8,
  turnAgility: 0.7,
  tailFrequency: 0.8,
  fishCount: 170,
  wake: 1,
  gridScale: 1,
  opacity: 1,
  session: false,
  color: "#4d6bfe",
  colorfulShimmer: false,
  eyeColor: "primary",
}

const TICK_MS = 66
const SIZE_RAMP = [1, 0.7, 0.84, 0.77, 0.65, 0.9]
/** Ocean dimming on session pages so tiles never fight the transcript. */
const SESSION_DIM = 0.6

/** The live koi engine, when the koi animation is on stage (/feed targets it). */
let activeKoi: KoiEngine | null = null

/** 字符强度 setting → koi body-glyph alpha factor. */
const GLYPH_FADE = { strong: 1, soft: 0.55, faint: 0.3, none: 0 } as const

export default Plugin.define({
  id: "ascii-whales",
  setup(context) {
    const [store, update] = context.storage.store("settings", { initial: { ...DEFAULTS } })

    const read = (): Settings => ({
      enabled: store.enabled !== false,
      animation: store.animation === "whales" ? "whales" : "koi",
      glyph:
        store.glyph === "strong" || store.glyph === "faint" || store.glyph === "none" ? store.glyph : "soft",
      species: store.species === "orca" ? "orca" : "humpback",
      count: num(store.count, DEFAULTS.count, 1, 8),
      size: num(store.size, DEFAULTS.size, 0.1, 10),
      speed: num(store.speed, DEFAULTS.speed, 0.1, 10),
      bodySwing: num(store.bodySwing, DEFAULTS.bodySwing, 0, 3),
      turnAgility: num(store.turnAgility, DEFAULTS.turnAgility, 0.1, 3),
      tailFrequency: num(store.tailFrequency, DEFAULTS.tailFrequency, 0.1, 5),
      fishCount: num(store.fishCount, DEFAULTS.fishCount, 0, 1000),
      wake: num(store.wake, DEFAULTS.wake, 0, 10),
      gridScale: num(store.gridScale, DEFAULTS.gridScale, 0.1, 10),
      opacity: num(store.opacity, DEFAULTS.opacity, 0.2, 1),
      session: store.session === true,
      color: typeof store.color === "string" && /^#?[0-9a-f]{6}$/i.test(store.color) ? store.color : DEFAULTS.color,
      colorfulShimmer: store.colorfulShimmer === true,
      eyeColor: store.eyeColor === "black" || store.eyeColor === "white" ? store.eyeColor : "primary",
    })

    /** Reads only population fields, so the engine memo recreates on those alone. */
    const readPopulation = () => ({
      animation: store.animation === "whales" ? "whales" : "koi",
      species: (store.species === "orca" ? "orca" : "humpback") as Settings["species"],
      count: num(store.count, DEFAULTS.count, 1, 8),
      size: num(store.size, DEFAULTS.size, 0.1, 10),
      gridScale: num(store.gridScale, DEFAULTS.gridScale, 0.1, 10),
      fishCount: num(store.fishCount, DEFAULTS.fishCount, 0, 1000),
    })

    async function set(patch: (draft: Settings) => void) {
      await update((draft) => {
        patch(draft as Settings)
      })
    }

    async function openSettings(input?: string) {
      const arg = input?.trim().toLowerCase()
      if (arg === "on" || arg === "off") {
        const enabled = arg === "on"
        await set((s) => {
          s.enabled = enabled
        })
        context.ui.toast.show({
          title: "ASCII 鲸鱼",
          message: enabled ? "鲸群回来了" : "鲸群已隐去",
          variant: "success",
        })
        return
      }
      if (arg === "reset") {
        await set((s) => {
          Object.assign(s, DEFAULTS)
        })
        context.ui.toast.show({ title: "ASCII 鲸鱼", message: "已恢复默认海面", variant: "success" })
        return
      }

      for (;;) {
        const s = read()
        const pick = await context.ui.dialog.select({
          title: "ASCII 鲸鱼 · 海洋设置",
          placeholder: "调一调你的海",
          options: [
            { title: s.enabled ? "隐藏鲸群" : "显示鲸群", value: "enabled" },
            { title: `动画 · ${s.animation === "koi" ? "锦鲤" : "鲸群"}`, value: "animation" },
            {
              title: `字符强度 · ${{ strong: "强", soft: "中", faint: "弱", none: "隐藏（纯色块）" }[s.glyph]}`,
              value: "glyph",
            },
            { title: `会话页鱼群 · ${s.session ? "开" : "关"}（默认关）`, value: "session" },
            { title: `鲸鱼种类 · ${s.species === "orca" ? "虎鲸" : "座头鲸"}`, value: "species" },
            { title: `鲸鱼数量 · ${s.count}`, value: "count" },
            { title: `鲸鱼大小 · ${s.size}×`, value: "size" },
            { title: `游动速度 · ${s.speed}×`, value: "speed" },
            { title: `身体摆动幅度 · ${s.bodySwing}×`, value: "bodySwing" },
            { title: `转弯灵活度 · ${s.turnAgility}×`, value: "turnAgility" },
            { title: `摆尾频率 · ${s.tailFrequency}×`, value: "tailFrequency" },
            { title: `小鱼数量 · ${s.fishCount}`, value: "fishCount" },
            { title: `尾迹强度 · ${s.wake}`, value: "wake" },
            { title: `字符栅格 · ${s.gridScale}×`, value: "gridScale" },
            { title: `动画透明度 · ${s.opacity}`, value: "opacity" },
            { title: `海洋颜色 · ${s.color}`, value: "color" },
            { title: `彩色闪烁 · ${s.colorfulShimmer ? "开" : "关"}`, value: "colorfulShimmer" },
            { title: `眼睛底色 · ${s.eyeColor === "primary" ? "跟随主色" : s.eyeColor === "black" ? "黑色" : "白色"}`, value: "eyeColor" },
            { title: "恢复默认", value: "reset" },
            { title: "完成", value: "done" },
          ],
        })
        if (!pick || pick === "done") return
        if (pick === "enabled") await set((s) => void (s.enabled = !s.enabled))
        else if (pick === "animation") await set((s) => void (s.animation = s.animation === "koi" ? "whales" : "koi"))
        else if (pick === "glyph")
          await set((s) => {
            const order = ["strong", "soft", "faint", "none"] as const
            s.glyph = order[(order.indexOf(s.glyph) + 1) % order.length]!
          })
        else if (pick === "session") await set((s) => void (s.session = !s.session))
        else if (pick === "colorfulShimmer") await set((s) => void (s.colorfulShimmer = !s.colorfulShimmer))
        else if (pick === "reset") await set((s) => void Object.assign(s, DEFAULTS))
        else if (pick === "species") {
          const value = await context.ui.dialog.select({
            title: "鲸鱼种类",
            current: s.species,
            options: [
              { title: "座头鲸", value: "humpback" as const },
              { title: "虎鲸", value: "orca" as const },
            ],
          })
          if (value) await set((s) => void (s.species = value))
        } else if (pick === "eyeColor") {
          const value = await context.ui.dialog.select({
            title: "眼睛底色",
            current: s.eyeColor,
            options: [
              { title: "跟随主色", value: "primary" as const },
              { title: "黑色", value: "black" as const },
              { title: "白色", value: "white" as const },
            ],
          })
          if (value) await set((s) => void (s.eyeColor = value))
        } else if (pick === "count") {
          const value = await context.ui.dialog.select({
            title: "鲸鱼数量",
            current: s.count,
            options: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ title: `${n}`, value: n })),
          })
          if (value !== undefined) await set((s) => void (s.count = value))
        } else if (pick === "color") {
          const value = await context.ui.dialog.prompt({
            title: "海洋颜色",
            description: "十六进制颜色，例如 #4d6bfe",
            placeholder: "#4d6bfe",
            value: s.color,
          })
          if (value !== undefined) {
            const hex = value.trim().startsWith("#") ? value.trim() : `#${value.trim()}`
            if (/^#[0-9a-f]{6}$/i.test(hex)) await set((s) => void (s.color = hex.toLowerCase()))
            else context.ui.toast.show({ title: "ASCII 鲸鱼", message: "颜色格式应为 #rrggbb", variant: "error" })
          }
        } else {
          const presets: Record<string, { title: string; options: number[] }> = {
            size: { title: "鲸鱼大小", options: [0.6, 0.8, 1, 1.2, 1.6, 2] },
            speed: { title: "游动速度", options: [0.3, 0.45, 0.65, 0.8, 1, 1.5, 2] },
            bodySwing: { title: "身体摆动幅度", options: [0, 0.4, 0.8, 1.2, 2] },
            turnAgility: { title: "转弯灵活度", options: [0.3, 0.5, 0.7, 1, 1.5] },
            tailFrequency: { title: "摆尾频率", options: [0.4, 0.6, 0.8, 1, 1.5] },
            fishCount: { title: "小鱼数量", options: [0, 80, 170, 260, 400, 600] },
            wake: { title: "尾迹强度（0 隐藏）", options: [0, 0.5, 1, 2, 5] },
            gridScale: { title: "字符栅格（越大越有颗粒感）", options: [0.6, 0.8, 1, 1.3, 1.6] },
            opacity: { title: "动画透明度", options: [0.3, 0.6, 1] },
          }
          const preset = presets[pick]
          if (!preset) continue
          const current = (read() as unknown as Record<string, number>)[pick] as number
          const value = await context.ui.dialog.select({
            title: preset.title,
            current,
            options: preset.options.map((n) => ({ title: `${n}${n === current ? " · 当前" : ""}`, value: n })),
          })
          if (value !== undefined) await set((s) => void ((s as unknown as Record<string, number>)[pick] = value))
        }
      }
    }

    /** Generates (once) the translucent-composer theme and explains how to use it. */
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "whales.settings",
          title: "Whales: ASCII ocean settings",
          description: "让鲸群游过留白 — 数量、速度、颜色",
          group: "Whales",
          palette: true,
          slash: { name: "whales", aliases: ["whale"], arguments: true },
          suggested: true,
          run: (input) => void openSettings(input),
        },
        {
          id: "koi.feed",
          title: "Koi: feed the fish",
          description: "撒一把鱼食，看锦鲤聚过来抢食",
          group: "Whales",
          palette: true,
          slash: { name: "feed", aliases: ["koi"] },
          suggested: true,
          run: () => {
            if (activeKoi) activeKoi.feed()
            else
              context.ui.toast.show({
                title: "锦鲤",
                message: "锦鲤不在场 —— 回到首页再喂",
                variant: "error",
              })
          },
        },
      ],
    }))

    return context.ui.slot({
      append: "app",
      render: () => <WhalesLayer context={context} read={read} readPopulation={readPopulation} />,
    })
  },
})

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(hi, Math.max(lo, n))
}

// ------------------------------------------------------------------ layer

function WhalesLayer(props: {
  context: Context
  read: () => Settings
  readPopulation: () => {
    animation: "whales" | "koi"
    species: "humpback" | "orca"
    count: number
    size: number
    gridScale: number
    fishCount: number
  }
}) {
  const ctx = props.context
  const [size, setSize] = createSignal({ w: 0, h: 0 })

  const route = createMemo(() => ctx.ui.router.current())
  // home = full character ocean; session pages = color tiles, off unless
  // enabled in settings (the koi pond is home-only); plugin routes = hidden.
  const stage = createMemo<"home" | "session" | "off">(() => {
    const r = route()
    if (r.type === "home") return "home"
    if (r.type === "session") {
      if (props.read().animation === "koi") return "off"
      return props.read().session ? "session" : "off"
    }
    return "off"
  })

  // Structures on the page (the composer card and the logo wordmark): the
  // koi pond treats them as no-fish zones and dims the water around them.
  // The host's renderables are not a stable API — every lookup is defensive.
  const [avoid, setAvoid] = createSignal<{ x: number; y: number; w: number; h: number }[]>([])
  const findStructures = () => {
    const regions: { x: number; y: number; w: number; h: number }[] = []
    try {
      let composer: { x: number; y: number; w: number; h: number; area: number } | undefined
      let logo: { x: number; y: number; w: number; h: number } | undefined
      const walk = (node: any, depth: number) => {
        if (!node || depth > 12) return
        const x = Math.round(node.x ?? -1)
        const y = Math.round(node.y ?? -1)
        const w = Math.round(node.width ?? -1)
        const h = Math.round(node.height ?? -1)
        if (w > 0 && h > 0) {
          let bg = ""
          try {
            if (node.backgroundColor) bg = String(node.backgroundColor)
          } catch {}
          const alpha = /rgba\((?:[\d.]+,\s*){3}([\d.]+)\)/.exec(bg)?.[1]
          // Composer: a roomy, mostly-opaque box low in the layout.
          if (bg && (!alpha || Number(alpha) > 0.05) && y >= 4 && w >= 20 && h >= 3 && h <= 10 && w < 200) {
            const area = w * h
            if (!composer || area > composer.area) composer = { x, y, w, h, area }
          }
          // Logo: a wide, short text box in the upper half (ASCII wordmark).
          if (!bg && !composer && y >= 2 && y <= 20 && w >= 20 && w <= 90 && h >= 3 && h <= 12) {
            logo ??= { x, y, w, h }
          }
        }
        const kids = typeof node.getChildren === "function" ? node.getChildren() : []
        for (const k of kids) walk(k, depth + 1)
      }
      walk((ctx.renderer as any).root, 0)
      if (composer) {
        const { x, y, w, h } = composer as { x: number; y: number; w: number; h: number }
        regions.push({ x: x - 1, y: y - 1, w: w + 2, h: h + 2 })
      }
      if (stage() === "home" && logo) {
        const { x, y, w, h } = logo
        regions.push({ x: x - 2, y: y - 1, w: w + 4, h: h + 2 })
      }
    } catch {
      // Tree shape changed; the pond just swims without zones.
    }
    return regions
  }
  const refreshAvoid = () => {
    if (stage() === "off" || props.read().animation !== "koi") {
      setAvoid([])
      return
    }
    setAvoid(findStructures())
  }
  createEffect(refreshAvoid)
  const avoidTimer = setInterval(refreshAvoid, 2500)
  onCleanup(() => clearInterval(avoidTimer))

  const bg = createMemo(() => rgbaToHex(ctx.theme.background.base, ctx.themeMode === "dark" ? "#0a0a0a" : "#fafafa"))

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={-1}
      onSizeChange={function () {
        setSize({ w: this.width, h: this.height })
      }}
    >
      <Show when={props.read().enabled && stage() !== "off" && size().w >= 50 && size().h >= 14}>
        <OceanView
          read={props.read}
          readPopulation={props.readPopulation}
          themeMode={ctx.themeMode}
          bg={bg()}
          stage={stage()}
          avoid={avoid()}
          cols={size().w}
          rows={size().h}
        />
      </Show>
    </box>
  )
}

/** RGBA (@opentui/core) → #rrggbb, tolerating 0–1 and 0–255 components. */
function rgbaToHex(value: unknown, fallback: string): string {
  const v = value as { r?: number; g?: number; b?: number } | null | undefined
  if (!v || typeof v.r !== "number" || typeof v.g !== "number" || typeof v.b !== "number") return fallback
  const to255 = (c: number) => Math.max(0, Math.min(255, Math.round(c * (c <= 1 ? 255 : 1))))
  return `#${((1 << 24) | (to255(v.r) << 16) | (to255(v.g) << 8) | to255(v.b)).toString(16).slice(1)}`
}

// ------------------------------------------------------------------ ocean

function OceanView(props: {
  read: () => Settings
  readPopulation: () => {
    animation: "whales" | "koi"
    species: "humpback" | "orca"
    count: number
    size: number
    gridScale: number
    fishCount: number
  }
  themeMode: "dark" | "light"
  bg: string
  stage: "home" | "session"
  avoid: { x: number; y: number; w: number; h: number }[]
  cols: number
  rows: number
}) {
  const appearance = (): OceanAppearance => {
    const s = props.read()
    const dim = props.stage === "session" ? SESSION_DIM : 1
    return {
      dark: props.themeMode === "dark",
      speed: s.speed,
      wake: s.wake,
      color: s.color,
      colorfulShimmer: s.colorfulShimmer,
      eyeColor: s.eyeColor,
      bodySwing: s.bodySwing,
      turnAgility: s.turnAgility,
      tailFrequency: s.tailFrequency,
      opacity: Math.max(0.15, s.opacity * dim),
      bg: props.bg,
    }
  }

  // Population changes recreate the engine, exactly as background.mjs does.
  // Only population fields are read here; appearance is applied untracked so
  // a color or speed change never reseeds the world.
  const engine = createMemo(() => {
    const p = props.readPopulation()
    const app = untrack(appearance)
    let e: OceanEngine | KoiEngine
    if (p.animation === "koi") {
      // koi size/speed settings are normalised so their defaults (1.2 / 0.65)
      // reproduce the source site's scale and pace
      e = new KoiEngine({
        dark: app.dark,
        bg: app.bg,
        opacity: app.opacity,
        speed: p.speed / 0.65,
        size: p.size / 1.2,
        wake: app.wake,
        color: app.color,
        gridScale: p.gridScale,
      })
    } else {
      const sharks = Array.from({ length: p.count }, (_, i) => ({
        kind: p.species === "orca" ? ("orca" as const) : ("whale" as const),
        size: p.size * SIZE_RAMP[i % 6]!,
      }))
      e = new OceanEngine(sharks, app, p.fishCount, p.gridScale)
    }
    untrack(() => {
      e.resize(props.cols, props.rows)
      e.setMode(props.stage === "home" ? "glyphs" : "blocks")
      e.settle()
    })
    return e
  })

  createEffect(() => {
    const e = engine()
    if (!e) return
    if (e instanceof KoiEngine) {
      const a = appearance()
      e.setAppearance({
        dark: a.dark,
        bg: a.bg,
        opacity: a.opacity,
        wake: a.wake,
        color: a.color,
        glyph: GLYPH_FADE[props.read().glyph] ?? 1,
      })
    } else e.setAppearance(appearance())
  })
  createEffect(() => {
    const e = engine()
    if (e) e.setMode(props.stage === "home" ? "glyphs" : "blocks")
  })
  createEffect(() => {
    const e = engine()
    if (e instanceof KoiEngine) e.setGlass(props.avoid)
  })
  createEffect(() => {
    const e = engine()
    if (e) e.resize(props.cols, props.rows)
  })
  // expose the koi engine to /feed while it is on stage
  let koi: KoiEngine | null = null
  createEffect(() => {
    const e = engine()
    koi = e instanceof KoiEngine ? e : null
    activeKoi = koi
  })
  onCleanup(() => {
    if (activeKoi === koi) activeKoi = null
  })

  const [rows, setRows] = createSignal<readonly (readonly { text: string; fg: string; bg?: string }[])[]>([])
  let last = performance.now()
  const timer = setInterval(() => {
    const e = engine()
    if (!e) return
    const now = performance.now()
    setRows(e.tick(now - last))
    last = now
  }, TICK_MS)
  onCleanup(() => clearInterval(timer))

  const nodes = createMemo<JSX.Element>(() => {
    const out: JSX.Element[] = []
    const frame = rows()
    for (let y = 0; y < frame.length; y++) {
      if (y > 0) out.push("\n")
      for (const run of frame[y]!) {
        out.push(run.bg ? <span style={{ fg: run.fg, bg: run.bg }}>{run.text}</span> : <span style={{ fg: run.fg }}>{run.text}</span>)
      }
    }
    return out
  })

  return (
    <text selectable={false} wrapMode="none">
      {nodes()}
    </text>
  )
}
