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
    BLUR_CELL: 3,                // 格子贴图 BlurFilter(3,3,3)
    BLUR_WAVE: 12,               // 波纹 BlurFilter(12,12,2)
    DIFFUSE_SUM: 0.5,            // interval(): 四邻域之和 × 0.5
    DIFFUSE_DAMP: 0.85,          // interval(): 整个结果再 × 0.85（阻尼）
    WAVE_SCALE: 128,             // interval(): 灰度 = v * 128

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
