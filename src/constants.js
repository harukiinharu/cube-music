/*
 * ToneMatrix Web — 常量与派生量
 *
 * 所有数值均来自对原 SWF 的 AVM2 字节码反汇编，见《逆向分析-原理篇.md》第 1 节。
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

  global.TM = global.TM || {};
  global.TM.CONFIG = CONFIG;
  global.TM.noteToFrequency = noteToFrequency;
  global.TM.barSeconds = barSeconds;
  global.TM.stepSeconds = stepSeconds;
  global.TM.buildEnvelopeCurve = buildEnvelopeCurve;
})(window);
