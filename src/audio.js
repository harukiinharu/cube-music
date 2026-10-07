/*
 * ToneMatrix Web — 音频引擎
 *
 * 对应原程序：
 *   toneMatrix::ToneMatrixVoice      单个正弦声部（相位累加 + 二次衰减包络 + 随机声像）
 *   com.hobnox.audio.polyphone::VoiceStack   128 复音池
 *   com.hobnox.audio.dsp::BasicDelay 反馈延迟
 *   toneMatrix::ToneMatrix.processSignals    混音 + 延迟
 *
 * 与 Flash 的差异：原程序在 SampleDataEvent 里逐样本填 PCM，
 * 这里用 OscillatorNode + GainNode.setValueCurveAtTime 得到数学上等价的波形与包络。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var NOTE_SECONDS = CFG.NOTE_SECONDS;

  function AudioEngine() {
    this.ctx = null;
    this.ready = false;
    this.activeVoices = 0;
    this.peakVoices = 0;
    this._envelopeCurve = global.TM.buildEnvelopeCurve(96);
    this.volume = 0.85;
  }

  AudioEngine.prototype.start = function () {
    if (this.ready) return Promise.resolve(this.ctx);

    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx();
    this.buildGraph(ctx);
    this.loopStart = ctx.currentTime;

    return ctx.resume().then(function () {
      return ctx;
    });
  };

  /** 构建音频图。抽出来是为了能在 OfflineAudioContext 上做自动化验证。 */
  AudioEngine.prototype.buildGraph = function (ctx) {
    this.ctx = ctx;

    // ── 母线 ───────────────────────────────────────────────
    // 原程序没有限幅器，多声部直接相加后由驱动钳位；
    // Web Audio 输出到设备时同样会钳位，因此这里保持纯净通路。
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // ── 声部汇流 ───────────────────────────────────────────
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;

    // ── 延迟：干 1.0 / 湿 0.06 / 反馈 0.4 ──────────────────
    var barSec = global.TM.barSeconds(CFG.TEMPO);
    var delayBase = CFG.DELAY_BARS * barSec;                       // 0.375 s
    var modDepth = CFG.DELAY_MOD_SAMPLES / CFG.SAMPLE_RATE;        // ±0.272 ms
    // 原程序 p ∈ [1,3]，即围绕 +24 采样摆动
    var centerOffset = (CFG.DELAY_MOD_SAMPLES * 2) / CFG.SAMPLE_RATE;

    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = delayBase + centerOffset;

    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = CFG.DELAY_FEEDBACK;

    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = CFG.DELAY_WET;

    this.delayDry = ctx.createGain();
    this.delayDry.gain.value = CFG.DELAY_DRY;

    // 延迟时间微调制（原程序用三角波，这里同样用三角波）
    this.delayLfo = ctx.createOscillator();
    this.delayLfo.type = 'triangle';
    this.delayLfo.frequency.value = CFG.DELAY_MOD_HZ;
    this.delayLfoDepth = ctx.createGain();
    this.delayLfoDepth.gain.value = modDepth;
    this.delayLfo.connect(this.delayLfoDepth);
    this.delayLfoDepth.connect(this.delay.delayTime);
    this.delayLfo.start();

    // 路由
    this.voiceBus.connect(this.delayDry);
    this.delayDry.connect(this.master);

    this.voiceBus.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(this.master);

    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);

    // ── 循环时基 ───────────────────────────────────────────
    this.loopStart = ctx.currentTime;
    this.ready = true;
  };

  AudioEngine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  };

  AudioEngine.prototype.resetClock = function () {
    if (this.ready) this.loopStart = this.ctx.currentTime;
  };

  /**
   * 播放一个音符。对应 ToneMatrixVoice.playEvent + processAdd。
   * @param {number} note  NOTES 表中的音高值
   * @param {number} when  音频时钟上的触发时刻（秒）
   */
  AudioEngine.prototype.synthNote = function (note, when) {
    if (!this.ready) return;
    // 复音上限：与 VoiceStack(capacity = 128) 一致
    if (this.activeVoices >= CFG.MAX_VOICES) return;

    var ctx = this.ctx;
    var t0 = Math.max(when, ctx.currentTime + 0.001);

    // ── 随机声像（playEvent 原文：r = rand - rand）──────────
    var r = Math.random() - Math.random();
    var g = 1 / (1 + Math.abs(r));
    var gainL = (1 - r) * g;
    var gainR = (1 + r) * g;

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = global.TM.noteToFrequency(note);

    // ── 包络：amp(t) = (0.4·(1-t/T))² ─────────────────────
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.setValueCurveAtTime(this._envelopeCurve, t0, NOTE_SECONDS);

    var panL = ctx.createGain();
    panL.gain.value = gainL;
    var panR = ctx.createGain();
    panR.gain.value = gainR;

    var merger = ctx.createChannelMerger(2);

    osc.connect(env);
    env.connect(panL);
    env.connect(panR);
    panL.connect(merger, 0, 0);
    panR.connect(merger, 0, 1);
    merger.connect(this.voiceBus);

    var self = this;
    this.activeVoices++;
    if (this.activeVoices > this.peakVoices) this.peakVoices = this.activeVoices;

    osc.onended = function () {
      self.activeVoices--;
      try { osc.disconnect(); } catch (e) {}
      try { env.disconnect(); } catch (e) {}
      try { panL.disconnect(); } catch (e) {}
      try { panR.disconnect(); } catch (e) {}
      try { merger.disconnect(); } catch (e) {}
    };

    osc.start(t0);
    osc.stop(t0 + NOTE_SECONDS + 0.01);
  };

  /** 用音频时钟计算当前处于第几步，对应 enterFrame 的延迟补偿逻辑 */
  AudioEngine.prototype.currentStepIndex = function (tempo) {
    if (!this.ready) return 0;
    var latency = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    var pos = (this.ctx.currentTime + latency - this.loopStart) /
              global.TM.barSeconds(tempo);
    var step = Math.floor(pos * CFG.RESOLUTION) % CFG.GRID;
    return step < 0 ? step + CFG.GRID : step;
  };

  global.TM.AudioEngine = AudioEngine;
})(window);
