/* THE LAST GARDEN - software renderer.
 *
 * A first-person raycaster with no dependencies and no asset files: every
 * texture, sprite and sky is generated from noise at level load.
 *
 *   - walls    DDA cast, textures carry baked relief lighting and contact
 *              shading so stone and foliage read as solid, not as flat panels
 *   - ground   floor cast against real textures, with corner shading where
 *              it meets a wall, and water that ripples, glints and foams
 *   - sky      a 360 degree panorama with a sun and layered cloud, sampled
 *              by heading; indoor levels get a cast stone ceiling instead
 *   - figures  anti-aliased sprites, supersampled then box filtered, with
 *              walk frames, soft shadows and rim light
 *   - plants   ferns, blossoms, reeds and lily pads scattered by tile hash,
 *              so the world is dressed without the server sending anything
 *
 * The frame is drawn into a pixel buffer whose size tracks a rolling frame
 * time, so it stays smooth on a phone and sharpens up on a laptop.
 */
'use strict';

const GFX = (() => {

  // ---------------------------------------------------------------- colour
  const rgb = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;
  const rgba = (r, g, b, a) => (a << 24) | (b << 16) | (g << 8) | r;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

  // ---------------------------------------------------------------- noise
  function h2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 144665371) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }
  const smooth = t => t * t * (3 - 2 * t);

  /** smooth value noise, tiling every `period` so textures wrap seamlessly */
  function vnoise(x, y, s, period) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const w = (v) => ((v % period) + period) % period;
    const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
    const a = h2(x0, y0, s), b = h2(x1, y0, s), c = h2(x0, y1, s), d = h2(x1, y1, s);
    return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
  }

  function fbm(x, y, oct, s, period) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) {
      v += vnoise(x * f, y * f, s + i * 17, period * f) * amp;
      amp *= 0.5; f *= 2;
    }
    return v;
  }

  // ------------------------------------------------------------- textures
  const TEX = 128, TMASK = TEX - 1;

  /**
   * Build a texture from a per-texel function returning [r,g,b,height].
   * The height channel is embossed into directional light, then contact
   * shadow is baked along the bottom and the tile seams.
   */
  function buildTex(fn, opts) {
    const o = opts || {};
    const col = new Float32Array(TEX * TEX * 3), hgt = new Float32Array(TEX * TEX);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const r = fn(x, y), i = y * TEX + x;
        col[i * 3] = r[0]; col[i * 3 + 1] = r[1]; col[i * 3 + 2] = r[2];
        hgt[i] = r[3];
      }
    }
    const out = new Uint32Array(TEX * TEX);
    const relief = o.relief === undefined ? 1.5 : o.relief;
    const seam = o.seam === undefined ? 0.35 : o.seam;
    const base = o.base === undefined ? 0.30 : o.base;
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const i = y * TEX + x;
        // light from the upper left: slope along x and y
        const hl = hgt[y * TEX + ((x - 1) & TMASK)], hr = hgt[y * TEX + ((x + 1) & TMASK)];
        const hu = hgt[((y - 1) & TMASK) * TEX + x], hd = hgt[((y + 1) & TMASK) * TEX + x];
        let shade = 1 + ((hl - hr) * 0.6 + (hu - hd) * 0.8) * relief;
        // ambient occlusion in the crevices
        shade *= 0.82 + 0.18 * clamp(hgt[i] * 1.6, 0, 1.4);
        // darker where the surface meets the ground, and along the tile seams
        const vy = y / TEX;
        shade *= 1 - base * vy * vy;
        const edge = Math.min(x, TEX - 1 - x) / (TEX * 0.5);
        shade *= 1 - seam * Math.pow(1 - clamp(edge * 4, 0, 1), 2);
        out[i] = rgb(clamp(col[i * 3] * shade, 0, 255) | 0,
                     clamp(col[i * 3 + 1] * shade, 0, 255) | 0,
                     clamp(col[i * 3 + 2] * shade, 0, 255) | 0);
      }
    }
    return out;
  }

  /** flat surfaces (ground, water, decking) get relief but no seam shading */
  function buildFlat(fn) {
    return buildTex(fn, { relief: 1.0, seam: 0, base: 0 });
  }

  // ------------------------------------------------------------ materials
  function makeMaterials(level) {
    const M = {};
    if (level === 0) {
      // ---- hedge: clumped foliage, deep gaps, blossoms sitting on top
      M.wall = buildTex((x, y) => {
        const clump = fbm(x / 13, y / 13, 4, 1, TEX / 13);
        const fine = fbm(x / 3.5, y / 3.5, 3, 7, TEX / 3.5);
        const leaf = fbm(x / 1.7, y / 1.7, 2, 21, TEX / 1.7);
        const h = clump * 0.55 + fine * 0.3 + leaf * 0.15;
        let g = 132 + clump * 84 + fine * 58 + leaf * 30;
        let r = 54 + clump * 46 + fine * 30 + leaf * 16;
        let b = 48 + clump * 32 + fine * 20;
        if (h < 0.34) { r *= 0.62; g *= 0.6; b *= 0.64; }          // gaps between clumps
        const fl = h2((x / 7) | 0, (y / 7) | 0, 3);
        if (fl > 0.955 && leaf > 0.5) {                            // blossoms
          const k = h2((x / 3) | 0, (y / 3) | 0, 9);
          if (k > 0.45) {
            const p = fl > 0.978 ? [246, 214, 118] : [238, 132, 176];
            r = p[0]; g = p[1]; b = p[2];
          }
        }
        return [r, g, b, h];
      }, { relief: 1.8, seam: 0.16, base: 0.16 });

      // ---- tree: bark below, canopy above
      M.prop = buildTex((x, y) => {
        const v = y / TEX;
        if (v > 0.52) {
          const bark = fbm(x / 2.2, y / 16, 3, 31, TEX / 2.2);
          const ridge = Math.abs(Math.sin(x * 0.52 + bark * 2)) ;
          const h = 0.3 + ridge * 0.5;
          const t = 78 + ridge * 44 + bark * 26;
          return [t, t * 0.68, t * 0.44, h];
        }
        const clump = fbm(x / 11, y / 11, 4, 5, TEX / 11);
        const fine = fbm(x / 3, y / 3, 3, 13, TEX / 3);
        const h = clump * 0.6 + fine * 0.4;
        const lit = 1 - v * 0.5;
        return [(44 + clump * 46 + fine * 24) * lit, (112 + clump * 88 + fine * 50) * lit,
                (48 + clump * 34 + fine * 18) * lit, h];
      }, { relief: 1.8, seam: 0.12, base: 0.16 });

      // ---- wayside shrine: mossy stone with a lit niche
      M.shrine = buildTex((x, y) => {
        const n = fbm(x / 9, y / 9, 4, 3, TEX / 9);
        const niche = x > 44 && x < 84 && y > 38 && y < 104;
        if (niche) {
          const gl = 1 - Math.min(1, Math.hypot(x - 64, y - 78) / 34);
          return [24 + gl * 210, 20 + gl * 168, 16 + gl * 70, 0.15];
        }
        const moss = fbm(x / 6, y / 6, 3, 11, TEX / 6) * clamp((y - 50) / 70, 0, 1);
        const s = 128 + n * 58;
        return [lerp(s, 74, moss), lerp(s * 0.99, 112, moss), lerp(s * 0.84, 60, moss),
                n * 0.7 + moss * 0.3];
      }, { relief: 1.7, seam: 0.4, base: 0.3 });

      M.ground = buildFlat((x, y) => {
        const patch = fbm(x / 16, y / 16, 3, 41, TEX / 16);
        const blade = fbm(x / 1.6, y / 2.6, 2, 51, TEX / 1.6);
        const h = blade * 0.7 + patch * 0.3;
        let r = 92 + patch * 44 + blade * 30, g = 132 + patch * 56 + blade * 44, b = 62 + patch * 30 + blade * 18;
        if (patch > 0.68) { r += 22; g += 6; b += 8; }              // worn earth
        const f = h2((x / 5) | 0, (y / 5) | 0, 77);
        if (f > 0.982) { r = 244; g = 242; b = 206; }               // daisies
        return [r, g, b, h];
      });
    } else if (level === 1) {
      // ---- ruined wall: cut blocks, mortar, moss at the foot, ivy hanging
      M.wall = buildTex((x, y) => {
        const bh = 32, bw = 44;
        const row = Math.floor(y / bh), off = (row % 2) * (bw / 2);
        const bx = ((x + off) % bw) / bw, by = (y % bh) / bh;
        const joint = bx < 0.05 || bx > 0.95 || by < 0.07 || by > 0.93;
        const grain = fbm(x / 7, y / 7, 4, 3, TEX / 7);
        const wear = fbm(x / 21, y / 21, 3, 19, TEX / 21);
        let h = joint ? 0.12 : 0.55 + grain * 0.4 - wear * 0.2;
        let s = joint ? 112 : 168 + grain * 52 - wear * 26;
        let r = s, g = s * 0.95, b = s * 0.82;
        const moss = clamp((y - 62) / 66, 0, 1) * fbm(x / 8, y / 8, 3, 23, TEX / 8) * 1.5;
        r = lerp(r, 82, clamp(moss, 0, 1)); g = lerp(g, 118, clamp(moss, 0, 1)); b = lerp(b, 62, clamp(moss, 0, 1));
        // ivy strands trailing down the face
        const strand = Math.abs(((x * 13.7) % TEX) / TEX - (0.25 + fbm(y / 18, x / 40, 2, 29, 8) * 0.5));
        const ivy = strand < 0.035 && y > 10;
        if (ivy) {
          const lf = h2((x / 4) | 0, (y / 5) | 0, 37);
          r = 44 + lf * 40; g = 104 + lf * 66; b = 42 + lf * 30; h = 0.8 + lf * 0.2;
          if (lf > 0.93) { r = 236; g = 142; b = 178; }             // flowering ivy
        }
        return [r, g, b, h];
      }, { relief: 1.9, seam: 0.18, base: 0.2 });

      // ---- fallen column: fluted, broken across the top
      M.prop = buildTex((x, y) => {
        const flut = Math.abs(((x % 26) - 13) / 13);
        const n = fbm(x / 9, y / 9, 3, 61, TEX / 9);
        const top = fbm(x / 12, 0.5, 2, 71, TEX / 12) * 46;
        if (y < top) return [96 + n * 40, 118 + n * 44, 86 + n * 30, 0.25];  // sky through the break
        const s = 186 - flut * 54 + n * 22;
        return [s, s * 0.96, s * 0.84, 0.75 - flut * 0.5 + n * 0.2];
      }, { relief: 2.0, seam: 0.25, base: 0.3 });

      M.shrine = buildTex((x, y) => {
        const n = fbm(x / 8, y / 8, 4, 13, TEX / 8);
        const arch = Math.hypot(x - 64, Math.max(0, y - 60)) < 34 && y > 26;
        if (arch) {
          const gl = 1 - Math.min(1, Math.hypot(x - 64, y - 74) / 40);
          return [28 + gl * 190, 24 + gl * 150, 20 + gl * 66, 0.12];
        }
        const s = 172 + n * 46;
        return [s, s * 0.94, s * 0.8, n * 0.8];
      }, { relief: 1.8, seam: 0.4, base: 0.32 });

      M.ground = buildFlat((x, y) => {
        const slab = 42;
        const sx = Math.floor(x / slab), sy = Math.floor(y / slab);
        const jx = (x % slab) / slab, jy = (y % slab) / slab;
        const joint = jx < 0.04 || jx > 0.96 || jy < 0.04 || jy > 0.96;
        const tint = h2(sx, sy, 5) * 26 - 13;
        const grit = fbm(x / 4, y / 4, 3, 67, TEX / 4);
        const crack = fbm(x / 15, y / 15, 2, 83, TEX / 15);
        let s = 166 + tint + grit * 30;
        if (joint) s *= 0.78;
        if (crack > 0.72) s *= 0.88;
        const weed = (joint && h2((x / 3) | 0, (y / 3) | 0, 91) > 0.86);
        if (weed) return [72, 116, 58, 0.5];
        return [s, s * 0.95, s * 0.82, joint ? 0.1 : 0.5 + grit * 0.4];
      });
    } else {
      // ---- temple wall: carved ashlar with gold inlay and soot
      M.wall = buildTex((x, y) => {
        const bh = 42, row = Math.floor(y / bh), off = (row % 2) * 22;
        const bx = ((x + off) % 52) / 52, by = (y % bh) / bh;
        const joint = bx < 0.04 || bx > 0.96 || by < 0.06 || by > 0.94;
        const grain = fbm(x / 6, y / 6, 4, 101, TEX / 6);
        const carve = Math.abs(Math.sin((x + row * 13) * 0.115)) < 0.22 && by > 0.2 && by < 0.8;
        let h = joint ? 0.1 : (carve ? 0.25 : 0.6 + grain * 0.35);
        let s = joint ? 44 : 76 + grain * 28;
        let r = s * 0.98, g = s * 0.9, b = s * 0.76;
        if (y > 44 && y < 62 && ((x + off) % 52 > 16 && (x + off) % 52 < 36)) {
          r = 208; g = 166; b = 74; h = 0.85;                       // inlay band
        }
        const soot = clamp(1 - y / 46, 0, 1) * fbm(x / 11, y / 11, 2, 111, TEX / 11);
        r *= 1 - soot * 0.5; g *= 1 - soot * 0.5; b *= 1 - soot * 0.45;
        return [r, g, b, h];
      }, { relief: 2.2, seam: 0.3, base: 0.34 });

      M.prop = buildTex((x, y) => {
        const flut = Math.abs(((x % 22) - 11) / 11);
        const n = fbm(x / 7, y / 7, 3, 121, TEX / 7);
        const band = (y % 54 < 7);
        let s = 126 - flut * 46 + n * 20;
        let r = s * 1.05, g = s * 0.88, b = s * 0.64;
        if (band) { r = 196; g = 156; b = 68; }
        return [r, g, b, band ? 0.9 : 0.7 - flut * 0.5 + n * 0.2];
      }, { relief: 2.0, seam: 0.26, base: 0.3 });

      M.shrine = buildTex((x, y) => {
        const n = fbm(x / 8, y / 8, 3, 131, TEX / 8);
        const fig = Math.hypot(x - 64, (y - 66) * 0.7) < 30;
        if (fig) {
          const gl = 1 - Math.min(1, Math.hypot(x - 64, y - 60) / 46);
          return [176 + gl * 74, 138 + gl * 74, 58 + gl * 60, 0.8];
        }
        const s = 92 + n * 30;
        return [s * 1.05, s * 0.88, s * 0.64, n * 0.7];
      }, { relief: 1.9, seam: 0.36, base: 0.3 });

      M.ground = buildFlat((x, y) => {
        const slab = 32;
        const jx = (x % slab) / slab, jy = (y % slab) / slab;
        const joint = jx < 0.05 || jx > 0.95 || jy < 0.05 || jy > 0.95;
        const polish = fbm(x / 18, y / 18, 3, 141, TEX / 18);
        const sx = Math.floor(x / slab), sy = Math.floor(y / slab);
        const diamond = ((sx + sy) % 2 === 0);
        let s = (diamond ? 78 : 62) + polish * 20;
        if (joint) s *= 0.66;
        return [s * 1.02, s * 0.9, s * 0.74, joint ? 0.1 : 0.55 + polish * 0.3];
      });

      M.ceil = buildFlat((x, y) => {
        const c = 34, jx = (x % c) / c, jy = (y % c) / c;
        const coffer = Math.max(Math.abs(jx - 0.5), Math.abs(jy - 0.5));
        const n = fbm(x / 9, y / 9, 3, 151, TEX / 9);
        const deep = coffer < 0.34;
        const s = (deep ? 24 : 48) + n * 14;
        return [s * 1.02, s * 0.92, s * 0.78, deep ? 0.1 : 0.7];
      });
    }

    // ---- decking, shared: planks with grain and dark gaps
    M.plank = buildFlat((x, y) => {
      const pw = 21, plank = Math.floor(y / pw);
      const gap = (y % pw) < 2.2;
      const grain = fbm(x / 3, plank * 9, 3, 161, TEX / 3);
      const knot = h2((x / 16) | 0, plank, 171) > 0.93 ? 0.5 : 0;
      let s = 148 + grain * 42 + h2(0, plank, 181) * 20 - knot * 60;
      if (gap) s *= 0.5;
      return [s, s * 0.76, s * 0.5, gap ? 0.05 : 0.55 + grain * 0.4];
    });

    // ---- water is shaded live, this is just the base ripple relief
    M.waterBase = level === 2 ? [30, 52, 68] : level === 1 ? [38, 84, 106] : [30, 82, 120];
    return M;
  }

  // ------------------------------------------------------------- sprites
  /** tiny supersampled rasteriser, so sprite edges are smooth rather than jagged */
  function raster(w, h, paint) {
    const S = 3, bw = w * S, bh = h * S;
    const buf = new Float32Array(bw * bh * 4);
    const P = {
      W: bw, H: bh, S,
      poly(pts, col) {
        let minY = 1e9, maxY = -1e9;
        for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        minY = Math.max(0, Math.floor(minY * S)); maxY = Math.min(bh - 1, Math.ceil(maxY * S));
        for (let y = minY; y <= maxY; y++) {
          const yy = (y + 0.5) / S, xs = [];
          for (let i = 0, n = pts.length; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy))
              xs.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
          xs.sort((p, q) => p - q);
          for (let i = 0; i + 1 < xs.length; i += 2) {
            const x0 = Math.max(0, Math.ceil(xs[i] * S)), x1 = Math.min(bw - 1, Math.floor(xs[i + 1] * S));
            for (let x = x0; x <= x1; x++) {
              const c = typeof col === 'function' ? col((x + 0.5) / S, yy) : col;
              if (!c) continue;
              const o = (y * bw + x) * 4;
              const a = c[3] === undefined ? 1 : c[3];
              buf[o] = lerp(buf[o], c[0], a); buf[o + 1] = lerp(buf[o + 1], c[1], a);
              buf[o + 2] = lerp(buf[o + 2], c[2], a); buf[o + 3] = Math.max(buf[o + 3], a);
            }
          }
        }
      },
      ellipse(cx, cy, rx, ry, col) {
        const pts = [];
        for (let i = 0; i < 28; i++) {
          const a = i / 28 * Math.PI * 2;
          pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
        }
        this.poly(pts, col);
      },
      rect(x0, y0, x1, y1, col) { this.poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], col); },
    };
    paint(P);
    // box filter down to the final size
    const out = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
          const o = ((y * S + j) * bw + x * S + i) * 4;
          r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
        }
        const n = S * S;
        out[y * w + x] = rgba(clamp(r / n, 0, 255) | 0, clamp(g / n, 0, 255) | 0,
                              clamp(b / n, 0, 255) | 0, clamp(a / n * 255, 0, 255) | 0);
      }
    }
    return { w, h, d: out };
  }

  /** a runner: shaded cloak, rim light, soft shadow, four walk frames */
  function makePerson(level, frame) {
    const cloak = level === 2 ? [96, 86, 124] : level === 1 ? [128, 112, 92] : [104, 118, 126];
    const skin = [212, 172, 136], hair = [54, 40, 32];
    const sw = Math.sin(frame / 4 * Math.PI * 2);        // arm / leg swing
    const bob = Math.abs(Math.cos(frame / 4 * Math.PI)) * 1.1;
    return raster(30, 52, P => {
      P.ellipse(15, 50, 9, 2.6, [0, 0, 0, 0.30]);        // contact shadow
      const top = 16 - bob, hem = 46 - bob * 0.3;
      // legs
      P.poly([[12 + sw * 2, hem - 8], [15 + sw * 2, hem - 8], [15 + sw * 3, hem], [11 + sw * 3, hem]],
             [cloak[0] * .6, cloak[1] * .6, cloak[2] * .6]);
      P.poly([[15 - sw * 2, hem - 8], [18 - sw * 2, hem - 8], [19 - sw * 3, hem], [15 - sw * 3, hem]],
             [cloak[0] * .5, cloak[1] * .5, cloak[2] * .5]);
      // cloak, lit from the left with a cool rim on the right
      P.poly([[9, top], [21, top], [24, hem - 4], [6, hem - 4]], (x, y) => {
        const u = (x - 6) / 18, v = (y - top) / (hem - top);
        let k = 1.18 - u * 0.55 - v * 0.16;
        if (u > 0.88) k += 0.5;
        return [cloak[0] * k, cloak[1] * k, cloak[2] * k];
      });
      // arms
      P.poly([[7, top + 3], [10, top + 3], [9 + sw * 2.5, top + 17], [6 + sw * 2.5, top + 17]],
             [cloak[0] * .82, cloak[1] * .82, cloak[2] * .82]);
      P.poly([[20, top + 3], [23, top + 3], [24 - sw * 2.5, top + 17], [21 - sw * 2.5, top + 17]],
             [cloak[0] * .9, cloak[1] * .9, cloak[2] * .9]);
      // head, shaded like a sphere
      P.ellipse(15, top - 6, 6.4, 7, (x, y) => {
        const k = 1.2 - (x - 9) / 13 * 0.5 - (y - (top - 13)) / 14 * 0.2;
        return [skin[0] * k, skin[1] * k, skin[2] * k];
      });
      P.poly([[9, top - 11], [21, top - 11], [21, top - 7], [9, top - 7]], hair);
      P.ellipse(15, top - 12, 6.4, 3.4, hair);
    });
  }

  function makeChest() {
    return raster(30, 26, P => {
      P.ellipse(15, 24, 11, 2.6, [0, 0, 0, 0.3]);
      P.rect(3, 11, 27, 23, (x, y) => {
        const k = 1.16 - (x - 3) / 24 * 0.45 - (y - 11) / 12 * 0.2;
        return [152 * k, 104 * k, 42 * k];
      });
      P.ellipse(15, 11, 12, 7.5, (x, y) => {
        const k = 1.25 - (x - 3) / 24 * 0.4 - (11 - y) / 8 * 0.25;
        return [214 * k, 160 * k, 58 * k];
      });
      P.rect(3, 10, 27, 13, [108, 72, 26]);
      P.rect(13, 13, 17, 19, [250, 228, 152]);
      P.rect(3, 11, 5, 23, [110, 76, 30]);
      P.rect(25, 11, 27, 23, [188, 132, 54]);
    });
  }

  function makeIdol() {
    // a seated figure on a stepped plinth: headdress, folded arms, gold leaf
    const gold = (k) => [clamp(244 * k, 0, 255), clamp(198 * k, 0, 255), clamp(88 * k, 0, 255)];
    const lit = (x, y, x0, span, y0, ysp) => 1.34 - (x - x0) / span * 0.6 - (y - y0) / ysp * 0.14;
    return raster(40, 68, P => {
      P.ellipse(20, 66, 17, 3.4, [0, 0, 0, 0.34]);
      // plinth, two steps
      P.rect(3, 58, 37, 65, (x, y) => gold(0.72 - (x - 3) / 34 * 0.2));
      P.rect(7, 51, 33, 58, (x, y) => gold(0.86 - (x - 7) / 26 * 0.25));
      // crossed legs
      P.poly([[9, 44], [31, 44], [34, 52], [6, 52]], (x, y) => gold(lit(x, y, 6, 28, 44, 10)));
      // torso
      P.poly([[13, 24], [27, 24], [31, 46], [9, 46]], (x, y) => gold(lit(x, y, 9, 22, 24, 24)));
      // folded arms
      P.poly([[9, 30], [31, 30], [30, 38], [10, 38]], (x, y) => gold(lit(x, y, 9, 22, 30, 9) * 0.92));
      // shoulders and neck
      P.ellipse(20, 25, 10, 4.5, (x, y) => gold(lit(x, y, 10, 20, 20, 10)));
      P.rect(18, 18, 22, 24, (x, y) => gold(1.0));
      // head
      P.ellipse(20, 13, 7.5, 8.5, (x, y) => gold(lit(x, y, 12, 16, 4, 18)));
      // tall headdress
      P.poly([[13, 8], [20, -2], [27, 8], [24, 10], [16, 10]], (x, y) => gold(lit(x, y, 13, 14, -2, 12) * 1.05));
      P.ellipse(20, 2, 2.6, 2.6, [255, 246, 206]);
      // face shadow, so the head reads as a face not a ball
      P.ellipse(17, 13, 1.5, 1.9, [150, 112, 40]);
      P.ellipse(23, 13, 1.5, 1.9, [150, 112, 40]);
      P.rect(18, 17, 22, 18, [168, 126, 46]);
    });
  }

  function makeBoat() {
    return raster(40, 20, P => {
      P.ellipse(20, 18, 16, 2.4, [0, 0, 0, 0.22]);
      P.poly([[2, 9], [38, 9], [32, 17], [8, 17]], (x, y) => {
        const k = 1.15 - (y - 9) / 8 * 0.4;
        return [126 * k, 86 * k, 48 * k];
      });
      P.rect(2, 8, 38, 10, [96, 64, 34]);
      P.rect(18, 1, 21, 9, [158, 118, 74]);
      P.poly([[21, 1], [31, 5], [21, 7]], [232, 226, 206]);
    });
  }

  /** plants, urns, braziers - whatever dresses this level's ground */
  function makePlants(level) {
    const out = [];
    const leafy = (cols, blossom) => raster(24, 26, P => {
      P.ellipse(12, 24, 7, 2, [0, 0, 0, 0.22]);
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i - 3) * 0.36, len = 12 + (i % 3) * 5;
        const tipx = 12 + Math.cos(a) * len, tipy = 23 + Math.sin(a) * len;
        const c = cols[i % cols.length];
        P.poly([[12, 24], [12 + Math.cos(a + .28) * len * .5, 23 + Math.sin(a + .28) * len * .5],
                [tipx, tipy], [12 + Math.cos(a - .28) * len * .5, 23 + Math.sin(a - .28) * len * .5]],
               (x, y) => { const k = 1.2 - (y / 26) * 0.5; return [c[0] * k, c[1] * k, c[2] * k]; });
      }
      if (blossom) for (let i = 0; i < 3; i++) {
        const bx = 6 + i * 6, by = 8 + (i % 2) * 5;
        for (let p = 0; p < 5; p++) {
          const a = p / 5 * Math.PI * 2;
          P.ellipse(bx + Math.cos(a) * 2.2, by + Math.sin(a) * 2.2, 1.9, 1.9, blossom);
        }
        P.ellipse(bx, by, 1.3, 1.3, [250, 224, 130]);
      }
    });

    if (level === 0) {
      out.push(leafy([[46, 118, 52], [58, 134, 60], [38, 100, 44]], null));            // fern
      out.push(leafy([[64, 128, 58], [76, 142, 66]], [238, 132, 176]));                // pink blossoms
      out.push(leafy([[70, 136, 60], [84, 148, 70]], [246, 214, 118]));                // gold blossoms
      out.push(leafy([[96, 150, 78], [110, 160, 88]], [248, 246, 226]));               // white blossoms
    } else if (level === 1) {
      out.push(leafy([[104, 120, 72], [118, 132, 84]], null));                         // dry shrub
      out.push(leafy([[74, 112, 58], [88, 124, 66]], [226, 138, 172]));                // wildflowers
      out.push(raster(24, 26, P => {                                                   // broken urn
        P.ellipse(12, 24, 8, 2.2, [0, 0, 0, 0.24]);
        P.poly([[6, 10], [18, 10], [16, 24], [8, 24]], (x, y) => {
          const k = 1.2 - (x - 6) / 12 * 0.45; return [176 * k, 150 * k, 116 * k];
        });
        P.rect(5, 8, 19, 11, [158, 132, 100]);
      }));
      out.push(leafy([[92, 134, 66]], [240, 232, 150]));
    } else {
      out.push(raster(24, 30, P => {                                                   // brazier
        P.ellipse(12, 28, 8, 2.2, [0, 0, 0, 0.3]);
        P.poly([[8, 16], [16, 16], [14, 28], [10, 28]], [78, 64, 44]);
        P.poly([[5, 11], [19, 11], [17, 17], [7, 17]], (x, y) => {
          const k = 1.2 - (x - 5) / 14 * 0.4; return [132 * k, 106 * k, 64 * k];
        });
        P.ellipse(12, 8, 5, 6, [250, 186, 80, 0.92]);
        P.ellipse(12, 6, 3, 4, [254, 236, 168]);
      }));
      out.push(raster(24, 26, P => {                                                   // rubble
        P.ellipse(12, 23, 9, 2.4, [0, 0, 0, 0.26]);
        P.poly([[5, 18], [12, 15], [17, 20], [8, 23]], [116, 98, 72]);
        P.poly([[12, 20], [19, 17], [21, 23], [13, 24]], [96, 80, 58]);
      }));
      out.push(raster(24, 26, P => {                                                   // gold offering bowl
        P.ellipse(12, 23, 8, 2.2, [0, 0, 0, 0.26]);
        P.ellipse(12, 19, 8, 4, [188, 148, 62]);
        P.ellipse(12, 17, 6.5, 3, [236, 198, 96]);
      }));
      out.push(raster(24, 26, P => { P.ellipse(12, 23, 7, 2, [0, 0, 0, 0.2]); }));
    }
    // reeds for the water's edge, and lily pads for the water itself
    out.push(raster(22, 30, P => {
      P.ellipse(11, 28, 6, 1.8, [0, 0, 0, 0.18]);
      for (let i = 0; i < 9; i++) {
        const x = 3 + i * 2, top = 4 + (i % 4) * 5, lean = (i % 3 - 1) * 2.5;
        P.poly([[x, 28], [x + 1.6, 28], [x + 1.2 + lean, top], [x + lean, top]],
               (px, py) => { const k = 1.25 - py / 30 * 0.6; return [96 * k, 138 * k, 74 * k]; });
      }
    }));
    out.push(raster(28, 14, P => {
      P.ellipse(14, 8, 12, 5.5, (x, y) => { const k = 1.15 - (y - 3) / 11 * 0.3; return [70 * k, 126 * k, 66 * k]; });
      P.poly([[14, 8], [26, 6], [26, 10]], [42, 82, 44]);
      for (let p = 0; p < 5; p++) {
        const a = p / 5 * Math.PI * 2;
        P.ellipse(9 + Math.cos(a) * 2.4, 6 + Math.sin(a) * 2.4, 2, 2, [250, 242, 248]);
      }
      P.ellipse(9, 6, 1.4, 1.4, [248, 218, 120]);
    }));
    return out;   // last two are always [reeds, lilypad]
  }

  // ----------------------------------------------------------------- sky
  /** a 360 degree panorama: gradient, sun with glow, layered cloud, haze */
  function buildSky(level, width, height) {
    const L = LOOKS[level];
    const d = new Uint32Array(width * height);
    const sunU = 0.28, sunV = 0.26;
    for (let y = 0; y < height; y++) {
      const v = y / height;
      for (let x = 0; x < width; x++) {
        const u = x / width;
        let c = mix(L.sky[0], L.sky[1], Math.pow(v, 0.85));
        // sun: a bright core with a wide warm halo
        let du = Math.abs(u - sunU); du = Math.min(du, 1 - du) * 3.4;
        const dv = (v - sunV) * 1.5;
        const sd = Math.hypot(du, dv);
        if (sd < 0.62) {
          const halo = Math.pow(1 - sd / 0.62, 3);
          c = mix(c, L.sun, halo * 0.75);
        }
        if (sd < 0.055) c = L.sunCore.slice();
        // cloud banks, thinning towards the horizon
        const cl = fbm(u * 9, v * 5 + 3, 4, 7, 9) * 1.5 - 0.42;
        if (cl > 0) {
          const cover = clamp(cl * 2.4, 0, 1) * clamp((0.92 - v) * 2.4, 0, 1);
          const lit = clamp(1 - sd * 0.9, 0, 1);
          c = mix(c, mix(L.cloud, L.cloudLit, lit), cover * 0.9);
        }
        // haze band right on the horizon
        c = mix(c, L.fog, Math.pow(clamp(v, 0, 1), 6) * 0.85);
        d[y * width + x] = rgb(clamp(c[0], 0, 255) | 0, clamp(c[1], 0, 255) | 0, clamp(c[2], 0, 255) | 0);
      }
    }
    return { w: width, h: height, d };
  }

  // -------------------------------------------------------------- palettes
  const LOOKS = [
    { // The Forest
      sky: [[86, 156, 224], [190, 222, 236]], sun: [255, 238, 190], sunCore: [255, 252, 238],
      cloud: [206, 214, 224], cloudLit: [255, 250, 240],
      fog: [178, 206, 186], fogFrom: 6, fogTo: 30, indoor: false, lamp: 0, ambient: 1,
    },
    { // The Ruins
      sky: [[238, 150, 92], [250, 214, 168]], sun: [255, 206, 140], sunCore: [255, 246, 222],
      cloud: [206, 158, 138], cloudLit: [255, 226, 190],
      fog: [226, 186, 152], fogFrom: 5, fogTo: 26, indoor: false, lamp: 0.18, ambient: 0.98,
    },
    { // The Temple
      sky: [[26, 20, 14], [40, 30, 20]], sun: [60, 44, 28], sunCore: [70, 52, 32],
      cloud: [30, 24, 16], cloudLit: [46, 36, 24],
      fog: [14, 17, 26], fogFrom: 2.0, fogTo: 11, indoor: true, lamp: 0.5, ambient: 0.5,
    },
  ];

  return { rgb, rgba, clamp, lerp, mix, h2, fbm, TEX, TMASK, LOOKS,
           makeMaterials, makePerson, makeChest, makeIdol, makeBoat, makePlants, buildSky, raster };
})();

if (typeof module !== 'undefined') module.exports = GFX;
