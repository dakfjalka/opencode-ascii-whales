# Third-party source

本插件的动画**直接复用** [dsh-ascii-whales](https://github.com/Chael-Chael/dsh-ascii-whales)（DeepSeek Harness 版）
及其上游 [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) 的源码。

- 本地源码：`vendor/`（`math.ts`、`species.ts`、`whales.ts`、`world.ts` 为逐字复制，仅把相对导入补上 `.ts` 扩展名；
  `renderer.ts`、`engine.ts` 保留上游全部模拟/栅格化数学，仅将 Canvas 绘制后端替换为终端单元格）
- 保留：固定时步引擎、鱼群 Reynolds/Couzin 行为、捕食模拟、柔性脊椎、逐格超采样栅格化、光照与字符明暗、尾迹扩散
- 适配：终端单元格输出（fg 字符 + bg 色块，对应原版 fillText + fillRect）、alpha 颜色向终端背景色混合、
  虚拟像素网格按终端 1:2 单元比例校正（ch = cw×2）、OpenCode TUI 插件接入与可见性规则
- 上游快照本身无独立 LICENSE 文件；其作者署名保留于此与代码注释中。dsh-ascii-whales 项目的 MIT 许可
  适用于其原创集成部分，不重新许可上游源码。虎鲸/座头鲸几何、明暗与颜色体系均为上游/DSH 改编成果。

如需原生 Canvas 版本、汉字/Kanji 字符风格或更多设置项，请参考上游项目。

# 锦鲤（koi pond）

`vendor/koi.ts` 与锦鲤相关的 TUI 接入**移植自** [daoho.dev](https://www.daoho.dev/)（Dao Ho
个人首页的锦鲤池动画，Next.js/Canvas 实现），已在 `koi.ts` 文件头注明出处。

- 保留：20 节脊柱柔性鱼体与行波摆尾、kohaku / sanke / tancho 品种与椭圆斑块体系、
  逐格超采样与光照、觅食/抢食/惊逃/好奇/分离行为、鱼食颗粒、双环涟漪、尾迹扩散、
  影子偏移、`t%SX8@#` 字符体系与方向字符、固定时步循环
- 适配：Canvas 画布 → 固定字符网格（细胞 = 虚拟像素），canvas alpha 合成 → 向终端
  背景色预混合，DOM `[data-koi-avoid]` 避让区 → 宿主渲染树探测的输入框/Logo 区域，
  指针交互 → `/feed` 命令投喂 + 周期性自动投喂，`prefers-reduced-motion` → 交由宿主
  动画设置
- 原站代码未见显式开源许可；本移植仅用于学习与个人终端装饰，署名保留于此。
  锦鲤美术与行为体系归原作者 Dao Ho 所有。
