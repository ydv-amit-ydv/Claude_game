/* THE LAST GARDEN - a QR code, drawn here rather than fetched.
 *
 * Three hundred people typing a URL and then a six-character code is the
 * worst minute of the whole event. A QR on the projector removes it: point
 * a camera, and the tournament is already chosen.
 *
 * Byte mode, error correction level M, versions 1 to 10 - comfortably more
 * than a join URL needs. No network, no library, nothing to fail to load.
 *
 * Verified bit-for-bit against a reference encoder across versions 1-10
 * and a spread of payloads, including the exact URLs this game produces.
 */
'use strict';

const QR = (() => {

  // ---- capacity in data codewords, and EC codewords per block, level M
  //      [ total data codewords, EC per block, blocks group1, blocks group2 ]
  const VER = {
    1:  [16,  10, 1, 0], 2: [28,  16, 1, 0], 3: [44,  26, 1, 0],
    4:  [64,  18, 2, 0], 5: [86,  24, 2, 0], 6: [108, 16, 4, 0],
    7:  [124, 18, 4, 0], 8: [154, 22, 2, 2], 9: [182, 22, 3, 2],
    10: [216, 26, 4, 1],
  };
  // where the alignment pattern centres sit, per version
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  // ---- GF(256) tables for Reed-Solomon
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /** the generator polynomial for n error-correction codewords */
  function genPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      // g is stored highest power first, so multiplying by x keeps the index
      // and multiplying by the constant shifts it - not the other way round
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function ecc(data, n) {
    const g = genPoly(n);
    const res = new Array(data.length + n).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const c = res[i];
      if (!c) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], c);
    }
    return res.slice(data.length);
  }

  /** smallest version that will hold this many bytes at level M */
  function pickVersion(len) {
    for (let v = 1; v <= 10; v++) {
      const cap = VER[v][0];
      const hdr = 4 + (v < 10 ? 8 : 16);          // mode + length bits
      if (len + Math.ceil(hdr / 8) <= cap) return v;
    }
    return 0;
  }

  // ---- bit stream
  function bits() {
    const a = [];
    return {
      push(val, n) { for (let i = n - 1; i >= 0; i--) a.push((val >> i) & 1); },
      get len() { return a.length; },
      bytes() {
        while (a.length % 8) a.push(0);
        const out = [];
        for (let i = 0; i < a.length; i += 8) {
          let b = 0;
          for (let j = 0; j < 8; j++) b = (b << 1) | a[i + j];
          out.push(b);
        }
        return out;
      },
    };
  }

  /** the final codeword stream: data blocks interleaved, then EC blocks */
  function encode(text) {
    const utf8 = [];
    for (const ch of unescape(encodeURIComponent(text))) utf8.push(ch.charCodeAt(0));
    const v = pickVersion(utf8.length);
    if (!v) return null;                          // too long for version 10
    const [totalData, ecPer, g1, g2] = VER[v];

    const bs = bits();
    bs.push(4, 4);                                // byte mode
    bs.push(utf8.length, v < 10 ? 8 : 16);
    for (const b of utf8) bs.push(b, 8);
    // terminator, then pad to a whole byte, then the alternating pad bytes
    for (let i = 0; i < 4 && bs.len < totalData * 8; i++) bs.push(0, 1);
    let data = bs.bytes();
    const PAD = [0xEC, 0x11];
    for (let i = 0; data.length < totalData; i++) data.push(PAD[i & 1]);

    // split into blocks: g1 short blocks then g2 blocks one codeword longer
    const nBlocks = g1 + g2;
    const shortLen = Math.floor(totalData / nBlocks);
    const blocks = [], eccs = [];
    let at = 0;
    for (let i = 0; i < nBlocks; i++) {
      const len = shortLen + (i >= g1 ? 1 : 0);
      const blk = data.slice(at, at + len); at += len;
      blocks.push(blk);
      eccs.push(ecc(blk, ecPer));
    }
    // interleave
    const out = [];
    const maxLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++)
      for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecPer; i++)
      for (const e of eccs) out.push(e[i]);
    return { v, out };
  }

  // ---- the module grid
  function place(v, codewords) {
    const n = v * 4 + 17;
    const m = [], fixed = [];
    for (let i = 0; i < n; i++) { m.push(new Uint8Array(n)); fixed.push(new Uint8Array(n)); }
    const set = (x, y, val) => { m[y][x] = val; fixed[y][x] = 1; };

    // finder patterns and their separators
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let y = -1; y <= 7; y++)
        for (let x = -1; x <= 7; x++) {
          const px = ox + x, py = oy + y;
          if (px < 0 || py < 0 || px >= n || py >= n) continue;
          const on = (x >= 0 && x <= 6 && (y === 0 || y === 6)) ||
                     (y >= 0 && y <= 6 && (x === 0 || x === 6)) ||
                     (x >= 2 && x <= 4 && y >= 2 && y <= 4);
          set(px, py, on ? 1 : 0);
        }
    }
    // timing patterns
    for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 ? 0 : 1); set(6, i, i % 2 ? 0 : 1); }
    // alignment patterns, skipping the three finder corners
    const ac = ALIGN[v];
    for (const cy of ac)
      for (const cx of ac) {
        if ((cx <= 8 && cy <= 8) || (cx >= n - 9 && cy <= 8) || (cx <= 8 && cy >= n - 9)) continue;
        for (let y = -2; y <= 2; y++)
          for (let x = -2; x <= 2; x++)
            set(cx + x, cy + y, (Math.max(Math.abs(x), Math.abs(y)) !== 1) ? 1 : 0);
      }
    // the dark module, and the reserved format areas
    set(8, n - 8, 1);
    for (let i = 0; i < 9; i++) {
      if (!fixed[i][8]) set(8, i, 0);
      if (!fixed[8][i]) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      if (!fixed[8][n - 1 - i]) set(n - 1 - i, 8, 0);
      if (!fixed[n - 1 - i][8]) set(8, n - 1 - i, 0);
    }
    // version information, from version 7 up
    if (v >= 7) {
      let d = v << 12, r = d;
      for (let i = 0; i < 6; i++) if (r >> (17 - i) & 1) r ^= 0x1F25 << (5 - i);
      const info = d | (r & 0xFFF);
      for (let i = 0; i < 18; i++) {
        const b = (info >> i) & 1;
        set(Math.floor(i / 3), n - 11 + (i % 3), b);
        set(n - 11 + (i % 3), Math.floor(i / 3), b);
      }
    }

    // zig-zag the data in from the bottom right
    let bi = 0, up = true;
    const bitAt = k => (k >> 3) < codewords.length ? (codewords[k >> 3] >> (7 - (k & 7))) & 1 : 0;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;                       // the vertical timing column is skipped
      for (let i = 0; i < n; i++) {
        const y = up ? n - 1 - i : i;
        for (const x of [col, col - 1]) {
          if (fixed[y][x]) continue;
          m[y][x] = bitAt(bi++);
        }
      }
      up = !up;
    }
    return { m, fixed, n };
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  /** the standard penalty score, used to choose the least ugly mask */
  function penalty(m, n) {
    let p = 0;
    // rule 1: runs of five or more of the same colour
    for (let i = 0; i < n; i++) {
      for (const row of [true, false]) {
        let run = 1;
        for (let j = 1; j < n; j++) {
          const a = row ? m[i][j] : m[j][i], b = row ? m[i][j - 1] : m[j - 1][i];
          if (a === b) { run++; } else { if (run >= 5) p += run - 2; run = 1; }
        }
        if (run >= 5) p += run - 2;
      }
    }
    // rule 2: 2x2 blocks of one colour
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    // rule 3: the finder-like 1:1:3:1:1 sequence
    const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let i = 0; i < n; i++)
      for (let j = 0; j + 11 <= n; j++) {
        let h1 = true, h2 = true, v1 = true, v2 = true;
        for (let k = 0; k < 11; k++) {
          if (m[i][j + k] !== PAT1[k]) h1 = false;
          if (m[i][j + k] !== PAT2[k]) h2 = false;
          if (m[j + k][i] !== PAT1[k]) v1 = false;
          if (m[j + k][i] !== PAT2[k]) v2 = false;
        }
        p += (h1 ? 40 : 0) + (h2 ? 40 : 0) + (v1 ? 40 : 0) + (v2 ? 40 : 0);
      }
    // rule 4: how far the light/dark balance is from even
    let dark = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) dark += m[y][x];
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function formatBits(maskId) {
    const data = (0x00 << 3) | maskId;            // 00 = level M
    let r = data << 10;
    for (let i = 0; i < 5; i++) if (r >> (14 - i) & 1) r ^= 0x537 << (4 - i);
    return ((data << 10) | (r & 0x3FF)) ^ 0x5412;
  }

  /** Build the module matrix for `text`. Returns null if it will not fit. */
  function matrix(text, forceMask) {
    const enc = encode(text);
    if (!enc) return null;
    const { m, fixed, n } = place(enc.v, enc.out);

    let best = null;
    for (let id = 0; id < 8; id++) {
      if (forceMask !== undefined && id !== forceMask) continue;
      const t = m.map(r => Uint8Array.from(r));
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          if (!fixed[y][x] && MASKS[id](x, y)) t[y][x] ^= 1;
      // the format bits belong to the mask, so write them before scoring
      const f = formatBits(id);
      for (let i = 0; i < 15; i++) {
        const b = (f >> i) & 1;
        if (i < 6) t[i][8] = b;
        else if (i === 6) t[7][8] = b;
        else if (i === 7) t[8][8] = b;
        else if (i === 8) t[8][7] = b;
        else t[8][14 - i] = b;
        if (i < 8) t[8][n - 1 - i] = b;
        else t[n - 15 + i][8] = b;
      }
      const s = penalty(t, n);
      if (!best || s < best.s) best = { s, t, id };
    }
    return { m: best.t, n, version: enc.v, mask: best.id };
  }

  /** Paint a QR onto a canvas context, fitted to `size` pixels. */
  function draw(c, text, x, y, size, dark = '#10161c', light = '#ffffff') {
    const q = matrix(text);
    if (!q) return false;
    const quiet = 4, total = q.n + quiet * 2;
    const s = size / total;
    c.fillStyle = light;
    c.fillRect(x, y, size, size);
    c.fillStyle = dark;
    for (let yy = 0; yy < q.n; yy++)
      for (let xx = 0; xx < q.n; xx++)
        if (q.m[yy][xx])
          c.fillRect(x + (xx + quiet) * s, y + (yy + quiet) * s, Math.ceil(s), Math.ceil(s));
    return true;
  }

  function _debug(text) {
    const enc = encode(text);
    const { m, fixed, n } = place(enc.v, enc.out);
    return { v: enc.v, n, m: m.map(r => Array.from(r).join('')),
             fixed: fixed.map(r => Array.from(r).join('')), cw: enc.out };
  }

  return { matrix, draw, pickVersion, _debug };
})();

if (typeof module !== 'undefined') module.exports = QR;
