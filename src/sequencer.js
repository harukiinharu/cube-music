/*
 * ToneMatrix Web — 步进音序器
 *
 * 对应原程序 toneMatrix::Sequencer。
 * 原实现为「音频线程按需推事件」：processTimedEvents(startPos, endPos) 会把
 * [startPos, endPos) 区间内所有音符事件提前排好。Web Audio 的天然做法是同构的
 * lookahead 调度器，因此这里保持同样的语义。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var LOOKAHEAD_MS = 25;      // 调度器轮询间隔
  var SCHEDULE_AHEAD = 0.1;   // 提前排程的时间窗（秒）

  function Sequencer(audio, grid) {
    this.audio = audio;
    this.grid = grid;
    this.tempo = CFG.TEMPO;
    this.currentStep = 0;
    this.playing = false;
    this.nextStepTime = 0;
    this.timer = null;
    this.onStep = null;
  }

  Sequencer.prototype.start = function () {
    if (this.playing || !this.audio.ready) return;
    this.playing = true;
    this.currentStep = 0;
    this.nextStepTime = this.audio.ctx.currentTime + 0.06;
    this.audio.resetClock();
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

  Sequencer.prototype.setTempo = function (bpm) {
    this.tempo = bpm;
  };

  Sequencer.prototype._tick = function () {
    if (!this.playing) return;
    var ctx = this.audio.ctx;
    var stepDur = global.TM.stepSeconds(this.tempo);
    var horizon = ctx.currentTime + SCHEDULE_AHEAD;

    var guard = 0;
    while (this.nextStepTime < horizon && guard++ < 256) {
      this._scheduleStep(this.currentStep, this.nextStepTime);
      this.nextStepTime += stepDur;
      this.currentStep = (this.currentStep + 1) % CFG.GRID;
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
    if (this.onStep) this.onStep(step, time);
  };

  global.TM.Sequencer = Sequencer;
})(window);
