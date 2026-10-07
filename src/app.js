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
    loop();
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
  function bindInput() {
    canvas.addEventListener('pointerdown', function (e) {
      boot().then(function () {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        var cell = cellAt(e);
        if (!cell) return;
        paintValue = grid.toggle(cell.col, cell.row);
      });
    });

    canvas.addEventListener('pointermove', function (e) {
      if (paintValue === null) return;
      var cell = cellAt(e);
      if (!cell) return;
      grid.set(cell.col, cell.row, paintValue);
    });

    var endPaint = function () { paintValue = null; };
    canvas.addEventListener('pointerup', endPaint);
    canvas.addEventListener('pointercancel', endPaint);

    // 空格清空（原程序 Keyboard.SPACE）
    global.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        grid.clear();
      }
    });

    // 阻止画布上的右键菜单干扰
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function cellAt(e) {
    var r = canvas.getBoundingClientRect();
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
  function loop() {
    var step = sequencer.playing
      ? audio.currentStepIndex(sequencer.tempo)
      : renderer.stepIndex;
    renderer.render(step);
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
