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
  var RUNTIME = TM.RUNTIME;

  var grid, audio, sequencer, renderer;
  var canvas;
  var paintValue = null;
  var booted = false;

  // ── 乐谱保存 ────────────────────────────────────────────
  var SAVE_DEBOUNCE_MS = 300;      // 拖动时会连发变更，攒一下再写
  var saveTimer = null;
  var shareBtn, shareRow, shareCode, shareStatus;

  function init() {
    canvas = document.getElementById('matrix');
    // 维度、格子尺寸、音表全部来自 TM.RUNTIME：
    // index.html 用缺省值（16×16，与原版逐位一致），large.html 由
    // src/large-config.js 覆盖成 32 行 × 64 列。
    grid = new TM.Grid(RUNTIME);
    audio = new TM.AudioEngine();
    sequencer = new TM.Sequencer(audio, grid, RUNTIME);
    renderer = new TM.Renderer(canvas, grid, RUNTIME);

    // 画布宽高比跟着网格走（style.css 里 .canvas-wrap 只写了默认值）。
    // 设置成 CSS 像素下的逻辑尺寸比，缩放由 max-width 控制。
    var wrapBox = document.querySelector('.canvas-wrap');
    if (wrapBox) wrapBox.style.aspectRatio = grid.cols + ' / ' + grid.rows;

    bindInput();
    bindControls();

    // 先载入乐谱，**再**挂自动保存 —— 否则载入本身会立刻回写一遍存储。
    // 优先级：URL hash（分享链接）> localStorage（本机自动存档）。
    restoreScore();
    grid.onChange(function () { scheduleSave(); });

    // 关页面时把还没落盘的那次改动补上（防抖窗口内退出会丢）
    global.addEventListener('pagehide', flushSave);

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
      // 只响应主键（左键）。浏览器在右键时会**先**派发 pointerdown(button=2)
      // 再派发 contextmenu；不判断按键的话右键会先把格子翻转，
      // 然后才发出试听的声音 —— 试听绝不能改动图案。
      if (e.button !== 0) return;
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
    // 大盘面（large.html）的遮罩在 .board-shell 里、不在 .canvas-wrap 内，
    // 所以优先挂到能同时罩住「棋盘 + 遮罩」的那一层。
    var wrap = document.querySelector('.board-shell') ||
               document.querySelector('.canvas-wrap') || canvas;
    wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!rect) rect = canvas.getBoundingClientRect();
      var cell = cellAt(e, rect);
      if (cell) audition(cell);
    });
  }

  /**
   * 试听某一格对应的音：发声 + 在该格套一圈白色描边，告诉用户按的是哪一格。
   * **只描边，不改动图案** —— 右键绝不能让格子的黑/白状态看起来变了。
   * 音频未启动时先启动（boot 内部已 catch，始终会 resolve）。
   */
  function audition(cell) {
    // 走音序器同一张音表，保证「试听听到的音」与「播放时听到的音」永远一致
    var note = sequencer.notes[cell.row];
    renderer.flash(cell.col, cell.row);   // 同步给出「按的是这格」的提示
    boot().then(function () {
      audio.synthNote(note, 0);
    });
  }

  // 命中测试按画布上的归一化坐标缩放。**必须**取 grid.cols / grid.rows，
  // 不能写死 CFG.GRID —— 矩形网格下会把右半边整片映射到错误列。
  function cellAt(e, rect) {
    var r = rect || canvas.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    var y = (e.clientY - r.top) / r.height;
    var col = Math.floor(x * grid.cols);
    var row = Math.floor(y * grid.rows);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
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

    // ── 乐谱：导出 / 载入面板 ─────────────────────────────
    shareBtn = document.getElementById('btn-share');
    shareRow = document.getElementById('share-row');
    shareCode = document.getElementById('share-code');
    shareStatus = document.getElementById('share-status');

    shareBtn.addEventListener('click', function () { toggleShare(); });
    document.getElementById('btn-share-copy').addEventListener('click', copyShare);
    document.getElementById('btn-share-load').addEventListener('click', loadShare);
  }

  function readTempo() {
    return parseInt(document.getElementById('tempo').value, 10) || CFG.TEMPO;
  }

  // ── 乐谱：本地保存 / 导入导出 ───────────────────────────
  //
  // 自动保存是**静默**的：改动后防抖写进 localStorage，刷新或关掉重开都还在。
  // 「导出 / 载入」面板负责跨设备搬运 —— 把整张谱子编成一段自包含的短代码。

  /**
   * 载入乐谱。优先 URL 的 hash（分享链接），其次本机的自动存档。
   * hash 用过一次就清掉：否则它会在每次刷新时盖住之后自动保存的新内容，
   * 用户改完一刷新发现被打回原样。
   */
  function restoreScore() {
    var fromHash = readHashCode();
    if (fromHash) {
      var r = TM.Store.applyCode(grid, fromHash);
      if (r.ok) { clearHash(); return; }
    }
    var saved = TM.Store.load(grid.cols, grid.rows);
    if (saved) TM.Store.applyCode(grid, saved);
  }

  function readHashCode() {
    var m = /(?:^#|&)p=([^&]+)/.exec(global.location.hash || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  function clearHash() {
    if (!global.history || !global.history.replaceState) return;
    global.history.replaceState(null, '',
      global.location.pathname + global.location.search);
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    TM.Store.save(grid);
  }

  function setShareStatus(msg) {
    if (shareStatus) shareStatus.textContent = msg;
  }

  function toggleShare(force) {
    var show = (force === undefined) ? shareRow.hidden : !!force;
    shareRow.hidden = !show;
    shareBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (!show) return;

    shareCode.value = TM.Store.encode(grid);
    shareCode.select();
    setShareStatus(TM.Store.available()
      ? '这是当前乐谱。复制发给别人，或把别人的代码粘进来点「载入」。'
      : '当前环境不能自动保存（无痕模式或存储被禁用），请用「复制」手动备份。');
  }

  function copyShare() {
    shareCode.select();
    // **先**给出确定的反馈：clipboard.writeText 的 promise 在无用户手势、
    // 无权限或 file:// 下可能一直挂着不 resolve 也不 reject（实测如此），
    // 把反馈挂在它上面会让按钮点了没反应。写入成功时再升级文案。
    setShareStatus('已选中，按 ⌘C / Ctrl+C 复制');
    var clip = global.navigator && global.navigator.clipboard;
    if (!clip || !clip.writeText) return;      // 非安全上下文下根本没有这个 API
    try {
      clip.writeText(shareCode.value).then(function () {
        setShareStatus('已复制到剪贴板');
      }, function () { /* 保持上面那句提示 */ });
    } catch (e) { /* 保持提示 */ }
  }

  function loadShare() {
    var r = TM.Store.applyCode(grid, shareCode.value);
    if (!r.ok) { setShareStatus('载入失败：' + r.error); return; }
    shareCode.value = TM.Store.encode(grid);       // 规整成标准写法
    shareCode.select();
    setShareStatus('已载入 ' + grid.count() + ' 个音符');
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
