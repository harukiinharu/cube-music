# AGENTS.md

给在本仓库工作的编码代理（以及人类协作者）的项目说明。

---

## 1. 这是什么

`Cube-Music.exe` 尾部内嵌的 Flash 程序（**Hobnox AudioTool / ToneMatrix**，2009）的 Web 重构版。
原程序已通过自研 AVM2 反汇编器完整逆向，本仓库是按逆向结论 1:1 重写的实现。

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

结果在 `<pre id="results">` 里。**必须 44/44 全过，不允许出现 FAIL / JS ERROR / WATCHDOG。**

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
test/selftest.html    44 项断言（含离线音频渲染）
test/sharp.html       格子边缘锐度探针
test/visual.html      渲染回归 + 亮度量化
test/wave.html        波场结构 ASCII 可视化
test/diag.html        频率/节点诊断
```

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
- 离屏层**不使用 `setTransform`**，坐标直接乘 `scale`。这既避开 `ctx.filter` 半径的
  单位歧义，也保证像素对齐。
- **模糊半径按设备像素给定**，不随 DPI 缩放。不要照搬原版的 `BlurFilter(3)`：
  那是作用在 512 逻辑空间的，在 2x 屏上会变成 6 设备像素并填满 6px 的格子间隙。
- 波场用**固定步长**（`app.js` 的 `SIM_DT = 1/60`）推进，与显示刷新率解耦，
  否则 60Hz 与 120Hz 屏上涟漪速度不一致。
- Canvas 2D 没有 `subtract` 合成模式，所以「底图 + 减淡」两层按公式预计算颜色后直接上色。

## 7. 已知的有意偏差（相对原作）

1. **未加限幅器。** 原作多声部直接相加后由驱动钳位；这里同样直接相加，由 `destination` 钳位。
   不要加 `WaveShaper` 软限幅：其 `oversample` 会引入明显振铃（实测主频不变但混入高频）。
2. **拖动涂抹语义。** 原作 `mouseMove` 复用 `mouseDown` 的 toggle，拖动经过同一格会反复翻转；
   这里改成「按下时决定目标值，拖动时统一写入」。
3. **播放列高亮。** 原作没有显式播放头（靠波纹提示位置）。这里加了一条极淡的列高亮作为辅助，
   可在控件区关闭。
4. **格子柔化半径收紧**（见 §6），用于修正高 DPI 下的糊化。

## 8. 提交约定

- **作者身份固定为** `haruki <harukiinharu@gmail.com>`（已写入本仓库的 local config）。
  提交前确认 `git config user.name` / `user.email` 正确，**不要出现其他身份**。
- 提交信息用**中文**，采用 Conventional Commits 前缀：
  `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `test:` / `chore:`
- 正文写清「问题 → 根因 → 改动 → 实测数据」。视觉/音频类改动**必须附量化证据**
  （探针读数、离线渲染测量值、测试通过数），不要只说"看起来好了"。
- 每次提交前跑通 §2 的回归。

## 9. 调试技巧

- 验证画布视觉问题**不要**在合成结果上做灰度统计 —— 辉光梯度会污染测量。
  应直接读对应图层的 `getImageData`（见 `test/sharp.html`）。
- 无头环境下 **`OfflineAudioContext` 只渲染一次**，第二次 `startRendering()` 不会推进
  （会卡住）。需要多个渲染场景时，合并到一次渲染里，或用单元测试覆盖。
- 截图核对：`--headless=new --force-device-scale-factor=2 --screenshot=...`，
  再用 Pillow 做像素分析。
- 改速度相关的逻辑时，重点验证 60 / 90 / 120 / 180 / 240 BPM 五个点。
