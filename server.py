#!/usr/bin/env python3
"""
THE LAST GARDEN - a hedge-maze gold race for live events.
Zero dependencies (Python 3.8+).   Run:  python server.py   ->  open http://<your-ip>:8000

A tournament runs three back-to-back stages under one shareable ID:
  Stage 0  Qualifiers   up to 300 runners, huge maze
  Stage 1  Semifinal    top 50, smaller maze
  Stage 2  Final        top 10, small ornate maze (names revealed)

Nobody has to reach the shrine to advance. Every runner is scored on
gold carried plus how close they got to the shrine at the maze's heart,
so a rich runner stuck far out and a poor runner at the door both rank.

Gold moves by the same rule for everyone: when two figures meet, the one
carrying LESS takes a cut from the one carrying MORE. That applies to
runner-vs-runner and to the passersby wandering the hedges, who carry
their own purses. Hoarding is dangerous; chasing a fat purse pays.

Server-authoritative: the maze, passerby purses and chest values never
leave the server as anything but positions and totals.
"""
import asyncio, base64, hashlib, json, os, random, socket, string, struct, time
from collections import deque

# ------------------------------------------------------------------ config
HOST, PORT = "0.0.0.0", int(os.environ.get("PORT", 8000))
MOVE_INTERVAL = 0.11
TICK = 0.1
PASSERBY_INTERVAL = 0.5
INTERMISSION = 20
MIN_DELAY, MAX_DELAY = 10, 3600
ROOM_IDLE_TTL = 240
MAX_ROOMS = 200

STAGE_NAMES = ["Qualifiers", "Semifinal", "Final"]
STAGE_CAPS = [300, 50, 10]
STAGE_CELLS = [41, 29, 21]          # maze is CELLS x CELLS cells -> (2*CELLS+1)^2 tiles
STAGE_SECONDS = [180, 180, 240]

BRAID_DEADENDS = 0.8                # share of dead ends opened up -> many routes
BRAID_EXTRA = 0.06                  # extra walls knocked out for more loops
CHAMBER_EVERY = 170                 # one open chamber per N cells
CHEST_EVERY = 46                    # one chest per N floor tiles
PASSERBY_EVERY = 150                # one passerby per N floor tiles
CHEST_MIN, CHEST_MAX = 5, 20
PASSERBY_MIN, PASSERBY_MAX = 0, 40  # purses: some are poor, some are worth chasing

LOOT_FRAC = 0.28                    # cut taken from the richer purse
LOOT_COOLDOWN = 3.0                 # seconds of immunity after a loot

GOLD_POINTS = 10                    # score per gold
PROGRESS_POINTS = 500               # score for reaching the shrine's doorstep
FINISH_BONUS = 200

VIEW_RADIUS = 14                    # tiles of other figures you can see
VIEW_MAX = 24
DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))
HERE = os.path.dirname(os.path.abspath(__file__))
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")


# ------------------------------------------------------------------ maze
class Maze:
    """A braided hedge maze with the shrine at its heart."""

    def __init__(self, cells, seed):
        rnd = random.Random(seed)
        n = self.cells = cells
        w = self.w = self.h = n * 2 + 1
        g = bytearray(b"\x01") * (w * w)                 # 1 = hedge
        seen = bytearray(n * n)

        # growing tree carve
        c0 = n // 2
        seen[c0 * n + c0] = 1
        g[(2 * c0 + 1) * w + 2 * c0 + 1] = 0
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
            g[(2 * cy + 1 + dy) * w + 2 * cx + 1 + dx] = 0
            g[(2 * ny + 1) * w + 2 * nx + 1] = 0
            active.append((nx, ny))

        # open chambers (little garden rooms)
        for _ in range(max(4, (n * n) // CHAMBER_EVERY)):
            k = rnd.choice((2, 3))
            cx, cy = rnd.randrange(0, n - k + 1), rnd.randrange(0, n - k + 1)
            for y in range(2 * cy + 1, 2 * (cy + k - 1) + 2):
                for x in range(2 * cx + 1, 2 * (cx + k - 1) + 2):
                    g[y * w + x] = 0

        # braid: open most dead ends so there are always several ways round
        for cy in range(n):
            for cx in range(n):
                t = (2 * cy + 1) * w + 2 * cx + 1
                exits = [d for d, (dx, dy) in enumerate(DIRS) if g[t + dx + dy * w] == 0]
                if len(exits) == 1 and rnd.random() < BRAID_DEADENDS:
                    shut = [d for d, (dx, dy) in enumerate(DIRS)
                            if d not in exits and 0 <= cx + dx < n and 0 <= cy + dy < n]
                    if shut:
                        d = rnd.choice(shut)
                        dx, dy = DIRS[d]
                        g[t + dx + dy * w] = 0

        # a few more walls knocked through for extra loops
        for y in range(1, w - 1):
            for x in range(1, w - 1):
                if g[y * w + x] and (x & 1) != (y & 1) and rnd.random() < BRAID_EXTRA:
                    a, b = ((y - 1) * w + x, (y + 1) * w + x) if x & 1 else (y * w + x - 1, y * w + x + 1)
                    if not g[a] and not g[b]:
                        g[y * w + x] = 0

        # the shrine sits at the heart; clear a small courtyard round it
        goal = (2 * c0 + 1) * w + 2 * c0 + 1
        for yy in range(-2, 3):
            for xx in range(-2, 3):
                g[goal + yy * w + xx] = 0

        self.grid, self.goal = g, goal
        self.gx, self.gy = goal % w, goal // w

        # distance from the shrine drives both spawning and scoring
        self.dist = self._bfs(goal)
        self.maxd = max(self.dist) or 1
        floors = [t for t in range(w * w) if self.dist[t] >= 0]
        self.floors = floors

        # runners start out on the rim, all roughly as far from the shrine
        self.spawn = [t for t in floors if self.dist[t] >= self.maxd * 0.82] or floors

        # chests, kept off the courtyard and spaced out
        rnd.shuffle(floors)
        used, chests = set(), []
        want = max(8, len(self.floors) // CHEST_EVERY)
        for t in floors:
            if len(chests) >= want:
                break
            if t in used or self.dist[t] < 6:
                continue
            chests.append({"id": len(chests), "t": t, "v": rnd.randint(CHEST_MIN, CHEST_MAX)})
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    used.add(t + dy * w + dx)

        self.chests = chests
        self.n_passersby = max(6, len(self.floors) // PASSERBY_EVERY)

    def _bfs(self, src):
        w, g = self.w, self.grid
        dist = [-1] * (w * w)
        dist[src] = 0
        dq = deque([src])
        while dq:
            p = dq.popleft()
            d = dist[p] + 1
            for q in (p - 1, p + 1, p - w, p + w):
                if 0 <= q < w * w and g[q] == 0 and dist[q] < 0:
                    dist[q] = d
                    dq.append(q)
        return dist

    def progress(self, t):
        """0 at the rim, 1 at the shrine."""
        d = self.dist[t]
        if d < 0:
            return 0.0
        return max(0.0, min(1.0, 1.0 - d / self.maxd))


# ------------------------------------------------------------------ figures
class Passerby:
    """A wandering figure with a purse of its own."""
    __slots__ = ("id", "t", "money", "loot_cd", "face")

    def __init__(self, pid, t, money):
        self.id, self.t, self.money = pid, t, money
        self.loot_cd = 0.0
        self.face = 0


class Player:
    __slots__ = ("id", "name", "hue", "w", "room", "x", "y", "t", "seq", "tok", "lm",
                 "money", "score", "fin", "got", "best", "last_o", "loot_cd")

    def send(self, frame):
        tr = self.w.transport
        if tr.is_closing():
            return
        if tr.get_write_buffer_size() > 1_500_000:
            tr.abort()
            return
        self.w.write(frame)


class Admin:
    __slots__ = ("w", "room")

    def send(self, frame):
        tr = self.w.transport
        if not tr.is_closing():
            self.w.write(frame)


class Room:
    """One tournament: a shareable ID running three sequential stages."""

    def __init__(self, code, start_at):
        self.code = code
        self.players = {}
        self.admins = set()
        self.passersby = []
        self.stage = 0
        self.maze = None
        self.phase = "lobby"            # lobby -> play -> lobby(next stage) -> done
        self.start_at = start_at
        self.t0 = 0.0
        self.ends_at = 0.0
        self.last_walk = 0.0
        self.empty_since = None
        self.history = []
        self.champion = None
        self.next_npc = -1

    def duration(self):
        return STAGE_SECONDS[self.stage]


ROOMS = {}
NEXT_ID = 1


# ------------------------------------------------------------------ wire
def ws_frame(text):
    b = text.encode()
    n = len(b)
    if n < 126:
        h = struct.pack(">BB", 0x81, n)
    elif n < 65536:
        h = struct.pack(">BBH", 0x81, 126, n)
    else:
        h = struct.pack(">BBQ", 0x81, 127, n)
    return h + b


def F(o):
    return ws_frame(json.dumps(o, separators=(",", ":")))


def broadcast(room, frame, skip=None):
    for p in room.players.values():
        if p is not skip:
            p.send(frame)


def broadcast_admins(room, frame):
    for a in room.admins:
        a.send(frame)


def gen_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(6))
        if code not in ROOMS:
            return code


def stage_info(room):
    return {"idx": room.stage, "name": STAGE_NAMES[room.stage], "cap": STAGE_CAPS[room.stage],
            "reveal": 1 if room.stage == len(STAGE_NAMES) - 1 else 0}


def maze_msg(room):
    m = room.maze
    return {"W": m.w, "H": m.h,
            "g": "".join("1" if b else "0" for b in m.grid),
            "goal": m.goal,
            "chests": [[c["id"], c["t"], c["v"]] for c in m.chests]}


# ------------------------------------------------------------------ scoring
def score_of(p):
    s = p.money * GOLD_POINTS + round(p.best * PROGRESS_POINTS)
    if p.fin:
        s += FINISH_BONUS
    return s


def pos_msg(p, force=False):
    m = {"t": "p", "x": p.x, "y": p.y, "s": p.seq, "money": p.money,
         "left": p.room.maze.dist[p.t] if p.room and p.room.maze else 0,
         "prog": round(p.best * 100)}
    if force:
        m["f"] = 1
    if p.fin:
        m["fin"] = 1
    return F(m)


def place(p, t, maze):
    p.t, p.x, p.y = t, t % maze.w, t // maze.w


def reset_player(room, p):
    place(p, random.choice(room.maze.spawn), room.maze)
    p.got = set()
    p.money = 0
    p.fin = False
    p.tok = 1.0
    p.lm = time.monotonic()
    p.last_o = None
    p.loot_cd = 0.0
    p.best = room.maze.progress(p.t)
    p.score = 0


# ------------------------------------------------------------------ looting
def do_loot(a, b):
    """The lighter purse takes a cut from the heavier one. Returns (rich, poor, amount)."""
    now = time.monotonic()
    if now < a.loot_cd or now < b.loot_cd or a.money == b.money:
        return None
    rich, poor = (a, b) if a.money > b.money else (b, a)
    amount = max(1, round(rich.money * LOOT_FRAC))
    rich.money -= amount
    poor.money += amount
    rich.loot_cd = poor.loot_cd = now + LOOT_COOLDOWN
    return rich, poor, amount


def note_loot(room, entity, delta, is_player_pair):
    if isinstance(entity, Player):
        entity.send(F({"t": "loot", "d": delta, "who": 1 if is_player_pair else 0,
                       "money": entity.money}))


# ------------------------------------------------------------------ round flow
def start_stage(room):
    room.maze = Maze(STAGE_CELLS[room.stage], random.getrandbits(48))
    room.phase = "play"
    room.t0 = time.time()
    room.ends_at = room.t0 + room.duration()
    room.last_walk = room.t0

    room.passersby = []
    for _ in range(room.maze.n_passersby):
        room.passersby.append(Passerby(room.next_npc,
                                       random.choice(room.maze.floors),
                                       random.randint(PASSERBY_MIN, PASSERBY_MAX)))
        room.next_npc -= 1

    reveal = room.stage == len(STAGE_NAMES) - 1
    roster = {q.id: [q.name if reveal else "Runner", q.hue] for q in room.players.values()}
    broadcast(room, F({"t": "n", "stage": stage_info(room), "roster": roster,
                       "secs": room.duration(), **maze_msg(room)}))
    for p in room.players.values():
        reset_player(room, p)
        p.send(pos_msg(p, True))
    if room.admins:
        broadcast_admins(room, F({"t": "adminMaze", **maze_msg(room)}))
        broadcast_admins(room, F({"t": "adminStage", "stage": stage_info(room), "phase": room.phase,
                                  "history": room.history, "champion": room.champion}))


def end_stage(room, now):
    for p in room.players.values():
        p.score = score_of(p)
    ranked = sorted(room.players.values(), key=lambda p: -p.score)
    room.history.append({"stage": room.stage, "name": STAGE_NAMES[room.stage],
                         "top": [[p.name, p.score, p.money, round(p.best * 100)] for p in ranked[:10]]})

    nxt = room.stage + 1
    if nxt < len(STAGE_CAPS) and len(ranked) > 1:
        cut = STAGE_CAPS[nxt]
        qualifiers, out = ranked[:cut], ranked[cut:]
        for i, p in enumerate(out):
            p.send(F({"t": "eliminated", "rank": cut + i + 1, "score": p.score,
                      "money": p.money, "prog": round(p.best * 100), "stage": STAGE_NAMES[room.stage]}))
            p.room = None
        room.players = {p.id: p for p in qualifiers}
        room.stage = nxt
        room.phase = "lobby"
        room.start_at = now + INTERMISSION
        room.passersby = []
        broadcast(room, F({"t": "qualified", "stage": STAGE_NAMES[room.stage],
                           "startIn": INTERMISSION, "rank": 0}))
    else:
        champ = ranked[0] if ranked else None
        room.champion = champ.name if champ else None
        room.phase = "done"
        broadcast(room, F({"t": "tourEnd", "champion": room.champion,
                           "top": [[p.name, p.score, p.money] for p in ranked[:10]]}))
        room.passersby = []
    broadcast_admins(room, F({"t": "adminStage", "stage": stage_info(room), "phase": room.phase,
                              "history": room.history, "champion": room.champion}))


# ------------------------------------------------------------------ movement
def on_move(p, d, seq):
    room = p.room
    now = time.monotonic()
    p.seq = seq
    p.tok = min(3.0, p.tok + (now - p.lm) / MOVE_INTERVAL)
    p.lm = now
    if room is None or room.phase != "play" or p.fin or p.tok < 1.0:
        p.send(pos_msg(p))
        return
    m = room.maze
    nt = p.t + DIRS[d][0] + DIRS[d][1] * m.w
    if not (0 <= nt < m.w * m.h) or m.grid[nt] != 0:
        p.send(pos_msg(p))
        return

    p.tok -= 1.0
    place(p, nt, m)
    p.best = max(p.best, m.progress(nt))

    for c in m.chests:
        if c["t"] == nt and c["id"] not in p.got:
            p.got.add(c["id"])
            p.money += c["v"]
            p.send(F({"t": "chest", "id": c["id"], "v": c["v"], "money": p.money}))

    # bumping into anyone triggers the purse rule
    for q in room.players.values():
        if q is not p and q.t == nt and not q.fin:
            r = do_loot(p, q)
            if r:
                rich, poor, amt = r
                note_loot(room, rich, -amt, True)
                note_loot(room, poor, amt, True)
            break
    else:
        for npc in room.passersby:
            if npc.t == nt:
                r = do_loot(p, npc)
                if r:
                    rich, poor, amt = r
                    note_loot(room, rich, -amt, False)
                    note_loot(room, poor, amt, False)
                break

    if nt == m.goal and not p.fin:
        p.fin = True
        p.best = 1.0
        broadcast(room, F({"t": "reached", "id": p.id}))
    p.send(pos_msg(p))


def walk_passersby(room):
    m = room.maze
    for npc in room.passersby:
        opts = []
        for d, (dx, dy) in enumerate(DIRS):
            nt = npc.t + dx + dy * m.w
            if 0 <= nt < m.w * m.h and m.grid[nt] == 0:
                opts.append((d, nt))
        if not opts:
            continue
        straight = [o for o in opts if o[0] == npc.face]
        d, nt = straight[0] if (straight and random.random() < 0.65) else random.choice(opts)
        npc.face, npc.t = d, nt
        for p in room.players.values():
            if p.t == nt and not p.fin:
                r = do_loot(p, npc)
                if r:
                    rich, poor, amt = r
                    note_loot(room, rich, -amt, False)
                    note_loot(room, poor, amt, False)
                break


# ------------------------------------------------------------------ fan-out
def broadcast_near(room):
    """Each runner sees only the figures close to them - and cannot tell who is who."""
    m = room.maze
    ps = list(room.players.values())
    buckets = {}
    for e in ps:
        buckets.setdefault((e.x >> 3, e.y >> 3), []).append((e.id, e.x, e.y))
    for npc in room.passersby:
        x, y = npc.t % m.w, npc.t // m.w
        buckets.setdefault((x >> 3, y >> 3), []).append((npc.id, x, y))

    span = (VIEW_RADIUS >> 3) + 1
    for p in ps:
        bx, by = p.x >> 3, p.y >> 3
        near = []
        for i in range(bx - span, bx + span + 1):
            for j in range(by - span, by + span + 1):
                for (eid, ex, ey) in buckets.get((i, j), ()):
                    if eid == p.id:
                        continue
                    if abs(ex - p.x) <= VIEW_RADIUS and abs(ey - p.y) <= VIEW_RADIUS:
                        near.append([eid, ex, ey])
                        if len(near) >= VIEW_MAX:
                            break
        if near != p.last_o:
            p.last_o = near
            p.send(F({"t": "o", "l": near}))

    if room.admins:
        broadcast_admins(room, F({
            "t": "adminPos",
            "p": [[e.id, e.name, e.x, e.y, e.money, 1 if e.fin else 0, score_of(e)] for e in ps],
            "n": [[npc.t % m.w, npc.t // m.w, npc.money] for npc in room.passersby]}))


def send_meta(room, now):
    reveal = room.stage == len(STAGE_NAMES) - 1
    ps = sorted(room.players.values(), key=lambda p: -score_of(p))
    top = [[p.name if reveal else "Runner", score_of(p), p.money, round(p.best * 100)] for p in ps[:8]]
    left = max(0, int(room.ends_at - now))
    for i, p in enumerate(ps):
        p.send(F({"t": "m", "n": len(ps), "tl": left, "lb": top, "rk": i + 1,
                  "sc": score_of(p), "money": p.money, "prog": round(p.best * 100)}))
    if room.admins:
        broadcast_admins(room, F({"t": "adminMeta", "n": len(ps), "tl": left,
                                  "lb": [[p.name, score_of(p), p.money, round(p.best * 100)] for p in ps[:20]]}))


def lobby_msg(room):
    left = max(0, round(room.start_at - time.time()))
    return F({"t": "lobby", "code": room.code, "startIn": left, "stage": stage_info(room),
              "n": len(room.players)})


async def game_loop():
    last_meta = 0.0
    while True:
        await asyncio.sleep(TICK)
        now = time.time()
        for code in list(ROOMS.keys()):
            room = ROOMS.get(code)
            if room is None:
                continue
            if not room.players and not room.admins:
                if room.empty_since is None:
                    room.empty_since = now
                elif now - room.empty_since >= ROOM_IDLE_TTL:
                    ROOMS.pop(code, None)
                continue
            room.empty_since = None

            if room.phase == "lobby":
                if now >= room.start_at and room.players:
                    start_stage(room)
                else:
                    broadcast(room, lobby_msg(room))
            elif room.phase == "play":
                if now - room.last_walk >= PASSERBY_INTERVAL:
                    room.last_walk = now
                    walk_passersby(room)
                if now >= room.ends_at:
                    end_stage(room, now)
                else:
                    broadcast_near(room)

        if now - last_meta >= 1:
            last_meta = now
            for room in ROOMS.values():
                if room.phase == "play" and room.players:
                    send_meta(room, now)


# ------------------------------------------------------------------ joining
def new_player(w, name):
    global NEXT_ID
    p = Player()
    p.id, NEXT_ID = NEXT_ID, NEXT_ID + 1
    name = "".join(c for c in str(name or "") if c.isprintable())[:16].strip()
    p.name = name or "Runner%d" % random.randint(100, 999)
    p.hue = (p.id * 137) % 360
    p.w, p.seq, p.score, p.room = w, 0, 0, None
    p.x = p.y = p.t = 0
    p.money = 0
    p.fin = False
    p.best = 0.0
    p.got = set()
    p.last_o = None
    p.tok = 1.0
    p.lm = time.monotonic()
    p.loot_cd = 0.0
    return p


def cfg_msg():
    return {"mi": int(MOVE_INTERVAL * 1000), "view": VIEW_RADIUS,
            "stages": [{"name": STAGE_NAMES[i], "cap": STAGE_CAPS[i], "secs": STAGE_SECONDS[i]}
                       for i in range(len(STAGE_NAMES))]}


def join_room(p, room):
    if room.stage != 0 or room.phase == "done":
        p.send(F({"t": "err", "msg": "This tournament has moved past the qualifiers."}))
        return False
    if len(room.players) >= STAGE_CAPS[0]:
        p.send(F({"t": "err", "msg": "This tournament is full (300 runners)."}))
        return False
    p.room = room
    room.players[p.id] = p
    p.send(F({"t": "w", "id": p.id, "code": room.code, "ph": room.phase,
              "stage": stage_info(room), "cfg": cfg_msg()}))
    if room.phase == "lobby":
        broadcast(room, lobby_msg(room))
    else:
        reset_player(room, p)
        reveal = room.stage == len(STAGE_NAMES) - 1
        roster = {q.id: [q.name if reveal else "Runner", q.hue] for q in room.players.values()}
        p.send(F({"t": "n", "stage": stage_info(room), "roster": roster,
                  "secs": max(1, int(room.ends_at - time.time())), **maze_msg(room)}))
        p.send(pos_msg(p, True))
    return True


def create_room(p, delay):
    if len(ROOMS) >= MAX_ROOMS:
        p.send(F({"t": "err", "msg": "Too many tournaments running right now."}))
        return None
    delay = max(MIN_DELAY, min(MAX_DELAY, int(delay or MIN_DELAY)))
    room = Room(gen_code(), time.time() + delay)
    ROOMS[room.code] = room
    join_room(p, room)
    return room


def leave_room(p):
    room = p.room
    if room and room.players.pop(p.id, None) and room.phase == "lobby":
        broadcast(room, lobby_msg(room))
    p.room = None


def join_admin(w, code):
    room = ROOMS.get(code)
    if room is None:
        w.write(F({"t": "err", "msg": "No tournament with that ID."}))
        return None
    a = Admin()
    a.w, a.room = w, room
    room.admins.add(a)
    a.send(F({"t": "adminHi", "code": room.code, "stage": stage_info(room), "phase": room.phase,
              "history": room.history, "champion": room.champion}))
    if room.maze:
        a.send(F({"t": "adminMaze", **maze_msg(room)}))
    return a


# ------------------------------------------------------------------ websocket
async def read_frame(r):
    b = await r.readexactly(2)
    op, ln, masked = b[0] & 15, b[1] & 127, b[1] & 128
    if ln == 126:
        ln = struct.unpack(">H", await r.readexactly(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", await r.readexactly(8))[0]
    if ln > 4096:
        raise ValueError("frame too large")
    mask = await r.readexactly(4) if masked else None
    data = await r.readexactly(ln) if ln else b""
    if mask:
        data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
    return op, data


async def ws_session(r, w, headers):
    key = headers.get("sec-websocket-key")
    if not key:
        w.close()
        return
    acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    w.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + acc + b"\r\n\r\n")
    sock = w.get_extra_info("socket")
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
    p, adm = None, None
    try:
        while True:
            op, data = await asyncio.wait_for(read_frame(r), 75)
            if op == 8:
                break
            if op == 9:
                w.write(b"\x8a" + bytes([len(data)]) + data)
                continue
            if op != 1:
                continue
            try:
                m = json.loads(data)
                t = m.get("t")
            except (ValueError, AttributeError):
                continue
            if p is None and adm is None:
                if t == "hi":
                    p = new_player(w, m.get("name"))
                    code = str(m.get("code") or "").strip().upper()
                    if m.get("mode") == "join":
                        room = ROOMS.get(code)
                        if room is None:
                            p.send(F({"t": "err", "msg": "That tournament code was not found."}))
                            p = None
                        elif not join_room(p, room):
                            p = None
                    elif create_room(p, m.get("delay")) is None:
                        p = None
                elif t == "admin":
                    adm = join_admin(w, str(m.get("code") or "").strip().upper())
                continue
            if p and t == "m":
                d, s = m.get("d"), m.get("s")
                if type(d) is int and 0 <= d < 4 and type(s) is int:
                    on_move(p, d, s)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, OSError):
        pass
    finally:
        if p:
            leave_room(p)
        if adm and adm.room:
            adm.room.admins.discard(adm)
        w.close()


PAGES = {"/": "index.html", "/index.html": "index.html", "/admin": "admin.html"}


async def handle(r, w):
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin1").split("\r\n")
        _, path, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    except Exception:
        w.close()
        return
    if headers.get("upgrade", "").lower() == "websocket":
        await ws_session(r, w, headers)
        return
    try:
        fname = PAGES.get(path.split("?")[0])
        if fname:
            with open(os.path.join(HERE, fname), "rb") as f:
                body, status, ctype = f.read(), b"200 OK", b"text/html; charset=utf-8"
        else:
            body, status, ctype = b"Not found", b"404 Not Found", b"text/plain"
        w.write(b"HTTP/1.1 " + status + b"\r\nContent-Type: " + ctype + b"\r\nContent-Length: " +
                str(len(body)).encode() + b"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n" + body)
        await w.drain()
    except Exception:
        pass
    finally:
        w.close()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


async def main():
    server = await asyncio.start_server(handle, HOST, PORT, backlog=2048)
    asyncio.create_task(game_loop())
    ip = lan_ip()
    print("THE LAST GARDEN  ->  http://%s:%d   (local: http://localhost:%d)" % (ip, PORT, PORT))
    print("Admin aerial view ->  http://%s:%d/admin" % (ip, PORT))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
