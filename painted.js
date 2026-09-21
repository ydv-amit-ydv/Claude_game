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

  /** small dressing on open ground: flower beds, bushes, lamps, benches, urns */
  function paintScatter(c, x, y, sx, sy, T, P, grid, W, H, level) {
    if (T < 15) return;
    const pick = h2(x, y, 101);
    if (pick > .13) return;                       // most ground stays clear
    const jx = h2(x, y, 103), jy = h2(x, y, 107);
    const cx = sx + T * (.22 + jx * .56), cy = sy + T * (.34 + jy * .44);
    const kind = (h2(x, y, 109) * 100) | 0;

    if (kind < 34) {                              // a bed of blooms
      const cols = P.blossom, base = (h2(x, y, 113) * cols.length) | 0;
      const n = 2 + ((h2(x, y, 127) * 3) | 0);
      c.fillStyle = 'rgba(30,60,30,.18)';
      c.beginPath(); c.ellipse(cx, cy + T * .09, T * .2, T * .07, 0, 0, TAU); c.fill();
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + jx * 3;
        const bx = cx + Math.cos(a) * T * .13, by = cy + Math.sin(a) * T * .085;
        c.strokeStyle = '#3f8f43'; c.lineWidth = Math.max(1, T * .028);
        c.beginPath(); c.moveTo(bx, by + T * .09); c.lineTo(bx, by); c.stroke();
        bloom(c, bx, by, T * .042, cols[(base + i) % cols.length]);
      }
    } else if (kind < 56) {                       // a low bush
      c.fillStyle = 'rgba(28,56,28,.24)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .21, T * .08, 0, 0, TAU); c.fill();
      for (let i = 0; i < 3; i++) {
        const a = -0.6 + i * 0.6, r = T * (.13 - i * .012);
        const g = c.createRadialGradient(cx + Math.cos(a) * T * .1 - r * .3, cy - r * .4, r * .1,
                                          cx + Math.cos(a) * T * .1, cy, r);
        g.addColorStop(0, P.canopy[2]); g.addColorStop(1, P.canopy[0]);
        c.fillStyle = g;
        c.beginPath(); c.arc(cx + Math.cos(a) * T * .1, cy - Math.abs(Math.sin(a)) * T * .04, r, 0, TAU); c.fill();
      }
      if (h2(x, y, 131) > .6) bloom(c, cx + T * .06, cy - T * .07, T * .04, P.blossom[0]);
    } else if (kind < 70) {                       // tuft of tall grass or reeds
      const near = (grid[y * W + x - 1] === WATER) || (grid[y * W + x + 1] === WATER) ||
                   (grid[(y - 1) * W + x] === WATER) || (grid[(y + 1) * W + x] === WATER);
      c.strokeStyle = near ? '#5f9a52' : P.canopy[1];
      c.lineWidth = Math.max(1, T * .035);
      for (let i = 0; i < 6; i++) {
        const bx = cx + (i - 3) * T * .035, lean = (h2(x + i, y, 137) - .5) * T * .1;
        c.beginPath(); c.moveTo(bx, cy + T * .1);
        c.quadraticCurveTo(bx + lean * .5, cy - T * .02, bx + lean, cy - T * .18); c.stroke();
      }
    } else if (kind < 82) {                       // a lamp post
      c.fillStyle = 'rgba(24,40,28,.26)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .1, T * .04, 0, 0, TAU); c.fill();
      c.fillStyle = '#3b4148';
      c.fillRect(cx - T * .022, cy - T * .3, T * .044, T * .4);
      c.fillStyle = '#2f353b';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .07, T * .028, 0, 0, TAU); c.fill();
      const gl = c.createRadialGradient(cx, cy - T * .34, 0, cx, cy - T * .34, T * .34);
      gl.addColorStop(0, 'rgba(255,226,150,.55)'); gl.addColorStop(1, 'rgba(255,226,150,0)');
      c.fillStyle = gl; c.beginPath(); c.arc(cx, cy - T * .34, T * .34, 0, TAU); c.fill();
      c.fillStyle = '#ffe9a8';
      c.beginPath(); c.arc(cx, cy - T * .34, T * .06, 0, TAU); c.fill();
    } else if (kind < 92) {                       // a stone urn
      c.fillStyle = 'rgba(24,40,28,.26)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .12, T * .045, 0, 0, TAU); c.fill();
      const g = c.createLinearGradient(cx - T * .1, cy, cx + T * .1, cy);
      g.addColorStop(0, P.stone[1]); g.addColorStop(1, P.stone[0]);
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - T * .075, cy - T * .12); c.quadraticCurveTo(cx - T * .13, cy, cx - T * .06, cy + T * .1);
      c.lineTo(cx + T * .06, cy + T * .1); c.quadraticCurveTo(cx + T * .13, cy, cx + T * .075, cy - T * .12);
      c.closePath(); c.fill();
      c.fillStyle = P.stone[1];
      c.beginPath(); c.ellipse(cx, cy - T * .12, T * .09, T * .035, 0, 0, TAU); c.fill();
      bloom(c, cx, cy - T * .17, T * .04, P.blossom[1]);
    } else if (kind < 94) {                       // a bench beside the path
      c.fillStyle = 'rgba(24,40,28,.24)';
      c.beginPath(); c.ellipse(cx, cy + T * .09, T * .16, T * .05, 0, 0, TAU); c.fill();
      c.fillStyle = '#8a6a42';
      c.fillRect(cx - T * .15, cy - T * .02, T * .3, T * .05);
      c.fillStyle = '#6d5133';
      c.fillRect(cx - T * .15, cy - T * .12, T * .3, T * .04);
      c.fillRect(cx - T * .13, cy + T * .03, T * .025, T * .06);
      c.fillRect(cx + T * .105, cy + T * .03, T * .025, T * .06);
    } else if (kind < 95) {                       // a fallen mossy log
      c.fillStyle = 'rgba(24,40,28,.24)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .22, T * .06, 0, 0, TAU); c.fill();
      const lg = c.createLinearGradient(cx, cy - T * .08, cx, cy + T * .08);
      lg.addColorStop(0, '#8a6a42'); lg.addColorStop(1, '#5a4228');
      c.fillStyle = lg;
      roundRect(c, cx - T * .22, cy - T * .07, T * .44, T * .15, T * .07); c.fill();
      c.fillStyle = 'rgba(110,170,96,.5)';
      c.beginPath(); c.ellipse(cx - T * .05, cy - T * .06, T * .12, T * .035, 0, 0, TAU); c.fill();
      c.fillStyle = '#6b4f32';
      c.beginPath(); c.ellipse(cx + T * .22, cy, T * .035, T * .07, 0, 0, TAU); c.fill();
    } else if (kind < 96) {                       // a ring of mushrooms
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * TAU + jx * 4;
        const mx = cx + Math.cos(a) * T * .14, my = cy + Math.sin(a) * T * .09;
        c.fillStyle = '#e8ded0';
        c.fillRect(mx - T * .012, my - T * .02, T * .024, T * .05);
        c.fillStyle = i % 2 ? '#c8503f' : '#cf7a3a';
        c.beginPath(); c.ellipse(mx, my - T * .02, T * .035, T * .024, 0, Math.PI, 0); c.fill();
        c.fillStyle = 'rgba(255,255,255,.7)';
        c.beginPath(); c.arc(mx - T * .01, my - T * .03, T * .008, 0, TAU); c.fill();
      }
    } else if (kind < 98) {                       // a birdbath
      c.fillStyle = 'rgba(24,40,28,.26)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .13, T * .05, 0, 0, TAU); c.fill();
      c.fillStyle = P.stone[0];
      c.fillRect(cx - T * .035, cy - T * .1, T * .07, T * .2);
      c.fillStyle = P.stone[1];
      c.beginPath(); c.ellipse(cx, cy - T * .12, T * .13, T * .055, 0, 0, TAU); c.fill();
      c.fillStyle = '#6fb6d8';
      c.beginPath(); c.ellipse(cx, cy - T * .13, T * .095, T * .038, 0, 0, TAU); c.fill();
    } else {                                      // a signpost at a junction
      c.fillStyle = 'rgba(24,40,28,.24)';
      c.beginPath(); c.ellipse(cx, cy + T * .1, T * .09, T * .035, 0, 0, TAU); c.fill();
      c.fillStyle = '#6d5133';
      c.fillRect(cx - T * .018, cy - T * .26, T * .036, T * .36);
      c.fillStyle = '#9a7748';
      c.fillRect(cx - T * .11, cy - T * .26, T * .17, T * .06);
      c.fillStyle = '#8a6a42';
      c.fillRect(cx - T * .05, cy - T * .16, T * .16, T * .055);
    }
  }

  /** the blocking scenery tiles: broadleaf, cypress, blossom tree or statue */
  function paintProp(c, x, y, sx, sy, T, D, P, level) {
    const kind = (h2(x, y, 211) * 100) | 0;
    const cx = sx + T * .5, base = sy + T * .78;
    c.fillStyle = 'rgba(20,42,24,.34)';
    c.beginPath(); c.ellipse(cx, base + T * .1, T * .5, T * .2, 0, 0, TAU); c.fill();

    if (kind < 22 && level !== 2) {               // cypress / poplar
      c.fillStyle = P.trunk;
      c.fillRect(cx - T * .05, base - T * .2, T * .1, T * .3);
      const g = c.createLinearGradient(cx - T * .3, base - T * 1.3, cx + T * .3, base);
      g.addColorStop(0, P.canopy[2]); g.addColorStop(.5, P.canopy[1]); g.addColorStop(1, P.canopy[0]);
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx, base - T * 1.45);
      c.quadraticCurveTo(cx + T * .34, base - T * .6, cx + T * .16, base - T * .16);
      c.lineTo(cx - T * .16, base - T * .16);
      c.quadraticCurveTo(cx - T * .34, base - T * .6, cx, base - T * 1.45);
      c.fill();
      c.fillStyle = 'rgba(190,240,150,.22)';
      c.beginPath(); c.ellipse(cx - T * .08, base - T * .8, T * .07, T * .3, .1, 0, TAU); c.fill();
      return;
    }
    if (kind < 34 && level !== 2) {               // blossom tree
      c.fillStyle = P.trunk;
      c.fillRect(cx - T * .07, base - T * .5, T * .14, T * .6);
      const tiers = [[0, -T * 1.0, T * .5], [-T * .28, -T * .74, T * .38], [T * .28, -T * .72, T * .36]];
      for (let i = tiers.length - 1; i >= 0; i--) {
        const [dx, dy, r] = tiers[i];
        const g = c.createRadialGradient(cx + dx - r * .35, base + dy - r * .4, r * .1, cx + dx, base + dy, r);
        g.addColorStop(0, '#ffd9ea'); g.addColorStop(.55, '#f4a8c8'); g.addColorStop(1, '#d4789f');
        c.fillStyle = g;
        c.beginPath(); c.arc(cx + dx, base + dy, r, 0, TAU); c.fill();
      }
      for (let i = 0; i < 5; i++) {
        const hx = h2(x * 7 + i, y, 221), hy = h2(x, y * 7 + i, 223);
        c.fillStyle = 'rgba(255,255,255,.5)';
        c.beginPath(); c.arc(cx + (hx - .5) * T * .8, base - T * .9 + (hy - .5) * T * .6, T * .05, 0, TAU); c.fill();
      }
      return;
    }
    if (kind < 44 || level === 2) {               // statue on a plinth
      c.fillStyle = P.stone[0];
      roundRect(c, cx - T * .28, base - T * .22, T * .56, T * .32, T * .05); c.fill();
      const g = c.createLinearGradient(cx - T * .2, base - T * 1.1, cx + T * .2, base - T * .2);
      g.addColorStop(0, P.stone[1]); g.addColorStop(1, P.stone[0]);
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - T * .16, base - T * .22); c.lineTo(cx - T * .1, base - T * .78);
      c.lineTo(cx + T * .1, base - T * .78); c.lineTo(cx + T * .16, base - T * .22);
      c.closePath(); c.fill();
      c.fillStyle = P.stone[1];
      c.beginPath(); c.arc(cx, base - T * .88, T * .12, 0, TAU); c.fill();
      c.fillStyle = 'rgba(120,170,110,.3)';                       // moss
      c.beginPath(); c.ellipse(cx - T * .09, base - T * .3, T * .07, T * .04, 0, 0, TAU); c.fill();
      return;
    }
    if (kind < 46) {                              // a garden pavilion
      c.fillStyle = P.stone[0];
      roundRect(c, cx - T * .38, base - T * .3, T * .76, T * .34, T * .05); c.fill();
      c.strokeStyle = P.stone[1]; c.lineWidth = Math.max(2, T * .07);
      c.beginPath();
      c.moveTo(cx - T * .3, base - T * .28); c.lineTo(cx - T * .3, base - T * .8);
      c.moveTo(cx + T * .3, base - T * .28); c.lineTo(cx + T * .3, base - T * .8);
      c.moveTo(cx - T * .12, base - T * .28); c.lineTo(cx - T * .12, base - T * .82);
      c.moveTo(cx + T * .12, base - T * .28); c.lineTo(cx + T * .12, base - T * .82);
      c.stroke();
      const rg = c.createLinearGradient(cx - T * .5, base - T * 1.2, cx + T * .5, base - T * .7);
      rg.addColorStop(0, '#6f8f76'); rg.addColorStop(1, '#3f5c49');
      c.fillStyle = rg;
      c.beginPath();
      c.moveTo(cx - T * .52, base - T * .76); c.lineTo(cx, base - T * 1.3);
      c.lineTo(cx + T * .52, base - T * .76); c.closePath(); c.fill();
      c.fillStyle = '#d8bc70';
      c.beginPath(); c.arc(cx, base - T * 1.34, T * .07, 0, TAU); c.fill();
      return;
    }
    if (kind < 50) {                              // a tiered fountain
      const pul = .5 + .5 * Math.sin(h2(x, y, 701) * 6.283);
      c.fillStyle = '#3c6f88';
      c.beginPath(); c.ellipse(cx, base - T * .1, T * .44, T * .22, 0, 0, TAU); c.fill();
      c.strokeStyle = P.stone[0]; c.lineWidth = Math.max(2, T * .08);
      c.beginPath(); c.ellipse(cx, base - T * .1, T * .44, T * .22, 0, 0, TAU); c.stroke();
      c.fillStyle = P.stone[1];
      c.fillRect(cx - T * .06, base - T * .56, T * .12, T * .46);
      c.beginPath(); c.ellipse(cx, base - T * .56, T * .2, T * .09, 0, 0, TAU); c.fill();
      c.fillStyle = 'rgba(190,232,245,' + (.55 + .25 * pul) + ')';
      c.beginPath(); c.ellipse(cx, base - T * .6, T * .07, T * .16, 0, 0, TAU); c.fill();
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * TAU;
        c.beginPath();
        c.ellipse(cx + Math.cos(a) * T * .2, base - T * .48 + Math.abs(Math.sin(a)) * T * .06,
                  T * .03, T * .05, 0, 0, TAU);
        c.fill();
      }
      return;
    }
    if (kind < 52) {                              // a standing stone
      const g = c.createLinearGradient(cx - T * .2, base - T * 1.1, cx + T * .2, base);
      g.addColorStop(0, P.stone[1]); g.addColorStop(1, P.stone[0]);
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - T * .19, base); c.lineTo(cx - T * .13, base - T * 1.02);
      c.lineTo(cx + T * .1, base - T * 1.1); c.lineTo(cx + T * .2, base);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(110,160,100,.28)';
      c.beginPath(); c.ellipse(cx - T * .05, base - T * .2, T * .1, T * .06, 0, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = Math.max(1, T * .03);
      c.beginPath(); c.moveTo(cx - T * .06, base - T * .8); c.lineTo(cx - T * .02, base - T * .5); c.stroke();
      return;
    }
    if (kind < 60) {                              // a well
      c.fillStyle = P.stone[0];
      roundRect(c, cx - T * .26, base - T * .42, T * .52, T * .48, T * .08); c.fill();
      c.fillStyle = '#1d2630';
      c.beginPath(); c.ellipse(cx, base - T * .38, T * .2, T * .1, 0, 0, TAU); c.fill();
      c.fillStyle = '#3c6f88';
      c.beginPath(); c.ellipse(cx, base - T * .36, T * .15, T * .07, 0, 0, TAU); c.fill();
      c.strokeStyle = '#6d5133'; c.lineWidth = Math.max(1.5, T * .05);
      c.beginPath();
      c.moveTo(cx - T * .24, base - T * .42); c.lineTo(cx - T * .24, base - T * .9);
      c.moveTo(cx + T * .24, base - T * .42); c.lineTo(cx + T * .24, base - T * .9); c.stroke();
      c.fillStyle = '#8a5f34';
      c.beginPath();
      c.moveTo(cx - T * .34, base - T * .86); c.lineTo(cx, base - T * 1.16);
      c.lineTo(cx + T * .34, base - T * .86); c.closePath(); c.fill();
      return;
    }
    if (kind < 68) {                              // a flowering trellis arch
      c.strokeStyle = P.stone[0]; c.lineWidth = Math.max(2, T * .09);
      c.beginPath();
      c.moveTo(cx - T * .3, base); c.lineTo(cx - T * .3, base - T * .62);
      c.quadraticCurveTo(cx, base - T * 1.1, cx + T * .3, base - T * .62);
      c.lineTo(cx + T * .3, base); c.stroke();
      c.strokeStyle = '#3f8f43'; c.lineWidth = Math.max(1.5, T * .05);
      c.beginPath();
      c.moveTo(cx - T * .3, base - T * .1);
      c.quadraticCurveTo(cx - T * .1, base - T * .7, cx + T * .28, base - T * .5); c.stroke();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI + i / 5 * Math.PI;
        bloom(c, cx + Math.cos(a) * T * .3, base - T * .62 + Math.sin(a) * T * .42,
              T * .05, P.blossom[i % P.blossom.length]);
      }
      return;
    }
    if (kind < 74) {                              // a mossy boulder
      const g = c.createRadialGradient(cx - T * .12, base - T * .4, T * .04, cx, base - T * .24, T * .4);
      g.addColorStop(0, P.stone[1]); g.addColorStop(1, P.stone[0]);
      c.fillStyle = g;
      c.beginPath(); c.ellipse(cx, base - T * .22, T * .38, T * .3, .1, 0, TAU); c.fill();
      c.fillStyle = 'rgba(96,150,84,.45)';
      c.beginPath(); c.ellipse(cx - T * .1, base - T * .4, T * .16, T * .08, -.2, 0, TAU); c.fill();
      return;
    }
    if (kind < 80 && level === 1) {               // a dead, gnarled tree
      c.strokeStyle = '#6a5136'; c.lineCap = 'round';
      c.lineWidth = Math.max(2, T * .12);
      c.beginPath(); c.moveTo(cx, base); c.lineTo(cx - T * .04, base - T * .7); c.stroke();
      c.lineWidth = Math.max(1.5, T * .06);
      c.beginPath();
      c.moveTo(cx - T * .04, base - T * .55); c.lineTo(cx - T * .3, base - T * .9);
      c.moveTo(cx - T * .04, base - T * .62); c.lineTo(cx + T * .26, base - T * .95);
      c.moveTo(cx - T * .04, base - T * .7); c.lineTo(cx + T * .05, base - T * 1.05);
      c.stroke(); c.lineCap = 'butt';
      return;
    }
    // broadleaf tree, the common one
    c.fillStyle = P.trunk;
    c.fillRect(cx - T * .08, base - T * .5, T * .16, T * .6);
    c.fillStyle = 'rgba(0,0,0,.18)';
    c.fillRect(cx + T * .02, base - T * .5, T * .06, T * .6);
    const tiers = [[0, -T * 1.0, T * .56], [-T * .3, -T * .72, T * .42], [T * .3, -T * .7, T * .4]];
    for (let i = tiers.length - 1; i >= 0; i--) {
      const [dx, dy, r] = tiers[i];
      const g = c.createRadialGradient(cx + dx - r * .35, base + dy - r * .4, r * .1, cx + dx, base + dy, r);
      g.addColorStop(0, P.canopy[2]); g.addColorStop(.5, P.canopy[1]); g.addColorStop(1, P.canopy[0]);
      c.fillStyle = g;
      c.beginPath(); c.arc(cx + dx, base + dy, r, 0, TAU); c.fill();
    }
    for (let i = 0; i < 6; i++) {
      const hx = h2(x * 11 + i, y, 61), hy = h2(x, y * 11 + i, 63);
      c.fillStyle = 'rgba(190,240,150,.32)';
      c.beginPath();
      c.arc(cx + (hx - .5) * T * .9, base - T * .9 + (hy - .5) * T * .7, T * .07, 0, TAU);
      c.fill();
    }
  }

  /** a tree: trunk, three tiers of canopy, highlight on the sunward side */
  function paintTree(c, x, y, sx, sy, T, D, P) {
    const cx = sx + T * .5, base = sy + T * .78;
    c.fillStyle = 'rgba(22,44,26,.34)';
    c.beginPath(); c.ellipse(cx, base + T * .1, T * .5, T * .2, 0, 0, TAU); c.fill();
    c.fillStyle = P.trunk;
    c.fillRect(cx - T * .08, base - T * .5, T * .16, T * .6);
    const tiers = [[0, -T * 1.0, T * .56], [-T * .3, -T * .72, T * .42], [T * .3, -T * .7, T * .4]];
    for (let i = tiers.length - 1; i >= 0; i--) {
      const [dx, dy, r] = tiers[i];
      const g = c.createRadialGradient(cx + dx - r * .35, base + dy - r * .4, r * .1, cx + dx, base + dy, r);
      g.addColorStop(0, P.canopy[2]); g.addColorStop(.5, P.canopy[1]); g.addColorStop(1, P.canopy[0]);
      c.fillStyle = g;
      c.beginPath(); c.arc(cx + dx, base + dy, r, 0, TAU); c.fill();
    }
    for (let i = 0; i < 6; i++) {
      const hx = h2(x * 11 + i, y, 61), hy = h2(x, y * 11 + i, 63);
      c.fillStyle = 'rgba(190,240,150,.34)';
      c.beginPath();
      c.arc(cx + (hx - .5) * T * .9, base - T * .9 + (hy - .5) * T * .7, T * .07, 0, TAU);
      c.fill();
    }
  }

  /** a wayside shrine: stone plinth, arch, a lit crystal and a pool of light */
  function paintShrine(c, x, y, sx, sy, T, D, P, t) {
    const cx = sx + T * .5, base = sy + T * .85;
    const pul = .5 + .5 * Math.sin(t * 1.8 + x);
    const R = T * 1.7;
    const gl = c.createRadialGradient(cx, base - T * .5, 0, cx, base - T * .5, R);
    gl.addColorStop(0, P.glow + (.36 + .16 * pul) + ')');
    gl.addColorStop(1, P.glow + '0)');
    c.fillStyle = gl; c.beginPath(); c.arc(cx, base - T * .5, R, 0, TAU); c.fill();

    c.fillStyle = 'rgba(20,34,24,.36)';
    c.beginPath(); c.ellipse(cx, base + T * .1, T * .5, T * .2, 0, 0, TAU); c.fill();
    // steps
    c.fillStyle = P.stone[0];
    roundRect(c, sx + T * .08, base - T * .18, T * .84, T * .3, T * .06); c.fill();
    c.fillStyle = P.stone[1];
    roundRect(c, sx + T * .18, base - T * .34, T * .64, T * .22, T * .05); c.fill();
    // arch
    const g = c.createLinearGradient(sx, base - T * 1.3, sx + T, base);
    g.addColorStop(0, P.stone[1]); g.addColorStop(1, P.stone[0]);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - T * .3, base - T * .3);
    c.lineTo(cx - T * .3, base - T * .85);
    c.arc(cx, base - T * .85, T * .3, Math.PI, 0);
    c.lineTo(cx + T * .3, base - T * .3);
    c.closePath(); c.fill();
    // hollow
    c.fillStyle = 'rgba(16,22,26,.85)';
    c.beginPath();
    c.moveTo(cx - T * .17, base - T * .3);
    c.lineTo(cx - T * .17, base - T * .85);
    c.arc(cx, base - T * .85, T * .17, Math.PI, 0);
    c.lineTo(cx + T * .17, base - T * .3);
    c.closePath(); c.fill();
    // the crystal itself
    const cy = base - T * .72;
    c.fillStyle = P.glow + (.85 + .15 * pul) + ')';
    c.beginPath();
    c.moveTo(cx, cy - T * .2); c.lineTo(cx + T * .11, cy); c.lineTo(cx, cy + T * .2);
    c.lineTo(cx - T * .11, cy); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,.8)';
    c.beginPath();
    c.moveTo(cx, cy - T * .2); c.lineTo(cx + T * .05, cy - T * .02); c.lineTo(cx, cy + T * .06);
    c.lineTo(cx - T * .05, cy - T * .02); c.closePath(); c.fill();
  }

  // -------------------------------------------------------------- objects
  function paintChest(c, sx, sy, T, t, seed, bonus) {
    const K = bonus ? 1.3 : 1;
    const cx = sx + T * .5, base = sy + T * .72;
    T = T * K;
    const bob = Math.sin(t * 2 + seed) * T * .03;
    const pul = .5 + .5 * Math.sin(t * 2.4 + seed);
    const gl = c.createRadialGradient(cx, base - T * .2, 0, cx, base - T * .2, T * (bonus ? 1.7 : 1.25));
    gl.addColorStop(0, bonus ? 'rgba(190,150,255,' + (.5 + .2 * pul) + ')'
                             : 'rgba(255,205,90,' + (.36 + .16 * pul) + ')');
    gl.addColorStop(1, bonus ? 'rgba(190,150,255,0)' : 'rgba(255,205,90,0)');
    c.fillStyle = gl; c.beginPath(); c.arc(cx, base - T * .2, T * 1.25, 0, TAU); c.fill();

    c.fillStyle = 'rgba(30,28,14,.34)';
    c.beginPath(); c.ellipse(cx, base + T * .1, T * .34, T * .13, 0, 0, TAU); c.fill();

    const y0 = base - T * .32 + bob;
    const g = c.createLinearGradient(sx, y0, sx, y0 + T * .42);
    g.addColorStop(0, '#c98c33'); g.addColorStop(1, '#7d5316');
    c.fillStyle = g;
    roundRect(c, cx - T * .3, y0 + T * .1, T * .6, T * .3, T * .05); c.fill();
    // domed lid
    const g2 = c.createLinearGradient(cx - T * .3, y0, cx + T * .3, y0 + T * .16);
    if (bonus) { g2.addColorStop(0, '#e6d2ff'); g2.addColorStop(1, '#9a72d8'); }
    else { g2.addColorStop(0, '#f2cd6a'); g2.addColorStop(1, '#c08a2a'); }
    c.fillStyle = g2;
    c.beginPath(); c.ellipse(cx, y0 + T * .1, T * .3, T * .16, 0, Math.PI, 0); c.fill();
    c.fillStyle = '#6b4711';
    c.fillRect(cx - T * .3, y0 + T * .07, T * .6, T * .06);
    c.fillStyle = '#ffe9a8';
    roundRect(c, cx - T * .05, y0 + T * .12, T * .1, T * .12, T * .02); c.fill();
    // a couple of coins spilling out
    c.fillStyle = '#ffd867';
    c.beginPath(); c.arc(cx - T * .34, base + T * .02, T * .06, 0, TAU); c.fill();
    c.beginPath(); c.arc(cx + T * .32, base + T * .04, T * .05, 0, TAU); c.fill();
    // sparkle
    const sp = Math.sin(t * 3 + seed);
    if (sp > .6) {
      c.strokeStyle = 'rgba(255,248,200,' + ((sp - .6) * 2.5) + ')';
      c.lineWidth = Math.max(1, T * .03);
      const px = cx + T * .22, py = y0 - T * .06, r = T * .12;
      c.beginPath(); c.moveTo(px - r, py); c.lineTo(px + r, py);
      c.moveTo(px, py - r); c.lineTo(px, py + r); c.stroke();
    }
  }

  function paintIdol(c, sx, sy, T, t) {
    const cx = sx + T * .5, base = sy + T * .8;
    const pul = .5 + .5 * Math.sin(t * 1.5);
    const R = T * 2.6;
    const gl = c.createRadialGradient(cx, base - T * .6, 0, cx, base - T * .6, R);
    gl.addColorStop(0, 'rgba(255,224,130,' + (.5 + .2 * pul) + ')');
    gl.addColorStop(.5, 'rgba(255,200,90,.22)');
    gl.addColorStop(1, 'rgba(255,200,90,0)');
    c.fillStyle = gl; c.beginPath(); c.arc(cx, base - T * .6, R, 0, TAU); c.fill();

    c.fillStyle = 'rgba(40,30,10,.4)';
    c.beginPath(); c.ellipse(cx, base + T * .12, T * .62, T * .24, 0, 0, TAU); c.fill();
    // plinth
    c.fillStyle = '#b89550';
    roundRect(c, cx - T * .62, base - T * .18, T * 1.24, T * .32, T * .06); c.fill();
    c.fillStyle = '#d6b268';
    roundRect(c, cx - T * .46, base - T * .38, T * .92, T * .24, T * .05); c.fill();
    // seated figure
    const g = c.createLinearGradient(cx - T * .4, base - T * 1.3, cx + T * .4, base - T * .3);
    g.addColorStop(0, '#ffe9a0'); g.addColorStop(.5, '#f0c86a'); g.addColorStop(1, '#b8892c');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - T * .42, base - T * .38);
    c.lineTo(cx - T * .22, base - T * .95);
    c.lineTo(cx + T * .22, base - T * .95);
    c.lineTo(cx + T * .42, base - T * .38);
    c.closePath(); c.fill();
    c.fillStyle = '#f7d886';
    c.beginPath(); c.arc(cx, base - T * 1.06, T * .2, 0, TAU); c.fill();
    // headdress
    c.fillStyle = '#ffe9a0';
    c.beginPath();
    c.moveTo(cx - T * .22, base - T * 1.14); c.lineTo(cx, base - T * 1.5);
    c.lineTo(cx + T * .22, base - T * 1.14); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,235,' + (.6 + .4 * pul) + ')';
    c.beginPath(); c.arc(cx, base - T * 1.46, T * .07, 0, TAU); c.fill();
  }

  function paintBoat(c, sx, sy, T, t, seed) {
    const cx = sx + T * .5, cy = sy + T * .55 + Math.sin(t * 1.3 + seed) * T * .05;
    c.fillStyle = 'rgba(10,30,44,.3)';
    c.beginPath(); c.ellipse(cx, cy + T * .2, T * .44, T * .12, 0, 0, TAU); c.fill();
    const g = c.createLinearGradient(cx, cy - T * .1, cx, cy + T * .2);
    g.addColorStop(0, '#8a6134'); g.addColorStop(1, '#4f3419');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - T * .44, cy - T * .06);
    c.quadraticCurveTo(cx, cy + T * .3, cx + T * .44, cy - T * .06);
    c.quadraticCurveTo(cx, cy + T * .06, cx - T * .44, cy - T * .06);
    c.fill();
    c.fillStyle = '#a97d46';
    c.fillRect(cx - T * .42, cy - T * .1, T * .84, T * .07);
    c.strokeStyle = '#6b4a24'; c.lineWidth = Math.max(1, T * .035);
    c.beginPath(); c.moveTo(cx - T * .1, cy - T * .06); c.lineTo(cx - T * .3, cy + T * .12); c.stroke();
  }

  /** a runner: cloak, hood, soft shadow, and a name plate above */
  function paintPerson(c, cx, cy, T, opts) {
    const o = opts || {};
    const body = o.body || '#5d6f78', trim = o.trim || '#8ea1a8', isMe = o.me;
    const bob = Math.sin((o.t || 0) * 6 + (o.seed || 0)) * (o.moving ? T * .035 : 0);
    const y = cy + bob;
    c.fillStyle = 'rgba(16,30,18,.34)';
    c.beginPath(); c.ellipse(cx, cy + T * .34, T * .26, T * .1, 0, 0, TAU); c.fill();
    if (isMe) {
      const pul = .5 + .5 * Math.sin((o.t || 0) * 3);
      c.strokeStyle = 'rgba(255,214,96,' + (.55 + .35 * pul) + ')';
      c.lineWidth = Math.max(1.5, T * .06);
      c.beginPath(); c.ellipse(cx, cy + T * .32, T * .36, T * .15, 0, 0, TAU); c.stroke();
    }
    // cloak
    const g = c.createLinearGradient(cx - T * .22, y - T * .3, cx + T * .22, y + T * .3);
    g.addColorStop(0, trim); g.addColorStop(.45, body);
    g.addColorStop(1, 'rgba(0,0,0,.35)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - T * .1, y - T * .26);
    c.quadraticCurveTo(cx - T * .3, y, cx - T * .24, y + T * .3);
    c.lineTo(cx + T * .24, y + T * .3);
    c.quadraticCurveTo(cx + T * .3, y, cx + T * .1, y - T * .26);
    c.closePath(); c.fill();
    // hood and face
    c.fillStyle = trim;
    c.beginPath(); c.arc(cx, y - T * .3, T * .17, 0, TAU); c.fill();
    c.fillStyle = '#e8c9a4';
    c.beginPath(); c.arc(cx, y - T * .27, T * .1, 0, TAU); c.fill();
    c.fillStyle = body;
    c.beginPath(); c.arc(cx, y - T * .33, T * .16, Math.PI, 0); c.fill();
    // rim light
    c.strokeStyle = 'rgba(255,255,240,.32)'; c.lineWidth = Math.max(1, T * .035);
    c.beginPath(); c.arc(cx - T * .05, y - T * .3, T * .17, Math.PI * .8, Math.PI * 1.5); c.stroke();
  }

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

  return { PALS, paintAir, paintGround, paintWater, paintHedge, paintTree, paintProp, paintScatter, bloom, paintShrine,
           paintChest, paintIdol, paintBoat, paintPerson, paintPlate, roundRect, h2,
           GROUND, WALL, WATER, BRIDGE, DOCK, PROP, SHRINE };
})();

if (typeof module !== 'undefined') module.exports = PAINT;
