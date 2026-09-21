/* THE LAST GARDEN - painted overhead view.
 *
 * The first-person view is a raycaster; this is its opposite number, a
 * hand-painted 2.5D garden drawn with Canvas 2D. Hedges are extruded so
 * they cast a face and a shadow, water has shallows, foam and lily pads,
 * shrines pool light onto the path, and every runner is a cloaked figure
 * with a name plate.
 *
 * Nothing here is loaded: it is all drawn from gradients and a tile hash,
 * so the same maze always looks the same and nothing can fail to arrive.
 *
 * The static parts (ground, hedges, trees, shrines) are cached into an
 * offscreen layer and only repainted when the camera drifts past its
 * margin, so a phone redraws a few dozen moving things per frame instead
 * of a few thousand static ones.
 */
'use strict';

const PAINT = (() => {

  const GROUND = 0, WALL = 1, WATER = 2, BRIDGE = 3, DOCK = 4, PROP = 5, SHRINE = 6, FLOWERS = 7;
  const TAU = Math.PI * 2;

  function h2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 144665371) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  /** smooth value noise over the tile grid, for organic regions */
  function snoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const sm = t => t * t * (3 - 2 * t), L = (a, b, t) => a + (b - a) * t;
    const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    return L(L(a, b, sm(xf)), L(c, d, sm(xf)), sm(yf));
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ------------------------------------------------------------- palettes
  const PALS = [
    { // The Forest - box hedge, warm sandstone paths, bright water
      hedgeDark: '#1f5b2c', hedgeMid: '#2f7f3b', hedgeLit: '#69bf55', hedgeRim: '#a8e06a',
      hedgeSide: '#1a4a26', leaf: '#7fd268',
      path: ['#d9c8a0', '#cdba90'], pathJoint: '#b3a07a', grass: ['#6ea14e', '#7cae59'],
      water: ['#12406b', '#1d6aa5', '#3fa0cf'], foam: '#bfe8f5',
      trunk: '#5d3f24', canopy: ['#2c7a36', '#49a349', '#74c95f'],
      stone: ['#9aa39a', '#c3c9bd'], glow: 'rgba(120,220,255,',
      blossom: ['#f487b4', '#f6d06a', '#fbf4e2', '#c98ae6'],
    },
    { // The Ruins - overgrown stonework at dusk
      hedgeDark: '#4a4535', hedgeMid: '#6d6549', hedgeLit: '#9a8f68', hedgeRim: '#c3b68a',
      hedgeSide: '#3b3728', leaf: '#7fa855',
      path: ['#c7b795', '#b8a886'], pathJoint: '#9c8d6e', grass: ['#7d8a52', '#8b9760'],
      water: ['#153c52', '#23678a', '#47a0b8'], foam: '#cfe9ef',
      trunk: '#6a4b2c', canopy: ['#5d7a3a', '#7d9b4c', '#9dbb66'],
      stone: ['#a49a86', '#cabfa8'], glow: 'rgba(255,196,110,',
      blossom: ['#e87fa8', '#f0c96a', '#f7efdc', '#b98ad6'],
    },
    { // The Temple - lamplit stone, dark and gilded
      hedgeDark: '#2b2419', hedgeMid: '#43392a', hedgeLit: '#6b5a41', hedgeRim: '#8c7654',
      hedgeSide: '#211b13', leaf: '#6b7a4a',
      path: ['#8a7a5c', '#7a6b50'], pathJoint: '#5e5240', grass: ['#4a4632', '#56513b'],
      water: ['#10222e', '#1b4256', '#2f6b80'], foam: '#9dc2cf',
      trunk: '#554025', canopy: ['#3f5230', '#55693c', '#6d814e'],
      stone: ['#8b7f68', '#b3a488'], glow: 'rgba(255,190,90,',
      blossom: ['#e0a6c8', '#f2cf84', '#f6eede', '#c2a0e0'],
    },
  ];

  // ---------------------------------------------------------------- ground
  function paintGround(c, x, y, sx, sy, T, kind, P, level) {
    const n = h2(x, y, 11), n2 = h2(x, y, 23);
    if (kind === WATER) return;                       // water is painted as one body later
    if (kind === BRIDGE || kind === DOCK) {
      c.fillStyle = '#8a6a42'; c.fillRect(sx, sy, T + 1, T + 1);
      c.strokeStyle = 'rgba(40,26,14,.55)'; c.lineWidth = Math.max(1, T * .05);
      c.beginPath();
      for (let i = 1; i < 4; i++) { c.moveTo(sx, sy + i * T / 4); c.lineTo(sx + T, sy + i * T / 4); }
      c.stroke();
      c.fillStyle = 'rgba(255,225,175,.16)'; c.fillRect(sx, sy, T + 1, T * .18);
      return;
    }
    if (kind === FLOWERS) {                           // a planted bed, kerbed in stone
      const soil = c.createLinearGradient(sx, sy, sx, sy + T);
      soil.addColorStop(0, '#7a6047'); soil.addColorStop(1, '#5f4a34');
      c.fillStyle = soil; c.fillRect(sx, sy, T + 1, T + 1);
      c.fillStyle = P.stone[1];                       // kerb stones round the edge
      c.fillRect(sx, sy, T + 1, T * .1);
      c.fillRect(sx, sy + T * .9, T + 1, T * .12);
      c.fillRect(sx, sy, T * .1, T + 1);
      c.fillRect(sx + T * .9, sy, T * .12, T + 1);
      c.fillStyle = 'rgba(0,0,0,.18)';
      c.fillRect(sx + T * .1, sy + T * .1, T * .8, T * .07);
      const cols = P.blossom;
      const base = (h2(x, y, 401) * cols.length) | 0;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const bx = sx + T * (.22 + i * .28), by = sy + T * (.24 + j * .27);
        const hh = h2(x * 9 + i, y * 9 + j, 403);
        if (hh < .18) continue;
        c.strokeStyle = '#3d7f3a'; c.lineWidth = Math.max(1, T * .022);
        c.beginPath(); c.moveTo(bx, by + T * .08); c.lineTo(bx, by); c.stroke();
        bloom(c, bx, by, T * .052, cols[(base + i + j) % cols.length]);
      }
      return;
    }
    // sandstone path, or turf - drawn from smooth noise so it forms real
    // sweeps of paving and lawn rather than scattered squares
    // (interpolated noise clusters around 0.27, so that is the halfway mark)
    const field = snoise(x / 3.5, y / 3.5, 3) * 0.72 + snoise(x / 1.7, y / 1.7, 9) * 0.28;
    const onPath = field > .30;
    const pal = onPath ? P.path : P.grass;
    c.fillStyle = n2 > .5 ? pal[0] : pal[1];
    c.fillRect(sx, sy, T + 1, T + 1);
    if (onPath && T > 14) {
      // cobbles
      c.fillStyle = 'rgba(255,248,225,.13)';
      const cs = T / 3;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        if (h2(x * 3 + i, y * 3 + j, 31) > .55) continue;
        roundRect(c, sx + i * cs + cs * .1, sy + j * cs + cs * .1, cs * .8, cs * .8, cs * .28);
        c.fill();
      }
      c.strokeStyle = 'rgba(90,74,48,.16)'; c.lineWidth = 1;
      c.strokeRect(sx + .5, sy + .5, T, T);
    } else if (!onPath && T > 14) {
      // turf tufts and the odd wildflower
      c.fillStyle = 'rgba(150,200,110,.35)';
      for (let i = 0; i < 3; i++) {
        const hx = h2(x * 5 + i, y, 41), hy = h2(x, y * 5 + i, 43);
        c.fillRect(sx + hx * T * .86, sy + hy * T * .86, Math.max(1, T * .07), Math.max(1, T * .14));
      }
      if (n2 > .94) {
        c.fillStyle = P.blossom[(n * 4) | 0];
        c.beginPath(); c.arc(sx + n * T * .7 + T * .15, sy + n2 * T * .7, Math.max(1, T * .07), 0, TAU); c.fill();
      }
    }
  }

  /** one connected body of water per visible patch: depth, shore foam, lilies */
  function paintWater(c, grid, W, H, x0, x1, y0, y1, ox, oy, T, P, t) {
    const inW = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === WATER);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inW(x, y)) continue;
        const sx = ox + x * T, sy = oy + y * T;
        // depth: shallower where it touches land
        let edges = 0;
        if (!inW(x, y - 1)) edges++; if (!inW(x + 1, y)) edges++;
        if (!inW(x, y + 1)) edges++; if (!inW(x - 1, y)) edges++;
        // How open the water is around this tile, counted over a 5x5 patch.
        // Using it as a smooth depth - rather than two or three hard bands -
        // is what stops a pond looking like a chequerboard of blue squares.
        let open = 0;
        for (let j = -2; j <= 2; j++)
          for (let i = -2; i <= 2; i++)
            if (inW(x + i, y + j)) open++;
        const depth = Math.min(1, Math.max(0, (open - 7) / 16));
        const ring = depth > .72 ? 2 : depth > .34 ? 1 : 0;
        // shallow -> mid -> deep, blended rather than stepped
        const base = depth < .5
          ? mixHex(P.water[2], P.water[1], depth * 2)
          : mixHex(P.water[1], P.water[0], (depth - .5) * 2);
        c.fillStyle = base;
        c.fillRect(sx, sy, T + 1, T + 1);
        // the bed showing through where it is shallowest
        if (depth < .42) {
          c.globalAlpha = (.42 - depth) * .8;
          c.fillStyle = mixHex(P.water[2], '#b9a878', .55);
          c.fillRect(sx, sy, T + 1, T + 1);
          c.globalAlpha = 1;
        }
        if (T < 12) continue;

        // ---- ripples, drawn in world coordinates so they run on across
        // tile boundaries instead of stopping dead at every seam
        c.save();
        c.beginPath(); c.rect(sx, sy, T + 1, T + 1); c.clip();
        c.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          const wy = (y + i) * T + oy;
          const phase = (y + i) * 1.7 + t * .8;
          c.strokeStyle = `rgba(226,248,255,${ring === 2 ? .10 : .16})`;
          c.lineWidth = Math.max(1, T * .05);
          c.beginPath();
          for (let k = 0; k <= 4; k++) {
            const px = sx - T * .1 + (k / 4) * T * 1.2;
            const py = wy + T * (.42 + Math.sin(phase + (x + k / 4) * 2.1) * .16);
            k ? c.lineTo(px, py) : c.moveTo(px, py);
          }
          c.stroke();
        }
        // a broken band of sun on the surface
        if (h2(x, y, 67) > .58) {
          c.strokeStyle = 'rgba(255,252,226,.26)';
          c.lineWidth = Math.max(1, T * .07);
          c.beginPath();
          c.moveTo(sx + T * .18, sy + T * .30);
          c.quadraticCurveTo(sx + T * .5, sy + T * .22, sx + T * .82, sy + T * .34);
          c.stroke();
        }
        c.restore();

        // round off the outer corners so the bank is not a staircase of squares
        const land = P.grass[0];
        const corner = (ax, ay, cxp, cyp) => {
          if (inW(ax, y) || inW(x, ay)) return;
          c.fillStyle = land;
          c.beginPath();
          c.moveTo(cxp, cyp);
          c.arc(cxp + (cxp === sx ? T : -T) * .42, cyp + (cyp === sy ? T : -T) * .42,
                T * .42, 0, TAU);
          c.fill();
        };
        c.save();
        c.beginPath(); c.rect(sx, sy, T + 1, T + 1); c.clip();
        c.fillStyle = land;
        const rr = T * .46;
        if (!inW(x - 1, y) && !inW(x, y - 1)) { c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + rr, sy); c.arc(sx + rr, sy + rr, rr, -Math.PI / 2, Math.PI, true); c.closePath(); c.fill(); }
        if (!inW(x + 1, y) && !inW(x, y - 1)) { c.beginPath(); c.moveTo(sx + T, sy); c.lineTo(sx + T, sy + rr); c.arc(sx + T - rr, sy + rr, rr, 0, -Math.PI / 2, true); c.closePath(); c.fill(); }
        if (!inW(x - 1, y) && !inW(x, y + 1)) { c.beginPath(); c.moveTo(sx, sy + T); c.lineTo(sx, sy + T - rr); c.arc(sx + rr, sy + T - rr, rr, Math.PI, Math.PI / 2, true); c.closePath(); c.fill(); }
        if (!inW(x + 1, y) && !inW(x, y + 1)) { c.beginPath(); c.moveTo(sx + T, sy + T); c.lineTo(sx + T - rr, sy + T); c.arc(sx + T - rr, sy + T - rr, rr, Math.PI / 2, 0, true); c.closePath(); c.fill(); }
        c.restore();

        // koi drifting under the surface
        if (ring === 2 && h2(x, y, 501) > .82) {
          const ph = t * .5 + h2(x, y, 503) * 6.283;
          const kx = sx + T * (.5 + Math.cos(ph) * .28), ky = sy + T * (.5 + Math.sin(ph * 1.3) * .22);
          c.save(); c.globalAlpha = .55;
          c.fillStyle = h2(x, y, 507) > .5 ? '#e8804a' : '#f2f0e6';
          c.beginPath(); c.ellipse(kx, ky, T * .1, T * .05, ph, 0, TAU); c.fill();
          c.beginPath();
          c.moveTo(kx - Math.cos(ph) * T * .1, ky - Math.sin(ph) * T * .1);
          c.lineTo(kx - Math.cos(ph) * T * .17 - Math.sin(ph) * T * .05,
                   ky - Math.sin(ph) * T * .17 + Math.cos(ph) * T * .05);
          c.lineTo(kx - Math.cos(ph) * T * .17 + Math.sin(ph) * T * .05,
                   ky - Math.sin(ph) * T * .17 - Math.cos(ph) * T * .05);
          c.closePath(); c.fill();
          c.restore();
        }
        // cattails standing in the shallows
        if (ring === 0 && h2(x, y, 511) > .74) {
          const rx = sx + T * (.25 + h2(x, y, 513) * .5);
          c.strokeStyle = '#4e8a44'; c.lineWidth = Math.max(1, T * .035);
          for (let i = 0; i < 3; i++) {
            const bx = rx + (i - 1) * T * .07;
            c.beginPath(); c.moveTo(bx, sy + T * .8);
            c.quadraticCurveTo(bx + T * .03, sy + T * .4, bx + T * .05, sy + T * .1); c.stroke();
            if (i === 1) {
              c.fillStyle = '#7a5230';
              roundRect(c, bx + T * .02, sy + T * .06, T * .06, T * .17, T * .03); c.fill();
            }
          }
        }
        // lily pads
        if (ring === 2 && h2(x, y, 67) > .78) {
          const px = sx + T * .5 + Math.sin(t * .6 + x) * T * .05, py = sy + T * .5;
          c.fillStyle = 'rgba(28,70,36,.45)';
          c.beginPath(); c.ellipse(px + T * .04, py + T * .06, T * .3, T * .2, 0, 0, TAU); c.fill();
          c.fillStyle = '#3f8f47';
          c.beginPath(); c.ellipse(px, py, T * .3, T * .2, 0, .5, TAU - .5); c.fill();
          c.fillStyle = '#58ad58';
          c.beginPath(); c.ellipse(px - T * .05, py - T * .04, T * .18, T * .11, 0, 0, TAU); c.fill();
          if (h2(x, y, 71) > .6) {
            c.fillStyle = '#fbeff4';
            c.beginPath(); c.arc(px + T * .1, py - T * .06, T * .08, 0, TAU); c.fill();
            c.fillStyle = '#f2c96a';
            c.beginPath(); c.arc(px + T * .1, py - T * .06, T * .035, 0, TAU); c.fill();
          }
        }
      }
    }
  }

  /**
   * The living part of the water, drawn over the baked chunks every frame.
   *
   * The still parts - depth, banks, lily pads, reeds - are baked once and
   * cached. Only what actually has to move is drawn here: travelling
   * ripples and the glint of sun on them. Kept to the water tiles on
   * screen, it is a few dozen strokes a frame.
   */
  function paintWaterLive(c, grid, W, H, x0, x1, y0, y1, ox, oy, T, P, t) {
    if (T < 14) return;
    const inW = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === WATER);
    c.save();
    c.lineCap = 'round';
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inW(x, y)) continue;
        const sx = ox + x * T, sy = oy + y * T;
        c.save();
        c.beginPath(); c.rect(sx, sy, T + 1, T + 1); c.clip();
        // two travelling wave crests, phased by world position so they run
        // continuously across the whole body of water
        for (let i = 0; i < 2; i++) {
          const drift = ((t * .16 + i * .5 + y * .07) % 1);
          const wy = sy + drift * T;
          c.strokeStyle = `rgba(230,250,255,${.13 - i * .04})`;
          c.lineWidth = Math.max(1, T * .05);
          c.beginPath();
          for (let k = 0; k <= 4; k++) {
            const pxx = sx - T * .1 + (k / 4) * T * 1.2;
            const pyy = wy + Math.sin(t * 1.1 + (x + k / 4) * 2.3 + i) * T * .07;
            k ? c.lineTo(pxx, pyy) : c.moveTo(pxx, pyy);
          }
          c.stroke();
        }
        // a glint that slides along the crest
        if (h2(x, y, 131) > .74) {
          const g = (t * .5 + h2(x, y, 137) * 6.28);
          c.fillStyle = 'rgba(255,253,232,.26)';
          c.beginPath();
          c.ellipse(sx + T * (.5 + Math.sin(g) * .3), sy + T * (.5 + Math.cos(g * .7) * .22),
                    T * .16, T * .045, Math.sin(g) * .4, 0, TAU);
          c.fill();
        }
        c.restore();
      }
    }
    c.restore();
  }

  // ---------------------------------------------------------------- hedges
  /** an extruded hedge block: cast shadow, dark face, lit crown, blossoms */
  /**
   * A stretch of hedge. The crown is rounded only at corners that are
   * genuinely exposed, so a run of hedge reads as one continuous wall
   * rather than a row of separate green pillows - which is the single
   * biggest thing that used to make the garden look like a board game.
   */
  function paintHedge(c, x, y, sx, sy, T, D, P, grid, W, H) {
    const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? WALL : grid[yy * W + xx];
    const N = at(x, y - 1) === WALL, S = at(x, y + 1) === WALL;
    const E = at(x + 1, y) === WALL, Wl = at(x - 1, y) === WALL;
    const n = h2(x, y, 13);
    const r = T * .30;
    // a corner is only rounded where both of its sides are open air
    const rNW = (N || Wl) ? 0 : r, rNE = (N || E) ? 0 : r;
    const rSE = (S || E) ? 0 : r, rSW = (S || Wl) ? 0 : r;

    const top = sy - D;
    // ---- the shadow this wall throws, down and to the right of the sun
    if (!S) {
      const g = c.createLinearGradient(0, sy + T, 0, sy + T + D * .8);
      g.addColorStop(0, 'rgba(18,38,22,.42)');
      g.addColorStop(1, 'rgba(18,38,22,0)');
      c.fillStyle = g;
      c.fillRect(sx + T * .1, sy + T, T + 1, D * .8);
    }
    if (!E) {
      const g = c.createLinearGradient(sx + T, 0, sx + T + D * .5, 0);
      g.addColorStop(0, 'rgba(18,38,22,.30)');
      g.addColorStop(1, 'rgba(18,38,22,0)');
      c.fillStyle = g;
      c.fillRect(sx + T, sy + D * .2, D * .5, T);
    }

    // ---- the face of the wall, seen below the crown
    if (!S) {
      const g = c.createLinearGradient(0, sy + T - D, 0, sy + T + 1);
      g.addColorStop(0, P.hedgeMid);
      g.addColorStop(.55, P.hedgeSide);
      g.addColorStop(1, shadeHex(P.hedgeSide, .30));
      c.fillStyle = g;
      corners(c, sx, sy + T - D, T + 1, D + 1, 0, 0, rSE, rSW); c.fill();
      // twigs and leaf ends poking out of the cut face
      for (let i = 0; i < 6; i++) {
        const hx = h2(x * 7 + i, y, 53);
        c.fillStyle = hx > .5 ? P.hedgeDark : shadeHex(P.hedgeSide, .16);
        c.globalAlpha = .6;
        c.beginPath();
        c.ellipse(sx + hx * T, sy + T - D * (.2 + h2(x, y + i, 59) * .6),
                  T * .09, T * .06, hx * 3, 0, TAU);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    // ---- the crown, lit from the upper left
    const g2 = c.createLinearGradient(sx, top, sx + T * .8, top + T);
    g2.addColorStop(0, P.hedgeRim);
    g2.addColorStop(.32, P.hedgeLit);
    g2.addColorStop(.78, P.hedgeMid);
    g2.addColorStop(1, P.hedgeDark);
    c.fillStyle = g2;
    corners(c, sx, top, T + 1, T + 1, rNW, rNE, rSE, rSW); c.fill();

    if (T < 13) return;

    // ---- leaf texture: many small dabs, dense and lit on the sun side
    c.save();
    corners(c, sx, top, T + 1, T + 1, rNW, rNE, rSE, rSW); c.clip();
    const dabs = Math.max(8, Math.round(T * .42));
    for (let i = 0; i < dabs; i++) {
      const hx = h2(x * 9 + i, y, 17), hy = h2(x, y * 9 + i, 19), hv = h2(x + i, y + i, 23);
      const lx = sx + hx * (T + 2) - 1, ly = top + hy * (T + 2) - 1;
      const rr = T * (.07 + hv * .08);
      // a dab is lit if it sits up-left within its own neighbourhood
      const up = (1 - hx) * .5 + (1 - hy) * .5;
      c.fillStyle = up > .72 ? P.hedgeRim : up > .5 ? P.hedgeLit
                  : up > .3 ? P.hedgeMid : P.hedgeDark;
      c.globalAlpha = .38 + hv * .34;
      c.beginPath();
      c.ellipse(lx, ly, rr, rr * .78, hv * 3, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;

    // clipped topiary balls, here and there along the top of a wall
    if (h2(x, y, 301) > .90) {
      for (let i = 0; i < 2; i++) {
        const bx = sx + T * (.3 + i * .4), by = top + T * .36;
        const g3 = c.createRadialGradient(bx - T * .07, by - T * .09, T * .02, bx, by, T * .22);
        g3.addColorStop(0, P.hedgeRim); g3.addColorStop(.6, P.hedgeLit); g3.addColorStop(1, P.hedgeDark);
        c.fillStyle = g3;
        c.beginPath(); c.arc(bx, by, T * .20, 0, TAU); c.fill();
      }
    }

    // ambient darkening where this tile meets a neighbouring wall, so a
    // long run still shows the seams between its sections
    c.fillStyle = 'rgba(16,34,20,.16)';
    if (N) c.fillRect(sx, top, T + 1, T * .07);
    if (Wl) c.fillRect(sx, top, T * .07, T + 1);
    c.restore();

    // ---- the sunlit ridge along the top edge
    if (!N) {
      c.strokeStyle = 'rgba(214,250,166,.40)';
      c.lineWidth = Math.max(1, T * .055);
      c.beginPath();
      c.moveTo(sx + (Wl ? 0 : r * .8), top + T * .055);
      c.lineTo(sx + T - (E ? 0 : r * .8), top + T * .055);
      c.stroke();
    }

    // ---- flowering hedge, and vines spilling over an exposed face
    if (n > .52) {
      const cols = P.blossom, k = (h2(x, y, 29) * cols.length) | 0;
      for (let i = 0; i < 4; i++) {
        const hx = h2(x * 3 + i, y * 5, 37), hy = h2(x * 5, y * 3 + i, 39);
        if (hx < .22) continue;
        bloomAt(c, sx + hx * T * .84 + T * .08, top + hy * T * .84 + T * .08,
                T * .085, cols[(k + i) % cols.length]);
      }
    }
    if (!S && n > .70) {
      c.strokeStyle = 'rgba(96,150,74,.85)';
      c.lineWidth = Math.max(1, T * .045);
      for (let i = 0; i < 3; i++) {
        const vx = sx + T * (.2 + i * .3 + h2(x, y + i, 61) * .1);
        c.beginPath();
        c.moveTo(vx, sy + T - D);
        c.quadraticCurveTo(vx + T * .07, sy + T - D * .4, vx - T * .04, sy + T * .98);
        c.stroke();
        c.fillStyle = 'rgba(120,176,92,.9)';
        c.beginPath(); c.ellipse(vx + T * .05, sy + T - D * .5, T * .055, T * .035, .6, 0, TAU); c.fill();
      }
    }
  }

  /** A rounded rectangle with a radius chosen per corner. */
  function corners(c, x, y, w, h, nw, ne, se, sw) {
    c.beginPath();
    c.moveTo(x + nw, y);
    c.lineTo(x + w - ne, y); if (ne) c.quadraticCurveTo(x + w, y, x + w, y + ne);
    c.lineTo(x + w, y + h - se); if (se) c.quadraticCurveTo(x + w, y + h, x + w - se, y + h);
    c.lineTo(x + sw, y + h); if (sw) c.quadraticCurveTo(x, y + h, x, y + h - sw);
    c.lineTo(x, y + nw); if (nw) c.quadraticCurveTo(x, y, x + nw, y);
    c.closePath();
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * t);
    const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
    const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }

  function shadeHex(a, t) {
    const pa = parseInt(a.slice(1), 16), pb = 0x111a20;
    const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * t);
    const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
    const b = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function bloomAt(c, x, y, r, col) {
    for (let p = 0; p < 5; p++) {
      const a = p / 5 * TAU;
      c.fillStyle = p % 2 ? col : col;
      c.beginPath(); c.arc(x + Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 1.1, r * .92, 0, TAU); c.fill();
    }
    c.fillStyle = '#fbe38a';
    c.beginPath(); c.arc(x, y, r * .8, 0, TAU); c.fill();
  }

  function bloom(c, x, y, r, col, centre) {
    c.fillStyle = col;
    for (let p = 0; p < 5; p++) {
      const a = p / 5 * TAU;
      c.beginPath(); c.arc(x + Math.cos(a) * r * 1.12, y + Math.sin(a) * r * 1.12, r, 0, TAU); c.fill();
    }
    c.fillStyle = centre || '#fbe38a';
    c.beginPath(); c.arc(x, y, r * .82, 0, TAU); c.fill();
  }





  // -------------------------------------------------------------- objects




  /** the little name plates from the reference art */
  function paintPlate(c, cx, cy, text, accent, T) {
    const fs = Math.max(9, Math.min(15, T * .34));
    c.font = '700 ' + fs + 'px system-ui, sans-serif';
    const w = c.measureText(text).width + fs * 2.4, h = fs * 1.62;
    const x = cx - w / 2, y = cy - h;
    c.fillStyle = 'rgba(10,22,34,.82)';
    roundRect(c, x, y, w, h, h / 2); c.fill();
    c.strokeStyle = 'rgba(214,180,110,.7)'; c.lineWidth = 1.2;
    roundRect(c, x + .5, y + .5, w - 1, h - 1, h / 2); c.stroke();
    c.fillStyle = accent;
    c.beginPath(); c.arc(x + h * .58, y + h / 2, h * .26, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.beginPath(); c.arc(x + h * .52, y + h * .4, h * .1, 0, TAU); c.fill();
    c.fillStyle = '#f3e7cf'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, x + h * .95, y + h / 2 + .5);
    c.textAlign = 'start'; c.textBaseline = 'alphabetic';
  }

  /** drifting life above the garden - butterflies, petals or fireflies */
  function paintAir(c, ox, oy, T, W, H, camX, camY, t, level, cw, ch) {
    const n = level === 2 ? 16 : 22;
    for (let i = 0; i < n; i++) {
      const s1 = h2(i, 7, 601), s2 = h2(i, 11, 607), s3 = h2(i, 13, 613);
      // each one wanders a slow loop around a home tile near the camera
      const hx = camX + (s1 - .5) * 22, hy = camY + (s2 - .5) * 16;
      const sp = .25 + s3 * .5;
      const ax = hx + Math.sin(t * sp + s1 * 9) * 3.2 + Math.sin(t * sp * 2.3) * .6;
      const ay = hy + Math.cos(t * sp * .8 + s2 * 9) * 2.4;
      const px = ox + ax * T, py = oy + ay * T;
      if (px < -20 || py < -20 || px > cw + 20 || py > ch + 20) continue;
      const lift = Math.sin(t * 2 + i) * T * .12;
      if (level === 2) {                                   // fireflies
        const pulse = .35 + .65 * Math.abs(Math.sin(t * 1.6 + i * 2.1));
        const gl = c.createRadialGradient(px, py + lift, 0, px, py + lift, T * .3);
        gl.addColorStop(0, 'rgba(255,226,140,' + (.7 * pulse) + ')');
        gl.addColorStop(1, 'rgba(255,226,140,0)');
        c.fillStyle = gl;
        c.beginPath(); c.arc(px, py + lift, T * .3, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,248,206,' + pulse + ')';
        c.beginPath(); c.arc(px, py + lift, T * .045, 0, TAU); c.fill();
      } else if (s3 > .45) {                               // butterflies
        const flap = Math.abs(Math.sin(t * 9 + i));
        const wing = T * (.05 + flap * .07);
        c.fillStyle = s1 > .5 ? 'rgba(255,196,86,.9)' : 'rgba(232,140,190,.9)';
        c.beginPath(); c.ellipse(px - wing * .7, py + lift, wing, T * .05, -.4, 0, TAU); c.fill();
        c.beginPath(); c.ellipse(px + wing * .7, py + lift, wing, T * .05, .4, 0, TAU); c.fill();
        c.fillStyle = 'rgba(60,44,30,.85)';
        c.fillRect(px - T * .012, py + lift - T * .035, T * .024, T * .07);
      } else {                                             // blossom petals falling
        const fall = ((t * 22 + s1 * 300) % 260) / 260;
        const py2 = oy + (hy + fall * 6) * T;
        if (py2 > ch + 20) continue;
        c.save();
        c.translate(px + Math.sin(t * 1.6 + i) * T * .22, py2);
        c.rotate(t * 1.4 + i);
        c.globalAlpha = .75 * (1 - fall * .5);
        c.fillStyle = level === 1 ? '#e8c98a' : '#f7b8d4';
        c.beginPath(); c.ellipse(0, 0, T * .06, T * .032, 0, 0, TAU); c.fill();
        c.restore();
      }
    }
  }

  return { PALS, paintAir, paintGround, paintWater, paintWaterLive, paintHedge, bloom, paintPlate, roundRect, h2,
           GROUND, WALL, WATER, BRIDGE, DOCK, PROP, SHRINE };
})();

if (typeof module !== 'undefined') module.exports = PAINT;
