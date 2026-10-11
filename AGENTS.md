# AGENTS.md

给在本仓库工作的编码代理（以及人类协作者）的项目说明。

---

## 1. 这是什么

**Cube Music** —— 一个 16×16 五声音阶音序器（灵感来自 warma）。

它同时是对原版 Flash 程序（**Hobnox AudioTool / ToneMatrix**，2009，内嵌在
`Cube-Music.exe` 尾部）的 Web 重构：原程序已通过自研 AVM2 反汇编器完整逆向，
本仓库按逆向结论 1:1 重写，并在其上做了若干产品化调整（见 §8）。

> 逆向用的原始文件（`.exe` / `.swf`）、反汇编工具与分析文档**不在本仓库内**
> （它们已移到仓库外的归档目录）。因此 §5 里那些常量没有可再生的推导过程 ——
> 它们是从字节码里读出来的既成事实，改之前请格外谨慎。

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

结果在 `<pre id="results">` 里。**必须全部通过（当前 117 项），不允许出现 FAIL / JS ERROR / WATCHDOG。**

页面级交互回归（文案 / 空格键 / 涟漪开关 / 点按涂抹）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=25000 \
  --user-data-dir=/tmp/tm-ui \
  --dump-dom "file://$PWD/test/interaction.html"
```

结果在 `<pre id="out">` 里（当前 110 项）。这个测试靠 iframe 加载 `index.html?debug=1`，
断言建立在模型状态上，**不要改成采样渲染后的像素**（原因见 §10）。

大面板回归（32 行 × 64 列，即 `large.html` 那条入口）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=30000 \
  --user-data-dir=/tmp/tm-large \
  --dump-dom "file://$PWD/test/large.html"
```

结果在 `<pre id="out">` 里（当前 93 项）。它盯的是**矩形网格相对正方形多出来的
失败模式**：一维数组拿错 stride、音序器 `% GRID` 提前归零、行扫描写死 16 行、
命中测试写死 `CFG.GRID`、波场维度接反。每一条都做过变异验证（见 §10）。

视觉回归（渲染是否被改坏）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --force-device-scale-factor=2 --virtual-time-budget=6000 --user-data-dir=/tmp/tm-vis \
  --dump-dom "file://$PWD/test/visual.html"
```

会输出 `log`（均值/峰值/活跃格数）和 `lum`（画布 16×16 亮度采样，便于逐格核对）。

## 3. 文件地图

```
index.html            原版入口（16×16）。脚本顺序：constants → grid → audio → sequencer → renderer → storage → app
large.html            大面板入口（36×64，半音阶）。比上面多一层 large-config，见 §12
style.css             视觉风格（纯黑底 + 浅灰方块）。.stage-wide 是大面板的宽版布局
src/constants.js      全部常量、音阶表、包络曲线 + TM.RUNTIME（运行时维度）。改动前先读 §5
src/large-config.js   只被 large.html 加载：把 TM.RUNTIME 覆盖成 48 行 × 64 列。见 §12
src/grid.js           音符网格（对应 toneMatrix::Pattern）。维度取自 TM.RUNTIME
src/audio.js          音频引擎：振荡器 / 包络 / 声像 / 反馈延迟 / 速度联动
src/sequencer.js      步进音序器。**整条链路的唯一时基**，见 §4
src/renderer.js       Canvas 渲染：格子图层 + 波动场 + ADD 辉光
src/storage.js        乐谱的编解码 + localStorage 存档。见 §13
src/app.js            装配、输入、主循环（固定步长）。两套入口共用这一份
test/selftest.html    117 项断言（离线音频渲染、波场稳定性、描边不变式、乐谱编解码、暂停续播）
test/interaction.html 110 项页面级交互断言（iframe + ?debug=1）
test/large.html       93 项大面板断言（矩形网格的 stride / 取模 / 命中 / 波场维度）
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

**暂停 / 继续不重置步号。** `currentStep` 的语义是「**下一个待排的步**」：

- 构造函数里是 0 → 首次播放自然从头开始，**不需要**在 `start()` 里再置零；
- 播放中它指向下一步，`stop()` 只停计时器、不动它；
- 于是 `start()` 接着往下排就是「继续」。

**不要在 `start()` 里写 `currentStep = 0`** —— 空格键与播放按钮都是「暂停 / 继续」
语义，归零会让每次继续都从头重放（踩过这个 bug）。真要「回到开头重播」，
单写一个方法，别塞回 `start()`。`test/selftest.html`（单元）和
`test/interaction.html`（页面级）各有一条断言守着「继续是接着排，不是从 0 排」。

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

以上量都与网格规格无关，两种面板共用。**`CONFIG.GRID` / `CONFIG.NOTES` /
`CONFIG.RESOLUTION` 描述的是原版规格**，`test/selftest.html` 直接断言它们等于
16 / 16 / 16 —— 要做别的规格的面板，**不要动这三个值**，去改 `TM.RUNTIME`（见 §12）。

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
| 空格 | **暂停 / 继续**（`togglePlayback()`）。继续是**接着播**，不回到第 0 步（见 §4）。清空**没有**快捷键，只有按钮 |
| 左键点击 / 拖动 | 开关方格 |
| **右键方格** | **试听该格的音**（`audition()`）—— 发声 + 套一圈白色描边，**不改图案、不改填充色** |
| `#btn-toggle` | 播放 / 暂停 |
| `#btn-clear` | 清空 |
| `#btn-wave` | 开关涟漪辉光 |
| `#btn-playhead` | 开关播放列高亮 |
| `#btn-share` | 展开 / 收起「谱子」面板（导出代码 / 粘贴载入），见 §13 |
| **点 / 拖棋盘上方的位置标尺** | **移动播放游标**（`sequencer.seek()`）—— 按住拖动即擦洗 |
| **⌘/Ctrl + Z** | 撤销 |
| **⌘/Ctrl + ⇧ + Z**（或 `Ctrl+Y`） | 反撤销 |
| **Alt + 左键拖动** | 拉框选择一块矩形 |
| **选区内按住左键拖** | 整块搬走（夹在棋盘内，拖不出去） |
| **A** / **X** | 把选区填满 / 清空 |
| **Esc** | 取消选择（点选区外也一样） |

- **框选**：选区就是一块矩形（`renderer.selection`，已归一化）。Alt+拖画框；
  框内按住左键整体搬走；A 填满、X 清空、Esc 取消。
  点**选区外**会先取消选择再照常涂抹 —— 和图像编辑器的习惯一致。
  - **取消选择有三条路，缺一不可**：① 点画布内、选区外（同时照常涂抹）；
    ② 点**画布外**的页面留白；③ Esc。
    ② 必须靠一条**文档级的 `pointerdown`**（`global.addEventListener`）——
    画布外那些留白上的事件根本不在 canvas 上；就算勉强落到 canvas，
    `cellAt()` 也会因为坐标越界返回 `null` 直接 `return`，选区就杵在那儿不动。
    **踩过**：只写了 ①，用户点四周一大片留白时选区不消失。
    控件区（`.controls` / `.ruler`）要豁免，否则调速度、按播放都会把选区弄丢。
  - **拖动状态（`dragMode` / `dragAnchor` / `move*`）声明在模块级，不在 `bindInput` 里。**
    `applyMove()` 这些 helper 定义在 `bindInput` **外面**；声明在里面的话 helper 访问到的
    是未声明变量，在 `'use strict'` 下直接抛 ReferenceError，而事件处理里的异常会被静默
    吞掉 —— 表现成「按下去什么也没发生」，极难查。**踩过一次。**
  - **搬动每次都从按下那一刻的整张谱子（`moveBase`）重算**，不在上一次结果上叠加。
    位移还要按选区尺寸夹在棋盘内（`Math.max(-s.col0, Math.min(dc, cols-1-s.col1))`），
    否则拖出边界时 `Uint8Array` 会静默丢弃越界写入、整块悄悄缺一块。
  - **选区高亮是青色的（`CONFIG.COLORS.select`），这是本项目新增的色相**：
    原版只有黑白灰，不留个颜色的话「选中区域」和「亮着的格子」分不出来
    （尤其选了一片全是亮格的区域）。它是**交互状态**，画在合成层最上层
    （辉光之上，`_drawSelection`），**不碰格子图层**。

- **撤销的粒度是「一次操作」，不是「一格」。** 快照在**操作开始时**拍
  （画布 `pointerdown` / 清空 / 载入），所以按住拖过一整条只占一步。
  历史里直接存整张 grid 的副本（16×16 = 256 B、64×48 = 3 KB），上限 60 步 ——
  为省这点内存去做增量记录不划算。
  空谱子上点「清空」不占步骤（`if (!grid.any()) return`），否则会攒出一串空撤销。
- **焦点在 `input` / `textarea` 里时 ⌘Z 要放行给浏览器**（判 `e.target.tagName`），
  否则在「谱子」面板里按 ⌘Z 会去撤销棋盘，很出戏。
- **「谱子」面板里的代码是实时同步的**：`grid.onChange` → `refreshShare()`。
  但**只在面板里那段内容没被用户改过时**才刷新（`shareCode.value === shareEncoded`
  才刷）—— 否则用户正在往里粘别人的代码，改一下格子就被冲掉了。

- **启动遮罩只解锁音频，不自动播放。** `boot()` **不**调用 `sequencer.start()` ——
  刷新后自己就放起来很吵，用户要的是先看着谱子、想听了再按播放。
  「播放」按钮与空格走的是 `togglePlayback()`，它才是**解锁 + 真的播**那条路。
  改这两者时注意别把「第一次点播放」也变成只解锁。
- **播放游标可以用鼠标拖。** 棋盘上方那条标尺（`#ruler`）宽度 = 棋盘宽度，
  所以「点在标尺的哪一处」直接对应「第几列」。实现见 `app.js` 的 `bindRuler()`：
  pointer capture 做按住擦洗；`seekFromEvent()` 除了 `sequencer.seek()` 还要同步
  `renderer.stepIndex` —— 否则**暂停时游标不会动**（主循环在 `audibleStep()`
  返回 null 时会退回 `renderer.stepIndex`）。
  大面板里标尺是 `.board-frame` 内的 `position: sticky`：纵向吸顶（滚到棋盘
  下半部分也够得着），横向跟着棋盘一起滚（所以位置始终对着同一列）。

- **`pointerdown` 必须判断 `e.button !== 0` 就返回。** 浏览器在右键时会**先**派发
  `pointerdown(button=2)` 再派发 `contextmenu`；不判断按键的话，右键会先把格子翻转，
  然后才发出试听的声音。任何"只有左键才应该生效"的指针处理都要加这道闸。
- 试听的 `contextmenu` 监听挂在 `.canvas-wrap` 上而不是 `canvas` 上：启动前遮罩层
  盖在 canvas 上方，只监听 canvas 会让第一次右键落到遮罩上并弹出浏览器菜单。
- **试听的视觉反馈必须是描边，不能是填充。** `renderer.flash(col, row)` 只在格子边距
  （黑底）上画一圈白色描边，所以明格暗格都看得见。
  - 反例一：用波动场涟漪（已删除的 `renderer.pulse()`）—— 暗格整体变亮，像被点开了。
  - 反例二：把描边画成填充白块 —— 就是直接改了格子的颜色。
  - `test/selftest.html` 有断言守着「填充色不变」（实测描边前后都是 51），
    撤掉成就会失败，别绕过去。

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
   发声链路，含延迟），并在该格套一圈白色描边提示「按的是这一格」；
   **不动图案，也不改格子填充色**。

## 9. 提交约定

- **作者身份固定为** `haruki <harukiinharu@gmail.com>`（已写入本仓库的 local config）。
  提交前确认 `git config user.name` / `user.email` 正确，**不要出现其他身份**。
- 提交信息用**中文**，采用 Conventional Commits 前缀：
  `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `test:` / `chore:`
- 正文写清「问题 → 根因 → 改动 → 实测数据」。视觉/音频类改动**必须附量化证据**
  （探针读数、离线渲染测量值、测试通过数），不要只说"看起来好了"。
- 每次提交前跑通 §2 的回归。
- **改完即提交并推送**：仓库所有者要求「每次更改完之后，自动 commit 然后 push」，
  不需要逐次征求确认。除非用户明确说「先别提交」「这次不要推」。
  推完顺手确认一下 Actions（`gh run watch`），部署失败要立刻报告。

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
- **性能探针：一个浏览器进程只测一个配置，并多轮取中位数。** 在同一页面里连着量
  两种规格，第二组会被前一组拖慢 —— 实测同一操作给出过 12.9 / 28.0 / 76.4 ms
  三种结果（差 2.7 倍），是显存压力下的降级，不是被测代码的问题。
  模板：`?which=small|large` 由 query 选配置 → 每配置单起一次无头 Chrome →
  热身 4 轮 × 10 次 → 采样 9 轮 × 10 次 → 报中位数/最小/最大。
  **单次读数一律不可信**，宁可多花 30 秒起两个进程。
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
- **负向断言先确认前置状态是非平凡的。** 「删除之后数量不变」「撤销之后没变化」
  这类断言，如果被作用的对象**本来就是空的**，撤掉实现也照样绿 —— 等于没写。
  已经踩过两次：在空时间轴上验证「seek 清空时间轴」，在空选区里验证
  「焦点在输入框时 X 不动选区」。**先断言前置状态（`count === 2`），再断言结果。**
  变异验证就是用来抓这种假断言的 —— 它专门暴露「撤掉实现也不红」。
- 改速度相关的逻辑时，重点验证 60 / 90 / 120 / 180 / 240 BPM 五个点。

## 11. 发布与部署

- **在线地址**：<https://harukiinharu.github.io/cube-music/>
- **远程**：`origin` = `github-haruki:harukiinharu/cube-music`（SSH 别名，认证身份 `harukiinharu`）。
  ⚠️ 本机 `gh` CLI 登录的是**另一个账号**，对该仓库只有读权限 —— 所以
  **推送走 git/SSH 没问题，但任何仓库设置（启用 Pages、改 Actions 权限）都得在网页端操作**。
  仓库内已写入 `core.sshCommand = "ssh -o IdentityAgent=none"`，**不要删**：本机 ssh-agent
  是坏的（`SSH_AUTH_SOCK` 指向一个无人应答的 launchd listener），不加这个选项 `git push`
  会静默挂死（端口 22 可达、`BatchMode` 也救不了）。这是 per-repo 配置，克隆/重建仓库后
  需要重新设置。
- **自动化**：`.github/workflows/deploy.yml`。push 到 `main` 即触发：
  跑 `scripts/ci-test.sh` → 组装 `_site/` → 部署到 Pages。**回归不通过就不部署。**
- 只有 `index.html` / `large.html` / `style.css` / `src/` / `test/` / `AGENTS.md` 会被发布；
  `.github/` 与 `scripts/` 不进站点。README.md / front2.png 只进仓库
  （GitHub 渲染 README 时解析相对图片），不进 Pages 站点 —— 站点首页就是应用本身。
  **改发布范围时记得同步 `deploy.yml` 的 `cp -R` 行**：那里列了谁就复制谁，
  少列一个文件会让整个部署直接失败。
- 站点是**项目页**（仓库名就是路径前缀），所有资源引用必须保持**相对路径**，
  不要写成 `/src/...`，否则在 `harukiinharu.github.io/cube-music/` 下会 404。
- 本地跑同一套回归：`bash scripts/ci-test.sh`
  （退出码 0 = 通过，1 = 有失败；找不到 Chrome 会跳过并返回 0）。
- 发布新版本：`git tag -a vX.Y.Z -m "..."` 并 `git push origin main --tags`。

## 12. 两套面板：16×16 与 32×64

同一个引擎跑两种规格，靠的是把**维度**从常量里解耦到 `TM.RUNTIME`。

| | 原版 `index.html` | 大面板 `large.html` |
|---|---|---|
| 列（时间步） | 16 | 64 |
| 行（音高） | 16 | 48 |
| 音阶 | D 大调**五声**（1 2 3 5 6） | **半音阶**（相邻行差 1 个半音，像吉他每格一品） |
| 音域 | A6 → A3（3 个八度） | A7 → A#3（47 个半音，将近 4 个八度） |
| 一圈 | 1 小节 = 2 s @120BPM | 4 小节 = 8 s @120BPM |
| 格子 / 方块 | 32 px / 26 px | **32 px / 26 px（与原版逐像素同尺寸）** |
| 画布 | 512×512 | 2048×1536（1:1 上屏，装不下就在框内滚动） |
| 配置来源 | `CONFIG`（缺省） | `src/large-config.js` 覆盖 `TM.RUNTIME` |

**步长不变**：`RESOLUTION` 两种规格都是 16 步/小节，所以大面板变长的是**段落**，
不是音符时值 —— 同一个速度下，两版单步的时长完全一致。

**音阶可换**：`TM.buildScaleTable(rows, topNote, scale)` 从 topNote 起逐级下行，
`scale` 是「相对 A 的半音偏移」升序数组，见 `TM.SCALES`。
`buildScaleTable(16, CONFIG.NOTES[0], TM.SCALES.pentatonic)` 会**逐位复现原版
`CONFIG.NOTES`** —— `test/large.html` 拿这条校验生成器本身没写错，改生成器时
先看这条有没有红。

**两版之间没有「行号平移对应」关系** —— 音阶完全不同，同一份图案搬过来音高会变。
行 0 取原版最高音**再高一个八度**（`CONFIG.NOTES[0] + 12` = A7），48 行往下铺到
A#3，所以整块棋盘把原版的音域整个包住了。

> 注意 48 行铺 108..61，原版 16 个音里有 15 个落在表内，**只有最低的 A3(60)
> 差一个半音**（底部是 A#3）。`test/large.html` 有一条断言把这条边界钉死。
> 再加八度 = `TOP + 12` 且 `ROWS + 12`，**底部不动** —— 旧表会原样落成新表的
> 行 12..47，有断言守着这个「加八度不动底部」的性质。

`SCALES` 里三张音阶都留着：`pentatonic`（原版规格，用来校验生成器）、
`major`（D 大调七声，上一版大面板用过）、`chromatic`（当前大面板）。
换音阶只要改 `large-config.js` 里的一个参数，行数与音域都不用动。

### 改这里时容易踩的坑

矩形网格（`cols ≠ rows`）会引入正方形网格下不存在的一类 bug，**全都踩过**：

- 一维数组的 stride 必须是 `rows`：`index = col * rows + row`。写成 `cols` 会让
  右下角落到数组之外被 Uint8Array **静默丢弃**（不报错）。
- 音序器绕回按 `cols` 取模，行扫描按 `rows` 循环。写死 `CFG.GRID` 会让第 16 步
  提前归零、且后 16 行永远播不到。
- 命中测试（`app.js` 的 `cellAt`）要分别用 `grid.cols` / `grid.rows`。
- 波场是 `rows × cols`（`map[行][列]`），`create2DMap(rows, cols)` 别接反。
- 越界判断要分别看 `cols` 与 `rows`。

### 布局：不缩放，可滚动

大盘面的方块**与原版逐像素同尺寸**，代价是棋盘 2048 × 1024 —— 既超出笔记本横向视口，
也超出纵向视口（32 行 × 26px 光棋盘就 1024px 高）。这是几何决定的：想同时要
「大盘面」和「原版大小的方块」就必然要滚动。所以大盘面的布局是：

- **整页高度锁死**（`body.wide` 是 `height:100dvh` 的 flex 列 + `overflow:hidden`），
  滚动条**收进 `.board-frame` 里** —— 页头、控件、页脚永远不动。这是关键：
  让 `body` 去滚的话，一滚页头控件全跑掉了。
- `.canvas-wrap` 的 CSS 宽高由 `large-config.js` 写进 `--board-w` / `--board-h`，
  **等于逻辑尺寸**，这样无论 dpr 多少都 1:1 上屏、浏览器不做二次重采样
  （`test/large.html` 有断言守着这条，它是「方块一样大」在上屏环节的保证）。
- `.board-frame` 用 `overflow:auto` + `max-width/height` = 棋盘尺寸：**装得下就没有
  滚动条**，装不下才滚。实测 2560×1300 时横向纵向都是 100%，一格都不用滚。
- 框内的 `.canvas-wrap` 用 `margin: auto` 居中，**不要**改用 flex 的
  `justify-content: center` —— 后者在内容溢出时会把起始边挤出容器、
  且那个方向永远滚不到（经典陷阱，踩过）。
- `.overlay` 挂在 `.board-shell` 上（滚动框**外面**），否则「点击开始」会跟着
  2048×1024 的棋盘一起被滚出可见区。`app.js` 的 contextmenu 监听也因此优先挂
  `.board-shell`。
- 控件栏另限宽 900px 居中：跟 2048 的棋盘同宽的话滑块会拉成一条 2000px 的线。

**实测各屏可容纳程度**（页头+控件+页脚共占 277px）：

| 视口 | 滚动框 | 横向可见 | 纵向可见 |
|---|---|---|---|
| 1512×747（14" 笔记本） | 1480×493 | 72% | 32% |
| 1512×982（最大化） | 1480×728 | 72% | 47% |
| 2560×1450（2K） | 2048×1196 | **100%** | 78% |
| 2560×1800（2K 足够高） | 2048×1536 | **100%** | **100%** |

笔记本上纵向只能看到三分之一左右，这是 48 行 × 26px 的方块尺寸决定的，**不是 bug**。
想整块可见又不想滚，只有「减行数」或「缩小方块」两条路，都改变手感，别擅自选。

> 曾经把格子减半到 16px 想塞进屏幕，但按比例算出的 `inset` 是 1.5，在 1x 屏上
> 方块边界落在半像素、被抗锯齿糊出灰边（实测过渡值 25 / 119，而整数内缩下灰度只
> 出现 `0 / 51 / 238` 三个值）。既然要跟原版一样大，索性连格子尺寸一起沿用原版。
> **如果将来要动 `cell`，`inset` 必须保持整数。**

### 参数怎么定的（都有实测依据）

- **波纹层刻意只有 1024×768**（画布是 2048×1536）。它本来就模糊，按画布分辨率渲染
  纯属浪费。`blurWave = 6`：这里一个波纹格 = 1024/64 = 16px，原版是 512/16 = 32px、
  模糊 12，取 `16 × 12/32 = 6` 两版的涟漪柔和程度才一致。
- **每帧开销（无头 Chrome / dpr2 / 硬件 GPU）：原版 `5.2 ~ 6.7 ms` → 大面板
  `30.1 ~ 32.1 ms`（约 5×）**。逐项：波场 ~1.1 → ~2.3 ms、合成 ~4.7 → ~28.7 ms、
  拖动 ~0.6 → ~1.8 ms（点格子本身仍然跟手）。
  设备层面积 1.0 → 12.6 Mpx，耗时的放大倍数与面积基本同步，**是固有代价**
  （格子层必须按设备分辨率 1:1 上屏，见 §6）。已经明显越过 60fps 的 16.7 ms 预算，
  涟漪会掉到 30fps 上下、偶尔更差。
- **⚠️ 量这里的性能必须「一个浏览器进程只测一个配置」。** 在同一个页面里连着量
  原版和大面板，第二组会被显著拖慢 —— 实测同一操作能给出 12.9 / 28.0 / 76.4 ms
  三种结果（最多差 2.7 倍），是显存压力导致的降级，不是代码问题。
  正确做法：一次进程只构造一个 Renderer，热身 4 轮后采 9 轮取中位数
  （见 §10「性能探针」）。**别信单次读数。**
- 要再降只能改渲染模型（例如把辉光拆成独立的 `mix-blend-mode` 图层、
  不再每帧整块重合成，格子层只在改动时更新），那是独立的一件事，别顺手做。

**加新规格面板的步骤**：写一个 `src/xxx-config.js` 覆盖 `TM.RUNTIME`（含
`notes`），照 `large.html` 复制一份页面并把脚本插在 `constants.js` 之后，
然后 **记得同步 `deploy.yml` 的 `cp -R` 行**。

## 13. 乐谱的保存与导入导出

`src/storage.js` 负责两件事：**自动保存**（localStorage）与**导入导出**（一段自包含代码）。

### 格式：CM2（当前）

```
CM2.<base64url>
```

正文二进制（base64url 编码，`+`→`-`、`/`→`_`、去掉尾部 `=`）：

```
[0]      enc：0 = 稠密、1 = 稀疏
[varint] base   本曲最低音高
[varint] span   最高音 - 最低音
[varint] cols   源网格的列数
[body]   稠密：cols × (span+1) 位的位图（列主序，LSB 优先）
         稀疏：逐列 { 列号增量, 个数, 各音高偏移(CSC) }
```

**必须用 base64url 而不是普通 base64** —— 整段代码要能直接塞进 URL 的 hash 当分享
链接，普通 base64 里的 `+` 在 URL 里会被解析成空格。

### 为什么按音高存，而不是按行号

直觉上「稀疏坐标 + CSC」存 (列, **行号**) 就够了，但行号是**相对**的：

- 大面板加一个八度，行号整体平移（A6 顶 → A7 顶，旧行 0 变成新行 12）；
- 换音阶（五声 ↔ 半音阶）会重新定义每一行是什么音。

所以按行号存的谱子一改规格就整体跑调。CM2 存的是**音高本身**（与 `CONFIG.NOTES`
同一套编号，72 = A）。载入时：

- 目标面板有那个音高 → 精确落到对应行；
- 没有 → **就近对齐**到最接近的一条行（同面板载入时全部精确命中，不会触发）；
- 列号超出目标宽度 → 丢弃。

`applyCode` 会返回 `placed / snapped / dropped` 三个计数，UI 如实显示（`describeLoad`）。

### 容量（实测，大面板 64×48；旧 CM1 固定 512 字符）

| 音符数 | 1 | 10 | 40 | 64 | 192 |
|---|---|---|---|---|---|
| 代码长度 | 14 | 50 | 148 | 266 | 436 |

编码器**同时算出稠密与稀疏两种正文、挑短的那个**（`enc` 标记），所以密铺到满格
这种极端情况也不会比旧格式更长。解码对列数 / 跨度 / 正文长度都做了上限校验，
畸形代码会明确报错而不是静默少读几个音。

### 向后兼容

- `CM1` 是旧的稠密位图（`CM1.<cols>x<rows>.<base64url>`），**尺寸耦合**。
  仍然能解，但只认尺寸完全一致的网格 —— 它的行号 ↔ 音高对应关系写在当时的面板配置里，
  现在重建不出来，所以载到大面板会明确拒绝并说明原因。
- 存储键从 `cubemusic.pattern.<cols>x<rows>` 换成了 `cubemusic.score.<面板 id>`。
  `load()` 在新键读不到时会**退回旧键一次**，`applyCode` 成功后下次自动保存就写到新键，
  迁移自然完成（旧键不删，保留兜底）。

### 约定

- **存储键按面板身份、故意不含尺寸**：`cubemusic.score.small` / `cubemusic.score.large`。
  以后再加/减八度，键不变，用户存在本机的那份谱子自动接着用 —— 这正是 CM2 要解决的问题。
  面板 id 来自 `TM.RUNTIME.id`（`constants.js` 里缺省 `small`，`large-config.js` 设 `large`）。
- **载入优先级：URL hash > localStorage**。hash 用过一次就 `replaceState` 清掉 ——
  否则那条旧链接会在每次刷新时盖住之后自动保存的新内容，用户改完一刷新发现被打回原样。
- 自动保存是**防抖 300ms 静默**写，另外挂 `pagehide` 补一次（防抖窗口内关页面会丢）。
  务必在 `restoreScore()` **之后**再挂 `onChange` 钩子，否则载入本身会立刻回写一遍。
- `encode` / `applyCode` 都要带**行 → 音高表**（缺省取 `TM.RUNTIME.notes`）。
  这层耦合是刻意的：音高是这段数据唯一稳定的坐标。
- `Grid.prototype.replaceAll` 只发**一次**变更事件（走渲染器整层重绘）。逐格 `set`
  会触发 3000+ 次局部重绘和同样多的波场种子，载入会明显卡一下。
- 所有 localStorage 调用都包在 try 里（隐私模式 / 配额满 / 被策略禁用不该把页面搞崩）。

### 踩过的坑

- **「复制」的反馈不能挂在 clipboard promise 上。** 无用户手势、无权限或 `file://` 下
  `clipboard.writeText` 可能既不 resolve 也不 reject（实测如此），按钮点了完全没反应。
  正确做法是**先同步**给出确定反馈（「已选中，按 ⌘C」），写入成功再升级文案。
- **`Array.prototype.concat` 不会展平 `Uint8Array`。** `[a].concat(head, body)` 里
  `body` 是个 TypedArray 时会被当成**一个元素**塞进去，结果是只有走普通数组的那条
  分支（稀疏编码）看起来正常，稠密分支静默产出垃圾。要用 `Uint8Array.set()` 拼。
  这个 bug 是被「满格谱子往返」那条断言抓出来的 —— 稀疏路径它测不到。
- **写两个编码分支，就必须有分别覆盖两条分支的断言。** 上面那个 bug 活过了整套
  「往返一致」测试，因为典型谱子全都走稀疏分支。测试里要**显式**构造一个密铺到
  满格的谱子，逼编码器切到稠密分支。
- `.ctl-row` 自带 `display: flex`，会**盖掉** `[hidden]` 的 `display: none`
  （作者样式优先于 UA 样式表）—— 隐藏面板必须显式写 `.ctl-row[hidden]`。
- 页面级测试要求「初始网格为空」，而乐谱现在会自动恢复。测试页必须在 **iframe 开始
  加载之前** 清掉 localStorage 的对应键（`test/interaction.html`、`test/large.html`
  里都有这段，位置不能挪到 iframe 后面）。
