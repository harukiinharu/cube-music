/*
 * Cube Music — 乐谱的编解码与本地存档
 *
 * 两条路：
 *   1) **自动保存**：谱子改动后（防抖）写进 localStorage，刷新 / 关掉重开接着玩。
 *   2) **导入导出**：把整张谱子编成一段自包含的短代码，可以复制给别人、
 *      粘回来载入，也可以塞进 URL 的 hash 当分享链接。
 *
 * ── 两种代码格式 ─────────────────────────────────────────
 *
 *   CM1   旧格式：**稠密位图**，每格 1 bit，**尺寸耦合**。只能载入尺寸完全相同的面板。
 *         现在只用于向后兼容（存量分享链接 / 存档），编码器不再产出它。
 *
 *   CM2   当前格式：**按音高记的稀疏坐标**，尺寸无关。
 *
 * ── 为什么存音高而不是行号 ───────────────────────────────
 *
 * 直觉上「稀疏坐标 + CSC」存 (列, 行号) 就够了，但**行号是相对的**：
 *
 *   - 大面板加一个八度，行号整体平移（A6 顶 → A7 顶，旧行 0 变成新行 12）；
 *   - 换音阶（五声 ↔ 半音阶）会重新定义每一行是什么音。
 *
 * 所以按行号存的谱子一改规格就整体跑调。这里存的是**音高本身**
 * （和 CONFIG.NOTES 里同一套编号，72 = A），于是：
 *   面板怎么加减八度、换不换音阶，旧谱子都还对得上；目标面板没有那个音高时，
 *   就近对齐到最接近的一条行（同面板载入时是精确的，就近取整不会触发）。
 *
 * ── 压缩 ─────────────────────────────────────────────────
 *
 * 布局沿用 **CSC（compressed sparse column）**：以时间列为主序，每列记下该列
 * 占用的音高（相对本曲最低音的偏移），空列不占空间。典型谱子只点亮百分之几的
 * 格子，而稠密位图必须把整张画布编进去（64×48 固定 512 字符）。
 *
 * 编码器会**同时算出稠密与稀疏两种正文，挑更短的那个**（1 字节的 enc 标记），
 * 所以密铺到满格这种极端情况也不会比旧格式更长。
 *
 * 二进制正文最后转 **base64url**（`+`→`-`、`/`→`_`、去掉尾部 `=`）——
 * 这样整段代码能直接塞进 URL 的 hash，不会被 `+` 之类的字符搞坏。
 *
 * ── 存储键 ───────────────────────────────────────────────
 *
 * `cubemusic.score.<面板 id>`（small / large）。**故意不带尺寸**：面板加减八度
 * 之后键不变，存档自动接着用 —— 这正是 CM2 想解决的问题之一。
 * 旧键 `cubemusic.pattern.<cols>x<rows>` 会在读不到新键时兜底一次（一次性迁移）。
 */
(function (global) {
  'use strict';

  var KEY_PREFIX = 'cubemusic.score.';
  var LEGACY_KEY_PREFIX = 'cubemusic.pattern.';
  var CM1_RE = /^CM1\.(\d+)x(\d+)\.([A-Za-z0-9\-_]+)$/;
  var CM2_RE = /^CM2\.([A-Za-z0-9\-_]+)$/;

  var ENC_DENSE = 0;
  var ENC_SPARSE = 1;

  var MAX_COLS = 4096;      // 解码时的防御上限：别让畸形代码逼出巨型分配
  var MAX_SPAN = 255;

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

  // ── varint（LEB128，小端，每字节 7 位）───────────────────
  function pushVarint(out, v) {
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
  }

  function readVarint(bytes, pos) {
    var v = 0, shift = 0, b;
    do {
      if (pos.i >= bytes.length) throw new Error('varint 越界');
      b = bytes[pos.i++];
      v += (b & 0x7f) * Math.pow(2, shift);        // 用乘法，避免 << 在 31 位溢出
      shift += 7;
      if (shift > 35) throw new Error('varint 过长');
    } while (b & 0x80);
    return v;
  }

  // ── 音高 → 行 / 就近取整 ─────────────────────────────────
  /** 目标面板里离 target 最近的音高（有序数组） */
  function nearestPitch(sorted, target) {
    if (!sorted.length) return undefined;
    var lo = 0, hi = sorted.length - 1, mid;
    while (lo < hi) {
      mid = (lo + hi) >> 1;
      if (sorted[mid] < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(sorted[lo] - target)) {
      return sorted[lo - 1];
    }
    return sorted[lo];
  }

  function currentNotes() {
    var R = global.TM && global.TM.RUNTIME;
    return (R && R.notes) || (global.TM && global.TM.CONFIG.NOTES);
  }

  // ── 编码（CM2）──────────────────────────────────────────
  /**
   * grid → 代码字符串。
   * @param {Object}   grid
   * @param {number[]} [notes] 行 → 音高。缺省取 TM.RUNTIME.notes。
   *
   * 结果**与网格尺寸无关**：只记录有音符的 (列, 音高)。
   */
  function encode(grid, notes) {
    notes = notes || currentNotes();

    var cols = grid.cols, rows = grid.rows;
    var byCol = [];                      // byCol[列] = 该列占用的音高（升序）
    var minN = Infinity, maxN = -Infinity;
    var c, r, n, list;

    for (c = 0; c < cols; c++) {
      list = null;
      for (r = rows - 1; r >= 0; r--) {   // 行号大 = 音低；倒着走天然得到升序
        if (!grid.get(c, r)) continue;
        n = notes[r];
        if (list === null) list = [];
        list.push(n);
        if (n < minN) minN = n;
        if (n > maxN) maxN = n;
      }
      byCol.push(list);
    }

    var empty = (minN === Infinity);
    var base = empty ? 0 : minN;
    var span = empty ? 0 : (maxN - minN);

    var head = [];
    pushVarint(head, base);
    pushVarint(head, span);
    pushVarint(head, cols);

    // 稠密：以 (列 × 音高跨度) 为位图的宽高，按列主序打包
    var pitchCount = span + 1;
    var bits = cols * pitchCount;
    var dense = new Uint8Array(Math.ceil(bits / 8));
    for (c = 0; c < cols; c++) {
      list = byCol[c];
      if (!list) continue;
      for (var k = 0; k < list.length; k++) {
        var bit = c * pitchCount + (list[k] - base);
        dense[bit >> 3] |= (1 << (bit & 7));
      }
    }

    // 稀疏（CSC）：每列记「列号增量 + 个数 + 各音高偏移」，空列不占空间
    var sparse = [];
    var prevCol = -1;
    for (c = 0; c < cols; c++) {
      list = byCol[c];
      if (!list) continue;
      pushVarint(sparse, c - prevCol);   // 首项即绝对列号（prevCol = -1）
      prevCol = c;
      pushVarint(sparse, list.length);
      for (var j = 0; j < list.length; j++) pushVarint(sparse, list[j] - base);
    }

    var useSparse = sparse.length < dense.length;
    var body = useSparse ? sparse : dense;
    // 注意：**别用 Array.concat 拼 Uint8Array** —— concat 不会展平 TypedArray，
    // 会把整个正文当成一个元素塞进去，只有稀疏（普通数组）那条路看起来是对的。
    var bytes = new Uint8Array(1 + head.length + body.length);
    bytes[0] = useSparse ? ENC_SPARSE : ENC_DENSE;
    bytes.set(head, 1);
    bytes.set(body, 1 + head.length);
    return 'CM2.' + toBase64Url(bytes);
  }

  // ── 解码 ─────────────────────────────────────────────────
  /**
   * 代码 → 归一化的稀疏坐标列表。
   * @returns {{ok:true, version:number, cols:number, notes:Array<{col:number,note:number}>}}
   *          或 `{ok:false, error}`
   */
  function decode(text) {
    if (typeof text !== 'string') return fail('不是文本');
    var s = text.trim();

    var m1 = CM1_RE.exec(s);
    if (m1) return decodeV1(m1);

    var m2 = CM2_RE.exec(s);
    if (m2) return decodeV2(m2[1]);

    return fail('格式不对（应形如 CM2.xxxx 或 CM1.16x16.xxxx）');
  }

  /** 旧格式：稠密位图，尺寸写死在代码里 */
  function decodeV1(m) {
    var cols = parseInt(m[1], 10);
    var rows = parseInt(m[2], 10);
    var cells;
    try {
      cells = fromBase64Url(m[3]);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (cells.length !== Math.ceil(cols * rows / 8)) {
      return fail('代码长度与尺寸不符（' + cols + '×' + rows + ' 需要 ' +
                  Math.ceil(cols * rows / 8) + ' 字节，实际 ' + cells.length + '）');
    }
    return { ok: true, version: 1, cols: cols, rows: rows, cells: cells };
  }

  /** 当前格式：按音高的稀疏坐标 */
  function decodeV2(payload) {
    var bytes;
    try {
      bytes = fromBase64Url(payload);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (!bytes.length) return fail('正文为空');

    var enc = bytes[0];
    if (enc !== ENC_DENSE && enc !== ENC_SPARSE) {
      return fail('未知的编码类型 ' + enc);
    }

    var pos = { i: 1 };
    var base, span, cols;
    try {
      base = readVarint(bytes, pos);
      span = readVarint(bytes, pos);
      cols = readVarint(bytes, pos);
    } catch (e) {
      return fail('头部损坏：' + e.message);
    }
    if (cols < 1 || cols > MAX_COLS) return fail('列数不合理：' + cols);
    if (span > MAX_SPAN) return fail('音域跨度不合理：' + span);

    var list = [];
    var c, count, k;

    if (enc === ENC_DENSE) {
      var pitchCount = span + 1;
      var need = Math.ceil(cols * pitchCount / 8);
      if (bytes.length - pos.i !== need) {
        return fail('正文长度与列数/音域不符（需要 ' + need + ' 字节，实际 ' +
                    (bytes.length - pos.i) + '）');
      }
      for (c = 0; c < cols; c++) {
        for (k = 0; k < pitchCount; k++) {
          var bit = c * pitchCount + k;
          if (bytes[pos.i + (bit >> 3)] & (1 << (bit & 7))) {
            list.push({ col: c, note: base + k });
          }
        }
      }
      return { ok: true, version: 2, cols: cols, base: base, span: span, notes: list };
    }

    // 稀疏：逐列读「列号增量 / 个数 / 各音高偏移」
    var col = -1;
    try {
      while (pos.i < bytes.length) {
        col += readVarint(bytes, pos);
        if (col >= MAX_COLS) return fail('列号越界：' + col);
        count = readVarint(bytes, pos);
        if (count > MAX_SPAN + 1) return fail('单列音符数不合理：' + count);
        for (k = 0; k < count; k++) {
          list.push({ col: col, note: base + readVarint(bytes, pos) });
        }
      }
    } catch (e) {
      return fail('正文损坏：' + e.message);
    }
    // 最坏情况是每个音符都自成一组，多到没边就别信了
    if (list.length > MAX_COLS * (MAX_SPAN + 1)) return fail('音符数量不合理');
    return { ok: true, version: 2, cols: cols, base: base, span: span, notes: list };
  }

  /** 把旧格式的位图摊成 0/1 数组（布局与网格一致：列 × 行数 + 行） */
  function unpack(data) {
    var n = data.cols * data.rows;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = (data.cells[i >> 3] >> (i & 7)) & 1;
    return out;
  }

  // ── 落位 ─────────────────────────────────────────────────
  /**
   * 把一段代码载入 grid。
   *
   * CM2 是按音高走的，所以**换面板也能载**：列超出目标宽度就丢弃；音高在目标
   * 音阶里没有就**就近对齐**到最接近的一条行（同面板载入时全都能精确命中，
   * 不会触发）。返回落位统计，供 UI 如实告诉用户发生了什么。
   *
   * @returns {{ok:boolean, error?:string, placed?:number, dropped?:number,
   *            snapped?:number, legacy?:boolean}}
   */
  function applyCode(grid, text, notes) {
    notes = notes || currentNotes();
    var d = decode(text);
    if (!d.ok) return d;

    // 旧格式：稠密位图，行号 ↔ 音高的对应关系写在当时的面板配置里，
    // 现在重建不出来，所以只认尺寸完全一致的网格。
    if (d.version === 1) {
      if (d.cols !== grid.cols || d.rows !== grid.rows) {
        return fail('旧格式（CM1）是稠密位图，只能载入 ' + d.cols + '×' + d.rows +
                    ' 的谱子，与当前面板（' + grid.cols + '×' + grid.rows +
                    '）不匹配。请用新版导出的 CM2 代码。');
      }
      var flat = unpack(d);
      var placed = 0;
      for (var i = 0; i < flat.length; i++) if (flat[i]) placed++;
      grid.replaceAll(flat);
      return { ok: true, placed: placed, dropped: 0, snapped: 0, legacy: true };
    }

    var rowOf = {};                       // 音高 → 行号（同音高取最靠上的那行）
    var sorted = [];
    for (var r = 0; r < grid.rows; r++) {
      if (!(notes[r] in rowOf)) { rowOf[notes[r]] = r; sorted.push(notes[r]); }
    }
    sorted.sort(function (a, b) { return a - b; });

    var cells = new Uint8Array(grid.cols * grid.rows);
    var placedN = 0, droppedN = 0, snappedN = 0;

    for (var j = 0; j < d.notes.length; j++) {
      var e = d.notes[j];
      if (e.col >= grid.cols) { droppedN++; continue; }

      var row = rowOf[e.note];
      if (row === undefined) {
        var near = nearestPitch(sorted, e.note);
        if (near === undefined) { droppedN++; continue; }
        row = rowOf[near];
        snappedN++;
      }
      var idx = e.col * grid.rows + row;
      if (!cells[idx]) { cells[idx] = 1; placedN++; }
    }

    grid.replaceAll(cells);
    return { ok: true, placed: placedN, dropped: droppedN, snapped: snappedN };
  }

  // ── localStorage ────────────────────────────────────────
  // 全部包在 try 里：隐私模式、配额满、或被策略禁用时不该把页面搞崩。

  /** 面板身份（small / large）。**故意不含尺寸**，见文件头说明。 */
  function panelId() {
    var R = global.TM && global.TM.RUNTIME;
    if (R && R.id) return R.id;
    return R ? (R.cols + 'x' + R.rows) : 'unknown';
  }

  function storageKey() { return KEY_PREFIX + panelId(); }
  function legacyKey(cols, rows) { return LEGACY_KEY_PREFIX + cols + 'x' + rows; }

  function save(grid, notes) {
    try {
      global.localStorage.setItem(storageKey(), encode(grid, notes));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 读存档。先读新键；读不到就退回旧键（按尺寸分的那种）一次。
   * 调用方只要 applyCode 成功，下一次自动保存就会写到新键上，迁移自然完成。
   */
  function load(grid) {
    try {
      var v = global.localStorage.getItem(storageKey());
      if (v) return v;
      var old = global.localStorage.getItem(legacyKey(grid.cols, grid.rows));
      return old || null;
    } catch (e) {
      return null;
    }
  }

  function remove() {
    try {
      global.localStorage.removeItem(storageKey());
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
    legacyKey: legacyKey,
    panelId: panelId,
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
