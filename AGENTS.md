# AGENTS.md

给在本仓库工作的编码代理（以及人类协作者）的项目说明。

---

## 1. 这是什么

**Cube Music** —— 一个 16×16 五声音阶音序器（灵感来自 warma）。

它同时是对 `Cube-Music.exe` 尾部内嵌 Flash 程序（**Hobnox AudioTool / ToneMatrix**，2009）
的 Web 重构：原程序已通过自研 AVM2 反汇编器完整逆向，本仓库按逆向结论 1:1 重写，
并在其上做了若干产品化调整（见 §8）。

用户可见的品牌名是 **Cube Music**；代码注释与 §5 里的常量仍以原程序类名标注来源，
这是刻意保留的溯源信息，不要一并改掉。

**技术约束（请勿引入例外）**

- 原生 JavaScript，**ES5 风格**（`var` / `function` / 无箭头函数、无 `let/const`）
- **无框架、无构建、无依赖、无包管理器**。不需要 `npm install`，没有 `node_modules`
- 使用**普通 `<script>` 标签**按依赖顺序加载，**不使用 ES Module**
  —— 这样直接双击 `index.html`（`file://`）也能运行，不受 CORS 限制
- 音画渲染只用 Canvas 2D + Web Audio API

## 2. 运行与验证

```bash
# 直接打开（推荐，零依赖）
open index.html

# 或起本地服务
python3 -m http.server 8000
```

改动后**必须**跑回归。用无头 Chrome 抓 DOM 断言：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --virtual-time-budget=15000 --user-data-dir=/tmp/tm-check \
  --dump-dom "file://$PWD/test/selftest.html"
```

结果在 `<pre id="results">` 里。**必须全部通过（当前 63 项），不允许出现 FAIL / JS ERROR / WATCHDOG。**

页面级交互回归（文案 / 空格键 / 涟漪开关 / 点按涂抹）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=25000 \
  --user-data-dir=/tmp/tm-ui \
  --dump-dom "file://$PWD/test/interaction.html"
```

结果在 `<pre id="out">` 里（当前 40 项）。这个测试靠 iframe 加载 `index.html?debug=1`，
断言建立在模型状态上，**不要改成采样渲染后的像素**（原因见 §10）。

视觉回归（渲染是否被改坏）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --force-device-scale-factor=2 --virtual-time-budget=6000 --user-data-dir=/tmp/tm-vis \
  --dump-dom "file://$PWD/test/visual.html"
```

会输出 `log`（均值/峰值/活跃格数）和 `lum`（画布 16×16 亮度采样，便于逐格核对）。

## 3. 文件地图

```
index.html            页面骨架 + 脚本加载顺序（constants → grid → audio → sequencer → renderer → app）
style.css             视觉风格（纯黑底 + 浅灰方块）
src/constants.js      全部常量、音阶表、包络曲线。数值均出自字节码，改动前先读 §5
src/grid.js           16×16 音符网格（对应 toneMatrix::Pattern）
src/audio.js          音频引擎：振荡器 / 包络 / 声像 / 反馈延迟 / 速度联动
src/sequencer.js      步进音序器。**整条链路的唯一时基**，见 §4
src/renderer.js       Canvas 渲染：格子图层 + 波动场 + ADD 辉光
src/app.js            装配、输入、主循环（固定步长）
test/selftest.html    63 项断言（含离线音频渲染、波场稳定性）
test/interaction.html 40 项页面级交互断言（iframe + ?debug=1）
test/sharp.html       格子边缘锐度探针（读图层像素）
test/perf.html        渲染开销探针（?cell=&wave=&wblur= 可切配置做 A/B）
test/visual.html      渲染回归 + 亮度量化
test/wave.html        波场结构 ASCII 可视化
test/diag.html        频率/节点诊断
```

`index.html?debug=1` 会在 `window.__cubeMusicDebug` 上暴露 `grid / audio / sequencer / renderer`。
**不带该参数时不会挂任何全局变量** —— 保持生产环境干净，改动时别把这条去掉。

## 4. 核心架构：单一时基

**音序器是所有时间相关行为的唯一真相来源。**

每次把一步排进音频时钟时，都会把 `{step, time}` 记入 `Sequencer.timeline`；
视觉层用 `Sequencer.audibleStep()` 反查「此刻耳朵听到的是哪一步」。

```
排程 ──> timeline[{step,time}] ──> audibleStep() ──> renderer.composite()
```

- **不要**改用「起点 + 步长 × n」这类公式去推算播放位置。它在两种情况下必然错位：
  1. 改速度时整条时间轴会整体错位；
  2. 起点与首步之间存在启动延迟（`START_DELAY`）。
- 延迟补偿：`ctx.currentTime` 是音频图的**写入头**，写进去的样本还要再过
  `outputLatency` 才从扬声器出来。所以「听到的位置」= `currentTime − outputLatency`。
  **符号不要写反。**
- 改速度**不需要**做任何重新对齐：已排的步保持不变，之后新排的步用新步长，
  反查自然连续。

**凡是与时间有关的量，都必须从速度派生，不能写死。** 历史上踩过的坑：
反馈延迟时长曾被写死成 120 BPM 的 375 ms，导致非 120 BPM 时回声脱离步网格、
听起来「不合拍」。正确做法是 `DELAY_BARS × barSeconds(tempo)`（= 恒为 3 步）。

## 5. 不可随意改动的量（字节码实证）

这些值来自对原 SWF 的 AVM2 反汇编，改动等于偏离原作。要改请先说明理由。

```
采样率 44100 / 速度 120 BPM / 每小节 16 步
音符时长 22050 采样 = 0.5 s
包络 amp(t) = (0.4·(1−t/T))²，峰值 0.16（注意是平方，不是指数衰减）
声像 L=(1−r)/(1+|r|), R=(1+r)/(1+|r|)，r = rand − rand
复音上限 128
延迟 3/16 小节，反馈 0.4，湿声 0.06，干声 1.0，±12 采样三角波微调制
音阶 NOTES[16] = 96,93,91,89,86,84,81,79,77,74,72,69,67,65,62,60
      → D 大调五声 A–B–D–E–F#（A6→A3），行 0 音最高
频率 f = 440 · 2^((note − 72)/12)
网格 16×16 / 格子 32px / 画布 512×512
配色 背景 #000000，关 #333333（= #EEEEEE − #BBBBBB），开 #EEEEEE
波场 v = (0.5·Σ四邻域 − v_prev) · 0.85   ← ×0.85 作用于整个括号，只乘 v_prev 会指数发散
```

## 6. 渲染约定

- **离屏图层按设备分辨率渲染**（`512 × min(devicePixelRatio, 3)`），主画布绘制时把坐标
  缩回 512 逻辑空间，使位图与屏幕像素 **1:1**。不要引入二次重采样 —— 曾经因此整片糊掉。
  唯一例外是**波纹层**：它本来就要被大半径模糊，固定 512 就够，按设备分辨率渲染纯属浪费面积。
- 离屏层**不使用 `setTransform`**，坐标直接乘 `scale`。这既避开 `ctx.filter` 半径的
  单位歧义，也保证像素对齐。
- **格子不模糊**（`BLUR_CELL = 0`），纯平直角。不要照搬原版的 `BlurFilter(3)`：
  那是作用在 512 逻辑空间的，在 2x 屏上会变成 6 设备像素并填满 6px 的格子间隙，整体糊成一片。
- **格子改动只重绘那一格**（`drawCell`），不要整层重绘。模糊关闭时方块完全落在自己
  32px 的格子里，局部重绘精确且几乎零成本；整层重绘要付 256 个方块的钱。
  `test/selftest.html` 有断言守住「局部重绘 == 整层重绘」这个不变式。
  > 如果哪天要把 `BLUR_CELL` 调回 > 0，`drawCell` 会自动回退成整层重绘（模糊会溢出格子，
  > 局部重绘不再精确）。此时必须接受拖动变卡，或者改用带 padding 的区域重绘。
- 波场用**固定步长**（`app.js` 的 `SIM_DT = 1/60`）推进，与显示刷新率解耦，
  否则 60Hz 与 120Hz 屏上涟漪速度不一致。
- **暂停时不得注入种子**：`renderer.simulate(step, seed)` 的 `seed` 必须传
  `sequencer.playing`。被注入的格子当帧会失去回正项（`−mapB` 变成常量 `+1`），
  等价于一个对邻域求和的积分器；步号冻结时同一列被无限次重复激励，
  波场会**指数爆炸**（实测 3000 帧达 `1e283`），叠加 ADD 辉光后铺满整屏。
  停止注入后涟漪只做传播 + 阻尼衰减，约 1 秒内自然消失（实测 3 秒内
  从 13.556 降到 0.000005）。正常播放是有界的（60 秒实测峰值 4.16 且无爬升趋势）。
- Canvas 2D 没有 `subtract` 合成模式，所以「底图 + 减淡」两层按公式预计算颜色后直接上色。

## 7. 输入约定

- **绘制与音频启动解耦**：`pointerdown` 必须**同步**上色，不能等 `AudioContext` 就绪。
  音频在后台异步启动。
- 拖动时用 `Grid.prototype.paintLine(from, to, value)` 补齐两次事件之间跳过的格子。
  契约是**涂 `(from, to]`** —— 含终点、不含起点（起点那格上一轮已经画过）。
- 用 `e.getCoalescedEvents()` 取回被浏览器合并掉的中间移动点，否则快速拖动会漏格。
- 缓存的画布矩形（`getBoundingClientRect`）在 `resize` / `scroll` 后必须失效重取。
- `.overlay.hidden` 必须带 `pointer-events: none`：`visibility` 的过渡是离散步进，
  会一直保持 `visible` 到过渡结束，这期间遮罩仍在吞指针事件（启动后 250ms 内拖拽全失效）。

**快捷键与开关（当前约定）**

| 操作 | 绑定 |
|---|---|
| 空格 | **暂停 / 继续**（`togglePlayback()`）。清空**没有**快捷键，只有按钮 |
| 左键点击 / 拖动 | 开关方格 |
| **右键方格** | **试听该格的音**（`audition()`）—— **只发声**，不改图案、不给该格任何视觉变化 |
| `#btn-toggle` | 播放 / 暂停 |
| `#btn-clear` | 清空 |
| `#btn-wave` | 开关涟漪辉光 |
| `#btn-playhead` | 开关播放列高亮 |

- **`pointerdown` 必须判断 `e.button !== 0` 就返回。** 浏览器在右键时会**先**派发
  `pointerdown(button=2)` 再派发 `contextmenu`；不判断按键的话，右键会先把格子翻转，
  然后才发出试听的声音。任何"只有左键才应该生效"的指针处理都要加这道闸。
- 试听的 `contextmenu` 监听挂在 `.canvas-wrap` 上而不是 `canvas` 上：启动前遮罩层
  盖在 canvas 上方，只监听 canvas 会让第一次右键落到遮罩上并弹出浏览器菜单。
- 试听**不要**加视觉反馈。曾用 `renderer.pulse()` 在该格打一圈涟漪，
  实际观感是那个暗格"变亮了"，用户会以为右键改动了格子的黑/白状态。

- 播放状态以 `sequencer.playing` 为唯一真相，按钮文案由 `syncPlayButton()` 派生，
  不要在事件处理里各自维护一个布尔量。
- 显示开关统一用 `.btn.toggle` 组件：**用 `aria-pressed` 表示状态**（圆点亮度 + 整块明暗），
  **文案里不写「开/关」**，避免按钮宽度随状态跳动。`setWave()` / `setPlayhead()`
  是唯一入口，状态各自以 `renderer.showWave` / `renderer.showPlayhead` 为准。
- 控件布局固定为两行（`.ctl-actions` / `.ctl-fields`），参数行是
  `标签 | 滑块 | 数值` 的三列网格 —— 不要在按钮行里混排滑块，否则换行不可控。

## 8. 已知的有意偏差（相对原作）

1. **未加限幅器。** 原作多声部直接相加后由驱动钳位；这里同样直接相加，由 `destination` 钳位。
   不要加 `WaveShaper` 软限幅：其 `oversample` 会引入明显振铃（实测主频不变但混入高频）。
2. **拖动涂抹语义。** 原作 `mouseMove` 复用 `mouseDown` 的 toggle，拖动经过同一格会反复翻转；
   这里改成「按下时决定目标值，拖动时统一写入」。
3. **播放列高亮。** 原作没有显式播放头（靠波纹提示位置）。这里加了一条极淡的列高亮作为辅助，
   可在控件区关闭。
4. **方块不做模糊**（见 §6），纯平直角，用于修正高 DPI 下的糊化与拖动卡顿。
5. **品牌改为 Cube Music**，页面上标注「灵感来自 warma」。原作名为 Hobnox AudioTool / ToneMatrix。
6. **空格键改为暂停 / 继续**，清空不再占用快捷键（原作空格是清空）。
   清空只剩按钮入口 —— 这是刻意去掉的，别"顺手加回来"。
7. **涟漪辉光可开关**（`#btn-wave`）。原作没有这个开关，辉光始终开启。
8. **右键试听**。原作没有这个交互。右键某一格会单独播一次该格的音（走同一条
   发声链路，含延迟），**不改动图案，也不给该格任何视觉变化**。

## 9. 提交约定

- **作者身份固定为** `haruki <harukiinharu@gmail.com>`（已写入本仓库的 local config）。
  提交前确认 `git config user.name` / `user.email` 正确，**不要出现其他身份**。
- 提交信息用**中文**，采用 Conventional Commits 前缀：
  `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `test:` / `chore:`
- 正文写清「问题 → 根因 → 改动 → 实测数据」。视觉/音频类改动**必须附量化证据**
  （探针读数、离线渲染测量值、测试通过数），不要只说"看起来好了"。
- 每次提交前跑通 §2 的回归。

## 10. 调试技巧

- 验证画布视觉问题**不要**在合成结果上做灰度统计 —— 辉光梯度会污染测量。
  应直接读对应图层的 `getImageData`（见 `test/sharp.html`）。
- **页面级测试不要断言渲染后的像素**。无头环境里 rAF 与 `setTimeout` 的推进节奏不一致：
  定时器可能跑得飞快而合成帧还没发生，固定等待与轮询都会拿到过期画面。
  用 `index.html?debug=1` 暴露的 `__cubeMusicDebug` 直接读模型状态；
  需要验证渲染链路时**显式调一次 `renderer.composite()`** 再读像素。
- **轮询 `waitFor` 会误判**：拿初始 HTML 文案当目标值时（如按钮默认就写着「暂停」），
  条件立刻成立，等于没等。要等**状态量**（`sequencer.playing`），不要等派生的文案。
  同理 `audio.ready` 在 `buildGraph` 里就置位了，早于 `sequencer.start()`，不能拿它当"启动完成"。
- **量 canvas 性能必须强制同步**：`getImageData(0,0,1,1)`，且要同步**对应的那个 canvas**
  （只 flush 主画布量不到离屏图层的工作）。否则 `performance.now()` 只统计到 JS 提交时间，
  会得到 0.27ms 这类假数据。
- 无头环境下 **`OfflineAudioContext` 只渲染一次**，第二次 `startRendering()` 不会推进
  （会卡住）。需要多个渲染场景时，合并到一次渲染里，或用单元测试覆盖。
- 截图核对：`--headless=new --force-device-scale-factor=2 --screenshot=...`，
  再用 Pillow 做像素分析。
- macOS **没有 `timeout` 命令**，用了会 `exit 127` 且无输出，别误判成"页面挂了"。
- 画面「逐渐被填满 / 发白」这类问题，**先量模型状态，不要盯着截图猜**：
  把波动场 max 值按帧打印出来（见 `test/wave.html` 场景 D/E/F），
  能立刻区分是「衰减不动」还是「被持续驱动」，也能顺手确认正常播放是否有界。
- **探针本身也会写错**，跑之前先自检两件事：索引对不对（`stepDiffusion(n)` 播种的是
  `n+1` 列，不是 `n` 列）、单位/取整有没有吃掉信号（`Math.round(0.85)` = `1`，
  会让你以为场是空的；要用 `Math.round(v * 1000) / 1000`）。
- **模拟用户操作要按真实事件序列派发**。右键在浏览器里是
  `pointerdown(button=2)` **加** `contextmenu` 两个事件；只派发后者测不出
  "右键把格子翻转了" 这类 bug（曾经就这么漏掉了）。拖动同理，是
  `pointerdown` + 若干 `pointermove`。
- **写完回归测试，把修复撤掉再跑一遍**，确认它确实会失败。
  不会失败的回归测试等于没写。撤掉后失败的条目数应与新增断言数吻合。
