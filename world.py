#!/usr/bin/env python3
"""
World generation for THE LAST GARDEN.

Three levels, each a real place rather than a plain maze:

  0  The Forest   open glades joined by wide tracks, thickets between them,
                  a river with bridges and ferry boats
  1  The Ruins    the same bones, but collapsed courtyards, vine-eaten walls
                  and standing stones
  2  The Temple   an inner sanctum of halls and colonnades around the idol

Every level is built the same way: carve a braided thicket for challenge,
lay plazas and wide roads over it for real crossroads, run a river through
it, bridge the river, then drop in landmarks, boats, chests and props.
Whatever cannot be reached from the idol is sealed off, so the playable
world is always one connected piece.
"""
import random
from collections import deque

# tile kinds (sent to the browser as digits)
GROUND, WALL, WATER, BRIDGE, DOCK, PROP, SHRINE = 0, 1, 2, 3, 4, 5, 6
WALKABLE = (GROUND, BRIDGE, DOCK)
OPAQUE = (WALL, PROP, SHRINE)          # blocks sight; water does not

DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))

LEVELS = [
    {"name": "The Forest", "cells": 41, "plazas": 14, "rivers": 1, "props": 0.030,
     "shrines": 5, "docks": 3, "thicket": 0.72},
    {"name": "The Ruins",  "cells": 29, "plazas": 10, "rivers": 1, "props": 0.038,
     "shrines": 6, "docks": 2, "thicket": 0.66},
    {"name": "The Temple", "cells": 21, "plazas": 8,  "rivers": 0, "props": 0.045,
     "shrines": 4, "docks": 0, "thicket": 0.60},
]


class World:
    def __init__(self, level, seed):
        spec = LEVELS[level]
        self.level = level
        self.name = spec["name"]
        rnd = random.Random(seed)
        self.rnd = rnd
        n = self.cells = spec["cells"]
        w = self.w = self.h = n * 2 + 1
        self.g = bytearray([WALL]) * (w * w)

        self._carve_thicket(rnd, n, spec["thicket"])
        centres = self._plazas(rnd, n, spec["plazas"])
        self._roads(rnd, centres)
        self.river_path = []
        for _ in range(spec["rivers"]):
            self._river(rnd)
        self.goal = self._sanctum(rnd)
        self.docks = self._docks(rnd, spec["docks"])
        self.shrines = self._landmarks(rnd, centres, spec["shrines"])
        self._props(rnd, spec["props"])
        self._seal_unreachable()

        self.dist = self._bfs(self.goal)
        self.maxd = max(self.dist) or 1
        self.floors = [t for t in range(w * w) if self.dist[t] >= 0]
        self.spawn = [t for t in self.floors if self.dist[t] >= self.maxd * 0.78] or self.floors
        self.chests = self._chests(rnd)
        self.n_passersby = max(6, len(self.floors) // 150)

    # ---------------------------------------------------------------- helpers
    def tile(self, x, y):
        return self.g[y * self.w + x]

    def inside(self, x, y, m=1):
        return m <= x < self.w - m and m <= y < self.h - m

    def walkable(self, t):
        return self.g[t] in WALKABLE

    def _bfs(self, src):
        w, g = self.w, self.g
        dist = [-1] * (w * w)
        dist[src] = 0
        dq = deque([src])
        while dq:
            p = dq.popleft()
            d = dist[p] + 1
            for q in (p - 1, p + 1, p - w, p + w):
                if 0 <= q < w * w and g[q] in WALKABLE and dist[q] < 0:
                    dist[q] = d
                    dq.append(q)
        return dist

    def _clear(self, x, y, r, kind=GROUND):
        for yy in range(y - r, y + r + 1):
            for xx in range(x - r, x + r + 1):
                if self.inside(xx, yy):
                    self.g[yy * self.w + xx] = kind

    # ------------------------------------------------------- 1. braided thicket
    def _carve_thicket(self, rnd, n, braid):
        """A growing-tree maze, then most dead ends opened: dense but never a trap."""
        w, g = self.w, self.g
        seen = bytearray(n * n)
        c0 = n // 2
        seen[c0 * n + c0] = 1
        g[(2 * c0 + 1) * w + 2 * c0 + 1] = GROUND
        active = [(c0, c0)]
        while active:
            i = len(active) - 1 if rnd.random() < 0.88 else rnd.randrange(len(active))
            cx, cy = active[i]
            opts = [(cx + dx, cy + dy, dx, dy) for dx, dy in DIRS
                    if 0 <= cx + dx < n and 0 <= cy + dy < n and not seen[(cy + dy) * n + cx + dx]]
            if not opts:
                active[i] = active[-1]
                active.pop()
                continue
            nx, ny, dx, dy = rnd.choice(opts)
            seen[ny * n + nx] = 1
            g[(2 * cy + 1 + dy) * w + 2 * cx + 1 + dx] = GROUND
            g[(2 * ny + 1) * w + 2 * nx + 1] = GROUND
            active.append((nx, ny))

        for cy in range(n):
            for cx in range(n):
                t = (2 * cy + 1) * w + 2 * cx + 1
                outs = [d for d, (dx, dy) in enumerate(DIRS) if g[t + dx + dy * w] == GROUND]
                if len(outs) == 1 and rnd.random() < braid:
                    shut = [d for d, (dx, dy) in enumerate(DIRS)
                            if d not in outs and 0 <= cx + dx < n and 0 <= cy + dy < n]
                    if shut:
                        dx, dy = DIRS[rnd.choice(shut)]
                        g[t + dx + dy * w] = GROUND

    # --------------------------------------------------------- 2. open plazas
    def _plazas(self, rnd, n, count):
        """Glades / courtyards / halls - the places that feel like somewhere."""
        centres, tries = [], 0
        margin = 5
        while len(centres) < count and tries < count * 60:
            tries += 1
            cx = rnd.randrange(margin, self.w - margin)
            cy = rnd.randrange(margin, self.h - margin)
            if any(abs(cx - ox) + abs(cy - oy) < 12 for ox, oy in centres):
                continue
            r = rnd.choice((3, 3, 4, 5))
            self._clear(cx, cy, r)
            centres.append((cx, cy))
        return centres

    # ---------------------------------------------------------- 3. wide roads
    def _road(self, x1, y1, x2, y2, half=1):
        """An L-shaped track, wide enough to feel like a road."""
        x, y = x1, y1
        step = 1 if x2 > x else -1
        while x != x2:
            self._clear(x, y, half)
            x += step
        step = 1 if y2 > y else -1
        while y != y2:
            self._clear(x, y, half)
            y += step
        self._clear(x, y, half)

    def _roads(self, rnd, centres):
        if len(centres) < 2:
            return
        # a spanning network so everywhere is joined, plus extra links for loops
        unlinked = centres[1:]
        linked = [centres[0]]
        while unlinked:
            best = min(((a, b) for a in linked for b in unlinked),
                       key=lambda pr: abs(pr[0][0] - pr[1][0]) + abs(pr[0][1] - pr[1][1]))
            a, b = best
            self._road(a[0], a[1], b[0], b[1], 1)
            linked.append(b)
            unlinked.remove(b)
        for _ in range(len(centres) // 2):
            a, b = rnd.sample(centres, 2)
            self._road(a[0], a[1], b[0], b[1], rnd.choice((0, 1)))

    # ------------------------------------------------------------- 4. a river
    def _river(self, rnd):
        """A watercourse across the world, then bridges so both banks connect."""
        w = self.w
        vertical = rnd.random() < 0.5
        span = self.h if vertical else self.w
        pos = rnd.randrange(int(span * 0.3), int(span * 0.7))
        width = rnd.choice((1, 2))
        path = []
        for i in range(2, span - 2):
            pos += rnd.choice((-1, 0, 0, 0, 1))
            pos = max(4, min(span - 5, pos))
            for k in range(width + 1):
                x, y = (pos + k, i) if vertical else (i, pos + k)
                if self.inside(x, y, 2):
                    self.g[y * w + x] = WATER
            path.append((pos, i))
        self.river_path.append((vertical, width, path))

        # bridges at regular intervals, with the banks cleared so they connect
        steps = max(4, len(path) // 9)
        for idx in range(steps // 2, len(path), steps):
            pos_i, i = path[idx]
            for k in range(-2, width + 3):
                x, y = (pos_i + k, i) if vertical else (i, pos_i + k)
                if not self.inside(x, y, 2):
                    continue
                t = y * w + x
                self.g[t] = BRIDGE if self.g[t] == WATER else GROUND
            # widen the approach so a bridge is never a one-tile trap
            for side in (-1, 1):
                x, y = (pos_i + width // 2, i + side) if vertical else (i + side, pos_i + width // 2)
                if self.inside(x, y, 2) and self.g[y * w + x] == WALL:
                    self.g[y * w + x] = GROUND

    # --------------------------------------------------- 5. the inner sanctum
    def _sanctum(self, rnd):
        """The idol sits at the heart, inside an open court."""
        c = self.w // 2
        cx = c if c % 2 else c + 1
        goal = cx * self.w + cx
        self._clear(cx, cx, 4)
        # a ring of columns around the court, with four ways in
        for d in range(-4, 5):
            for (x, y) in ((cx + d, cx - 4), (cx + d, cx + 4), (cx - 4, cx + d), (cx + 4, cx + d)):
                if abs(d) in (2, 3) and self.inside(x, y):
                    self.g[y * self.w + x] = PROP
        return goal

    # ------------------------------------------------------------- 6. ferries
    def _docks(self, rnd, pairs):
        """Landing stages on the bank; each pair is a boat ride across the world."""
        if not pairs:
            return []
        w = self.w
        banks = []
        for t in range(w * w):
            if self.g[t] != GROUND:
                continue
            if any(0 <= t + o < w * w and self.g[t + o] == WATER for o in (-1, 1, -w, w)):
                banks.append(t)
        rnd.shuffle(banks)
        docks, used = [], []
        for a in banks:
            if len(docks) >= pairs:
                break
            ax, ay = a % w, a // w
            if any(abs(ax - ux) + abs(ay - uy) < 10 for ux, uy in used):
                continue
            far = [b for b in banks
                   if abs(b % w - ax) + abs(b // w - ay) > w * 0.7
                   and all(abs(b % w - ux) + abs(b // w - uy) >= 10 for ux, uy in used)]
            if not far:
                continue
            b = rnd.choice(far)
            self.g[a] = DOCK
            self.g[b] = DOCK
            docks.append((a, b))
            used.append((ax, ay))
            used.append((b % w, b // w))
        return docks

    # ----------------------------------------------------------- 7. landmarks
    def _landmarks(self, rnd, centres, count):
        """Wayside shrines you can navigate by."""
        out = []
        for (cx, cy) in rnd.sample(centres, min(count, len(centres))):
            t = cy * self.w + cx
            if t == self.goal or abs(cx - self.goal % self.w) + abs(cy - self.goal // self.w) < 8:
                continue
            self.g[t] = SHRINE
            out.append(t)
        return out

    # --------------------------------------------------------------- 8. props
    def _props(self, rnd, density):
        """Trees, fallen columns, statues - only where they cannot wall anyone in."""
        w, g = self.w, self.g
        for t in range(w * w):
            if g[t] != GROUND or t == self.goal or rnd.random() > density:
                continue
            x, y = t % w, t // w
            if not self.inside(x, y, 3):
                continue
            open_ring = sum(1 for o in (-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1)
                            if g[t + o] in WALKABLE)
            if open_ring >= 7:                 # deep inside an open space
                g[t] = PROP

    # ----------------------------------------------------- 9. seal the strays
    def _seal_unreachable(self):
        """Anything the idol cannot reach is turned back into scenery."""
        reach = self._bfs(self.goal)
        for t in range(self.w * self.h):
            if self.g[t] in WALKABLE and reach[t] < 0:
                self.g[t] = WALL
        # docks whose far side got sealed are no longer boats
        self.docks = [(a, b) for (a, b) in self.docks
                      if reach[a] >= 0 and reach[b] >= 0]

    # -------------------------------------------------------------- 10. chests
    def _chests(self, rnd):
        spots = [t for t in self.floors if self.g[t] == GROUND and self.dist[t] > 5]
        rnd.shuffle(spots)
        want = max(8, len(self.floors) // 46)
        used, chests = set(), []
        for t in spots:
            if len(chests) >= want:
                break
            if t in used:
                continue
            chests.append({"id": len(chests), "t": t, "v": rnd.randint(5, 20)})
            x, y = t % self.w, t // self.w
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    used.add((y + dy) * self.w + x + dx)
        return chests

    # ------------------------------------------------------------------ query
    def progress(self, t):
        d = self.dist[t]
        if d < 0:
            return 0.0
        return max(0.0, min(1.0, 1.0 - d / self.maxd))

    def as_string(self):
        return "".join(chr(48 + b) for b in self.g)

    def stats(self):
        counts = {}
        for b in self.g:
            counts[b] = counts.get(b, 0) + 1
        junctions = 0
        for t in self.floors:
            opens = sum(1 for q in (t - 1, t + 1, t - self.w, t + self.w)
                        if 0 <= q < self.w * self.h and self.g[q] in WALKABLE)
            if opens >= 3:
                junctions += 1
        return {"size": self.w, "walkable": len(self.floors), "junctions": junctions,
                "water": counts.get(WATER, 0), "bridge": counts.get(BRIDGE, 0),
                "props": counts.get(PROP, 0), "shrines": counts.get(SHRINE, 0),
                "docks": len(self.docks), "chests": len(self.chests), "maxd": self.maxd}
