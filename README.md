# ascii-whales · ASCII 鲸群与锦鲤

让鲸群游过留白，让锦鲤聚在首页抢食。OpenCode 版 [dsh-ascii-whales](https://github.com/Chael-Chael/dsh-ascii-whales)——
动画本体直接复用其 vendored 源码（上游 [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks)），
只把 Canvas 渲染后端换成了终端单元格。署名与改动范围见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

新对话的空白区域里，蓝色鲸群从字符之间游来：小鱼随水流散开、尾迹缓缓隐去、
座头鲸拖着长长的白色胸鳍。进入对话框、设置页等界面时装饰自动退场。

会话页默认无鱼群；想让它常驻的话，`/whales` → 打开「会话页鱼群」，
鲸群会以纯色块形态游在正文后面（不带字符，避免与正文混淆），并整体调暗。

## 锦鲤（koi pond）

`/whales` → 动画 → **锦鲤**（默认）。移植自 daoho.dev 首页的锦鲤池：

- 锦鲤沿 20 节脊柱摆尾游动，品种按权重随机——kohaku（红白）、sanke（红白黑斑）、
  tancho（头顶丹顶），斑块为 (脊长, 横向) 椭圆域 + 值噪声抖动；
- 逐格超采样 + 光照，红斑用六级明暗梯度，白身铺浅色瓦片并随时间微闪；
- **字符强度**：`/whales` → 字符强度，强 / 中（默认）/ 弱 / 隐藏——隐藏即纯色块锦鲤，
  只剩剪影和斑纹色块，一个字符都没有；
- 会饿：`/feed`（别名 `/koi`）撒一把鱼食，附近的锦鲤会加速聚过来，
  张嘴吞食时溅起水花（`*`→`+`→`.`），水面荡开双环涟漪；
- 没人喂也会每 30–60 秒自己落几粒食，偶尔冲刺、潜水、浮出水面；
- 输入框和 Logo 所在区域是"禁渔区"：鱼会绕开，附近海面略微调暗。
- 注意：锦鲤池只在**首页**（新会话画面）出现，会话页里不显示。

## 效果（与原版同源）

- **逐格超采样栅格化**：鲸身每个单元格按原版 `sampleShark` 分类为身体/鳍/背鳍/眼/边缘，
  亚采样覆盖度决定实体色块或轻字符边缘——即原版“字符色块”的观感，终端里用 fg 字符 + bg 色块呈现。
- **逐格光照**：背光面压深、受光面提亮（`bodyColor` 明暗梯度），字符疏密随明暗强化立体感（`:;t%SX8#@`）。
- **座头鲸 / 虎鲸**：上游鲸形几何（钝吻、宽背、弯曲长胸鳍、分叉尾叶）；虎鲸带白色眼斑与侧腹斑块。
- **鱼群模拟**：Reynolds/Couzin boids——分离/对齐/凝聚、盲区、惊恐传染、绕鲨“喷泉”规避、饵球盘旋；
  小鱼被吃掉后成群从边缘游回。
- **尾迹扩散**：能量场扩散衰减，点亮游过之处；捕食处有 `*` 涟漪。
- 默认 DeepSeek 蓝 `#4d6bfe`，深浅主题各自校准色板。

## 使用

- `/whales` — 打开设置（动画、种类、数量、大小、速度、摆幅、灵活度、摆尾、小鱼、尾迹、栅格、透明度、颜色、彩色闪烁、眼睛底色）
- `/feed`（`/koi`）— 撒鱼食，锦鲤会聚过来抢
- `/whales on` / `/whales off` / `/whales reset` — 直接命令
- 命令面板 `Ctrl+P` 搜 "Whales" 也可

设置持久化，跨重启保留；默认值与 dsh-ascii-whales 一致（3 条座头鲸、1.2×、0.65 速、170 小鱼）。

## 结构

```
vendor/
├── math.ts      # 上游：hash、smoothstep、无散度洋流（逐字复制）
├── species.ts   # 上游：沙丁鱼/鳀鱼/银汉鱼/鲭鱼/虾虎鱼种群参数（逐字复制）
├── whales.ts    # 上游：座头鲸/虎鲸几何（逐字复制）
├── world.ts     # 上游：鱼群 + 捕鲸模拟（逐字复制，含构造参数属性微调）
├── renderer.ts  # 上游渲染器的终端移植：栅格化数学保留，绘制走终端单元格
├── engine.ts    # 上游引擎的定时器移植：1/60s 固定时步 + 摆尾墙钟校准
└── koi.ts       # 锦鲤池：daoho.dev 的 Canvas 实现的终端移植（世界模拟 + 光栅化）
tui.tsx          # OpenCode 插件接入：app slot 底层、空白对话可见性、/whales 设置、/feed 投喂
index.ts         # server 入口占位
```

终端小于 50×14 时自动隐藏；超宽终端上模拟世界按原版 hero 画布比例（约 1.45:1）取景居中、两侧留白，鲸鱼不会贴边游。实测约 7ms/帧（120×40），客户端 CPU 约 4–5%。

## 安装

把本目录复制到 OpenCode 的插件目录即可：

```sh
git clone https://github.com/dakfjalka/opencode-ascii-whales \
  ~/.config/opencode/plugins/ascii-whales
```

插件依赖 `@opencode-ai/plugin`（类型与入口桩）。若 TUI 里提示模块找不到，在
`~/.config/opencode` 下装一次：

```sh
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

重启 `opencode`，首页即见锦鲤（或 `/whales` 切回鲸群）。

## 鸣谢

- [dsh-ascii-whales](https://github.com/Chael-Chael/dsh-ascii-whales)（DeepSeek Harness 版）与上游
  [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) —— 鲸群动画本体
- [daoho.dev](https://www.daoho.dev/) —— 锦鲤池动画的原始实现

详细出处与改动范围见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
