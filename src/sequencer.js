/*
 * ToneMatrix Web — 步进音序器
 *
 * 对应原程序 toneMatrix::Sequencer。
 * 原实现为「音频线程按需推事件」：processTimedEvents(startPos, endPos) 会把
 * [startPos, endPos) 区间内所有音符事件提前排好。Web Audio 的天然做法是同构的
 * lookahead 调度器，因此这里保持同样的语义。
 *
 * 关键设计：音序器是整条链路唯一的时基。
 * 每把一步排进音频时钟，就记录 {step, time} 到 timeline；视觉层用 stepAtTime()
 * 反查「此刻听到的是哪一步」，而不是用「起点 + 步长 × n」去推算 —— 后者在
 * 改速度、或起点与首步之间存在启动延迟时都会和真实音频错位。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var LOOKAHEAD_MS = 25;      // 调度器轮询间隔
  var SCHEDULE_AHEAD = 0.12;  // 提前排程的时间窗（秒）
  var START_DELAY = 0.06;     // 首步相对 currentTime 的启动延迟
  var TIMELINE_KEEP = 1.0;    // 保留最近 1 秒的排程记录

  function Sequencer(audio, grid) {
    this.audio = audio;
    this.grid = grid;
    this.tempo = CFG.TEMPO;
    this.currentStep = 0;
    this.playing = false;
    this.nextStepTime = 0;
    this.timer = null;
    this.onStep = null;
    this.timeline = [];       // [{step, time}]，time 单调递增
  }

  Sequencer.prototype.start = function () {
    if (this.playing || !this.audio.ready) return;
    this.playing = true;
    this.currentStep = 0;
    this.timeline.length = 0;
    this.nextStepTime = this.audio.ctx.currentTime + START_DELAY;

    var self = this;
    this.timer = setInterval(function () { self._tick(); }, LOOKAHEAD_MS);
    this._tick();
  };

  Sequencer.prototype.stop = function () {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  /**
   * 改速度。音频与视觉都从真实排程派生，因此这里不需要做任何重新对齐：
   * 之后新排的步用新步长，已排的步保持不变，视觉反查自然连续。
   */
  Sequencer.prototype.setTempo = function (bpm) {
    this.tempo = bpm;
    this.audio.setTempo(bpm);
  };

  Sequencer.prototype.stepDuration = function () {
    return global.TM.stepSeconds(this.tempo);
  };

  Sequencer.prototype._tick = function () {
    if (!this.playing) return;
    var ctx = this.audio.ctx;
    var stepDur = this.stepDuration();
    var horizon = ctx.currentTime + SCHEDULE_AHEAD;

    var guard = 0;
    while (this.nextStepTime < horizon && guard++ < 256) {
      this._scheduleStep(this.currentStep, this.nextStepTime);
      this.nextStepTime += stepDur;
      this.currentStep = (this.currentStep + 1) % CFG.GRID;
    }

    // 丢弃已经过去的排程记录
    var cutoff = ctx.currentTime - TIMELINE_KEEP;
    while (this.timeline.length && this.timeline[0].time < cutoff) {
      this.timeline.shift();
    }
  };

  /**
   * 把某一列的所有音符排进音频时钟。
   * 对应 Sequencer.processTimedEvents 中的内层循环：扫描 16 行。
   */
  Sequencer.prototype._scheduleStep = function (step, time) {
    for (var row = 0; row < CFG.GRID; row++) {
      if (this.grid.get(step, row)) {
        this.audio.synthNote(CFG.NOTES[row], time);
      }
    }
    this.timeline.push({ step: step, time: time });
    if (this.onStep) this.onStep(step, time);
  };

  /** 二分查找：音频时钟 t 时刻正在播放的步号；早于首步则返回 null */
  Sequencer.prototype.stepAtTime = function (t) {
    var tl = this.timeline;
    if (!tl.length || t < tl[0].time) return null;
    var lo = 0, hi = tl.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tl[mid].time <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return tl[best].step;
  };

  /**
   * 此刻「听得到」的步号。
   * ctx.currentTime 是音频图的写入头：此刻写进去的样本还要再过 outputLatency
   * 才真正从扬声器出来。所以耳朵此刻听到的位置对应 currentTime − latency。
   */
  Sequencer.prototype.audibleStep = function () {
    if (!this.playing) return null;
    var t = this.audio.ctx.currentTime - this.audio.outputLatency();
    return this.stepAtTime(t);
  };

  global.TM.Sequencer = Sequencer;
})(window);
