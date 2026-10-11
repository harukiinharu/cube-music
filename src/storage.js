/*
 * Cube Music — 乐谱的本地保存与导入导出
 *
 * 两条路：
 *   1) **自动保存**：谱子改动后（防抖）写进 localStorage，刷新 / 关掉重开接着玩。
 *   2) **导入导出**：把整张谱子编成一段自包含的短代码（版本 + 尺寸 + base64url），
 *      可以复制给别人、粘回来载入，也可以塞进 URL 的 hash 当分享链接。
 *
 * 编码：每个格子占 1 bit，按 grid 的扁平索引（列 × 行数 + 行）打包成字节，
 * 再转 **base64url**（`+`→`-`、`/`→`_`、去掉尾部 `=`）—— 这样整段代码可以直接
 * 放进 URL 的 hash，不会被 `+` 之类的字符搞坏。
 *
 * 容量：16×16 = 256 bit = 32 字节 → 43 字符；64×48 = 3072 bit = 384 字节 → 512 字符。
 *
 * 存储键按面板尺寸分开（`cubemusic.pattern.16x16` / `cubemusic.pattern.64x48`），
 * 两个面板各存各的，互不覆盖。
 */
(function (global) {
  'use strict';

  var PREFIX = 'CM';               // 代码前缀
  var VERSION = '1';               // 格式版本：格式变了就加一，旧代码会被判为不兼容
  var KEY_PREFIX = 'cubemusic.pattern.';
  var CODE_RE = /^CM(\d+)\.(\d+)x(\d+)\.([A-Za-z0-9\-_]+)$/;

  function storageKey(cols, rows) { return KEY_PREFIX + cols + 'x' + rows; }

  function fail(msg) { return { ok: false, error: msg }; }

  // ── base64url ────────────────────────────────────────────
  function toBase64Url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';                 // 补回被去掉的 padding
    var bin = global.atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── 编解码 ───────────────────────────────────────────────
  /** grid → 代码字符串。空谱子也会编成一段合法代码（全 0 位） */
  function encode(grid) {
    var cells = grid.cells;
    var n = cells.length;
    var bytes = new Uint8Array(Math.ceil(n / 8));
    for (var i = 0; i < n; i++) {
      if (cells[i]) bytes[i >> 3] |= (1 << (i & 7));
    }
    return PREFIX + VERSION + '.' + grid.cols + 'x' + grid.rows + '.' + toBase64Url(bytes);
  }

  /**
   * 代码字符串 → `{ok:true, cols, rows, cells}` 或 `{ok:false, error}`。
   * 只做格式与长度校验，不碰 grid。
   */
  function decode(text) {
    if (typeof text !== 'string') return fail('不是文本');
    var m = CODE_RE.exec(text.trim());
    if (!m) return fail('格式不对（应形如 CM1.16x16.xxxx）');
    if (m[1] !== VERSION) return fail('版本不兼容（代码是 v' + m[1] + '，当前只认 v' + VERSION + '）');

    var cols = parseInt(m[2], 10);
    var rows = parseInt(m[3], 10);
    var cells;
    try {
      cells = fromBase64Url(m[4]);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (cells.length !== Math.ceil(cols * rows / 8)) {
      return fail('代码长度与尺寸不符（' + cols + '×' + rows + ' 需要 ' +
                  Math.ceil(cols * rows / 8) + ' 字节，实际 ' + cells.length + '）');
    }
    return { ok: true, cols: cols, rows: rows, cells: cells };
  }

  /** 解包成与网格同布局的 Uint8Array（0/1） */
  function unpack(data) {
    var n = data.cols * data.rows;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = (data.cells[i >> 3] >> (i & 7)) & 1;
    return out;
  }

  /**
   * 把一段代码载入 grid。尺寸必须与当前面板一致 —— 16×16 的谱子载进 64×48 没有
   * 合理的对应关系，直接拒绝比悄悄截断好。
   * @returns {{ok:boolean, error?:string}}
   */
  function applyCode(grid, text) {
    var d = decode(text);
    if (!d.ok) return d;
    if (d.cols !== grid.cols || d.rows !== grid.rows) {
      return fail('这段代码是 ' + d.cols + '×' + d.rows + ' 的，与当前面板（' +
                  grid.cols + '×' + grid.rows + '）不匹配');
    }
    grid.replaceAll(unpack(d));
    return { ok: true };
  }

  // ── localStorage ────────────────────────────────────────
  // 全部包在 try 里：隐私模式、配额满、或被策略禁用时不该把页面搞崩。

  function save(grid) {
    try {
      global.localStorage.setItem(storageKey(grid.cols, grid.rows), encode(grid));
      return true;
    } catch (e) {
      return false;
    }
  }

  function load(cols, rows) {
    try {
      return global.localStorage.getItem(storageKey(cols, rows));
    } catch (e) {
      return null;
    }
  }

  function remove(cols, rows) {
    try {
      global.localStorage.removeItem(storageKey(cols, rows));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** localStorage 是否真的可用（用于给出「本次会话不会保存」的提示） */
  function available() {
    try {
      var k = KEY_PREFIX + '__probe';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  global.TM.Store = {
    storageKey: storageKey,
    encode: encode,
    decode: decode,
    unpack: unpack,
    applyCode: applyCode,
    save: save,
    load: load,
    remove: remove,
    available: available
  };
})(window);
