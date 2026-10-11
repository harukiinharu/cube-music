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

  // ── 播放位置标尺 ────────────────────────────────────────
  var ruler, rulerFill, rulerCursor;
  var scrubbing = false;
  var rulerStep = -1;              // 上一帧画过的步号，避免每帧都写样式

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
    bindRuler();
    syncPlayButton();          // 还没播放，按钮应该写着「播放」

    // 先载入乐谱，**再**挂自动保存 —— 否则载入本身会立刻回写一遍存储。
    // 优先级：URL hash（分享链接）> localStorage（本机自动存档）。
    restoreScore();
    grid.onChange(function () { scheduleSave(); refreshShare(); });

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
  /**
   * 解锁音频。**只出声不出音** —— 刷新后点遮罩应该只是「允许播放」，
   * 不该自己就放起来（用户要的是先看着谱子、想听了再按播放）。
   * 想立刻听到，用 `togglePlayback()`（播放按钮 / 空格）。
   */
  function boot() {
    if (booted) return Promise.resolve();
    booted = true;
    return audio.start().then(function () {
      sequencer.setTempo(readTempo());
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
    if (!booted) {
      // 第一次点「播放」：先解锁音频，解锁完**真的开始播** —— 用户点的就是播放。
      // （点遮罩走的是 boot()，那条路只解锁、不播放。）
      boot().then(function () {
        if (!sequencer.playing) sequencer.start();
        syncPlayButton();
      });
      return;
    }
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
    // 拖动状态（dragMode / anchor / move*）声明在模块级 —— 见文件下方「拖动状态」
    // 那段注释：applyMove() 定义在 bindInput 外面，声明在这里它就看不见了。

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

      // Alt + 左键拖 = 拉框选择
      if (e.altKey) {
        dragMode = 'select';
        dragAnchor = cell;
        setSelection(cell, cell);
        lastCell = null;
        return;
      }

      // 已有选区、且按在选区**里面** = 整体搬走这一块
      if (renderer.selection && inSelection(cell)) {
        dragMode = 'move';
        moveBase = grid.cells.slice();
        moveFrom = cell;
        moveRect = renderer.selection;
        moveDc = 0; moveDr = 0;
        pushHistory();                 // 整次搬动 = 一步撤销
        return;
      }

      // 按在选区外：先取消选择，再按老路子涂抹
      if (renderer.selection) setSelection(null);

      dragMode = 'paint';
      pushHistory();                                  // 一次按下 = 一步撤销
      paintValue = grid.toggle(cell.col, cell.row);   // 同步上色，不等音频
      lastCell = cell;
      boot();                                         // 音频后台启动
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!rect) rect = canvas.getBoundingClientRect();

      if (dragMode === 'select') {
        var sel = cellAt(e, rect);
        if (sel) setSelection(dragAnchor, sel);
        return;
      }
      if (dragMode === 'move') {
        var dst = cellAt(e, rect);
        if (dst) applyMove(dst);
        return;
      }
      if (dragMode !== 'paint' || paintValue === null) return;

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
      if (dragMode === null) return;
      dragMode = null;
      paintValue = null;
      lastCell = null;
      dragAnchor = null;
      moveBase = null;
      moveFrom = null;
      moveRect = null;
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

    // ⌘/Ctrl+Z 撤销、⌘/Ctrl+Shift+Z（或 Ctrl+Y）反撤销。
    // 焦点在输入框里时**放行** —— 让浏览器自带的文本撤销生效，
    // 否则在「谱子」面板里按 ⌘Z 会去撤销棋盘，很出戏。
    global.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (k === 'y') {          // Windows 习惯的反撤销
        e.preventDefault();
        redo();
      }
    });

    // 选区快捷键：X 删除、A 填充、Esc 取消选择。
    // 不带修饰键、且焦点不在输入框里 —— 否则 Cmd+A（全选）之类会被误伤。
    global.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (!renderer.selection) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      var k = (e.key || '').toLowerCase();
      if (k === 'x') {
        e.preventDefault();
        setSelectionCells(0);          // 删除
      } else if (k === 'a') {
        e.preventDefault();
        setSelectionCells(1);          // 填充
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSelection(null);            // 取消选择
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

  // ── 拖动状态 ────────────────────────────────────────────
  //
  // 这些必须声明在**模块级**：`applyMove()` 等 helper 定义在 `bindInput` 外面，
  // 若把它们声明在 `bindInput` 里，helper 里访问到的是未声明变量 ——
  // 在 'use strict' 下直接抛 ReferenceError，而事件处理里的异常会被吞掉，
  // 表现成「按下去什么也没发生」，极难查。踩过。
  var dragMode = null;        // null | 'paint'（涂格）| 'select'（拉框）| 'move'（搬选区）
  var dragAnchor = null;      // 拉框起点
  var moveBase = null;        // 搬动开始时整张谱子的副本（每次移动都从它重算）
  var moveFrom = null;        // 搬动起点格
  var moveRect = null;        // 搬动开始时选区的矩形
  var moveDc = 0, moveDr = 0;

  // ── 框选 ────────────────────────────────────────────────
  //
  // 选区就是一块矩形。Alt + 左键拉框；框内按住左键整体搬走；
  // X 清空这一块、A 填满这一块、Esc 取消。
  function setSelection(a, b) {
    if (!a) { renderer.selection = null; return; }
    renderer.selection = {
      col0: Math.min(a.col, b.col), row0: Math.min(a.row, b.row),
      col1: Math.max(a.col, b.col), row1: Math.max(a.row, b.row)
    };
  }

  function inSelection(cell) {
    var s = renderer.selection;
    return !!s && cell.col >= s.col0 && cell.col <= s.col1 &&
                   cell.row >= s.row0 && cell.row <= s.row1;
  }

  /**
   * 把整块选区搬到指针所在的格。
   *
   * 每次都从 `moveBase`（按下那一刻的整张谱子）**重算**，而不是在上一次结果上
   * 继续叠加 —— 否则来回拖会把同一块反复叠上去、越拖越多。位移还会夹在棋盘内，
   * 拖不出边界。
   */
  function applyMove(cell) {
    var s = moveRect;
    var dc = cell.col - moveFrom.col;
    var dr = cell.row - moveFrom.row;
    dc = Math.max(-s.col0, Math.min(dc, grid.cols - 1 - s.col1));
    dr = Math.max(-s.row0, Math.min(dr, grid.rows - 1 - s.row1));
    if (dc === moveDc && dr === moveDr) return;    // 没挪满一格就别重绘
    moveDc = dc; moveDr = dr;

    var next = moveBase.slice();
    var c, r;
    for (c = s.col0; c <= s.col1; c++) {           // 先清掉原位置
      for (r = s.row0; r <= s.row1; r++) next[c * grid.rows + r] = 0;
    }
    for (c = s.col0; c <= s.col1; c++) {           // 再把这一块贴到新位置
      for (r = s.row0; r <= s.row1; r++) {
        if (!moveBase[c * grid.rows + r]) continue;
        next[(c + dc) * grid.rows + (r + dr)] = 1;
      }
    }
    grid.replaceAll(next);
    renderer.selection = {
      col0: s.col0 + dc, row0: s.row0 + dr,
      col1: s.col1 + dc, row1: s.row1 + dr
    };
  }

  /** 把选区内所有格子设成同一个值：A 传 1（填充）、X 传 0（删除） */
  function setSelectionCells(value) {
    var s = renderer.selection;
    if (!s) return;
    pushHistory();
    var next = grid.cells.slice();
    for (var c = s.col0; c <= s.col1; c++) {
      for (var r = s.row0; r <= s.row1; r++) next[c * grid.rows + r] = value;
    }
    grid.replaceAll(next);
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
      if (!grid.any()) return;         // 空谱子别占一步撤销
      pushHistory();
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
      if (applyScore(fromHash).ok) { clearHash(); return; }
    }
    var saved = TM.Store.load(grid);       // 新键优先，读不到会退回旧尺寸键
    if (saved) applyScore(saved);
  }

  // 编解码都要带上行→音高的表：CM2 是按音高存的，不是按行号（见 storage.js 文件头）
  function applyScore(text) {
    return TM.Store.applyCode(grid, text, RUNTIME.notes);
  }

  function encodeScore() {
    return TM.Store.encode(grid, RUNTIME.notes);
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
    TM.Store.save(grid, RUNTIME.notes);
  }

  function setShareStatus(msg) {
    if (shareStatus) shareStatus.textContent = msg;
  }

  /** 上一次由我们填进面板的代码，用来分辨「面板里是生成的代码」还是「用户在粘贴」 */
  var shareEncoded = '';

  function fillShareCode() {
    shareEncoded = encodeScore();
    shareCode.value = shareEncoded;
  }

  /**
   * 面板开着时让代码跟着谱子实时更新。
   * 但如果面板里的内容**不是**我们填的那段（说明用户正在往里粘别人的代码），
   * 就不动它 —— 否则改一下格子就把人家刚粘的东西冲掉了。
   */
  function refreshShare() {
    if (!shareRow || shareRow.hidden || !shareCode) return;
    if (shareCode.value !== shareEncoded) return;
    fillShareCode();
  }

  function toggleShare(force) {
    var show = (force === undefined) ? shareRow.hidden : !!force;
    shareRow.hidden = !show;
    shareBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (!show) return;

    fillShareCode();
    shareCode.select();
    setShareStatus(TM.Store.available()
      ? '这是当前乐谱，会跟着你的改动实时更新。换个面板（加/减八度）也照样能载入。'
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
    var text = shareCode.value;
    var probe = TM.Store.decode(text);             // 先校验，别把坏代码记进撤销历史
    if (!probe.ok) { setShareStatus('载入失败：' + probe.error); return; }

    pushHistory();                                 // 载入也能撤销回原来的谱子
    var r = applyScore(text);
    if (!r.ok) { setShareStatus('载入失败：' + r.error); return; }
    fillShareCode();                               // 规整成当前面板的标准写法
    shareCode.select();
    setShareStatus(describeLoad(r));
  }

  /** 如实告诉用户载入时发生了什么 —— 跨面板载入会有就近对齐和丢弃 */
  function describeLoad(r) {
    var s = (r.legacy ? '已载入旧格式乐谱：' : '已载入 ') + r.placed + ' 个音符';
    if (r.snapped) s += '，其中 ' + r.snapped + ' 个本面板没有该音高，已按音高就近对齐';
    if (r.dropped) s += '，' + r.dropped + ' 个超出本面板范围被丢弃';
    return s;
  }

  // ── 撤销 / 反撤销 ───────────────────────────────────────
  //
  // 只在**一次操作的开始**拍快照，所以「按住拖过一整条」是一步撤销，不是几十步。
  // 快照就是整张 grid 的副本：16×16 是 256 字节、64×48 是 3072 字节，
  // 存满 60 步最多也就 180 KB —— 不值得为省这点内存去做增量记录。
  var HISTORY_MAX = 60;
  var history = [];
  var redoStack = [];

  function snapshot() { return grid.cells.slice(); }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > HISTORY_MAX) history.shift();
    redoStack.length = 0;        // 走了新分支，原来的反撤销链就作废了
  }

  function undo() {
    if (!history.length) return false;
    redoStack.push(snapshot());
    grid.replaceAll(history.pop());
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    history.push(snapshot());
    grid.replaceAll(redoStack.pop());
    return true;
  }

  // ── 播放位置标尺（鼠标控制游标）──────────────────────────
  //
  // 标尺宽度 = 整块棋盘的宽度（大面板 2048px，跟着棋盘一起横向滚），所以
  // 「点在标尺的哪个位置」直接对应「第几列」。点一下跳过去，按住拖动就是擦洗。
  function bindRuler() {
    ruler = document.getElementById('ruler');
    if (!ruler) return;
    rulerFill = document.getElementById('ruler-fill');
    rulerCursor = document.getElementById('ruler-cursor');

    // 刻度背景按列数算（CSS 里用 repeating-linear-gradient 画），
    // 大面板 2048px 宽、可见的常常只有一小段，没有刻度看不出自己在哪一列
    global.document.documentElement.style.setProperty('--cols', grid.cols);

    ruler.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;         // 与画布同样的约定：只管左键
      e.preventDefault();
      scrubbing = true;
      if (ruler.setPointerCapture) {
        try { ruler.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      seekFromEvent(e);
      boot();                             // 拖动游标也算一次用户手势，顺手解锁音频
    });

    ruler.addEventListener('pointermove', function (e) {
      if (scrubbing) seekFromEvent(e);
    });

    var end = function () { scrubbing = false; };
    ruler.addEventListener('pointerup', end);
    ruler.addEventListener('pointercancel', end);
    global.addEventListener('pointerup', end);   // 指针在标尺外抬起也要收尾
  }

  function seekFromEvent(e) {
    var r = ruler.getBoundingClientRect();
    var col = Math.floor((e.clientX - r.left) / r.width * grid.cols);
    if (col < 0) col = 0;
    if (col >= grid.cols) col = grid.cols - 1;
    sequencer.seek(col);
    // 暂停时 audibleStep() 返回 null，主循环会退回 renderer.stepIndex ——
    // 不把它一起挪过去的话，游标在暂停状态下不会跟着走。
    renderer.stepIndex = col;
    syncRuler(col);
  }

  /** 把游标画到当前位置。同一帧内重复同一步号就不写样式了。 */
  function syncRuler(step) {
    if (!rulerFill || step === rulerStep) return;
    rulerStep = step;
    var n = grid.cols;
    rulerFill.style.width = ((step + 1) / n * 100) + '%';
    rulerCursor.style.left = (step / n * 100) + '%';
    ruler.setAttribute('aria-valuenow', step);
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

    syncRuler(step);
    renderer.composite(step);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
