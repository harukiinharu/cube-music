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

    // 仅在 ?debug=1 时暴露内部句柄，供自动化测试直接读模型状态。
    // 测试不应依赖渲染后的像素 —— 无头环境里 rAF 与定时器的推进节奏不一致，
    // 像素采样必然不稳定。生产环境不带该参数时不会挂任何全局变量。
    if (/[?&]debug=1/.test(global.location.search)) {
      global.__cubeMusicDebug = {
        grid: grid,
        audio: audio,
        sequencer: sequencer,
        renderer: renderer
      };
    }

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
      syncPlayButton();
    }).catch(function (err) {
      // 启动失败（例如被自动播放策略拦下）时允许下次手势重试，
      // 同时避免抛出未处理的 Promise 拒绝
      booted = false;
      if (global.console) global.console.warn('音频启动失败：', err);
    });
  }

  // ── 播放控制 ────────────────────────────────────────────
  // 按钮与空格键共用这一对函数，状态以 sequencer.playing 为准，
  // 避免两处各自维护一个布尔量而不同步。
  function togglePlayback() {
    if (!booted) { boot().then(syncPlayButton); return; }
    if (sequencer.playing) sequencer.stop(); else sequencer.start();
    syncPlayButton();
  }

  function syncPlayButton() {
    var btn = document.getElementById('btn-toggle');
    if (btn) btn.textContent = sequencer.playing ? '暂停' : '播放';
  }

  // ── 显示开关 ────────────────────────────────────────────
  // 状态一律以 renderer 上的字段为准，按钮外观由这里派生，避免两处不同步。
  function syncToggle(id, on) {
    var btn = document.getElementById(id);
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setWave(on) {
    renderer.setWaveEnabled(on);
    syncToggle('btn-wave', renderer.showWave);
  }

  function setPlayhead(on) {
    renderer.showPlayhead = !!on;
    syncToggle('btn-playhead', renderer.showPlayhead);
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

    // 空格 = 暂停 / 继续（清空不再占用快捷键）
    global.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        togglePlayback();
      }
    });

    // 布局变化后缓存的矩形会失效
    global.addEventListener('resize', function () { rect = null; });
    global.addEventListener('scroll', function () { rect = null; }, true);

    // 右键：试听该格的音，不改动图案（顺带屏蔽浏览器右键菜单）。
    // 挂在容器上而不是 canvas 上 —— 启动前遮罩层盖在 canvas 上方，
    // 若只监听 canvas，第一次右键会落到遮罩上而弹出浏览器菜单。
    var wrap = document.querySelector('.canvas-wrap') || canvas;
    wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!rect) rect = canvas.getBoundingClientRect();
      var cell = cellAt(e, rect);
      if (cell) audition(cell);
    });
  }

  /**
   * 试听某一格对应的音。只发声 + 在该格打一圈涟漪，不修改图案。
   * 音频未启动时先启动（boot 内部已 catch，始终会 resolve）。
   */
  function audition(cell) {
    var note = CFG.NOTES[cell.row];
    renderer.pulse(cell.col, cell.row);   // 同步给出视觉反馈
    boot().then(function () {
      audio.synthNote(note, 0);
    });
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
      togglePlayback();
    });

    document.getElementById('btn-clear').addEventListener('click', function () {
      grid.clear();
    });

    document.getElementById('btn-wave').addEventListener('click', function () {
      setWave(!renderer.showWave);
    });

    document.getElementById('btn-playhead').addEventListener('click', function () {
      setPlayhead(!renderer.showPlayhead);
    });

    var tempo = document.getElementById('tempo');
    tempo.addEventListener('input', function () {
      document.getElementById('tempo-out').textContent = tempo.value + ' BPM';
      sequencer.setTempo(readTempo());
    });

    var vol = document.getElementById('volume');
    vol.addEventListener('input', function () {
      audio.setVolume(vol.value / 100);
      document.getElementById('volume-out').textContent = vol.value + '%';
    });
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

    // 涟漪关掉时整段跳过：省掉每帧的波动场推进。
    // 暂停时仍然推进（让已有涟漪扩散衰减），但不再注入种子 —— 暂停时步号冻结，
    // 继续注入等于对同一列无限次重复激励，波场会被泵高直到铺满整屏。
    if (renderer.showWave) {
      simAccumulator += dt;
      var n = 0;
      while (simAccumulator >= SIM_DT && n < MAX_CATCHUP) {
        renderer.simulate(step, sequencer.playing);
        simAccumulator -= SIM_DT;
        n++;
      }
      if (n >= MAX_CATCHUP) simAccumulator = 0;
    } else {
      simAccumulator = 0;
    }

    renderer.composite(step);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
