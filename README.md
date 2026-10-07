# ToneMatrix · Web 重构版

把 `Cube-Music.exe` 里那个 Flash 程序（Hobnox AudioTool / ToneMatrix，2009）按逆向得到的原理重写成纯 Web 实现。

**技术栈：** 原生 JavaScript + Canvas 2D + Web Audio API。无框架、无构建、无依赖。

---

## 运行

直接双击 `index.html` 即可（脚本使用普通 `<script>` 标签，不受 `file://` 的 CORS 限制）。

若要起本地服务：

```bash
cd web && python3 -m http.server 8000
# 打开 http://localhost:8000
```

浏览器需要一次点击才会出声（自动播放策略），所以页面上有一层「点击开始」遮罩。

---

## 操作

| 操作 | 效果 |
|---|---|
| 点击方格 | 开 / 关该音符 |
| 按住拖动 | 连续涂抹 |
| `空格` | 清空整个网格 |
| 播放 / 暂停 | 启停音序器 |
| 速度 | 40 – 240 BPM（默认 120，与原程序一致） |
| 音量 | 主输出增益 |
| 显示播放列 | 显示 / 隐藏当前播放列的辅助高亮（原程序没有，纯辅助） |

---

## 目录结构

```
web/
├── index.html              页面与装配顺序
├── style.css               视觉风格（纯黑底 + 浅灰方块，沿用原程序）
├── preview-render.png      渲染结果预览
└── src/
    ├── constants.js        全部常量（数值均出自字节码）、音阶表、包络曲线
    ├── grid.js             16×16 音符网格（对应 toneMatrix::Pattern）
    ├── audio.js            音频引擎（振荡器 + 包络 + 声像 + 反馈延迟）
    ├── sequencer.js        步进音序器（lookahead 调度）
    ├── renderer.js         Canvas 渲染 + 波场动画（对应 PatternView）
    └── app.js              装配、交互、主循环
└── test/
    ├── selftest.html       25 项自动化验证（含离线音频渲染）
    ├── sharp.html          格子边缘锐度探针（读图案层像素）
    ├── visual.html         渲染检查 + 画布亮度量化
    ├── wave.html           波场结构可视化（ASCII）
    └── diag.html           频率/节点诊断
```

---

## 与 Flash 原版的对照

| 模块 | Flash 原版 | Web 版 |
|---|---|---|
| 音符合成 | `SampleDataEvent` 逐样本填 PCM，相位累加 + 快速正弦近似 | `OscillatorNode('sine')`，数学等价 |
| 包络 | `out = sin(θ) · env²`，`env = 0.4·(1−t/T)` | `gain.setValueCurveAtTime(预先算好的 96 点曲线)` |
| 声像 | 每音随机 `r = rand − rand`，L/R 独立增益 | 两个 `GainNode` → `ChannelMergerNode`，增益律完全一致 |
| 复音 | `VoiceStack(128)` 手动池化 | 每音新建节点，`onended` 自动回收，上限同样 128 |
| 延迟 | `BasicDelay` 环形缓冲 + 线性插值 + 三角波调制 | `DelayNode` 反馈环路 + 三角 LFO |
| 混合限幅 | 直接相加，由驱动钳位 | 直接相加，`destination` 钳位（未加限幅器，与原版一致） |
| 时序 | `processTimedEvents(startPos, endPos)` 按需推事件 | lookahead 调度器（25 ms 轮询 / 100 ms 前瞻） |
| 视觉合成 | `BitmapData` + `SUBTRACT` / `ADD` / `LAYER` 三层 | 单 Canvas，按层公式预计算颜色 + `lighter` 合成 |
| 波场 | `interval()` 二维波动方程 | 同一方程，`Float64Array` 双缓冲 |
| 主循环 | `stage.frameRate = 999` | `requestAnimationFrame` |
| 播放头同步 | `pos = engine.position − latency·tempo/240000` | `currentStepIndex()` 用 `baseLatency + outputLatency` 补偿 |

---

## 渲染分辨率与清晰度

所有离屏图层（格子底图、波纹）都按**设备分辨率**（`512 × devicePixelRatio`，上限 3x）渲染；
主画布绘制时再把坐标缩回 512 逻辑空间，使位图与屏幕像素 **1:1 对应**，不会被浏览器二次重采样。

模糊半径统一按**设备像素**给定，不随 DPI 缩放：

```js
BLUR_CELL: 1.4,   // 格子边缘柔化（约 3 逻辑像素的过渡带）
BLUR_WAVE: 24,    // 波纹辉光（等价于原版的 12 逻辑像素）
```

> 这里没有照搬原版的 `BlurFilter(3)`。原版是 3 像素作用在 512 逻辑空间；若在 2x 屏上直接沿用，
> 会变成 6 设备像素，而格子之间的间隙只有 6px —— 模糊尾迹会把间隙完全填满，整片糊成一团。
> 用 `test/sharp.html` 直接读图案层像素实测，改造前峰值亮度只有 **17**（`#EEEEEE` 应为 238），
> 改造后为 **238**、间隙 **0**（纯黑），几何完全锐利。

---

## 有意做出的偏差

1. **未加限幅器。** 原程序把多声部直接相加后交给驱动钳位；Web 版同样直接相加，由 `destination` 钳位。曾尝试加软限幅，但 `WaveShaper` 的 `oversample` 会引入明显振铃（实测主频不变但混入高频），因此去掉，保持信号纯净。
2. **拖动涂抹语义。** 原版 `mouseMove` 复用 `mouseDown` 的 toggle，按住拖动经过同一格会反复翻转；Web 版改为「按下时决定目标值，拖动时统一写入」，避免抖动。
3. **播放列高亮。** 原版没有显式播放头（只靠波纹提示位置）。Web 版加了一条极淡的列高亮作为辅助，可在控件区关闭。
4. **格子柔化半径收紧。** 见上一节，目的是修正高 DPI 下的糊化。

---

## 精确还原的参数（全部出自字节码实证）

```
采样率        44100 Hz
速度          120 BPM            → 1 小节 = 2000 ms
步数          16 步/小节          → 单步 125 ms，一轮循环 2.0 s
音阶          D 大调五声 A–B–D–E–F#，音高 96→60（A6→A3），行 0 最高
频率          f = 440 · 2^((note − 72)/12)
音符时长      22050 采样 = 0.5 s
包络          峰值 0.4，输出包络为平方 → amp(t) = (0.4·(1−t/T))²
复音上限      128
延迟          3/16 小节 = 375 ms，反馈 0.4，湿声 0.06，干声 1.0
延迟调制      ±12 采样，三角波 3 Hz
网格          16 × 16，格子 32 px，画布 512 × 512
配色          背景 #000000，关 #333333（= #EEEEEE − #BBBBBB），开 #EEEEEE
波场          v = (0.5·Σ四邻域 − v_prev) · 0.85
```

---

## 自动化验证

`test/selftest.html` 共 25 项断言，全部通过：

```
音高换算（3 项）        A4=440、A3=220、A6=1760 Hz
时序（3 项）            1 小节 2 s、单步 0.125 s、RESOLUTION=16
包络曲线（4 项）        首值 0.16、末值 0、单调递减、中点 0.0392
网格模型（4 项）        初始空、列/行索引、toggle、clear
波场（5 项）            种子 −1、单步后 0.85、邻格 0.36125（= 0.5·0.85²）、
                        无输入时衰减到 0
离线音频渲染（6 项）    峰值 0.160、主频 438.3 Hz（目标 440）、
                        t=0.25s 幅值 0.0402（目标 0.04）、
                        延迟尾音残留、立体声一致性
```

用无头 Chrome 运行：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --virtual-time-budget=12000 --user-data-dir=/tmp/chrome-tm \
  --dump-dom "file://$(pwd)/test/selftest.html"
```

---

## 已知的忠实"怪癖"

- `NOTE_SECONDS = 0.5 s` 而单步只有 125 ms，所以每个音会跨约 4 步重叠 —— 这是它声音厚度的来源，不是 bug。
- 延迟湿声仅 6%，**不要**按常规把它做成明显的 ping-pong echo。
- 复音上限 128；格子全开且密集触发时会饱和，与原版行为一致。
- 波场是**二阶**方程，扰动需要两步才传到相邻格；单点源形成菱形波前（不是圆形）。
