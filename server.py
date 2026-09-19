#!/usr/bin/env python3
"""
LABYRINTH - multiplayer maze race, tournament rooms, whole-map view.
Zero dependencies (Python 3.8+).   Run:  python server.py   ->  open http://<your-ip>:8000

Players create or join a tournament by a 6-character code. A tournament can be
scheduled to start at a fixed time in the future so everyone begins the same
maze together regardless of when they finished loading or logging in.
Server-authoritative: the maze, thieves and chest values never leave the
server as anything but positions/values.
"""
import asyncio, base64, hashlib, json, os, random, socket, string, struct, time
from collections import deque

# ------------------------------------------------------------------ config
HOST, PORT = "0.0.0.0", int(os.environ.get("PORT", 8000))
CELLS = 19                     # maze is CELLS x CELLS cells -> (2*CELLS+1)^2 tiles (whole map is shown at once)
W = H = CELLS * 2 + 1
MOVE_INTERVAL = 0.11            # seconds per tile
TICK = 0.1                      # world tick (nearby-player + thief updates)
THIEF_INTERVAL = 0.42           # seconds per thief step
ROUND_MAX = 240                 # seconds before a round is abandoned
FINISH_GRACE = 22               # seconds left after the first finisher
INTERMISSION = 10
MAX_PLAYERS_PER_ROOM = 300
BRAID = 0.02                    # share of walls knocked out to create loops
CHAMBERS = 10                   # open chambers
N_CHESTS = 26
N_THIEVES = 9
CHEST_MIN, CHEST_MAX = 6, 22
STEAL_MIN, STEAL_MAX = 0.25, 0.55   # fraction of carried gold a thief takes
POINTS = (10, 7, 5, 4, 3, 2, 1)
DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))          # up right down left
HERE = os.path.dirname(os.path.abspath(__file__))
TOP_VISIBLE = 5                 # only the leading few runners are shown on the map
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")
MIN_DELAY, MAX_DELAY = 10, 3600
ROOM_IDLE_TTL = 90               # seconds an empty room is kept around before it's dropped


# ------------------------------------------------------------------ maze
def bfs(g, src):
    dist = [-1] * (W * H)
    dist[src] = 0
    dq = deque([src])
    while dq:
        p = dq.popleft()
        d = dist[p] + 1
        for q in (p - 1, p + 1, p - W, p + W):
            if g[q] == 0 and dist[q] < 0:
                dist[q] = d
                dq.append(q)
    return dist


class Maze:
    def __init__(self, seed):
        rnd = random.Random(seed)
        n = CELLS
        g = bytearray(b"\x01") * (W * H)                # 1 = wall
        seen = bytearray(n * n)
        c0 = n // 2
        seen[c0 * n + c0] = 1
        g[(2 * c0 + 1) * W + 2 * c0 + 1] = 0
        active = [(c0, c0)]
        while active:
            i = len(active) - 1 if rnd.random() < 0.9 else rnd.randrange(len(active))
            cx, cy = active[i]
            opts = [(cx + dx, cy + dy, dx, dy) for dx, dy in DIRS
                    if 0 <= cx + dx < n and 0 <= cy + dy < n and not seen[(cy + dy) * n + cx + dx]]
            if not opts:
                active[i] = active[-1]
                active.pop()
                continue
            nx, ny, dx, dy = rnd.choice(opts)
            seen[ny * n + nx] = 1
            g[(2 * cy + 1 + dy) * W + 2 * cx + 1 + dx] = 0
            g[(2 * ny + 1) * W + 2 * nx + 1] = 0
            active.append((nx, ny))
        for _ in range(CHAMBERS):
            k = rnd.choice((2, 3))
            cx, cy = rnd.randrange(0, n - k + 1), rnd.randrange(0, n - k + 1)
            for y in range(2 * cy + 1, 2 * (cy + k - 1) + 2):
                for x in range(2 * cx + 1, 2 * (cx + k - 1) + 2):
                    g[y * W + x] = 0
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                if g[y * W + x] and (x & 1) != (y & 1) and rnd.random() < BRAID:
                    a, b = ((y - 1) * W + x, (y + 1) * W + x) if x & 1 else (y * W + x - 1, y * W + x + 1)
                    if not g[a] and not g[b]:
                        g[y * W + x] = 0

        s = (2 * c0 + 1) * W + 2 * c0 + 1
        dist = bfs(g, s)
        maxd = max(dist)
        goal = rnd.choice([t for t in range(W * H) if dist[t] >= 0.9 * maxd])
        floors = [t for t in range(W * H) if dist[t] >= 0]

        far = [t for t in floors if dist[t] >= maxd * 0.12]
        rnd.shuffle(far)
        chests = []
        used = set()
        for t in far:
            if len(chests) >= N_CHESTS:
                break
            if t in used or t == goal or t == s:
                continue
            chests.append({"id": len(chests), "t": t, "v": rnd.randint(CHEST_MIN, CHEST_MAX)})
            for o in (-1, 1, -W, W, 0):
                used.add(t + o)

        mid = [t for t in floors if dist[t] >= maxd * 0.2]
        rnd.shuffle(mid)
        thieves = [{"id": i, "t": mid[i % len(mid)]} for i in range(N_THIEVES)]

        self.grid, self.start, self.goal = g, s, goal
        self.floors = floors
        self.spawn = [t for t in floors if dist[t] <= 6] + [s]
        self.gx, self.gy = goal % W, goal // W
        self.chests = chests
        self.thieves = thieves
        self.dist = dist


# ------------------------------------------------------------------ state
class Player:
    __slots__ = ("id", "name", "hue", "w", "room", "x", "y", "t", "seq", "tok", "lm",
                 "money", "score", "fin", "got", "last_o")

    def send(self, frame):
        tr = self.w.transport
        if tr.is_closing():
            return
        if tr.get_write_buffer_size() > 1_000_000:
            tr.abort()
            return
        self.w.write(frame)


class Room:
    def __init__(self, code, start_at):
        self.code = code
        self.players = {}
        self.round = 0
        self.maze = None
        self.phase = "lobby"            # lobby -> play -> over -> play -> ...
        self.start_at = start_at        # epoch seconds the first round begins
        self.t0 = 0.0
        self.first = None
        self.fins = []
        self.next_at = 0.0
        self.last_thief = 0.0
        self.empty_since = None


ROOMS = {}
NEXT_ID = 1


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


def gen_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(6))
        if code not in ROOMS:
            return code


def maze_msg(room):
    m = room.maze
    return {
        "W": W, "H": H,
        "g": "".join("1" if b else "0" for b in m.grid),
        "goal": m.goal,
        "chests": [[c["id"], c["t"], c["v"]] for c in m.chests],
        "thieves": [[th["id"], th["t"]] for th in m.thieves],
    }


def score_of(money, elapsed):
    """Normalised score blending gold collected and pace."""
    time_factor = max(0.35, 1.0 - min(1.0, elapsed / ROUND_MAX) * 0.65)
    return round(money * 8 * time_factor)


def pos_msg(p, force=False):
    m = {"t": "p", "x": p.x, "y": p.y, "s": p.seq, "money": p.money}
    if force:
        m["f"] = 1
    if p.fin is not None:
        m["fin"] = p.fin[0]
    return F(m)


def place_player(p, t):
    p.t, p.x, p.y = t, t % W, t // W


def reset_player(room, p):
    place_player(p, random.choice(room.maze.spawn))
    p.got = set()
    p.money = 0
    p.fin = None
    p.tok = 1.0
    p.lm = time.monotonic()
    p.last_o = None


def lobby_msg(room):
    left = max(0, round(room.start_at - time.time()))
    return F({"t": "lobby", "code": room.code, "startIn": left,
              "players": [[q.id, q.name] for q in room.players.values()]})


def start_round(room):
    """Fires the first (scheduled) round, or the next one after an intermission."""
    room.round += 1
    room.maze = Maze(random.getrandbits(48))
    room.phase, room.t0, room.first, room.fins = "play", time.time(), None, []
    room.last_thief = time.time()
    roster = {q.id: [q.name, q.hue] for q in room.players.values()}
    broadcast(room, F({"t": "n", "r": room.round, "roster": roster, **maze_msg(room)}))
    for p in room.players.values():
        reset_player(room, p)
        p.send(pos_msg(p, True))


def end_round(room, now):
    room.phase, room.next_at = "over", now + INTERMISSION
    top = sorted(room.players.values(), key=lambda p: -p.score)[:5]
    broadcast(room, F({"t": "e", "res": [[n, round(t, 1), mo, sc] for n, t, mo, sc in room.fins[:10]],
                        "sc": [[p.name, p.score] for p in top if p.score > 0], "nx": INTERMISSION}))


def finish(room, p):
    now = time.time()
    el = now - room.t0
    rank = len(room.fins) + 1
    sc = score_of(p.money, el) + POINTS[min(rank, len(POINTS)) - 1] * 12
    p.fin = (rank, el)
    p.score = sc
    room.fins.append((p.name, el, p.money, sc))
    if room.first is None:
        room.first = now
    broadcast(room, F({"t": "f", "id": p.id, "n": p.name, "k": rank, "e": round(el, 1), "mo": p.money, "sc": sc}))


def on_move(p, d, seq):
    room = p.room
    now = time.monotonic()
    p.seq = seq
    p.tok = min(3.0, p.tok + (now - p.lm) / MOVE_INTERVAL)
    p.lm = now
    if room is None or room.phase != "play":
        p.send(pos_msg(p))
        return
    m = room.maze
    if p.fin is None and p.tok >= 1.0:
        nt = p.t + DIRS[d][0] + DIRS[d][1] * W
        if m.grid[nt] == 0:
            p.tok -= 1.0
            place_player(p, nt)
            for c in m.chests:
                if c["t"] == nt and c["id"] not in p.got:
                    p.got.add(c["id"])
                    p.money += c["v"]
                    p.send(F({"t": "chest", "id": c["id"], "v": c["v"]}))
            for th in m.thieves:
                if th["t"] == nt and p.money > 0:
                    loss = max(1, round(p.money * random.uniform(STEAL_MIN, STEAL_MAX)))
                    p.money -= loss
                    back = m.spawn[random.randrange(len(m.spawn))] if random.random() < 0.15 else nt
                    place_player(p, back)
                    p.send(pos_msg(p, True))
                    p.send(F({"t": "thief", "loss": loss}))
                    return
            if nt == m.goal:
                finish(room, p)
            p.send(pos_msg(p))
            return
    p.send(pos_msg(p))


def step_thieves(room):
    m = room.maze
    for th in m.thieves:
        opts = [th["t"] + d[0] + d[1] * W for d in DIRS]
        opts = [o for o in opts if m.grid[o] == 0]
        if opts:
            th["t"] = random.choice(opts)
    broadcast(room, F({"t": "th", "l": [[th["id"], th["t"]] for th in m.thieves]}))


def broadcast_near(room):
    """Only the leading few runners (by gold / finish) are ever shown on the map."""
    ps = list(room.players.values())
    top = sorted(ps, key=lambda p: (0, p.fin[1]) if p.fin else (1, -p.money))[:TOP_VISIBLE]
    lst_all = [[p.id, p.x, p.y] for p in top]
    for p in ps:
        others = [q for q in lst_all if q[0] != p.id]
        if others != p.last_o:
            p.last_o = others
            p.send(F({"t": "o", "l": others}))


def send_meta(room, now):
    ps = sorted(room.players.values(), key=lambda p: (0, p.fin[1]) if p.fin else (1, -p.money))
    top = [[p.name, p.money, 1 if p.fin else 0] for p in ps[:8]]
    if room.phase == "play":
        tl = max(0, int(ROUND_MAX - (now - room.t0)))
        gl = max(0, int(FINISH_GRACE - (now - room.first))) if room.first else -1
    else:
        tl, gl = 0, -1
    for i, p in enumerate(ps):
        p.send(F({"t": "m", "n": len(ps), "tl": tl, "gl": gl, "lb": top, "rk": i + 1, "money": p.money}))


async def game_loop():
    last_meta = 0.0
    while True:
        await asyncio.sleep(TICK)
        now = time.time()
        for code in list(ROOMS.keys()):
            room = ROOMS.get(code)
            if room is None:
                continue
            if not room.players:
                if room.empty_since is None:
                    room.empty_since = now
                elif now - room.empty_since >= ROOM_IDLE_TTL:
                    ROOMS.pop(code, None)
                continue
            room.empty_since = None
            if room.phase == "lobby":
                if now >= room.start_at:
                    start_round(room)
                else:
                    broadcast(room, lobby_msg(room))
            elif room.phase == "play":
                if now - room.last_thief >= THIEF_INTERVAL:
                    room.last_thief = now
                    step_thieves(room)
                if (room.first and now - room.first >= FINISH_GRACE) or now - room.t0 >= ROUND_MAX:
                    end_round(room, now)
            elif room.phase == "over" and now >= room.next_at:
                start_round(room)
            if room.phase != "lobby":
                broadcast_near(room)
        if now - last_meta >= 1:
            last_meta = now
            for room in ROOMS.values():
                if room.players and room.phase != "lobby":
                    send_meta(room, now)


# ------------------------------------------------------------------ networking
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
    p.fin = None
    p.got = set()
    p.last_o = None
    return p


def create_room(p, delay):
    delay = max(MIN_DELAY, min(MAX_DELAY, int(delay or MIN_DELAY)))
    code = gen_code()
    room = Room(code, time.time() + delay)
    ROOMS[code] = room
    join_room(p, room)
    return room


def join_room(p, room):
    p.room = room
    room.players[p.id] = p
    if room.phase == "lobby":
        p.x = p.y = p.t = 0
        p.send(F({"t": "w", "id": p.id, "hue": p.hue, "roster": {}, "ph": "lobby", "r": room.round,
                   "code": room.code,
                   "cfg": {"W": W, "H": H, "mi": int(MOVE_INTERVAL * 1000), "roundMax": ROUND_MAX}}))
        broadcast(room, lobby_msg(room))
    else:
        reset_player(room, p)
        roster = {q.id: [q.name, q.hue] for q in room.players.values()}
        p.send(F({"t": "w", "id": p.id, "hue": p.hue, "roster": roster, "ph": room.phase, "r": room.round,
                   "code": room.code,
                   "cfg": {"W": W, "H": H, "mi": int(MOVE_INTERVAL * 1000), "roundMax": ROUND_MAX}}))
        p.send(F({"t": "n", "r": room.round, **maze_msg(room)}))
        p.send(pos_msg(p, True))
        broadcast(room, F({"t": "j", "id": p.id, "n": p.name, "h": p.hue}), skip=p)


def leave_room(p):
    room = p.room
    if room is None:
        return
    if room.players.pop(p.id, None):
        if room.phase == "lobby":
            broadcast(room, lobby_msg(room))
        else:
            broadcast(room, F({"t": "l", "id": p.id}))
    p.room = None


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
    p = None
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
            if p is None:
                if t != "hi":
                    continue
                p = new_player(w, m.get("name"))
                mode, code = m.get("mode"), str(m.get("code") or "").strip().upper()
                if mode == "join":
                    room = ROOMS.get(code)
                    if room is None or len(room.players) >= MAX_PLAYERS_PER_ROOM:
                        p.send(F({"t": "err", "msg": "That tournament code was not found."}))
                        p = None
                        continue
                    join_room(p, room)
                else:
                    create_room(p, m.get("delay"))
                continue
            if t == "m":
                d, s = m.get("d"), m.get("s")
                if type(d) is int and 0 <= d < 4 and type(s) is int:
                    on_move(p, d, s)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, OSError):
        pass
    finally:
        if p:
            leave_room(p)
        w.close()


async def handle(r, w):
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    except Exception:
        w.close()
        return
    if headers.get("upgrade", "").lower() == "websocket":
        await ws_session(r, w, headers)
        return
    try:
        if path.split("?")[0] in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
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
    print("LABYRINTH running  ->  http://%s:%d   (local: http://localhost:%d)" % (lan_ip(), PORT, PORT))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
