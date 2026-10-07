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
 *   - 波纹图层固定 512（逻辑分辨率）即可 —— 它本来就要被大半径模糊，
 *     再按设备分辨率渲染纯属浪费（面积 ×4）。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var N = CFG.GRID;
  var CELL = CFG.CELL;
  var SIZE = N * CELL;              // 512

  var SEED_VALUE = -1;              // 原程序用 pushbyte 255（有符号解释为 -1）注入种子

  function Renderer(canvas, grid) {
    this.canvas = canvas;
    this.grid = grid;

    // 设备像素比。格子图层按设备分辨率渲染，主画布绘制时再缩回逻辑坐标，
    // 这样位图与屏幕像素 1:1 对应，不会被浏览器二次重采样。
    this.scale = Math.min(global.devicePixelRatio || 1, 3);
    this.devSize = Math.round(SIZE * this.scale);

    canvas.width = this.devSize;
    canvas.height = this.devSize;

    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    // ── 图层 1：格子底图（设备分辨率）─────────────────────
    this.patternLayer = makeCanvas(this.devSize, this.devSize);
    this.patternCtx = this.patternLayer.getContext('2d');

    // ── 图层 3：波纹（逻辑分辨率即可）─────────────────────
    this.waveSmall = makeCanvas(N, N);
    this.waveSmallCtx = this.waveSmall.getContext('2d');
    this.waveImage = this.waveSmallCtx.createImageData(N, N);

    this.waveSize = CFG.WAVE_SIZE;
    this.waveBig = makeCanvas(this.waveSize, this.waveSize);
    this.waveBigCtx = this.waveBig.getContext('2d');

    // ── 波动场（对应 _mapA / _mapB）────────────────────────
    this.mapA = create2DMap();
    this.mapB = create2DMap();

    this.showPlayhead = true;
    this.showWave = true;         // 涟漪辉光开关
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
    var D = this.devSize;

    // 离屏层不使用变换，尺寸与滤镜半径都用设备像素，避免 ctx.filter 的单位歧义
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(0, 0, D, D);

    this._applyCellFilter(c);
    for (var col = 0; col < N; col++) {
      for (var row = 0; row < N; row++) this._paintCell(c, col, row);
    }
    c.filter = 'none';
  };

  /**
   * 只重绘一个格子。
   * 关闭模糊时，方块完全落在自己 32px 的格子里（inset > 0），
   * 因此局部重绘是精确的 —— 拖动涂抹时把它从「重绘 256 个方块」降到「重绘 1 个」。
   */
  Renderer.prototype.drawCell = function (col, row) {
    if (CFG.BLUR_CELL > 0) { this.drawPattern(); return; }   // 有模糊时局部重绘不精确
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
   * 在指定格子向波动场注入一次种子，产生一圈从该格扩散出去的涟漪。
   * 用于右键试听这类「一次性反馈」——与 setStep 的种子注入等价，但不改动图案。
   * 注意只注入一次：反复注入同一格会让波场指数发散（见 §6 / AGENTS.md）。
   */
  Renderer.prototype.pulse = function (col, row) {
    if (!this.showWave || !this.grid.inBounds(col, row)) return false;
    this.mapB[row][col] = SEED_VALUE;
    return true;
  };

  /**
   * 开关涟漪辉光。
   * 关闭时把波动场清零 —— 否则场会冻结在原地，重新打开时冒出一圈旧涟漪。
   */
  Renderer.prototype.setWaveEnabled = function (on) {
    this.showWave = !!on;
    if (this.showWave) return;

    for (var i = 0; i < N; i++) {
      this.mapA[i].fill(0);
      this.mapB[i].fill(0);
    }
    var wb = this.waveBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.waveSize, this.waveSize);
  };

  Renderer.prototype._applyCellFilter = function (c) {
    c.filter = CFG.BLUR_CELL > 0
      ? 'blur(' + (CFG.BLUR_CELL * this.scale) + 'px)'
      : 'none';
  };

  Renderer.prototype._paintCell = function (c, col, row) {
    var S = this.scale;
    var step = CELL * S;
    var x = col * step;
    var y = row * step;
    var inset = CFG.CELL_INSET * S;
    var side = (CELL - 2 * CFG.CELL_INSET) * S;

    // 先清成背景，再画方块（局部重绘时这一步保证旧状态被擦掉）
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(x, y, step, step);

    c.fillStyle = this.grid.get(col, row) ? CFG.COLORS.on : CFG.COLORS.off;
    roundRect(c, x + inset, y + inset, side, side, CFG.CELL_RADIUS * S);
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
    var next = (stepIndex + 1) % N;
    var mapA = this.mapA;
    var mapB = this.mapB;
    var data = this.waveImage.data;

    // 1) 种子：下一步将要触发的格子
    if (seed) {
      for (var r = 0; r < N; r++) {
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

    for (var x = 0; x < N; x++) {
      for (var y = 0; y < N; y++) {
        var v = 0;
        if (x > 0) v += mapA[y][x - 1];
        if (y > 0) v += mapA[y - 1][x];
        if (x < N - 1) v += mapA[y][x + 1];
        if (y < N - 1) v += mapA[y + 1][x];
        v = (v * SUM - mapB[y][x]) * DAMP;
        mapB[y][x] = v;

        var g = (v * SCALE) | 0;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        p = (y * N + x) * 4;
        data[p] = g; data[p + 1] = g; data[p + 2] = g; data[p + 3] = 255;
      }
    }

    // 3) 双缓冲交换
    this.mapA = mapB;
    this.mapB = mapA;

    this.waveSmallCtx.putImageData(this.waveImage, 0, 0);

    // 最近邻放大到 512，再模糊（对应 Bitmap.scaleX=32 + BlurFilter(12,12,2)）
    var wb = this.waveBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.waveSize, this.waveSize);
    wb.imageSmoothingEnabled = false;
    wb.filter = CFG.BLUR_WAVE > 0 ? 'blur(' + CFG.BLUR_WAVE + 'px)' : 'none';
    wb.drawImage(this.waveSmall, 0, 0, this.waveSize, this.waveSize);
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

    ctx.drawImage(this.patternLayer, 0, 0, SIZE, SIZE);

    if (this.showPlayhead) {
      // 原程序没有显式播放头（靠波纹提示），这里作为可关闭的辅助指示
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.fillRect(stepIndex * CELL, 0, CELL, SIZE);
    }

    // ADD 辉光。波纹层是逻辑分辨率的柔和渐变，放大时开插值让过渡更顺
    if (this.showWave) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.waveBig, 0, 0, SIZE, SIZE);
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  /** 推进 + 合成（一次性调用，供测试与简单场景使用） */
  Renderer.prototype.render = function (stepIndex) {
    this.stepDiffusion(stepIndex);
    this.composite(stepIndex);
  };

  // ────────────────────────────────────────────────────────

  function create2DMap() {
    var m = new Array(N);
    for (var i = 0; i < N; i++) {
      m[i] = new Float64Array(N);
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
