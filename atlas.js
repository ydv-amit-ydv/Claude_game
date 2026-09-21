/* THE LAST GARDEN - the sprite forge.
 *
 * Every standing thing in the garden - trees, flowers, urns, people, the
 * idol - is drawn ONCE here into an offscreen canvas at twice the size it
 * will be seen at, then blitted wherever it is needed. Two things follow
 * from that:
 *
 *   - it is fast. A tree that used to cost forty path operations every
 *     frame now costs one drawImage.
 *   - it can afford to be beautiful. A sprite baked once can carry three
 *     canopy layers, a lit rim, bark grain and a soft contact shadow,
 *     because nobody pays for it twice.
 *
 * Everything is drawn from code - no PNG is fetched, so nothing can fail
 * to load on fest wifi - but it is drawn as artwork rather than as
 * geometry: one sun, consistent shadows, and colour chosen per level.
 *
 * SUN is the single light direction for the whole game. Every highlight
 * and every shadow in this file and in painted.js derives from it, which
 * is most of why the world reads as solid.
 */
'use strict';

const ATLAS = (() => {

  const TAU = Math.PI * 2;

  // one sun for the whole world: high, and over your left shoulder
  const SUN = { x: -0.62, y: -0.78, amb: 0.42 };

  const SS = 2;              // supersample: bake at 2x, blit down, stay crisp
  const CAP = 420;           // sprites kept alive; a level uses far fewer
  const cache = new Map();

  function h2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 144665371) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  /** mix two '#rrggbb' colours */
  function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * t);
    const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
    const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }
  const lit = (c, t) => mix(c, '#fff8e0', t);
  const shade = (c, t) => mix(c, '#111a20', t);

  // In the browser this is document.createElement('canvas'); the headless
  // test harness swaps in its own so the same art can be rendered to PNG.
  let makeCanvas = () => document.createElement('canvas');
  function setCanvasFactory(fn) { makeCanvas = fn; }

  function newCanvas(w, h) {
    const c = makeCanvas();
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /**
   * Bake a sprite, or return the one already baked.
   * `draw(c, w, h)` paints into a canvas whose origin is the top-left and
   * whose bottom-centre is the point the sprite stands on.
   */
  function sprite(key, w, h, draw) {
    let s = cache.get(key);
    if (s) { cache.delete(key); cache.set(key, s); return s; }   // LRU touch
    const cv = newCanvas(w * SS, h * SS);
    const c = cv.getContext('2d');
    c.scale(SS, SS);
    draw(c, w, h);
    s = { cv, w, h };
    cache.set(key, s);
    while (cache.size > CAP) cache.delete(cache.keys().next().value);
    return s;
  }

  /** draw a baked sprite so its bottom-centre lands on (x, y) */
  function blit(c, s, x, y, alpha) {
    if (alpha !== undefined && alpha !== 1) {
      c.save(); c.globalAlpha = alpha;
      c.drawImage(s.cv, x - s.w / 2, y - s.h, s.w, s.h);
      c.restore();
    } else {
      c.drawImage(s.cv, x - s.w / 2, y - s.h, s.w, s.h);
    }
  }

  function clear() { cache.clear(); }

  // ---------------------------------------------------------------- pieces
  /** the soft dark pool every standing thing sits in */
  function contact(c, cx, cy, rx, ry, strength) {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(12,22,14,${strength})`);
    g.addColorStop(.55, `rgba(12,22,14,${strength * .55})`);
    g.addColorStop(1, 'rgba(12,22,14,0)');
    c.save();
    c.translate(cx, cy); c.scale(1, ry / Math.max(rx, ry)); c.translate(-cx, -cy);
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, Math.max(rx, ry), 0, TAU); c.fill();
    c.restore();
  }

  /** a cast shadow, stretched away from the sun */
  function cast(c, cx, cy, r, strength) {
    c.save();
    c.translate(cx, cy);
    c.rotate(Math.atan2(-SUN.y, -SUN.x));
    c.scale(1.7, .42);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(10,20,12,${strength})`);
    g.addColorStop(1, 'rgba(10,20,12,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(r * .34, 0, r, 0, TAU); c.fill();
    c.restore();
  }

  /**
   * One blob of foliage: a shaded ball of leaves with a sun-side rim and
   * a scatter of individual leaf dabs along its lit edge. Three of these
   * overlapping is what makes a canopy read as a tree rather than a disc.
   */
  function foliage(c, cx, cy, r, dark, mid, lightc, seed, leafy) {
    const lx = cx + SUN.x * r * .42, ly = cy + SUN.y * r * .42;
    const g = c.createRadialGradient(lx, ly, r * .08, cx, cy, r);
    g.addColorStop(0, lit(lightc, .22));
    g.addColorStop(.38, lightc);
    g.addColorStop(.72, mid);
    g.addColorStop(1, dark);
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.fill();

    // leaf dabs: small, dense on the lit side, sparse and dark below
    const n = leafy === false ? 0 : Math.max(6, Math.round(r * 1.5));
    for (let i = 0; i < n; i++) {
      const a = h2(seed, i, 7) * TAU;
      const d = r * (.42 + h2(seed, i, 11) * .56);
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d * .92;
      const facing = (Math.cos(a) * SUN.x + Math.sin(a) * SUN.y);   // 1 = into the sun
      const lr = r * (.10 + h2(seed, i, 13) * .13);
      c.fillStyle = facing > .2 ? lit(lightc, .3 * facing)
                  : facing > -.3 ? mid : shade(dark, .22);
      c.globalAlpha = .55 + h2(seed, i, 17) * .45;
      c.beginPath();
      c.ellipse(px, py, lr, lr * .74, a, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;

    // the rim where the sun grazes the top of the crown
    c.save();
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip();
    const rim = c.createLinearGradient(cx + SUN.x * r, cy + SUN.y * r, cx - SUN.x * r * .3, cy - SUN.y * r * .3);
    rim.addColorStop(0, `rgba(255,248,210,.34)`);
    rim.addColorStop(.45, 'rgba(255,248,210,0)');
    c.fillStyle = rim;
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.fill();
    c.restore();
  }

  /** a trunk with bark grain, tapering and leaning very slightly */
  function trunk(c, cx, base, h, w, col, seed) {
    const lean = (h2(seed, 3, 5) - .5) * w * .8;
    const top = base - h;
    const g = c.createLinearGradient(cx - w, 0, cx + w, 0);
    g.addColorStop(0, shade(col, .3));
    g.addColorStop(.32, lit(col, .16));
    g.addColorStop(1, shade(col, .42));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - w, base);
    c.quadraticCurveTo(cx - w * .62, base - h * .5, cx + lean - w * .42, top);
    c.lineTo(cx + lean + w * .42, top);
    c.quadraticCurveTo(cx + w * .62, base - h * .5, cx + w, base);
    c.closePath(); c.fill();
    // grain
    c.strokeStyle = `rgba(30,20,12,.22)`;
    c.lineWidth = Math.max(.4, w * .12);
    for (let i = 0; i < 3; i++) {
      const f = -.4 + i * .4;
      c.beginPath();
      c.moveTo(cx + w * f, base);
      c.quadraticCurveTo(cx + w * f * .6, base - h * .5, cx + lean + w * f * .35, top);
      c.stroke();
    }
    // roots flaring into the ground
    c.fillStyle = shade(col, .34);
    c.beginPath();
    c.ellipse(cx, base, w * 1.5, w * .5, 0, 0, TAU);
    c.fill();
  }

  /** a five-petalled bloom seen from above-ish */
  function bloom(c, x, y, r, col, seed) {
    const petals = 5 + ((h2(seed, 1, 2) * 3) | 0);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + h2(seed, i, 9) * .4;
      c.fillStyle = i % 2 ? col : lit(col, .22);
      c.beginPath();
      c.ellipse(x + Math.cos(a) * r * .52, y + Math.sin(a) * r * .46,
                r * .5, r * .34, a, 0, TAU);
      c.fill();
    }
    c.fillStyle = '#ffdf86';
    c.beginPath(); c.arc(x, y, r * .27, 0, TAU); c.fill();
    c.fillStyle = 'rgba(180,120,20,.5)';
    c.beginPath(); c.arc(x - r * .07, y - r * .07, r * .13, 0, TAU); c.fill();
  }


  // ================================================================ catalogue
  // Each entry bakes one kind of thing at one size for one level. The cache
  // key carries both, so walking between levels or zooming rebakes cleanly.

  const TREE_KINDS = 6;

  /** A tree. Kind picks the silhouette; the palette picks the season. */
  function tree(T, P, level, kind, seed) {
    const w = T * 2.5, h = T * 3.0;
    return sprite(`tr|${T}|${level}|${kind}|${seed & 7}`, w, h, (c) => {
      const cx = w / 2, base = h - T * 0.16;
      const s = (seed & 7) + kind * 31;
      const [d, m, l] = P.canopy;
      cast(c, cx, base, T * .95, .30);
      contact(c, cx, base, T * .62, T * .20, .38);

      if (kind === 0) {                       // broadleaf: three overlapping crowns
        trunk(c, cx, base, T * 1.12, T * .16, P.trunk, s);
        foliage(c, cx - T * .46, base - T * 1.42, T * .70, d, m, l, s + 1);
        foliage(c, cx + T * .48, base - T * 1.30, T * .64, d, m, l, s + 2);
        foliage(c, cx, base - T * 1.92, T * .78, d, m, l, s + 3);
      } else if (kind === 1) {                // cypress: a tall dark flame
        trunk(c, cx, base, T * .55, T * .11, P.trunk, s);
        for (let i = 0; i < 4; i++) {
          const yy = base - T * (.55 + i * .52), rr = T * (.62 - i * .11);
          foliage(c, cx + (i % 2 ? .06 : -.06) * T, yy, rr, shade(d, .12), d, m, s + i);
        }
      } else if (kind === 2) {                // blossom tree
        trunk(c, cx, base, T * 1.05, T * .14, P.trunk, s);
        foliage(c, cx - T * .40, base - T * 1.34, T * .62, d, m, l, s + 1);
        foliage(c, cx + T * .42, base - T * 1.44, T * .66, d, m, l, s + 2);
        foliage(c, cx, base - T * 1.86, T * .70, d, m, l, s + 3);
        for (let i = 0; i < 26; i++) {        // blossom clustered on the crown
          const a = h2(s, i, 21) * TAU, rr = T * (.3 + h2(s, i, 23) * 1.0);
          const bx = cx + Math.cos(a) * rr, by = base - T * 1.55 + Math.sin(a) * rr * .62;
          bloom(c, bx, by, T * (.10 + h2(s, i, 27) * .07),
                P.blossom[(h2(s, i, 29) * P.blossom.length) | 0], s + i);
        }
      } else if (kind === 3) {                // palm-ish fan, for the water's edge
        trunk(c, cx, base, T * 1.6, T * .12, P.trunk, s);
        const top = base - T * 1.6;
        for (let i = 0; i < 7; i++) {
          const a = -Math.PI / 2 + (i - 3) * .42;
          const ex = cx + Math.cos(a) * T * 1.0, ey = top + Math.sin(a) * T * .78;
          const facing = Math.cos(a) * SUN.x + Math.sin(a) * SUN.y;
          c.fillStyle = facing > 0 ? l : m;
          c.beginPath();
          c.moveTo(cx, top);
          c.quadraticCurveTo((cx + ex) / 2, (top + ey) / 2 - T * .24, ex, ey);
          c.quadraticCurveTo((cx + ex) / 2, (top + ey) / 2 + T * .10, cx, top);
          c.fill();
        }
      } else if (kind === 4) {                // gnarled dead tree, for the ruins
        trunk(c, cx, base, T * 1.45, T * .22, '#6a5a44', s);
        c.lineCap = 'round';
        for (let i = 0; i < 6; i++) {
          const sgn = i % 2 ? 1 : -1;
          const a = -Math.PI / 2 + sgn * (.5 + h2(s, i, 31) * .7);
          const y0 = base - T * (.75 + i * .18);
          const len = T * (.95 - i * .07);
          // each limb is drawn dark then re-drawn thinner and lit on the sun side
          for (const [col, wid] of [['#4e4032', .19], ['#7d6a50', .12]]) {
            c.strokeStyle = col; c.lineWidth = T * (wid - i * .012);
            c.beginPath();
            c.moveTo(cx + sgn * T * .04, y0);
            c.quadraticCurveTo(cx + Math.cos(a) * len * .55, y0 - T * .34,
                               cx + Math.cos(a) * len, y0 - T * .62);
            c.stroke();
          }
          // a forked twig off the end
          c.strokeStyle = '#6a5a44'; c.lineWidth = T * .05;
          const tx = cx + Math.cos(a) * len, ty = y0 - T * .62;
          c.beginPath();
          c.moveTo(tx, ty); c.lineTo(tx + Math.cos(a) * T * .26, ty - T * .22);
          c.moveTo(tx, ty); c.lineTo(tx + Math.cos(a) * T * .10, ty - T * .30);
          c.stroke();
        }
        for (let i = 0; i < 9; i++) {         // a few vines still clinging on
          const a = h2(s, i, 37) * TAU;
          c.strokeStyle = 'rgba(86,132,64,.75)'; c.lineWidth = T * .05;
          const vx = cx + Math.cos(a) * T * .5, vy = base - T * (.9 + h2(s, i, 41) * .7);
          c.beginPath(); c.moveTo(vx, vy);
          c.quadraticCurveTo(vx + T * .12, vy + T * .3, vx - T * .06, vy + T * .58);
          c.stroke();
        }
      } else {                                // dense round shade tree
        trunk(c, cx, base, T * .9, T * .18, P.trunk, s);
        foliage(c, cx, base - T * 1.62, T * .95, d, m, l, s + 5);
        foliage(c, cx - T * .52, base - T * 1.18, T * .52, d, m, l, s + 6);
        foliage(c, cx + T * .54, base - T * 1.20, T * .50, d, m, l, s + 7);
      }
    });
  }

  /** A low bush - the filler that stops open turf looking bare. */
  function bush(T, P, level, seed) {
    const w = T * 1.15, h = T * .95;
    return sprite(`bu|${T}|${level}|${seed & 7}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .06, s = seed & 7;
      const [d, m, l] = P.canopy;
      contact(c, cx, base, T * .38, T * .13, .34);
      foliage(c, cx - T * .18, base - T * .28, T * .30, d, m, l, s + 1);
      foliage(c, cx + T * .20, base - T * .26, T * .28, d, m, l, s + 2);
      foliage(c, cx, base - T * .44, T * .33, d, m, l, s + 3);
    });
  }

  /** A clump of flowers in the grass. */
  function clump(T, P, level, seed) {
    const w = T * .92, h = T * .72;
    return sprite(`cl|${T}|${level}|${seed & 15}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .04, s = seed & 15;
      contact(c, cx, base, T * .26, T * .09, .26);
      const n = 4 + ((h2(s, 0, 3) * 4) | 0);
      for (let i = 0; i < n; i++) {
        const fx = cx + (h2(s, i, 5) - .5) * T * .62;
        const fh = T * (.22 + h2(s, i, 7) * .26);
        c.strokeStyle = mix(P.canopy[1], '#8fbf5e', .5);
        c.lineWidth = T * .035;
        c.beginPath(); c.moveTo(fx, base);
        c.quadraticCurveTo(fx + (h2(s, i, 11) - .5) * T * .16, base - fh * .6, fx, base - fh);
        c.stroke();
        // a leaf off the stem
        c.fillStyle = P.canopy[0];
        c.beginPath();
        c.ellipse(fx + T * .07, base - fh * .38, T * .07, T * .035, .5, 0, TAU);
        c.fill();
        bloom(c, fx, base - fh, T * (.085 + h2(s, i, 13) * .05),
              P.blossom[(h2(s, i, 17) * P.blossom.length) | 0], s + i);
      }
    });
  }


  // ---------------------------------------------------------------- figures
  const WALK_FRAMES = 4;

  /**
   * A runner, seen from slightly above and behind. Four headings and four
   * walk frames each, baked per tint - 32 little sprites that between them
   * cover every figure on screen.
   */
  function person(T, facing, frame, body, trim, seed) {
    const w = T * 1.05, h = T * 1.62;
    return sprite(`pe|${T}|${facing}|${frame}|${body}|${trim}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .06;
      const ph = frame / WALK_FRAMES * TAU;
      const sw = Math.sin(ph);                            // limb swing
      const bob = Math.abs(Math.cos(ph)) * T * .05;       // rise and fall of the gait
      const back = facing === 0, front = facing === 2;
      const side = facing === 1 ? 1 : facing === 3 ? -1 : 0;

      const foot = base - T * .02;
      const hip = base - T * .56;
      const shoulder = base - T * 1.06;
      const headY = base - T * 1.26 + bob * .6;
      const hr = T * .20;

      contact(c, cx, foot, T * .30, T * .11, .40);
      cast(c, cx, foot, T * .34, .26);

      // ---- legs, swinging opposite one another
      c.lineCap = 'round';
      for (const sgn of [-1, 1]) {
        const swing = sw * sgn * (side ? .40 : .30);
        const kx = cx + sgn * T * .10 * (side ? .35 : 1);
        c.strokeStyle = shade(body, sgn > 0 ? .50 : .38);
        c.lineWidth = T * .14;
        c.beginPath();
        c.moveTo(kx, hip);
        c.quadraticCurveTo(kx + swing * T * .5, (hip + foot) / 2, kx + swing * T, foot);
        c.stroke();
        c.strokeStyle = '#59452e'; c.lineWidth = T * .10;    // a boot
        c.beginPath();
        c.moveTo(kx + swing * T, foot);
        c.lineTo(kx + swing * T + (side || 1) * T * .07, foot);
        c.stroke();
      }

      // ---- the cloak: a tapering bell, lit from the sun side
      const g = c.createLinearGradient(cx - T * .32, 0, cx + T * .32, 0);
      g.addColorStop(0, lit(body, .30));
      g.addColorStop(.46, body);
      g.addColorStop(1, shade(body, .38));
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - T * .19, shoulder - bob);
      c.quadraticCurveTo(cx - T * .34, hip - T * .10, cx - T * .29, hip + T * .06);
      c.lineTo(cx + T * .29, hip + T * .06);
      c.quadraticCurveTo(cx + T * .34, hip - T * .10, cx + T * .19, shoulder - bob);
      c.closePath(); c.fill();
      // the hem, catching a little light where it swings
      c.fillStyle = shade(body, .5);
      c.beginPath();
      c.ellipse(cx, hip + T * .05, T * .29, T * .06, 0, 0, TAU);
      c.fill();
      // folds down the cloak
      c.strokeStyle = 'rgba(12,20,16,.22)'; c.lineWidth = T * .03;
      for (const f of [-.12, .06]) {
        c.beginPath();
        c.moveTo(cx + f * T, shoulder + T * .04);
        c.quadraticCurveTo(cx + f * T * 1.3, hip - T * .2, cx + f * T * 1.5, hip);
        c.stroke();
      }

      // ---- sash of trim, the one strong colour that says which side you are on
      c.fillStyle = trim;
      c.beginPath();
      c.moveTo(cx - T * .22, base - T * .86);
      c.lineTo(cx + T * .22, base - T * .92);
      c.lineTo(cx + T * .22, base - T * .82);
      c.lineTo(cx - T * .22, base - T * .76);
      c.closePath(); c.fill();
      // a small purse on the belt
      c.fillStyle = '#6d5030';
      c.beginPath(); c.ellipse(cx + T * .20, base - T * .74, T * .06, T * .07, 0, 0, TAU); c.fill();

      // ---- arms
      for (const sgn of [-1, 1]) {
        const swing = -sw * sgn * (side ? .34 : .26);
        c.strokeStyle = shade(body, sgn > 0 ? .30 : .16);
        c.lineWidth = T * .105;
        c.beginPath();
        c.moveTo(cx + sgn * T * .20, shoulder - bob + T * .04);
        c.quadraticCurveTo(cx + sgn * T * .26 + swing * T * .5, base - T * .78,
                           cx + sgn * T * .24 + swing * T, base - T * .60);
        c.stroke();
        c.fillStyle = '#e0b88c';                            // hand
        c.beginPath();
        c.arc(cx + sgn * T * .24 + swing * T, base - T * .60, T * .055, 0, TAU);
        c.fill();
      }

      // ---- neck and head
      c.strokeStyle = shade('#e8c49a', .3); c.lineWidth = T * .09;
      c.beginPath(); c.moveTo(cx, shoulder - bob); c.lineTo(cx, headY + hr * .7); c.stroke();
      const hg = c.createRadialGradient(cx + SUN.x * hr * .5, headY + SUN.y * hr * .5,
                                        hr * .08, cx, headY, hr);
      hg.addColorStop(0, lit('#eccba4', .30));
      hg.addColorStop(.7, '#e0b88c');
      hg.addColorStop(1, shade('#e0b88c', .30));
      c.fillStyle = hg;
      c.beginPath(); c.arc(cx, headY, hr, 0, TAU); c.fill();

      // the hood, pushed back off the face - a full cowl when seen from behind
      c.fillStyle = shade(body, .32);
      c.beginPath();
      if (back) {
        c.arc(cx, headY, hr * 1.06, 0, TAU);
      } else {
        c.arc(cx, headY, hr * 1.04, Math.PI * (1 + (side ? side * .12 : 0)),
              TAU * (1 + (side ? side * .06 : 0)));
        c.closePath();
      }
      c.fill();
      c.fillStyle = 'rgba(255,248,220,.16)';               // sun on the crown
      c.beginPath(); c.arc(cx + SUN.x * hr * .3, headY + SUN.y * hr * .5, hr * .5, 0, TAU); c.fill();

      if (front) {
        c.fillStyle = '#2f241a';
        c.beginPath(); c.arc(cx - hr * .33, headY + hr * .14, hr * .11, 0, TAU); c.fill();
        c.beginPath(); c.arc(cx + hr * .33, headY + hr * .14, hr * .11, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(120,70,50,.5)'; c.lineWidth = hr * .09;
        c.beginPath(); c.arc(cx, headY + hr * .34, hr * .26, .3, Math.PI - .3); c.stroke();
      } else if (side) {
        c.fillStyle = '#2f241a';
        c.beginPath(); c.arc(cx + side * hr * .40, headY + hr * .12, hr * .11, 0, TAU); c.fill();
        c.fillStyle = shade('#e0b88c', .12);               // the nose in profile
        c.beginPath();
        c.moveTo(cx + side * hr * .74, headY + hr * .04);
        c.lineTo(cx + side * hr * .98, headY + hr * .22);
        c.lineTo(cx + side * hr * .70, headY + hr * .26);
        c.closePath(); c.fill();
      }
    });
  }

  /** A treasure chest. Bonus chests are bigger and glow violet. */
  function chest(T, bonus) {
    const w = T * 1.05, h = T * .95;
    return sprite(`ch|${T}|${bonus ? 1 : 0}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .05;
      const bw = T * (bonus ? .40 : .34), bh = T * (bonus ? .30 : .26);
      contact(c, cx, base, bw * 1.3, bh * .5, .42);
      cast(c, cx, base, bw * 1.1, .26);
      // body
      const g = c.createLinearGradient(cx - bw, 0, cx + bw, 0);
      g.addColorStop(0, '#8a5a2c'); g.addColorStop(.35, '#b07a3e'); g.addColorStop(1, '#5e3a1c');
      c.fillStyle = g;
      c.fillRect(cx - bw, base - bh, bw * 2, bh);
      // domed lid
      c.fillStyle = '#9a6733';
      c.beginPath();
      c.ellipse(cx, base - bh, bw, bh * .72, 0, Math.PI, TAU);
      c.fill();
      const lg = c.createLinearGradient(cx + SUN.x * bw, base - bh * 1.6, cx, base - bh);
      lg.addColorStop(0, 'rgba(255,240,190,.45)'); lg.addColorStop(1, 'rgba(255,240,190,0)');
      c.fillStyle = lg;
      c.beginPath(); c.ellipse(cx, base - bh, bw, bh * .72, 0, Math.PI, TAU); c.fill();
      // iron bands and a lock
      c.fillStyle = bonus ? '#c9a2e8' : '#e0c064';
      c.fillRect(cx - bw * .10, base - bh * 1.7, bw * .20, bh * 1.7);
      c.fillRect(cx - bw, base - bh * .34, bw * 2, bh * .13);
      c.beginPath(); c.arc(cx, base - bh * .5, bw * .17, 0, TAU); c.fill();
      c.fillStyle = 'rgba(40,26,10,.6)';
      c.beginPath(); c.arc(cx, base - bh * .5, bw * .06, 0, TAU); c.fill();
      // coins spilling from under the lid
      for (let i = 0; i < 5; i++) {
        const a = h2(i, bonus ? 2 : 1, 5);
        c.fillStyle = a > .5 ? '#ffd45e' : '#e8b53c';
        c.beginPath();
        c.ellipse(cx + (a - .5) * bw * 1.5, base - bh * (1.02 + a * .16),
                  bw * .13, bw * .07, 0, 0, TAU);
        c.fill();
      }
    });
  }

  /** The idol at the heart of the level - the thing everyone is running at. */
  function idol(T) {
    const w = T * 2.2, h = T * 2.6;
    return sprite(`id|${T}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .1;
      contact(c, cx, base, T * .85, T * .30, .46);
      // stepped plinth
      for (let i = 0; i < 3; i++) {
        const pw = T * (.86 - i * .16), ph = T * .13;
        const y = base - i * ph;
        c.fillStyle = i % 2 ? '#c9b58a' : '#b8a279';
        c.beginPath(); c.ellipse(cx, y, pw, pw * .34, 0, 0, TAU); c.fill();
        c.fillStyle = 'rgba(60,48,30,.30)';
        c.beginPath(); c.ellipse(cx, y + ph * .5, pw, pw * .34, 0, 0, Math.PI); c.fill();
      }
      const fy = base - T * .42;
      // the figure: a seated golden idol
      const g = c.createLinearGradient(cx - T * .4, fy - T * 1.2, cx + T * .4, fy);
      g.addColorStop(0, '#fff0b0'); g.addColorStop(.42, '#f0c65e');
      g.addColorStop(.75, '#c99a2e'); g.addColorStop(1, '#8a6318');
      c.fillStyle = g;
      // body
      c.beginPath();
      c.moveTo(cx - T * .34, fy);
      c.quadraticCurveTo(cx - T * .30, fy - T * .62, cx - T * .17, fy - T * .74);
      c.lineTo(cx + T * .17, fy - T * .74);
      c.quadraticCurveTo(cx + T * .30, fy - T * .62, cx + T * .34, fy);
      c.closePath(); c.fill();
      // folded arms
      c.strokeStyle = '#d9ae45'; c.lineWidth = T * .10; c.lineCap = 'round';
      c.beginPath(); c.moveTo(cx - T * .24, fy - T * .40); c.lineTo(cx + T * .24, fy - T * .40); c.stroke();
      // head and halo
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, fy - T * .92, T * .19, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,232,150,.85)'; c.lineWidth = T * .045;
      c.beginPath(); c.arc(cx, fy - T * .92, T * .32, 0, TAU); c.stroke();
      // a crown of points
      c.fillStyle = '#ffe89a';
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * .38;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * T * .17, fy - T * .92 + Math.sin(a) * T * .17);
        c.lineTo(cx + Math.cos(a) * T * .34, fy - T * .92 + Math.sin(a) * T * .34);
        c.lineTo(cx + Math.cos(a + .16) * T * .17, fy - T * .92 + Math.sin(a + .16) * T * .17);
        c.closePath(); c.fill();
      }
      // braziers either side
      for (const sgn of [-1, 1]) {
        c.fillStyle = '#7a6a4a';
        c.fillRect(cx + sgn * T * .74 - T * .05, base - T * .46, T * .10, T * .40);
        c.fillStyle = '#9a8a66';
        c.beginPath(); c.ellipse(cx + sgn * T * .74, base - T * .46, T * .15, T * .06, 0, 0, TAU); c.fill();
      }
    });
  }

  /** A moored ferry boat. */
  function boat(T, seed) {
    const w = T * 2.0, h = T * .95;
    return sprite(`bo|${T}|${seed & 3}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .18;
      c.fillStyle = 'rgba(10,30,40,.30)';
      c.beginPath(); c.ellipse(cx, base + T * .1, T * .56, T * .13, 0, 0, TAU); c.fill();
      // the hull's flank, curving up to a point at each end
      const g = c.createLinearGradient(0, base - T * .34, 0, base + T * .10);
      g.addColorStop(0, '#b0844e'); g.addColorStop(.55, '#7d5730'); g.addColorStop(1, '#422c17');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - T * .86, base - T * .30);
      c.quadraticCurveTo(cx - T * .40, base + T * .12, cx, base + T * .13);
      c.quadraticCurveTo(cx + T * .40, base + T * .12, cx + T * .86, base - T * .30);
      c.quadraticCurveTo(cx + T * .44, base - T * .18, cx, base - T * .18);
      c.quadraticCurveTo(cx - T * .44, base - T * .18, cx - T * .86, base - T * .30);
      c.closePath(); c.fill();
      // the well of the boat, seen into from above
      c.fillStyle = '#33210f';
      c.beginPath(); c.ellipse(cx, base - T * .20, T * .70, T * .085, 0, 0, TAU); c.fill();
      c.fillStyle = '#6b4a29';
      c.beginPath(); c.ellipse(cx, base - T * .23, T * .64, T * .065, 0, 0, TAU); c.fill();
      // planking along the gunwale, and two thwarts across it
      c.strokeStyle = 'rgba(255,240,205,.30)'; c.lineWidth = T * .035;
      c.beginPath();
      c.moveTo(cx - T * .86, base - T * .30);
      c.quadraticCurveTo(cx, base - T * .14, cx + T * .86, base - T * .30);
      c.stroke();
      c.fillStyle = '#9a7042';
      for (const f of [-.26, .14]) {
        c.beginPath(); c.ellipse(cx + f * T, base - T * .22, T * .09, T * .05, 0, 0, TAU); c.fill();
      }
      // a pole leaning out of it
      c.strokeStyle = '#6f5130'; c.lineWidth = T * .05;
      c.beginPath(); c.moveTo(cx + T * .20, base - T * .28); c.lineTo(cx + T * .52, base - T * .80); c.stroke();
    });
  }


  // ---------------------------------------------------------------- scenery
  const PROP_KINDS = 11;

  /** The furniture of the garden: pavilions, fountains, urns, shrines. */
  function prop(T, P, level, kind, seed) {
    const w = T * 2.2, h = T * 2.6;
    return sprite(`pr|${T}|${level}|${kind}|${seed & 7}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .12, s = (seed & 7) + kind * 17;
      const st = P.stone;
      contact(c, cx, base, T * .60, T * .21, .38);
      cast(c, cx, base, T * .60, .24);

      if (kind === 0) {                       // garden pavilion
        for (const sgn of [-1, 1]) {
          c.fillStyle = st[0];
          c.fillRect(cx + sgn * T * .52 - T * .055, base - T * .96, T * .11, T * .96);
          c.fillStyle = 'rgba(255,248,220,.22)';
          c.fillRect(cx + sgn * T * .52 - T * .055, base - T * .96, T * .04, T * .96);
        }
        const rg = c.createLinearGradient(cx - T * .8, base - T * 1.6, cx + T * .8, base - T * .9);
        rg.addColorStop(0, lit('#8d5f46', .3)); rg.addColorStop(1, shade('#8d5f46', .3));
        c.fillStyle = rg;
        c.beginPath();
        c.moveTo(cx - T * .82, base - T * .94);
        c.lineTo(cx, base - T * 1.56);
        c.lineTo(cx + T * .82, base - T * .94);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(40,24,16,.30)';
        for (let i = 1; i < 5; i++) {
          c.fillRect(cx - T * .82 + i * T * .33, base - T * .96, T * .03, T * .04);
        }
        c.fillStyle = '#d8b25a';                // finial
        c.beginPath(); c.arc(cx, base - T * 1.62, T * .08, 0, TAU); c.fill();
      } else if (kind === 1) {                // tiered fountain
        for (let i = 0; i < 3; i++) {
          const rr = T * (.64 - i * .17), y = base - i * T * .34;
          // the stone rim, with a shaded underside so the tier has thickness
          c.fillStyle = shade(st[0], .34);
          c.beginPath(); c.ellipse(cx, y + rr * .12, rr, rr * .36, 0, 0, TAU); c.fill();
          c.fillStyle = lit(st[1], .12);
          c.beginPath(); c.ellipse(cx, y, rr, rr * .36, 0, 0, TAU); c.fill();
          // water sunk inside it
          const wg = c.createLinearGradient(0, y - rr * .3, 0, y + rr * .3);
          wg.addColorStop(0, '#2f6f8e'); wg.addColorStop(1, '#17435c');
          c.fillStyle = wg;
          c.beginPath(); c.ellipse(cx, y, rr * .72, rr * .25, 0, 0, TAU); c.fill();
          c.fillStyle = 'rgba(214,244,255,.55)';
          c.beginPath(); c.ellipse(cx - rr * .24, y - rr * .05, rr * .24, rr * .07, 0, 0, TAU); c.fill();
          // the column carrying the next tier up
          if (i < 2) { c.fillStyle = st[0]; c.fillRect(cx - rr * .13, y - T * .34, rr * .26, T * .34); }
        }
        c.strokeStyle = 'rgba(200,232,244,.72)'; c.lineWidth = T * .045;
        for (const sgn of [-1, 1]) {
          c.beginPath();
          c.moveTo(cx, base - T * .92);
          c.quadraticCurveTo(cx + sgn * T * .26, base - T * .80, cx + sgn * T * .30, base - T * .60);
          c.stroke();
        }
      } else if (kind === 2) {                // standing stone
        c.fillStyle = st[0];
        c.beginPath();
        c.moveTo(cx - T * .26, base);
        c.lineTo(cx - T * .19, base - T * 1.18);
        c.lineTo(cx + T * .17, base - T * 1.24);
        c.lineTo(cx + T * .25, base);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,250,225,.20)';
        c.beginPath();
        c.moveTo(cx - T * .26, base); c.lineTo(cx - T * .19, base - T * 1.18);
        c.lineTo(cx - T * .04, base - T * 1.21); c.lineTo(cx - T * .08, base);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(92,132,70,.5)';     // moss at the foot
        c.beginPath(); c.ellipse(cx, base - T * .06, T * .24, T * .09, 0, 0, TAU); c.fill();
      } else if (kind === 3) {                // well
        c.fillStyle = st[1];
        c.beginPath(); c.ellipse(cx, base - T * .30, T * .40, T * .16, 0, 0, TAU); c.fill();
        c.fillRect(cx - T * .40, base - T * .30, T * .80, T * .30);
        c.fillStyle = shade(st[1], .3);
        c.beginPath(); c.ellipse(cx, base, T * .40, T * .16, 0, 0, Math.PI); c.fill();
        c.fillStyle = '#16303a';
        c.beginPath(); c.ellipse(cx, base - T * .30, T * .29, T * .11, 0, 0, TAU); c.fill();
        c.fillStyle = 'rgba(110,180,200,.45)';
        c.beginPath(); c.ellipse(cx, base - T * .28, T * .22, T * .08, 0, 0, TAU); c.fill();
        c.strokeStyle = '#6f5130'; c.lineWidth = T * .055;
        c.beginPath();
        c.moveTo(cx - T * .32, base - T * .34); c.lineTo(cx - T * .28, base - T * .96);
        c.lineTo(cx + T * .28, base - T * .96); c.lineTo(cx + T * .32, base - T * .34);
        c.stroke();
        c.fillStyle = '#8d5f46';
        c.beginPath();
        c.moveTo(cx - T * .44, base - T * .92); c.lineTo(cx, base - T * 1.26);
        c.lineTo(cx + T * .44, base - T * .92); c.closePath(); c.fill();
      } else if (kind === 4) {                // trellis arch heavy with vine
        c.strokeStyle = '#8a6a44'; c.lineWidth = T * .07; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(cx - T * .44, base);
        c.quadraticCurveTo(cx - T * .44, base - T * 1.14, cx, base - T * 1.14);
        c.quadraticCurveTo(cx + T * .44, base - T * 1.14, cx + T * .44, base);
        c.stroke();
        for (let i = 0; i < 16; i++) {
          const u = i / 15, a = Math.PI + u * Math.PI;
          const vx = cx + Math.cos(a) * T * .44;
          const vy = base - T * 1.14 + Math.sin(a) * T * .0 + (1 - Math.sin(u * Math.PI)) * T * .5;
          c.fillStyle = P.canopy[(i % 3)];
          c.beginPath(); c.ellipse(vx, vy, T * .11, T * .08, u * 3, 0, TAU); c.fill();
          if (i % 3 === 0) bloom(c, vx + T * .05, vy + T * .06, T * .08,
                                 P.blossom[i % P.blossom.length], s + i);
        }
      } else if (kind === 5) {                // boulder wearing moss
        const g = c.createRadialGradient(cx + SUN.x * T * .2, base - T * .5 + SUN.y * T * .2,
                                         T * .05, cx, base - T * .34, T * .55);
        g.addColorStop(0, lit(st[1], .26)); g.addColorStop(1, shade(st[0], .3));
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(cx - T * .54, base - T * .04);
        c.lineTo(cx - T * .44, base - T * .46);
        c.lineTo(cx - T * .12, base - T * .70);
        c.lineTo(cx + T * .28, base - T * .62);
        c.lineTo(cx + T * .52, base - T * .26);
        c.lineTo(cx + T * .44, base - T * .02);
        c.closePath(); c.fill();
        // the plane that faces the sun, and the one turned away
        c.fillStyle = 'rgba(255,250,224,.26)';
        c.beginPath();
        c.moveTo(cx - T * .44, base - T * .46); c.lineTo(cx - T * .12, base - T * .70);
        c.lineTo(cx + T * .06, base - T * .40); c.lineTo(cx - T * .30, base - T * .24);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(16,26,32,.28)';
        c.beginPath();
        c.moveTo(cx + T * .28, base - T * .62); c.lineTo(cx + T * .52, base - T * .26);
        c.lineTo(cx + T * .44, base - T * .02); c.lineTo(cx + T * .14, base - T * .12);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(88,138,66,.6)';
        c.beginPath(); c.ellipse(cx - T * .16, base - T * .58, T * .22, T * .09, -.3, 0, TAU); c.fill();
        c.beginPath(); c.ellipse(cx + T * .22, base - T * .10, T * .16, T * .06, .1, 0, TAU); c.fill();
      } else if (kind === 6) {                // urn on a plinth
        c.fillStyle = st[0];
        c.fillRect(cx - T * .20, base - T * .26, T * .40, T * .26);
        const g = c.createLinearGradient(cx - T * .26, 0, cx + T * .26, 0);
        g.addColorStop(0, lit('#b4936a', .26)); g.addColorStop(1, shade('#b4936a', .34));
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(cx - T * .13, base - T * .26);
        c.quadraticCurveTo(cx - T * .32, base - T * .60, cx - T * .16, base - T * .84);
        c.lineTo(cx + T * .16, base - T * .84);
        c.quadraticCurveTo(cx + T * .32, base - T * .60, cx + T * .13, base - T * .26);
        c.closePath(); c.fill();
        for (let i = 0; i < 5; i++) {         // planted, and spilling over
          const a = -Math.PI + i * (Math.PI / 4);
          bloom(c, cx + Math.cos(a) * T * .17, base - T * .88 + Math.sin(a) * T * .07,
                T * .10, P.blossom[i % P.blossom.length], s + i);
        }
      } else if (kind === 7) {                // stone bench
        c.fillStyle = shade(st[0], .36);
        for (const sgn of [-1, 1]) c.fillRect(cx + sgn * T * .30 - T * .07, base - T * .28, T * .14, T * .28);
        c.fillStyle = shade(st[1], .30);                 // the seat's front edge
        c.fillRect(cx - T * .48, base - T * .30, T * .96, T * .10);
        c.fillStyle = lit(st[1], .10);                   // the seat's top face
        c.beginPath();
        c.moveTo(cx - T * .48, base - T * .30); c.lineTo(cx - T * .42, base - T * .40);
        c.lineTo(cx + T * .54, base - T * .40); c.lineTo(cx + T * .48, base - T * .30);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(88,138,66,.4)';
        c.beginPath(); c.ellipse(cx - T * .34, base - T * .04, T * .12, T * .05, 0, 0, TAU); c.fill();
      } else if (kind === 8) {                // lamp post, lit
        c.fillStyle = '#3c4a3e';
        c.fillRect(cx - T * .035, base - T * 1.06, T * .07, T * 1.06);
        c.beginPath(); c.ellipse(cx, base, T * .13, T * .05, 0, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,214,120,.95)';
        c.beginPath();
        c.moveTo(cx - T * .13, base - T * 1.06);
        c.lineTo(cx, base - T * 1.30);
        c.lineTo(cx + T * .13, base - T * 1.06);
        c.closePath(); c.fill();
        const gl = c.createRadialGradient(cx, base - T * 1.12, 0, cx, base - T * 1.12, T * .5);
        gl.addColorStop(0, 'rgba(255,214,120,.55)'); gl.addColorStop(1, 'rgba(255,214,120,0)');
        c.fillStyle = gl;
        c.beginPath(); c.arc(cx, base - T * 1.12, T * .5, 0, TAU); c.fill();
      } else if (kind === 9) {                // a fallen mossy log
        const g = c.createLinearGradient(0, base - T * .34, 0, base);
        g.addColorStop(0, '#7a5c3c'); g.addColorStop(1, '#4a3622');
        c.fillStyle = g;
        c.beginPath();
        c.ellipse(cx, base - T * .16, T * .68, T * .17, -.06, 0, TAU);
        c.fill();
        c.fillStyle = '#6a8f48';
        c.beginPath(); c.ellipse(cx - T * .1, base - T * .27, T * .40, T * .07, -.06, 0, TAU); c.fill();
        c.fillStyle = '#c8b48a';
        c.beginPath(); c.ellipse(cx + T * .66, base - T * .14, T * .07, T * .15, 0, 0, TAU); c.fill();
        for (let i = 0; i < 4; i++) {         // mushrooms along the trunk
          const mx = cx - T * .4 + i * T * .26;
          c.fillStyle = '#efe4cf';
          c.fillRect(mx - T * .018, base - T * .10, T * .036, T * .09);
          c.fillStyle = i % 2 ? '#c8563f' : '#d9a24a';
          c.beginPath(); c.ellipse(mx, base - T * .10, T * .06, T * .04, 0, Math.PI, TAU); c.fill();
        }
      } else {                                // a wayside signpost at a crossing
        c.fillStyle = '#6f5130';
        c.fillRect(cx - T * .04, base - T * .94, T * .08, T * .94);
        c.fillStyle = '#9a7a4e';
        c.fillRect(cx - T * .34, base - T * .90, T * .60, T * .17);
        c.fillStyle = 'rgba(255,250,225,.25)';
        c.fillRect(cx - T * .34, base - T * .90, T * .60, T * .04);
        c.fillStyle = 'rgba(60,40,20,.5)';
        for (let i = 0; i < 3; i++) c.fillRect(cx - T * .28 + i * T * .13, base - T * .83, T * .08, T * .022);
      }
    });
  }

  /** A wayside shrine: a lantern on a plinth that pools light on the path. */
  function shrine(T, P, level, seed) {
    const w = T * 1.7, h = T * 2.1;
    return sprite(`sh|${T}|${level}|${seed & 3}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .1;
      const st = P.stone;
      contact(c, cx, base, T * .48, T * .18, .40);
      cast(c, cx, base, T * .46, .22);
      c.fillStyle = st[0];
      c.beginPath(); c.ellipse(cx, base - T * .04, T * .40, T * .15, 0, 0, TAU); c.fill();
      c.fillRect(cx - T * .13, base - T * .74, T * .26, T * .72);
      c.fillStyle = 'rgba(255,250,225,.22)';
      c.fillRect(cx - T * .13, base - T * .74, T * .08, T * .72);
      c.fillStyle = st[1];
      c.fillRect(cx - T * .28, base - T * .88, T * .56, T * .16);
      // the lantern housing
      c.fillStyle = 'rgba(255,210,120,.95)';
      c.fillRect(cx - T * .19, base - T * 1.20, T * .38, T * .34);
      c.strokeStyle = shade(st[0], .3); c.lineWidth = T * .04;
      c.strokeRect(cx - T * .19, base - T * 1.20, T * .38, T * .34);
      c.beginPath(); c.moveTo(cx, base - T * 1.20); c.lineTo(cx, base - T * .86); c.stroke();
      // roof
      c.fillStyle = st[1];
      c.beginPath();
      c.moveTo(cx - T * .34, base - T * 1.20);
      c.lineTo(cx, base - T * 1.48);
      c.lineTo(cx + T * .34, base - T * 1.20);
      c.closePath(); c.fill();
      c.fillStyle = '#d8b25a';
      c.beginPath(); c.arc(cx, base - T * 1.52, T * .06, 0, TAU); c.fill();
      // the glow it throws
      const gl = c.createRadialGradient(cx, base - T * 1.02, 0, cx, base - T * 1.02, T * .78);
      gl.addColorStop(0, P.glow + '.45)');
      gl.addColorStop(1, P.glow + '0)');
      c.save(); c.globalCompositeOperation = 'lighter';
      c.fillStyle = gl;
      c.beginPath(); c.arc(cx, base - T * 1.02, T * .78, 0, TAU); c.fill();
      c.restore();
    });
  }


  /** A tuft of grass or reeds - the quiet filler that most tiles get. */
  function tuft(T, P, level, seed) {
    const w = T * .8, h = T * .52;
    return sprite(`tu|${T}|${level}|${seed & 15}`, w, h, (c) => {
      const cx = w / 2, base = h - T * .03, s = seed & 15;
      const n = 5 + ((h2(s, 0, 3) * 5) | 0);
      for (let i = 0; i < n; i++) {
        const bx = cx + (h2(s, i, 5) - .5) * T * .56;
        const bh = T * (.14 + h2(s, i, 7) * .24);
        const lean = (h2(s, i, 11) - .5) * T * .22;
        const shade_t = h2(s, i, 13);
        c.strokeStyle = shade_t > .66 ? lit(P.canopy[2], .18)
                      : shade_t > .33 ? P.canopy[1] : P.canopy[0];
        c.lineWidth = T * .035;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(bx, base);
        c.quadraticCurveTo(bx + lean * .4, base - bh * .65, bx + lean, base - bh);
        c.stroke();
      }
    });
  }

  /** The ring of light that marks where you are - never lose yourself. */
  function marker(T) {
    const w = T * 1.5, h = T * .7;
    return sprite(`mk|${T}`, w, h, (c) => {
      const cx = w / 2, cy = h - T * .12;
      for (const [r, a, col] of [[.62, .30, '255,226,120'], [.48, .55, '255,240,180']]) {
        c.strokeStyle = `rgba(${col},${a})`;
        c.lineWidth = T * .07;
        c.beginPath(); c.ellipse(cx, cy, T * r, T * r * .38, 0, 0, TAU); c.stroke();
      }
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, T * .62);
      g.addColorStop(0, 'rgba(255,226,120,.22)');
      g.addColorStop(1, 'rgba(255,226,120,0)');
      c.save(); c.translate(cx, cy); c.scale(1, .38); c.translate(-cx, -cy);
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, T * .62, 0, TAU); c.fill();
      c.restore();
    });
  }

  return { SUN, SS, h2, mix, lit, shade, sprite, blit, clear, cache,
           contact, cast, foliage, trunk, bloom, newCanvas, setCanvasFactory,
           TREE_KINDS, tree, bush, clump,
           WALK_FRAMES, person, chest, idol, boat,
           PROP_KINDS, prop, shrine, tuft, marker };
})();

if (typeof module !== 'undefined') module.exports = ATLAS;
