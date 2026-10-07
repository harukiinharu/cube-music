/*
 * ToneMatrix Web — 渲染器
 *
 * 对应原程序 toneMatrix::PatternView：
 *   _bitmapDots     格子底图（黑底 + 柔化浅色方块）
 *   _bitmapStep     状态遮罩（BlendMode.SUBTRACT 减淡）
 *   _bitmapWave     波纹辉光（BlendMode.ADD + BlurFilter(12,12,2)）
 *   interval()      每帧的四邻域扩散场
 *
 * Canvas 2D 没有 subtract 合成模式，因此把「底图 + 减淡」两层按公式合并后直接上色：
 *   开 → 0xEEEEEE，关 → 0xEEEEEE - 0xBBBBBB = 0x333333
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

    // 设备像素比。所有离屏图层都按设备分辨率渲染，主画布绘制时再缩回逻辑坐标，
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

    // ── 图层 3：波纹（设备分辨率）─────────────────────────
    this.waveSmall = makeCanvas(N, N);
    this.waveSmallCtx = this.waveSmall.getContext('2d');
    this.waveImage = this.waveSmallCtx.createImageData(N, N);

    this.waveBig = makeCanvas(this.devSize, this.devSize);
    this.waveBigCtx = this.waveBig.getContext('2d');

    // ── 扩散场（对应 _mapA / _mapB）────────────────────────
    this.mapA = create2DMap();
    this.mapB = create2DMap();

    this.showPlayhead = true;
    this.stepIndex = 0;

    this.grid.onChange(function (grid, action) {
      // 对应 PatternView.setStep：切换格子时向扩散场注入种子（-1）
      if (action && action.type === 'set') {
        this.mapB[action.row][action.col] = SEED_VALUE;
      }
      this.drawPattern();
    }.bind(this));
    this.drawPattern();
  }

  // ────────────────────────────────────────────────────────
  // 格子底图
  // ────────────────────────────────────────────────────────
  Renderer.prototype.drawPattern = function () {
    var c = this.patternCtx;
    var S = this.scale;
    var D = this.devSize;

    // 离屏层不使用变换，尺寸与滤镜半径都用设备像素，避免 ctx.filter 的单位歧义
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(0, 0, D, D);

    var inset = CFG.CELL_INSET * S;
    var side = (CELL - 2 * CFG.CELL_INSET) * S;
    var radius = CFG.CELL_RADIUS * S;
    var step = CELL * S;

    c.filter = 'blur(' + (CFG.BLUR_CELL * S) + 'px)';
    for (var col = 0; col < N; col++) {
      for (var row = 0; row < N; row++) {
        c.fillStyle = this.grid.get(col, row) ? CFG.COLORS.on : CFG.COLORS.off;
        roundRect(c, col * step + inset, row * step + inset, side, side, radius);
        c.fill();
      }
    }
    c.filter = 'none';
  };

  // ────────────────────────────────────────────────────────
  // 扩散场：对应 interval()
  // ────────────────────────────────────────────────────────
  Renderer.prototype.stepDiffusion = function (stepIndex) {
    var next = (stepIndex + 1) % N;
    var mapA = this.mapA;
    var mapB = this.mapB;
    var data = this.waveImage.data;

    // 1) 种子：下一步将要触发的格子
    for (var r = 0; r < N; r++) {
      if (this.grid.get(next, r)) mapB[r][next] = SEED_VALUE;
    }

    // 2) 二维波动方程（leapfrog 格式）+ 阻尼
    //    原文：v = (0.5 * Σ四邻域 - mapB[y][x]) * 0.85
    //    这是一个阻尼波场，因此会产生向外扩散的涟漪环。
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

    // 放大到设备分辨率后模糊（对应 Bitmap.scaleX=32 + BlurFilter(12,12,2)）
    var wb = this.waveBigCtx;
    var D = this.devSize;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, D, D);
    wb.imageSmoothingEnabled = false;
    wb.filter = 'blur(' + (CFG.BLUR_WAVE * this.scale) + 'px)';
    wb.drawImage(this.waveSmall, 0, 0, D, D);
    wb.filter = 'none';
  };

  // ────────────────────────────────────────────────────────
  // 每帧合成
  // ────────────────────────────────────────────────────────
  Renderer.prototype.render = function (stepIndex) {
    this.stepIndex = stepIndex;
    this.stepDiffusion(stepIndex);

    var ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.drawImage(this.patternLayer, 0, 0, SIZE, SIZE);

    if (this.showPlayhead) {
      // 原程序没有显式播放头（靠波纹提示），这里作为可关闭的辅助指示
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.fillRect(stepIndex * CELL, 0, CELL, SIZE);
    }

    // ADD 辉光
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.waveBig, 0, 0, SIZE, SIZE);
    ctx.globalCompositeOperation = 'source-over';
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
