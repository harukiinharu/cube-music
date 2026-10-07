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
  // 原程序把调制三角波映射到 [1,3]×12 采样，中心即 +24 采样
  var DELAY_CENTER_OFFSET = (CFG.DELAY_MOD_SAMPLES * 2) / CFG.SAMPLE_RATE;

  function AudioEngine() {
    this.ctx = null;
    this.ready = false;
    this.activeVoices = 0;
    this.peakVoices = 0;
    this._envelopeCurve = global.TM.buildEnvelopeCurve(96);
    this.volume = 0.85;
    this.tempo = CFG.TEMPO;
  }

  AudioEngine.prototype.start = function () {
    if (this.ready) return Promise.resolve(this.ctx);

    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx();
    this.buildGraph(ctx);

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
    // 延迟时长按小节计算（原程序 processSignals 每个音频块都重算一次
    // positionToNumSamples(3/16)，是跟速度走的）。如果写死成 120 BPM 的
    // 375 ms，换速度后回声会落到步网格之外，听起来「不合拍」。
    var modDepth = CFG.DELAY_MOD_SAMPLES / CFG.SAMPLE_RATE;        // ±0.272 ms

    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = this.delaySecondsFor(this.tempo) + DELAY_CENTER_OFFSET;

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

    // ── 就绪 ───────────────────────────────────────────────
    this.ready = true;
  };

  AudioEngine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  };

  /** 延迟时长随速度变化：DELAY_BARS 小节 */
  AudioEngine.prototype.delaySecondsFor = function (bpm) {
    return CFG.DELAY_BARS * global.TM.barSeconds(bpm);
  };

  /**
   * 改速度。除了音序器的步长，延迟时长也必须跟着走，
   * 否则回声会脱离步网格（原程序每个音频块都重算，是跟随的）。
   */
  AudioEngine.prototype.setTempo = function (bpm) {
    this.tempo = bpm;
    if (!this.ready) return;
    var now = this.ctx.currentTime;
    var target = this.delaySecondsFor(bpm) + DELAY_CENTER_OFFSET;
    // 平滑过渡，避免拖动滑块时延迟线跳变产生咔哒声
    this.delay.delayTime.cancelScheduledValues(now);
    this.delay.delayTime.setTargetAtTime(target, now, 0.05);
  };

  /**
   * 输出链路总延迟（秒）。
   * 此刻写进音频图的样本要再过这么久才从扬声器出来，
   * 所以「耳朵此刻听到的位置」= currentTime − outputLatency。
   */
  AudioEngine.prototype.outputLatency = function () {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
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

  global.TM.AudioEngine = AudioEngine;
})(window);
