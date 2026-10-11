/*
 * Cube Music — 常量与派生量
 *
 * 所有数值均来自对原版 Flash 程序（ToneMatrix，2009）AVM2 字节码的反汇编，
 * 不是猜的、也不是调出来的。改动前请先读 AGENTS.md §5。
 */
(function (global) {
  'use strict';

  var CONFIG = {
    // ── 音频 ──────────────────────────────────────────────
    SAMPLE_RATE: 44100,          // 原程序 SampleDataEvent 采样率
    TEMPO: 120,                  // BPM，AudioEngine 默认值
    RESOLUTION: 16,              // 每小节 16 步（Sequencer.RESOLUTION）
    NOTE_SECONDS: 22050 / 44100, // 音符时长 0.5 s（playEvent 中 _length = 22050）
    ENV_PEAK: 0.4,               // 包络线性峰值，平方后为 0.16
    MAX_VOICES: 128,             // VoiceStack 容量

    // ── 延迟（ToneMatrix.processSignals）──────────────────
    DELAY_BARS: 3 / 16,          // 3 步 = 375 ms @120BPM
    DELAY_FEEDBACK: 0.4,
    DELAY_WET: 0.06,
    DELAY_DRY: 1.0,
    DELAY_MOD_SAMPLES: 12,       // 延迟时间微调制 ±12 采样
    DELAY_MOD_HZ: 3,             // 相位每 3/44100 前进 → 1/3 秒周期

    // ── 网格与视觉（PatternView）──────────────────────────
    GRID: 16,                    // 16 × 16
    CELL: 32,                    // 每格像素（new PatternView(32, ...)）
    CELL_INSET: 3,               // 方块相对格子的内缩
    CELL_RADIUS: 2,              // 方块圆角

    // 模糊半径。离屏图层按设备分辨率渲染，因此这里统一用「设备像素」，
    // 不再随 DPI 缩放 —— 这样 retine 屏上边缘锐利，且与 1x 屏观感一致。
    //
    // BLUR_CELL = 0 表示方块边缘不做任何柔化，纯平直角（当前设定）。
    // 原 Flash 版是 BlurFilter(3) 作用在 512 逻辑空间；若照搬，在 2x 屏上会
    // 变成 6 设备像素并填满 6px 的格子间隙，导致整体发糊。
    BLUR_CELL: 0,
    // 波纹辉光。它本来就该是柔和渐变，固定渲染在 512 逻辑分辨率上（见 WAVE_SIZE）。
    BLUR_WAVE: 12,

    WAVE_SIZE: 512,              // 波纹图层边长（逻辑分辨率，够用且省 4 倍面积）

    DIFFUSE_SUM: 0.5,            // interval(): 四邻域之和 × 0.5
    DIFFUSE_DAMP: 0.85,          // interval(): 整个结果再 × 0.85（阻尼）
    WAVE_SCALE: 128,             // interval(): 灰度 = v * 128

    // 右键试听时套在那一格上的白色描边（只是描边，不改填充 —— 见 AGENTS.md §7）
    HIGHLIGHT_MS: 280,           // 持续时间
    HIGHLIGHT_INSET: 1.2,        // 相对格子边缘的内缩（逻辑像素）
    HIGHLIGHT_WIDTH: 1.6,        // 线宽（逻辑像素）
    HIGHLIGHT_FADE: 0.4,         // 末段淡出所占比例

    COLORS: {
      background: '#000000',
      on: '#EEEEEE',             // 0xEEEEEE（未减淡）
      off: '#333333',            // 0xEEEEEE - 0xBBBBBB
      wave: 'rgba(255,255,255,1)'
    },

    // ── 音阶：Sequencer.NOTES（行 0 音最高）────────────────
    NOTES: [96, 93, 91, 89, 86, 84, 81, 79, 77, 74, 72, 69, 67, 65, 62, 60]
  };

  /** 与 playEvent 的 `440 * 2^(note/12 - 6)` 完全等价 */
  function noteToFrequency(note) {
    return 440 * Math.pow(2, (note - 72) / 12);
  }

  /** 一小节秒数：enterFrame 里 240000/tempo 是毫秒 */
  function barSeconds(tempo) {
    return (240000 / tempo) / 1000;
  }

  /** 单步秒数 */
  function stepSeconds(tempo) {
    return barSeconds(tempo) / CONFIG.RESOLUTION;
  }

  /**
   * 包络曲线：amp(t) = (0.4 · (1 - t/T))²   —— processAdd 里的 env*env
   * 返回 Float32Array，供 GainNode.setValueCurveAtTime 使用。
   */
  function buildEnvelopeCurve(points) {
    points = points || 96;
    var curve = new Float32Array(points);
    for (var i = 0; i < points; i++) {
      var linear = CONFIG.ENV_PEAK * (1 - i / (points - 1));
      curve[i] = linear * linear;          // 平方，和原程序一致
    }
    curve[points - 1] = 0;
    return curve;
  }

  // ────────────────────────────────────────────────────────
  // 运行时网格配置
  // ────────────────────────────────────────────────────────
  //
  // 原版是 16×16 的正方形网格，CONFIG.GRID 一个数同时充当「列数」和「行数」。
  // 这里把维度单独抽出来，让同一套引擎能跑不同规格的面板（见 large.html）。
  //
  // **缺省值等于原版**，所以不传参数构造出来的东西与改造前逐位一致 ——
  // test/selftest.html 的 71 项断言全部建立在这个前提上。
  //
  // 另外几个可调项（inset / radius / blurCell / blurWave / waveSize / hl*）
  // 刻意**不在这里给默认值**：缺省一律回落 CONFIG.*，因为 test/perf.html 会
  // 直接改 CONFIG 做 A/B，把值抄进这里会让它失效。
  var RUNTIME = {
    id: 'small',            // 面板身份，只用于 localStorage 的键（见 storage.js）
    cols: CONFIG.GRID,      // 时间步数（一圈走多少步）
    rows: CONFIG.GRID,      // 音高行数
    cell: CONFIG.CELL,      // 格子边长（逻辑像素）
    notes: CONFIG.NOTES     // 行 → 音高，长度必须等于 rows
  };

  // ── 音阶 ───────────────────────────────────────────────
  // 写成「相对 A 的半音偏移」的升序数组（音高编号里 72 = A）。
  //
  // 原版是 **D 大调五声** D E F# A B。放到 D 大调里看它正好是 1 2 3 5 6 级，
  // 缺的是**第 4 音 G 与第 7 音 C#** —— 补回这两个就是完整的 D 大调七声。
  // 大面板要的就是补全后的那张（见 src/large-config.js）。
  var SCALES = {
    pentatonic: [0, 2, 5, 7, 9],                 // A B D  E F#      （= 原版规格）
    major:      [0, 2, 4, 5, 7, 9, 10],         // A B C# D E F# G  （五声补上 4、7 级）
    chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]  // 半音阶：相邻行差 1 个半音
  };

  /**
   * 从 topNote 起**逐级下行**，生成 rows 个音的行表（行 0 最高）。
   *
   * 用「逐级下行」而不是按固定音程展开，是为了让音阶可换：换 `scale` 数组
   * 即换音阶，行数与音域都不用动。
   *
   * `buildScaleTable(16, CONFIG.NOTES[0], SCALES.pentatonic)` 应当**逐位复现
   * 原版 CONFIG.NOTES** —— test/large.html 拿这条校验生成器本身没写错。
   *
   * @param {number}   rows    行数
   * @param {number}   topNote 行 0 的音（必须在音阶内）
   * @param {number[]} scale   音阶相对 A 的半音偏移，升序
   */
  function buildScaleTable(rows, topNote, scale) {
    var last = scale.length - 1;
    var out = [topNote];
    var n = topNote;
    var i, p, idx;

    for (i = 1; i < rows; i++) {
      p = ((n - 72) % 12 + 12) % 12;             // 取模后落到 [0, 12)
      idx = scale.indexOf(p);
      if (idx < 0) {
        throw new Error('buildScaleTable: 音 ' + n + ' 不在音阶里（起手音 ' + topNote + '）');
      }
      // 退到低一级；若已经是本级最低音，就跨回上一个八度
      n -= (idx > 0) ? (scale[idx] - scale[idx - 1]) : (12 + scale[0] - scale[last]);
      out.push(n);
    }
    return out;
  }

  global.TM = global.TM || {};
  global.TM.CONFIG = CONFIG;
  global.TM.RUNTIME = RUNTIME;
  global.TM.SCALES = SCALES;
  global.TM.buildScaleTable = buildScaleTable;
  global.TM.noteToFrequency = noteToFrequency;
  global.TM.barSeconds = barSeconds;
  global.TM.stepSeconds = stepSeconds;
  global.TM.buildEnvelopeCurve = buildEnvelopeCurve;
})(window);
