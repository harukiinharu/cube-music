/*
 * ToneMatrix Web — 应用装配与交互
 *
 * 对应原程序 ToneMatrixSandbox：
 *   stage.frameRate = 999 → requestAnimationFrame
 *   舞台黑底、512×512 居中
 *   空格清空
 */
(function (global) {
  'use strict';

  var TM = global.TM;
  var CFG = TM.CONFIG;

  var grid, audio, sequencer, renderer;
  var canvas;
  var paintValue = null;
  var booted = false;

  function init() {
    canvas = document.getElementById('matrix');
    grid = new TM.Grid();
    audio = new TM.AudioEngine();
    sequencer = new TM.Sequencer(audio, grid);
    renderer = new TM.Renderer(canvas, grid);

    bindInput();
    bindControls();
    requestAnimationFrame(loop);
  }

  // ── 启动（浏览器要求先有用户手势才能出声）─────────────────
  function boot() {
    if (booted) return Promise.resolve();
    booted = true;
    return audio.start().then(function () {
      sequencer.setTempo(readTempo());
      sequencer.start();
      document.getElementById('overlay').classList.add('hidden');
      document.body.classList.add('running');
    });
  }

  // ── 交互 ────────────────────────────────────────────────
  //
  // 绘制必须与音频启动解耦：点下就立刻上色，不能等 AudioContext 就绪。
  // 拖动时还要把两次事件之间跳过的格子补上，否则快速拖动会漏格。
  function bindInput() {
    var rect = null;          // 缓存的画布矩形，避免每次 pointermove 都触发重排
    var lastCell = null;

    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      rect = canvas.getBoundingClientRect();
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      var cell = cellAt(e, rect);
      if (!cell) return;
      paintValue = grid.toggle(cell.col, cell.row);   // 同步上色，不等音频
      lastCell = cell;
      boot();                                         // 音频后台启动
    });

    canvas.addEventListener('pointermove', function (e) {
      if (paintValue === null) return;
      if (!rect) rect = canvas.getBoundingClientRect();

      // 快速拖动时浏览器会把多个移动合并成一个事件，
      // getCoalescedEvents() 能取回中间点，避免漏格。
      var pts = (e.getCoalescedEvents && e.getCoalescedEvents().length)
        ? e.getCoalescedEvents() : [e];

      for (var i = 0; i < pts.length; i++) {
        var cell = cellAt(pts[i], rect);
        if (!cell) continue;
        grid.paintLine(lastCell, cell, paintValue);
        lastCell = cell;
      }
    });

    var endPaint = function () {
      if (paintValue === null) return;
      paintValue = null;
      lastCell = null;
    };
    canvas.addEventListener('pointerup', endPaint);
    canvas.addEventListener('pointercancel', endPaint);
    // 指针在画布外抬起时也要收尾
    global.addEventListener('pointerup', endPaint);

    // 空格清空（原程序 Keyboard.SPACE）
    global.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        grid.clear();
      }
    });

    // 布局变化后缓存的矩形会失效
    global.addEventListener('resize', function () { rect = null; });
    global.addEventListener('scroll', function () { rect = null; }, true);

    // 阻止画布上的右键菜单干扰
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function cellAt(e, rect) {
    var r = rect || canvas.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    var y = (e.clientY - r.top) / r.height;
    var col = Math.floor(x * CFG.GRID);
    var row = Math.floor(y * CFG.GRID);
    if (col < 0 || col >= CFG.GRID || row < 0 || row >= CFG.GRID) return null;
    return { col: col, row: row };
  }

  // ── 控件 ────────────────────────────────────────────────
  function bindControls() {
    var overlay = document.getElementById('overlay');
    overlay.addEventListener('click', function () { boot(); });

    document.getElementById('btn-toggle').addEventListener('click', function () {
      boot().then(function () {
        if (sequencer.playing) {
          sequencer.stop();
          this.textContent = '播放';
          document.body.classList.remove('running');
        } else {
          sequencer.start();
          this.textContent = '暂停';
          document.body.classList.add('running');
        }
      }.bind(this));
    });

    document.getElementById('btn-clear').addEventListener('click', function () {
      grid.clear();
    });

    var tempo = document.getElementById('tempo');
    tempo.addEventListener('input', function () {
      document.getElementById('tempo-out').textContent = tempo.value + ' BPM';
      sequencer.setTempo(readTempo());
    });

    var vol = document.getElementById('volume');
    vol.addEventListener('input', function () {
      audio.setVolume(vol.value / 100);
    });

    var head = document.getElementById('playhead');
    if (head) {
      head.addEventListener('change', function () {
        renderer.showPlayhead = head.checked;
      });
    }
  }

  function readTempo() {
    return parseInt(document.getElementById('tempo').value, 10) || CFG.TEMPO;
  }

  // ── 主循环 ──────────────────────────────────────────────
  //
  // 波场用固定步长推进，与显示刷新率解耦：60Hz 与 120Hz 屏上涟漪速度一致。
  // 播放头位置则来自音序器的真实排程反查（audibleStep），
  // 因此任何速度下都与听到的声音对齐，改速度也不会跳。
  var SIM_DT = 1 / 60;
  var MAX_CATCHUP = 5;          // 单帧最多补算几步，避免切回标签页时追帧
  var simAccumulator = 0;
  var lastFrameTime = 0;

  function loop(now) {
    requestAnimationFrame(loop);

    var dt = lastFrameTime ? (now - lastFrameTime) / 1000 : SIM_DT;
    lastFrameTime = now;
    if (dt > 0.25) {           // 标签页刚切回来，重新起步
      dt = SIM_DT;
      simAccumulator = 0;
    }

    var step = sequencer.audibleStep();
    if (step === null || step === undefined) step = renderer.stepIndex;

    simAccumulator += dt;
    var n = 0;
    while (simAccumulator >= SIM_DT && n < MAX_CATCHUP) {
      renderer.simulate(step);
      simAccumulator -= SIM_DT;
      n++;
    }
    if (n >= MAX_CATCHUP) simAccumulator = 0;

    renderer.composite(step);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
