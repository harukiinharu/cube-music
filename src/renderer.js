/*
 * ToneMatrix Web — 渲染器
 *
 * 对应原程序 toneMatrix::PatternView：
 *   _bitmapDots     格子底图（黑底 + 柔化浅色方块）
 *   _bitmapStep     状态遮罩（BlendMode.SUBTRACT 减淡）
 *   _bitmapWave     波纹辉光（BlendMode.ADD + BlurFilter(12,12,2)）
 *   interval()      每帧推进的二维波动场
 *
 * Canvas 2D 没有 subtract 合成模式，因此把「底图 + 减淡」两层按公式合并后直接上色：
 *   开 → 0xEEEEEE，关 → 0xEEEEEE - 0xBBBBBB = 0x333333
 *
 * 分辨率策略：
 *   - 格子图层按设备分辨率渲染，保证方块边缘锐利（见 AGENTS.md §6）。
 *   - 波纹图层不需要按设备分辨率渲染 —— 它本来就要被大半径模糊。
 *
 * 维度策略：网格尺寸全部取自 grid.cols / grid.rows，不再有模块级的 N/CELL/SIZE。
 * 缺省配置下（16×16、格子 32px）行为与改造前逐位一致。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;

  var SEED_VALUE = -1;              // 原程序用 pushbyte 255（有符号解释为 -1）注入种子

  /** opts 未提供时回落到 CONFIG —— 保留 test/perf.html 直接改 CONFIG 做 A/B 的用法 */
  function pick(v, fallback) {
    return (v === undefined || v === null) ? fallback : v;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} grid 需提供 cols / rows
   * @param {Object} [opts] 可选覆盖：cell / inset / radius / blurCell / blurWave /
   *                        waveSize / hlInset / hlWidth
   */
  function Renderer(canvas, grid, opts) {
    opts = opts || {};

    this.canvas = canvas;
    this.grid = grid;

    this.cols = grid.cols;
    this.rows = grid.rows;

    this.cell = pick(opts.cell, CFG.CELL);
    this.inset = pick(opts.inset, CFG.CELL_INSET);
    this.radius = pick(opts.radius, CFG.CELL_RADIUS);
    this.blurCell = pick(opts.blurCell, CFG.BLUR_CELL);
    this.blurWave = pick(opts.blurWave, CFG.BLUR_WAVE);
    this.hlInset = pick(opts.hlInset, CFG.HIGHLIGHT_INSET);
    this.hlWidth = pick(opts.hlWidth, CFG.HIGHLIGHT_WIDTH);

    // ── 逻辑尺寸（CSS 空间的 512×512）──────────────────────
    this.w = this.cols * this.cell;
    this.h = this.rows * this.cell;

    // 设备像素比。格子图层按设备分辨率渲染，主画布绘制时再缩回逻辑坐标，
    // 这样位图与屏幕像素 1:1 对应，不会被浏览器二次重采样。
    this.scale = Math.min(global.devicePixelRatio || 1, 3);
    this.devW = Math.round(this.w * this.scale);
    this.devH = Math.round(this.h * this.scale);
    // 正方形网格下 devSize 即边长。test/selftest.html、sharp.html、perf.html
    // 都是拿它平方着取像素的，保留这个别名以免动到那些探针。
    this.devSize = this.devW;

    canvas.width = this.devW;
    canvas.height = this.devH;

    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    // ── 图层 1：格子底图（设备分辨率）─────────────────────
    this.patternLayer = makeCanvas(this.devW, this.devH);
    this.patternCtx = this.patternLayer.getContext('2d');

    // ── 图层 3：波纹 ──────────────────────────────────────
    // 采样网格与音符网格 1:1（cols × rows），再放大成 waveW × waveH 后模糊。
    this.waveSmall = makeCanvas(this.cols, this.rows);
    this.waveSmallCtx = this.waveSmall.getContext('2d');
    this.waveImage = this.waveSmallCtx.createImageData(this.cols, this.rows);

    // 波纹图层与画布同宽高比，放大后不会拉伸
    this.waveW = Math.round(pick(opts.waveSize, CFG.WAVE_SIZE));
    this.waveH = Math.round(this.waveW * this.rows / this.cols);
    this.waveBig = makeCanvas(this.waveW, this.waveH);
    this.waveBigCtx = this.waveBig.getContext('2d');

    // ── 波动场（对应 _mapA / _mapB）────────────────────────
    // 索引沿用 map[行][列]，与原程序一致
    this.mapA = create2DMap(this.rows, this.cols);
    this.mapB = create2DMap(this.rows, this.cols);

    this.showPlayhead = true;
    this.showWave = true;         // 涟漪辉光开关
    this.highlights = [];         // 右键试听的临时白色描边 [{col,row,until}]
    this.stepIndex = 0;

    this.grid.onChange(function (grid, action) {
      this.applyChange(action);
    }.bind(this));
    this.drawPattern();
  }

  // ────────────────────────────────────────────────────────
  // 格子底图
  // ────────────────────────────────────────────────────────

  /** 重绘整层。仅在启动、清空、以及开启模糊（局部重绘会不精确）时使用 */
  Renderer.prototype.drawPattern = function () {
    var c = this.patternCtx;

    // 离屏层不使用变换，尺寸与滤镜半径都用设备像素，避免 ctx.filter 的单位歧义
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(0, 0, this.devW, this.devH);

    this._applyCellFilter(c);
    for (var col = 0; col < this.cols; col++) {
      for (var row = 0; row < this.rows; row++) this._paintCell(c, col, row);
    }
    c.filter = 'none';
  };

  /**
   * 只重绘一个格子。
   * 关闭模糊时，方块完全落在自己那一格里（inset > 0），因此局部重绘是精确的
   * —— 拖动涂抹时把它从「重绘所有方块」降到「重绘 1 个」。
   */
  Renderer.prototype.drawCell = function (col, row) {
    if (this.blurCell > 0) { this.drawPattern(); return; }   // 有模糊时局部重绘不精确
    var c = this.patternCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    this._paintCell(c, col, row);
  };

  /** 响应网格变化：注入波场种子 + 更新对应像素 */
  Renderer.prototype.applyChange = function (action) {
    if (action && action.type === 'set') {
      // 对应 PatternView.setStep：切换格子时向波动场注入种子（-1）。
      // 涟漪关闭时不注入，否则重新打开会冒出一堆积压的种子。
      if (this.showWave) this.mapB[action.row][action.col] = SEED_VALUE;
      this.drawCell(action.col, action.row);
    } else {
      this.drawPattern();          // clear 或未知动作 → 整层重绘
    }
  };

  /**
   * 在指定格子上套一圈白色描边，持续 ms 毫秒后自动消失。
   * 用于右键试听时告诉用户「我正在按这一格」。
   *
   * 注意：**只描边，不改填充**。曾经试过用波动场的涟漪做反馈，
   * 但那样会让暗格整体变亮，看起来像右键把格子状态改了（见 AGENTS.md §7）。
   */
  Renderer.prototype.flash = function (col, row, ms) {
    if (!this.grid.inBounds(col, row)) return false;
    this.highlights.push({
      col: col,
      row: row,
      until: nowMs() + (ms === undefined ? CFG.HIGHLIGHT_MS : ms)
    });
    return true;
  };

  /** 画并清理临时描边。描边落在格子的黑边距上，因此明格暗格都看得见 */
  Renderer.prototype._drawHighlights = function () {
    var list = this.highlights;
    if (!list.length) return;

    var now = nowMs();
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].until <= now) list.splice(i, 1);
    }
    if (!list.length) return;

    var ctx = this.ctx;
    var inset = this.hlInset;
    var side = this.cell - 2 * inset;
    var fade = CFG.HIGHLIGHT_MS * CFG.HIGHLIGHT_FADE;

    ctx.save();
    ctx.lineWidth = this.hlWidth;
    ctx.strokeStyle = '#FFFFFF';
    for (var j = 0; j < list.length; j++) {
      var h = list[j];
      var remain = h.until - now;
      ctx.globalAlpha = remain < fade ? Math.max(0, remain / fade) : 1;
      roundRect(ctx, h.col * this.cell + inset, h.row * this.cell + inset, side, side, 4);
      ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * 开关涟漪辉光。
   * 关闭时把波动场清零 —— 否则场会冻结在原地，重新打开时冒出一圈旧涟漪。
   */
  Renderer.prototype.setWaveEnabled = function (on) {
    this.showWave = !!on;
    if (this.showWave) return;

    for (var i = 0; i < this.rows; i++) {
      this.mapA[i].fill(0);
      this.mapB[i].fill(0);
    }
    var wb = this.waveBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.waveW, this.waveH);
  };

  Renderer.prototype._applyCellFilter = function (c) {
    c.filter = this.blurCell > 0
      ? 'blur(' + (this.blurCell * this.scale) + 'px)'
      : 'none';
  };

  Renderer.prototype._paintCell = function (c, col, row) {
    var S = this.scale;
    var step = this.cell * S;
    var x = col * step;
    var y = row * step;
    var inset = this.inset * S;
    var side = (this.cell - 2 * this.inset) * S;

    // 先清成背景，再画方块（局部重绘时这一步保证旧状态被擦掉）
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(x, y, step, step);

    c.fillStyle = this.grid.get(col, row) ? CFG.COLORS.on : CFG.COLORS.off;
    roundRect(c, x + inset, y + inset, side, side, this.radius * S);
    c.fill();
  };

  // ────────────────────────────────────────────────────────
  // 波动场：对应 interval()
  // ────────────────────────────────────────────────────────

  /**
   * 推进一帧波动场。
   * @param {number}  stepIndex 当前步号
   * @param {boolean} [seed]    是否向「即将播放的列」注入种子，默认 true。
   *
   * 暂停时必须传 false：暂停时步号冻结，若继续注入种子就等于对同一列
   * 无限次重复激励，波场会被持续泵高直到铺满整个画面。
   * 不注入时波场只做传播 + 阻尼衰减，涟漪会自然向外扩散消失。
   */
  Renderer.prototype.stepDiffusion = function (stepIndex, seed) {
    if (seed === undefined) seed = true;

    var cols = this.cols;
    var rows = this.rows;
    var next = (stepIndex + 1) % cols;
    var mapA = this.mapA;
    var mapB = this.mapB;
    var data = this.waveImage.data;

    // 1) 种子：下一步将要触发的格子
    if (seed) {
      for (var r = 0; r < rows; r++) {
        if (this.grid.get(next, r)) mapB[r][next] = SEED_VALUE;
      }
    }

    // 2) 二维波动方程（leapfrog 格式）+ 阻尼
    //    原文：v = (0.5 * Σ四邻域 - mapB[y][x]) * 0.85
    //    ×0.85 作用于整个括号；只乘 v_prev 会让场指数发散。
    var SUM = CFG.DIFFUSE_SUM;
    var DAMP = CFG.DIFFUSE_DAMP;
    var SCALE = CFG.WAVE_SCALE;
    var p = 0;

    for (var x = 0; x < cols; x++) {
      for (var y = 0; y < rows; y++) {
        var v = 0;
        if (x > 0) v += mapA[y][x - 1];
        if (y > 0) v += mapA[y - 1][x];
        if (x < cols - 1) v += mapA[y][x + 1];
        if (y < rows - 1) v += mapA[y + 1][x];
        v = (v * SUM - mapB[y][x]) * DAMP;
        mapB[y][x] = v;

        var g = (v * SCALE) | 0;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        p = (y * cols + x) * 4;
        data[p] = g; data[p + 1] = g; data[p + 2] = g; data[p + 3] = 255;
      }
    }

    // 3) 双缓冲交换
    this.mapA = mapB;
    this.mapB = mapA;

    this.waveSmallCtx.putImageData(this.waveImage, 0, 0);

    // 最近邻放大到 waveW × waveH，再模糊（对应 Bitmap.scaleX=32 + BlurFilter）
    var wb = this.waveBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.waveW, this.waveH);
    wb.imageSmoothingEnabled = false;
    wb.filter = this.blurWave > 0 ? 'blur(' + this.blurWave + 'px)' : 'none';
    wb.drawImage(this.waveSmall, 0, 0, this.waveW, this.waveH);
    wb.filter = 'none';
  };

  // ────────────────────────────────────────────────────────
  // 每帧合成
  // ────────────────────────────────────────────────────────

  /**
   * 推进波场。调用方应按固定步长驱动（见 app.js），
   * 这样涟漪的传播速度与显示刷新率无关 —— 60Hz 与 120Hz 屏上观感一致。
   * 暂停时传 seed = false，让已有涟漪自然扩散衰减。
   */
  Renderer.prototype.simulate = function (stepIndex, seed) {
    this.stepIndex = stepIndex;
    this.stepDiffusion(stepIndex, seed);
  };

  /** 只做图层合成，不推进波场 */
  Renderer.prototype.composite = function (stepIndex) {
    this.stepIndex = stepIndex;

    var ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.drawImage(this.patternLayer, 0, 0, this.w, this.h);

    if (this.showPlayhead) {
      // 原程序没有显式播放头（靠波纹提示），这里作为可关闭的辅助指示
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.fillRect(stepIndex * this.cell, 0, this.cell, this.h);
    }

    // ADD 辉光。波纹层是柔和渐变，放大时开插值让过渡更顺
    if (this.showWave) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.waveBig, 0, 0, this.w, this.h);
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 描边放在最上层，保证辉光不会把它冲淡
    this._drawHighlights();
  };

  /** 推进 + 合成（一次性调用，供测试与简单场景使用） */
  Renderer.prototype.render = function (stepIndex) {
    this.stepDiffusion(stepIndex);
    this.composite(stepIndex);
  };

  // ────────────────────────────────────────────────────────

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now()
      : Date.now();
  }

  function create2DMap(rows, cols) {
    var m = new Array(rows);
    for (var i = 0; i < rows; i++) {
      m[i] = new Float64Array(cols);
    }
    return m;
  }

  function makeCanvas(w, h) {
    var c = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : global.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  global.TM.Renderer = Renderer;
})(window);
