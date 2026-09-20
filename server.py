#!/usr/bin/env python3
"""
THE LAST GARDEN - a three-level treasure race for live events.
Zero dependencies (Python 3.8+).   Run:  python server.py   ->  open http://<your-ip>:8000

A tournament runs three back-to-back levels under one shareable ID:
  0  The Forest   up to 300 runners, open glades, tracks, a river and ferries
  1  The Ruins    the top 50, collapsed courtyards and vine-eaten walls
  2  The Temple   the last 10, the inner sanctum around the idol (names shown)

Nobody has to reach the idol to advance. Every runner is scored on gold
carried plus how close they got to it, so a rich runner stuck out in the
thickets and a poor runner at the sanctum door both rank.

Gold moves by one rule for everyone: when two figures meet, whoever carries
LESS takes a cut from whoever carries MORE. Passersby wander the world with
purses of their own, so a fat purse is worth chasing and hoarding is risky.

Server-authoritative: the layout, passerby purses and chest values never
leave the server as anything but positions and totals.
"""
import asyncio, base64, hashlib, json, os, random, socket, string, struct, time

import world as worldgen
from world import WALKABLE, DOCK, DIRS

# ------------------------------------------------------------------ config
HOST, PORT = "0.0.0.0", int(os.environ.get("PORT", 8000))
MOVE_INTERVAL = 0.11
TICK = 0.1
PASSERBY_INTERVAL = 0.5
INTERMISSION = 20
MIN_DELAY, MAX_DELAY = 10, 3600
ROOM_IDLE_TTL = 240
MAX_ROOMS = 200

STAGE_NAMES = [lv["name"] for lv in worldgen.LEVELS]
STAGE_CAPS = [300, 50, 10]
STAGE_SECONDS = [180, 180, 240]

LOOT_FRAC = 0.28
LOOT_COOLDOWN = 3.0
BOAT_COOLDOWN = 6.0

GOLD_POINTS = 10
PROGRESS_POINTS = 500
FINISH_BONUS = 200

VIEW_RADIUS = 16
VIEW_MAX = 24
HERE = os.path.dirname(os.path.abspath(__file__))
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")


# ------------------------------------------------------------------ figures
class Passerby:
    __slots__ = ("id", "t", "money", "loot_cd", "face")

    def __init__(self, pid, t, money):
        self.id, self.t, self.money = pid, t, money
        self.loot_cd = 0.0
        self.face = 0


class Player:
    __slots__ = ("id", "name", "w", "room", "x", "y", "t", "seq", "tok", "lm", "face",
                 "money", "score", "fin", "got", "best", "last_o", "loot_cd", "boat_cd")

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
        if not self.w.transport.is_closing():
            self.w.write(frame)


class Room:
    def __init__(self, code, start_at):
        self.code = code
        self.players = {}
        self.admins = set()
        self.passersby = []
        self.stage = 0
        self.world = None
        self.phase = "lobby"
        self.start_at = start_at
        self.t0 = 0.0
        self.ends_at = 0.0
        self.last_walk = 0.0
        self.empty_since = None
        self.history = []
        self.champion = None
        self.next_npc = -1


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


def world_msg(room):
    wd = room.world
    return {"W": wd.w, "H": wd.h, "g": wd.as_string(), "goal": wd.goal,
            "level": room.stage,
            "chests": [[c["id"], c["t"], c["v"]] for c in wd.chests],
            "docks": [[a, b] for (a, b) in wd.docks],
            "shrines": wd.shrines}


# ------------------------------------------------------------------ scoring
def score_of(p):
    s = p.money * GOLD_POINTS + round(p.best * PROGRESS_POINTS)
    if p.fin:
        s += FINISH_BONUS
    return s


def pos_msg(p, force=False, boat=False):
    wd = p.room.world if p.room else None
    m = {"t": "p", "x": p.x, "y": p.y, "s": p.seq, "money": p.money, "face": p.face,
         "left": wd.dist[p.t] if wd else 0, "prog": round(p.best * 100)}
    if force:
        m["f"] = 1
    if boat:
        m["boat"] = 1
    if p.fin:
        m["fin"] = 1
    return F(m)


def place(p, t, wd):
    p.t, p.x, p.y = t, t % wd.w, t // wd.w


def reset_player(room, p):
    place(p, random.choice(room.world.spawn), room.world)
    p.got = set()
    p.money = 0
    p.fin = False
    p.tok = 1.0
    p.face = 2
    p.lm = time.monotonic()
    p.last_o = None
    p.loot_cd = 0.0
    p.boat_cd = 0.0
    p.best = room.world.progress(p.t)
    p.score = 0


# ------------------------------------------------------------------ looting
def do_loot(a, b):
    """The lighter purse takes a cut from the heavier one."""
    now = time.monotonic()
    if now < a.loot_cd or now < b.loot_cd or a.money == b.money:
        return None
    rich, poor = (a, b) if a.money > b.money else (b, a)
    amount = max(1, round(rich.money * LOOT_FRAC))
    rich.money -= amount
    poor.money += amount
    rich.loot_cd = poor.loot_cd = now + LOOT_COOLDOWN
    return rich, poor, amount


def note_loot(entity, delta, from_player):
    if isinstance(entity, Player):
        entity.send(F({"t": "loot", "d": delta, "who": 1 if from_player else 0,
                       "money": entity.money}))


# ------------------------------------------------------------------ stages
def start_stage(room):
    room.world = worldgen.World(room.stage, random.getrandbits(48))
    room.phase = "play"
    room.t0 = time.time()
    room.ends_at = room.t0 + STAGE_SECONDS[room.stage]
    room.last_walk = room.t0

    room.passersby = []
    for _ in range(room.world.n_passersby):
        room.passersby.append(Passerby(room.next_npc, random.choice(room.world.floors),
                                       random.randint(0, 40)))
        room.next_npc -= 1

    broadcast(room, F({"t": "n", "stage": stage_info(room),
                       "secs": STAGE_SECONDS[room.stage], **world_msg(room)}))
    for p in room.players.values():
        reset_player(room, p)
        p.send(pos_msg(p, True))
    if room.admins:
        broadcast_admins(room, F({"t": "adminMaze", **world_msg(room)}))
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
            p.send(F({"t": "eliminated", "rank": cut + i + 1, "score": p.score, "money": p.money,
                      "prog": round(p.best * 100), "stage": STAGE_NAMES[room.stage]}))
            p.room = None
        room.players = {p.id: p for p in qualifiers}
        room.stage = nxt
        room.phase = "lobby"
        room.start_at = now + INTERMISSION
        room.passersby = []
        broadcast(room, F({"t": "qualified", "stage": STAGE_NAMES[room.stage], "startIn": INTERMISSION}))
    else:
        champ = ranked[0] if ranked else None
        room.champion = champ.name if champ else None
        room.phase = "done"
        room.passersby = []
        broadcast(room, F({"t": "tourEnd", "champion": room.champion,
                           "top": [[p.name, p.score, p.money] for p in ranked[:10]]}))
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

    wd = room.world
    p.face = d
    nt = p.t + DIRS[d][0] + DIRS[d][1] * wd.w
    if not (0 <= nt < wd.w * wd.h) or wd.g[nt] not in WALKABLE:
        p.send(pos_msg(p))
        return

    p.tok -= 1.0
    place(p, nt, wd)
    p.best = max(p.best, wd.progress(nt))

    for c in wd.chests:
        if c["t"] == nt and c["id"] not in p.got:
            p.got.add(c["id"])
            p.money += c["v"]
            p.send(F({"t": "chest", "id": c["id"], "v": c["v"], "money": p.money}))

    # meeting anyone triggers the purse rule
    met = False
    for q in room.players.values():
        if q is not p and q.t == nt and not q.fin:
            r = do_loot(p, q)
            if r:
                note_loot(r[0], -r[2], True)
                note_loot(r[1], r[2], True)
            met = True
            break
    if not met:
        for npc in room.passersby:
            if npc.t == nt:
                r = do_loot(p, npc)
                if r:
                    note_loot(r[0], -r[2], False)
                    note_loot(r[1], r[2], False)
                break

    # a landing stage: the ferry carries you clear across the world
    if wd.g[nt] == DOCK and now >= p.boat_cd:
        for (a, b) in wd.docks:
            if nt == a or nt == b:
                p.boat_cd = now + BOAT_COOLDOWN
                place(p, b if nt == a else a, wd)
                p.best = max(p.best, wd.progress(p.t))
                p.send(pos_msg(p, True, boat=True))
                return

    if nt == wd.goal and not p.fin:
        p.fin = True
        p.best = 1.0
        broadcast(room, F({"t": "reached", "id": p.id}))
    p.send(pos_msg(p))


def walk_passersby(room):
    wd = room.world
    for npc in room.passersby:
        opts = []
        for d, (dx, dy) in enumerate(DIRS):
            nt = npc.t + dx + dy * wd.w
            if 0 <= nt < wd.w * wd.h and wd.g[nt] in WALKABLE:
                opts.append((d, nt))
        if not opts:
            continue
        ahead = [o for o in opts if o[0] == npc.face]
        d, nt = ahead[0] if (ahead and random.random() < 0.65) else random.choice(opts)
        npc.face, npc.t = d, nt
        for p in room.players.values():
            if p.t == nt and not p.fin:
                r = do_loot(p, npc)
                if r:
                    note_loot(r[0], -r[2], False)
                    note_loot(r[1], r[2], False)
                break


# ------------------------------------------------------------------ fan-out
def broadcast_near(room):
    """Runners see only figures close by, and cannot tell who is who."""
    wd = room.world
    ps = list(room.players.values())
    buckets = {}
    for e in ps:
        buckets.setdefault((e.x >> 3, e.y >> 3), []).append((e.id, e.x, e.y))
    for npc in room.passersby:
        x, y = npc.t % wd.w, npc.t // wd.w
        buckets.setdefault((x >> 3, y >> 3), []).append((npc.id, x, y))

    span = (VIEW_RADIUS >> 3) + 1
    for p in ps:
        bx, by = p.x >> 3, p.y >> 3
        near = []
        for i in range(bx - span, bx + span + 1):
            for j in range(by - span, by + span + 1):
                for (eid, ex, ey) in buckets.get((i, j), ()):
                    if eid != p.id and abs(ex - p.x) <= VIEW_RADIUS and abs(ey - p.y) <= VIEW_RADIUS:
                        near.append([eid, ex, ey])
                        if len(near) >= VIEW_MAX:
                            break
        if near != p.last_o:
            p.last_o = near
            p.send(F({"t": "o", "l": near}))

    # the admin sees the real runners only - never the wandering passersby
    if room.admins:
        broadcast_admins(room, F({"t": "adminPos",
                                  "p": [[e.id, e.name, e.x, e.y, e.money, 1 if e.fin else 0,
                                         score_of(e)] for e in ps]}))


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
                                  "lb": [[p.name, score_of(p), p.money, round(p.best * 100)]
                                         for p in ps[:20]]}))


def lobby_msg(room):
    return F({"t": "lobby", "code": room.code, "startIn": max(0, round(room.start_at - time.time())),
              "stage": stage_info(room), "n": len(room.players)})


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
    p.w, p.seq, p.score, p.room = w, 0, 0, None
    p.x = p.y = p.t = 0
    p.money = 0
    p.fin = False
    p.best = 0.0
    p.face = 2
    p.got = set()
    p.last_o = None
    p.tok = 1.0
    p.lm = time.monotonic()
    p.loot_cd = 0.0
    p.boat_cd = 0.0
    return p


def cfg_msg():
    return {"mi": int(MOVE_INTERVAL * 1000), "view": VIEW_RADIUS,
            "stages": [{"name": STAGE_NAMES[i], "cap": STAGE_CAPS[i], "secs": STAGE_SECONDS[i]}
                       for i in range(len(STAGE_NAMES))]}


def join_room(p, room):
    if room.stage != 0 or room.phase == "done":
        p.send(F({"t": "err", "msg": "This tournament has already moved past the first level."}))
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
        p.send(F({"t": "n", "stage": stage_info(room),
                  "secs": max(1, int(room.ends_at - time.time())), **world_msg(room)}))
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
    if room.world:
        a.send(F({"t": "adminMaze", **world_msg(room)}))
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
    print("THE LAST GARDEN   ->  http://%s:%d   (local: http://localhost:%d)" % (ip, PORT, PORT))
    print("Admin aerial view ->  http://%s:%d/admin" % (ip, PORT))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
