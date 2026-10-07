/*
 * ToneMatrix Web — 网格数据模型
 *
 * 对应原程序 toneMatrix::Pattern。
 * 原结构是 Vector.<Vector.<Boolean>>，索引方式为 steps[列][行]：
 *   列 = 时间步（0 → 15），行 = 音高索引（0 最高音）。
 * Web 版用一维 Uint8Array 存储，索引 = 列 * 16 + 行。
 */
(function (global) {
  'use strict';

  var GRID = global.TM.CONFIG.GRID;

  function Grid() {
    this.size = GRID;
    this.cells = new Uint8Array(GRID * GRID);
    this.listeners = [];
  }

  Grid.prototype.index = function (col, row) {
    return col * this.size + row;
  };

  Grid.prototype.get = function (col, row) {
    return this.cells[col * this.size + row] === 1;
  };

  Grid.prototype.set = function (col, row, value) {
    if (!this.inBounds(col, row)) return;
    var next = value ? 1 : 0;
    var i = col * this.size + row;
    if (this.cells[i] === next) return;
    this.cells[i] = next;
    this.emit({ type: 'set', col: col, row: row, value: next === 1 });
  };

  Grid.prototype.toggle = function (col, row) {
    var v = !this.get(col, row);
    this.set(col, row, v);
    return v;
  };

  Grid.prototype.clear = function () {
    if (!this.any()) return;
    this.cells.fill(0);
    this.emit({ type: 'clear' });
  };

  Grid.prototype.any = function () {
    for (var i = 0; i < this.cells.length; i++) {
      if (this.cells[i]) return true;
    }
    return false;
  };

  Grid.prototype.count = function () {
    var n = 0;
    for (var i = 0; i < this.cells.length; i++) n += this.cells[i];
    return n;
  };

  Grid.prototype.inBounds = function (col, row) {
    return col >= 0 && col < this.size && row >= 0 && row < this.size;
  };

  Grid.prototype.onChange = function (fn) {
    this.listeners.push(fn);
  };

  Grid.prototype.emit = function (action) {
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i](this, action);
  };

  global.TM.Grid = Grid;
})(window);
