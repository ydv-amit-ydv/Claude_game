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

Gold you are carrying is at risk: when two figures meet, whoever carries LESS
takes a cut from whoever carries MORE, and passersby play by the same rule.
Gold you have left at the idol is safe for good, and counts in full, while
gold still in your hands counts only half. So the loop is: gather, run it
back to the idol, and set out again.

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
INTERMISSION = int(os.environ.get("GARDEN_INTERMISSION", 20))
MIN_DELAY, MAX_DELAY = int(os.environ.get("GARDEN_MIN_DELAY", 10)), 3600
RESUME_GRACE = 150        # seconds a dropped phone has to come back
PRACTICE_SECONDS = 90     # a practice run is short on purpose
ROOM_IDLE_TTL = 240
MAX_ROOMS = 200

STAGE_NAMES = [lv["name"] for lv in worldgen.LEVELS]
STAGE_CAPS = [300, 50, 10]
STAGE_SECONDS = [int(v) for v in os.environ.get("GARDEN_STAGE_SECONDS", "180,180,240").split(",")]
REVEAL_FROM_STAGE = 1     # names stay hidden in the opening heat, shown from the semi-final on

# ---- talk
EMOTES = ["\U0001F44B", "\U0001F602", "\U0001F631", "\U0001F4B0", "\U0001F3C3", "\U0001F64F"]
EMOTE_COOLDOWN = 1.2
CHAT_COOLDOWN = 2.5
CHAT_MAX = 120
FEED_KEEP = 40

CHEST_RESPAWN = 22.0      # seconds between fresh chests appearing
BONUS_PER_ARRIVAL = 3     # rich chests released each time someone reaches the idol
BONUS_MIN, BONUS_MAX = 18, 40

LOOT_FRAC = 0.28
LOOT_COOLDOWN = 3.0

# ---- sanctuary
# Nobody may be robbed on the idol's doorstep. Measured in walking steps from
# the idol rather than as the crow flies, so a hedge between you and the idol
# means you are not there yet.
SANCTUARY_STEPS = 4
# ...and nobody may rob anyone while loitering on the approach. A runner who
# has banked everything carries nothing, and the purse rule would otherwise
# make them the guaranteed winner of every encounter with someone arriving
# heavy. Hanging about near the idol instead of running for it disarms you.
LURK_STEPS = 12           # the band around the idol that counts as the approach
LURK_SECONDS = 12.0       # how long you may linger in it before you cannot take
LURK_DECAY = 2.5          # how fast that clears once you leave or deliver
BOAT_COOLDOWN = 6.0

GOLD_POINTS = 10
UNBANKED_SHARE = 0.5      # gold is worth half until you have reached the idol
PROGRESS_POINTS = 500
FINISH_BONUS = 200

VIEW_RADIUS = 16
VIEW_MAX = 24
HERE = os.path.dirname(os.path.abspath(__file__))
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")


# ------------------------------------------------------------------ figures
class Passerby:
    """Someone else on the road.

    Not all of them are the same. A WANDERER drifts. A PILGRIM is walking
    somewhere in particular and mostly keeps to its heading. A CUTPURSE
    steers toward whoever is nearest, and a SHY one steers away. You cannot
    tell which is which by looking, which is the point.
    """
    WANDER, PILGRIM, CUTPURSE, SHY = 0, 1, 2, 3

    __slots__ = ("id", "t", "money", "loot_cd", "face", "kind", "aim")

    def __init__(self, pid, t, money, kind=0):
        self.id, self.t, self.money = pid, t, money
        self.loot_cd = 0.0
        self.face = 0
        self.kind = kind
        self.aim = None        # a tile a pilgrim is heading for


class Player:
    __slots__ = ("id", "name", "w", "room", "x", "y", "t", "seq", "tok", "lm", "face",
                 "money", "banked", "trips", "score", "fin", "got", "best", "last_o",
                 "loot_cd", "boat_cd", "em_cd", "chat_cd", "key", "gone", "lurk")

    def send(self, frame):
        if self.w is None:
            return                  # restored from a snapshot, not yet reconnected
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
        self.last_chest = 0.0
        self.empty_since = None
        self.history = []
        self.feed = []
        self.champion = None
        self.next_npc = -1
        self.next_chest = 0
        self.seed = 0
        self.practice = False


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
            "reveal": 1 if room.stage >= REVEAL_FROM_STAGE else 0}


def world_msg(room):
    wd = room.world
    return {"W": wd.w, "H": wd.h, "g": wd.as_string(), "goal": wd.goal,
            "level": room.stage,
            "chests": [[c["id"], c["t"], c["v"]] for c in wd.chests],
            "docks": [[a, b] for (a, b) in wd.docks],
            "shrines": wd.shrines}


# ------------------------------------------------------------------ scoring
def rank_key(p):
    """How runners are ordered, and how ties at the cut are settled.

    With 300 runners a tie on score at the 50th place is likely, so the
    order falls through to what the tournament actually rewards: gold
    banked at the idol, then how close they got, then who got there
    first. Only if all of that matches does it come down to join order,
    which at least is stable rather than arbitrary.
    """
    return (-score_of(p), -p.banked, -p.best, -p.trips, p.id)


def score_of(p):
    """Gold left at the idol is safe and counts in full. Gold still being
    carried is only worth half, and can still be taken off you."""
    s = round(p.banked * GOLD_POINTS)
    s += round(p.money * GOLD_POINTS * UNBANKED_SHARE)
    s += round(p.best * PROGRESS_POINTS)
    if p.fin:
        s += FINISH_BONUS
    return s


def pos_msg(p, force=False, boat=False):
    wd = p.room.world if p.room else None
    m = {"t": "p", "x": p.x, "y": p.y, "s": p.seq, "money": p.money, "face": p.face,
         "left": wd.dist[p.t] if wd else 0, "prog": round(p.best * 100),
         "bank": p.banked, "sc": score_of(p)}
    if wd is not None:
        if in_sanctuary(wd, p):
            m["safe"] = 1                      # standing where nobody may rob you
        if p.lurk >= LURK_SECONDS:
            m["lurk"] = 1                      # waiting here has disarmed you
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
    p.banked = 0
    p.trips = 0
    p.fin = False
    p.tok = 1.0
    p.face = 2
    p.lm = time.monotonic()
    p.last_o = None
    p.loot_cd = 0.0
    p.boat_cd = 0.0
    p.em_cd = 0.0
    p.chat_cd = 0.0
    p.lurk = 0.0
    p.best = room.world.progress(p.t)
    p.score = 0


# ------------------------------------------------------------------ looting
def in_sanctuary(wd, e):
    """True when this figure stands on the idol's doorstep."""
    if wd is None:
        return False
    d = wd.dist[e.t]
    return 0 <= d <= SANCTUARY_STEPS


def do_loot(a, b, wd=None):
    """The lighter purse takes a cut from the heavier one - with two limits.

    Nobody is robbed inside the sanctuary, and nobody who has been loitering
    on the approach may do the robbing. Between them these close the hole
    where the cunning play was to bank everything, stand by the idol carrying
    nothing, and take a cut off every runner who arrived heavy.
    """
    now = time.monotonic()
    if now < a.loot_cd or now < b.loot_cd or a.money == b.money:
        return None
    if in_sanctuary(wd, a) or in_sanctuary(wd, b):
        return "sanctuary"
    rich, poor = (a, b) if a.money > b.money else (b, a)
    if getattr(poor, "lurk", 0) >= LURK_SECONDS:
        return "lurking"
    amount = max(1, round(rich.money * LOOT_FRAC))
    rich.money -= amount
    poor.money += amount
    rich.loot_cd = poor.loot_cd = now + LOOT_COOLDOWN
    return rich, poor, amount


def note_loot(entity, delta, from_player):
    if isinstance(entity, Player):
        entity.send(F({"t": "loot", "d": delta, "who": 1 if from_player else 0,
                       "money": entity.money}))


def note_blocked(entity, why):
    """Tell a runner why an encounter cost them nothing."""
    if isinstance(entity, Player):
        entity.send(F({"t": "safe", "why": why}))


def spawn_chests(room, count, bonus=False):
    """Put fresh chests into the world and tell everyone where they landed."""
    wd = room.world
    if wd is None or len(wd.chests) > len(wd.floors) // 18:
        return []
    taken = {c["t"] for c in wd.chests}
    for p in room.players.values():
        taken.add(p.t)
    spots = [t for t in wd.floors if wd.g[t] == worldgen.GROUND and t not in taken and wd.dist[t] > 4]
    if not spots:
        return []
    made = []
    for _ in range(count):
        t = random.choice(spots)
        cid = room.next_chest
        room.next_chest += 1
        v = random.randint(BONUS_MIN, BONUS_MAX) if bonus else random.randint(5, 20)
        wd.chests.append({"id": cid, "t": t, "v": v})
        made.append([cid, t, v, 1 if bonus else 0])
        taken.add(t)
    if made:
        broadcast(room, F({"t": "chestAdd", "l": made}))
        if room.admins:
            broadcast_admins(room, F({"t": "adminChests",
                                      "l": [[c["id"], c["t"], c["v"]] for c in wd.chests]}))
    return made


# ------------------------------------------------------------------ stages
def start_stage(room, seed=None):
    room.feed = []
    room.seed = random.getrandbits(48) if seed is None else seed
    room.world = worldgen.World(room.stage, room.seed)
    room.phase = "play"
    room.t0 = time.time()
    room.ends_at = room.t0 + (PRACTICE_SECONDS if room.practice else STAGE_SECONDS[room.stage])
    room.last_walk = room.t0
    room.last_chest = room.t0

    room.next_chest = len(room.world.chests)
    room.passersby = []
    for _ in range(room.world.n_passersby):
        # a road full of identical random walkers reads as scenery; a mix of
        # errands reads as a place where other people have business
        kind = random.choices(
            [Passerby.WANDER, Passerby.PILGRIM, Passerby.CUTPURSE, Passerby.SHY],
            weights=[34, 30, 22, 14])[0]
        room.passersby.append(Passerby(room.next_npc, random.choice(room.world.floors),
                                       random.randint(0, 40), kind))
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
    # this is the sort that decides who goes through, so it is the tied one
    ranked = sorted(room.players.values(), key=rank_key)
    room.history.append({"stage": room.stage, "name": STAGE_NAMES[room.stage],
                         "top": [[p.name, p.score, p.banked + p.money, round(p.best * 100)]
                                 for p in ranked[:10]]})

    if room.practice:
        room.phase = "done"
        for p in ranked:
            p.send(F({"t": "tourEnd", "champion": p.name, "practice": 1,
                      "score": p.score, "money": p.banked + p.money,
                      "prog": round(p.best * 100), "history": room.history}))
        return

    nxt = room.stage + 1
    if nxt < len(STAGE_CAPS) and len(ranked) > 1:
        cut = STAGE_CAPS[nxt]
        # a phone that never came back does not hold a place in the next round
        present = [p for p in ranked if p.gone is None]
        absent = [p for p in ranked if p.gone is not None]
        ranked = present + absent
        qualifiers, out = ranked[:cut], ranked[cut:]
        for i, p in enumerate(out):
            p.send(F({"t": "eliminated", "rank": cut + i + 1, "score": p.score,
                      "money": p.banked + p.money, "bank": p.banked,
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
                           "top": [[p.name, p.score, p.banked + p.money] for p in ranked[:10]]}))
    broadcast_admins(room, F({"t": "adminStage", "stage": stage_info(room), "phase": room.phase,
                              "history": room.history, "champion": room.champion}))


# ------------------------------------------------------------------ talk
def near_players(room, x, y, radius=VIEW_RADIUS):
    for q in room.players.values():
        if abs(q.x - x) <= radius and abs(q.y - y) <= radius:
            yield q


def who(room, p):
    """A runner's public name: anonymous until the semi-final."""
    return p.name if room.stage >= REVEAL_FROM_STAGE else "someone"


def feed(room, text):
    """A line for the match ticker - everyone sees it, nobody is named early."""
    room.feed.append(text)
    del room.feed[:-FEED_KEEP]
    broadcast(room, F({"t": "feed", "x": text}))
    broadcast_admins(room, F({"t": "adminFeed", "x": text}))


def on_emote(p, idx):
    room = p.room
    now = time.monotonic()
    if room is None or room.phase != "play" or now < p.em_cd:
        return
    p.em_cd = now + EMOTE_COOLDOWN
    msg = F({"t": "em", "id": p.id, "e": idx})
    for q in near_players(room, p.x, p.y):
        q.send(msg)


def on_say(p, text):
    """Open talk is for the final, where everyone already has a name."""
    room = p.room
    now = time.monotonic()
    if room is None or room.stage < len(STAGE_NAMES) - 1:
        p.send(F({"t": "sayErr", "msg": "Open talk opens in the final."}))
        return
    if now < p.chat_cd:
        return
    text = " ".join(str(text).split())[:CHAT_MAX]
    if not text:
        return
    p.chat_cd = now + CHAT_COOLDOWN
    broadcast(room, F({"t": "say", "n": p.name, "x": text}))
    broadcast_admins(room, F({"t": "adminSay", "n": p.name, "x": text}))


def admin_control(adm, what, arg):
    """The levers the organiser needs when a room of 300 is watching."""
    room = adm.room
    if room is None:
        return
    now = time.time()
    if what == "start" and room.phase == "lobby" and room.players:
        room.start_at = now
        feed(room, "The organiser started the level")
    elif what == "extend":
        secs = max(-300, min(300, int(arg or 60)))
        if room.phase == "play":
            room.ends_at += secs
            broadcast(room, F({"t": "ann",
                               "x": ("%+d seconds on the clock" % secs)}))
        elif room.phase == "lobby":
            room.start_at = max(now, room.start_at + secs)
    elif what == "end" and room.phase == "play":
        room.ends_at = now                      # the tick ends the stage cleanly
    elif what == "kick":
        p = room.players.get(int(arg or 0))
        if p:
            p.send(F({"t": "err", "msg": "The organiser removed you from this tournament."}))
            room.players.pop(p.id, None)
            p.room = None
            if not p.w.transport.is_closing():
                p.w.transport.close()
    adm.send(F({"t": "adminStage", "stage": stage_info(room), "phase": room.phase,
                "startIn": max(0, round(room.start_at - now)),
                "tl": max(0, int(room.ends_at - now)) if room.phase == "play" else 0}))


def on_announce(adm, text):
    """The admin speaks to the whole tournament - a banner on every phone."""
    room = adm.room
    if room is None:
        return
    text = " ".join(str(text).split())[:CHAT_MAX]
    if not text:
        return
    broadcast(room, F({"t": "ann", "x": text}))
    broadcast_admins(room, F({"t": "adminSay", "n": "Organiser", "x": text}))


# ------------------------------------------------------------------ movement
def on_move(p, d, seq):
    room = p.room
    now = time.monotonic()
    p.seq = seq
    p.tok = min(3.0, p.tok + (now - p.lm) / MOVE_INTERVAL)
    p.lm = now
    if room is None or room.phase != "play" or p.tok < 1.0:
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
        if q is not p and q.gone is None and q.t == nt:
            r = do_loot(p, q, wd)
            if isinstance(r, str):
                note_blocked(p, r); note_blocked(q, r)
            elif r:
                note_loot(r[0], -r[2], True)
                note_loot(r[1], r[2], True)
                if r[2] >= 10:
                    feed(room, "%s took %d gold from %s" %
                         (who(room, r[1]), r[2], who(room, r[0])))
            met = True
            break
    if not met:
        for npc in room.passersby:
            if npc.t == nt:
                r = do_loot(p, npc, wd)
                if isinstance(r, str):
                    note_blocked(p, r)
                elif r:
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

    if nt == wd.goal:
        first = not p.fin
        dropped = p.money
        p.banked += dropped               # safe from here on: nobody can take it
        p.money = 0
        p.fin = True
        p.best = 1.0
        p.trips += 1
        p.lurk = 0.0                      # you came to deliver, not to wait
        if dropped or first:
            # the idol thanks each delivery by scattering rich chests for everyone
            spawn_chests(room, BONUS_PER_ARRIVAL if first else 1, bonus=True)
            p.send(F({"t": "banked", "added": dropped, "bank": p.banked, "trips": p.trips}))
            if dropped:
                feed(room, "%s laid %d gold at the idol" % (who(room, p), dropped))
        if first:
            broadcast(room, F({"t": "reached", "id": p.id}))
            feed(room, "%s reached the idol" % who(room, p))
    p.send(pos_msg(p))


def walk_passersby(room):
    wd = room.world
    here = [(p.x, p.y, p) for p in room.players.values() if p.gone is None]
    for npc in room.passersby:
        opts = []
        for d, (dx, dy) in enumerate(DIRS):
            nt = npc.t + dx + dy * wd.w
            if 0 <= nt < wd.w * wd.h and wd.g[nt] in WALKABLE:
                opts.append((d, nt))
        if not opts:
            continue

        nx, ny = npc.t % wd.w, npc.t // wd.w
        near = None
        if npc.kind in (Passerby.CUTPURSE, Passerby.SHY) and here:
            near = min(here, key=lambda e: abs(e[0] - nx) + abs(e[1] - ny))
            if abs(near[0] - nx) + abs(near[1] - ny) > 9:
                near = None

        if near is not None:
            # steer toward whoever is closest, or directly away from them
            want = 1 if npc.kind == Passerby.CUTPURSE else -1
            def toward(o):
                ox, oy = o[1] % wd.w, o[1] // wd.w
                return want * (abs(near[0] - ox) + abs(near[1] - oy))
            d, nt = min(opts, key=toward) if random.random() < .8 else random.choice(opts)
        elif npc.kind == Passerby.PILGRIM:
            # keep going the way you were going, and pick a new heading rarely
            ahead = [o for o in opts if o[0] == npc.face]
            d, nt = ahead[0] if (ahead and random.random() < .88) else random.choice(opts)
        else:
            ahead = [o for o in opts if o[0] == npc.face]
            d, nt = ahead[0] if (ahead and random.random() < 0.65) else random.choice(opts)
        npc.face, npc.t = d, nt
        for p in room.players.values():
            if p.gone is None and p.t == nt:
                r = do_loot(p, npc, wd)
                if isinstance(r, str):
                    note_blocked(p, r)
                elif r:
                    note_loot(r[0], -r[2], False)
                    note_loot(r[1], r[2], False)
                break


# ------------------------------------------------------------------ fan-out
def tick_lurk(room, dt):
    """Time spent hanging about the idol instead of running for it.

    Only used to decide whether someone may take gold. It climbs while you
    are inside the approach band and falls faster once you leave, so passing
    through - even slowly - never disarms you, but waiting does.
    """
    wd = room.world
    if wd is None:
        return
    for p in room.players.values():
        if p.gone is not None:
            continue
        d = wd.dist[p.t]
        if 0 <= d <= LURK_STEPS:
            p.lurk = min(LURK_SECONDS * 2, p.lurk + dt)
        elif p.lurk > 0:
            p.lurk = max(0.0, p.lurk - dt * LURK_DECAY)


def broadcast_near(room):
    """Runners see only figures close by, and cannot tell who is who."""
    wd = room.world
    ps = [q for q in room.players.values() if q.gone is None]   # away phones are not drawn
    # from the semi-final on, a rival close enough to see is close enough to name
    reveal = room.stage >= REVEAL_FROM_STAGE
    buckets = {}
    for e in ps:
        buckets.setdefault((e.x >> 3, e.y >> 3), []).append(
            (e.id, e.x, e.y, e.name if reveal else ""))
    for npc in room.passersby:
        x, y = npc.t % wd.w, npc.t // wd.w
        buckets.setdefault((x >> 3, y >> 3), []).append((npc.id, x, y, ""))

    span = (VIEW_RADIUS >> 3) + 1
    for p in ps:
        bx, by = p.x >> 3, p.y >> 3
        near = []
        for i in range(bx - span, bx + span + 1):
            for j in range(by - span, by + span + 1):
                for (eid, ex, ey, enm) in buckets.get((i, j), ()):
                    if eid != p.id and abs(ex - p.x) <= VIEW_RADIUS and abs(ey - p.y) <= VIEW_RADIUS:
                        near.append([eid, ex, ey, enm])
                        if len(near) >= VIEW_MAX:
                            break
        if near != p.last_o:
            p.last_o = near
            p.send(F({"t": "o", "l": near}))

    # the admin sees the real runners only - never the wandering passersby
    if room.admins:
        broadcast_admins(room, F({"t": "adminPos",
                                  "p": [[e.id, e.name, e.x, e.y, e.banked + e.money,
                                         1 if e.fin else 0, score_of(e)] for e in ps]}))


def send_meta(room, now):
    reveal = room.stage >= REVEAL_FROM_STAGE
    ps = sorted(room.players.values(), key=rank_key)
    top = [[p.name if reveal else "Runner", score_of(p), p.banked + p.money, round(p.best * 100)]
           for p in ps[:8]]
    left = max(0, int(room.ends_at - now))
    wd = room.world
    for i, p in enumerate(ps):
        m = {"t": "m", "n": len(ps), "tl": left, "lb": top, "rk": i + 1,
             "sc": score_of(p), "money": p.money, "prog": round(p.best * 100)}
        if wd is not None:
            # a runner standing still still needs to know where they stand, so
            # the sanctuary and lurk flags ride the once-a-second update too
            if in_sanctuary(wd, p):
                m["safe"] = 1
            if p.lurk >= LURK_SECONDS:
                m["lurk"] = 1
            elif p.lurk > LURK_SECONDS * 0.6:
                m["lurkSoon"] = 1
        p.send(F(m))
    if room.admins:
        broadcast_admins(room, F({"t": "adminMeta", "n": len(ps), "tl": left,
                                  "lb": [[p.name, score_of(p), p.banked + p.money,
                                          round(p.best * 100)] for p in ps[:20]]}))


def lobby_msg(room):
    return F({"t": "lobby", "code": room.code, "startIn": max(0, round(room.start_at - time.time())),
              "stage": stage_info(room), "n": len(room.players)})


async def game_loop():
    last_meta = 0.0
    last_snap = 0.0
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
                sweep_gone(room, time.monotonic())
                tick_lurk(room, TICK)
                if now - room.last_walk >= PASSERBY_INTERVAL:
                    room.last_walk = now
                    walk_passersby(room)
                if now - room.last_chest >= CHEST_RESPAWN:
                    room.last_chest = now
                    spawn_chests(room, 2 + len(room.players) // 40)
                if now >= room.ends_at:
                    end_stage(room, now)
                else:
                    broadcast_near(room)

        if now - last_meta >= 1:
            last_meta = now
            for room in ROOMS.values():
                if room.phase == "play" and room.players:
                    send_meta(room, now)

        if now - last_snap >= SNAP_EVERY:
            last_snap = now
            save_snapshot()



# ------------------------------------------------------------------ snapshots
# A tournament lives in memory, so a crash or a restart would normally throw
# away a room of 300 people mid-match. Every few seconds the essentials go to
# disk: the room's clock, the seed its world was grown from, and each
# runner's purse and position. On boot they come back marked as away, which
# is exactly the state a dropped phone is in - so everyone simply reconnects
# with the key their browser already holds, and carries on.
SNAP_PATH = os.environ.get("GARDEN_SNAPSHOT", os.path.join(HERE, "garden-state.json"))
SNAP_EVERY = 5.0
SNAP_MAX_AGE = 900          # a snapshot older than this is stale; ignore it


def snapshot():
    rooms = []
    for room in ROOMS.values():
        if room.phase == "done" or not room.players:
            continue
        rooms.append({
            "code": room.code, "stage": room.stage, "phase": room.phase,
            "seed": room.seed, "start_at": room.start_at, "ends_at": room.ends_at,
            "history": room.history, "champion": room.champion, "feed": room.feed[-12:],
            "players": [{
                "key": p.key, "name": p.name, "t": p.t, "money": p.money,
                "banked": p.banked, "trips": p.trips, "fin": p.fin, "best": p.best,
                "got": sorted(p.got), "face": p.face,
            } for p in room.players.values()],
        })
    return {"at": time.time(), "rooms": rooms}


def save_snapshot():
    try:
        tmp = SNAP_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snapshot(), f)
        os.replace(tmp, SNAP_PATH)     # atomic, so a crash never leaves a half file
    except Exception:
        pass


def load_snapshot():
    """Rebuild whatever was running when we stopped."""
    global NEXT_ID
    try:
        with open(SNAP_PATH) as f:
            snap = json.load(f)
    except Exception:
        return 0
    if time.time() - snap.get("at", 0) > SNAP_MAX_AGE:
        return 0
    n = 0
    for rs in snap.get("rooms", []):
        try:
            room = Room(rs["code"], rs["start_at"])
            room.stage = rs["stage"]
            room.phase = rs["phase"]
            room.seed = rs["seed"]
            room.ends_at = rs["ends_at"]
            room.history = rs.get("history", [])
            room.champion = rs.get("champion")
            room.feed = rs.get("feed", [])
            if room.phase == "play":
                room.world = worldgen.World(room.stage, room.seed)
                room.t0 = time.time()
                room.last_walk = room.last_chest = time.time()
                room.next_chest = len(room.world.chests)
                for _ in range(room.world.n_passersby):
                    kind = random.choices([0, 1, 2, 3], weights=[34, 30, 22, 14])[0]
                    room.passersby.append(Passerby(room.next_npc,
                                                   random.choice(room.world.floors),
                                                   random.randint(0, 40), kind))
                    room.next_npc -= 1
            for ps in rs.get("players", []):
                p = Player()
                p.id, NEXT_ID = NEXT_ID, NEXT_ID + 1
                p.w = None
                p.room = room
                p.name = ps["name"]
                p.key = ps["key"]
                p.seq = 0
                p.money, p.banked, p.trips = ps["money"], ps["banked"], ps["trips"]
                p.fin, p.best = ps["fin"], ps["best"]
                p.got = set(ps.get("got", []))
                p.face = ps.get("face", 2)
                p.score = 0
                p.tok, p.lm = 1.0, time.monotonic()
                p.loot_cd = p.boat_cd = p.em_cd = p.chat_cd = p.lurk = 0.0
                p.last_o = None
                p.gone = time.monotonic()      # everyone is away until they reconnect
                if room.world:
                    place(p, ps["t"], room.world)
                else:
                    p.x = p.y = p.t = 0
                room.players[p.id] = p
            if room.players:
                ROOMS[room.code] = room
                n += 1
        except Exception:
            continue
    return n


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
    p.banked = 0
    p.trips = 0
    p.fin = False
    p.best = 0.0
    p.face = 2
    p.got = set()
    p.last_o = None
    p.tok = 1.0
    p.lm = time.monotonic()
    p.loot_cd = 0.0
    p.boat_cd = 0.0
    p.em_cd = 0.0
    p.chat_cd = 0.0
    p.lurk = 0.0
    # the key a dropped phone comes back with
    p.key = base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")
    p.gone = None
    return p


def cfg_msg():
    return {"mi": int(MOVE_INTERVAL * 1000), "view": VIEW_RADIUS, "emotes": EMOTES,
            "revealFrom": REVEAL_FROM_STAGE, "sanct": SANCTUARY_STEPS,
            "lurkSteps": LURK_STEPS, "lurkSecs": LURK_SECONDS,
            "stages": [{"name": STAGE_NAMES[i], "cap": STAGE_CAPS[i], "secs": STAGE_SECONDS[i]}
                       for i in range(len(STAGE_NAMES))]}


def join_room(p, room):
    if room.practice:
        p.send(F({"t": "err", "msg": "That code belongs to a practice run."}))
        return False
    if room.stage != 0 or room.phase == "done":
        p.send(F({"t": "err", "msg": "This tournament has already moved past the first level."}))
        return False
    if len(room.players) >= STAGE_CAPS[0]:
        p.send(F({"t": "err", "msg": "This tournament is full (300 runners)."}))
        return False
    p.room = room
    room.players[p.id] = p
    p.send(F({"t": "w", "id": p.id, "code": room.code, "ph": room.phase, "key": p.key,
              "stage": stage_info(room), "cfg": cfg_msg()}))
    if room.phase == "lobby":
        broadcast(room, lobby_msg(room))
    else:
        reset_player(room, p)
        p.send(F({"t": "n", "stage": stage_info(room),
                  "secs": max(1, int(room.ends_at - time.time())), **world_msg(room)}))
        p.send(pos_msg(p, True))
    return True


def create_practice(p):
    """A room of one, starting at once.

    Nobody learns the purse rule from a lobby screen, and a fest is a poor
    place to learn it for the first time. Practice is the real game - the
    same world, the same chests, the same passersby - just alone, short,
    and with nothing riding on it.
    """
    if len(ROOMS) >= MAX_ROOMS:
        p.send(F({"t": "err", "msg": "Too many tournaments running right now."}))
        return None
    room = Room(gen_code(), time.time() + 2)
    room.practice = True
    ROOMS[room.code] = room
    p.room = room
    room.players[p.id] = p
    p.send(F({"t": "w", "id": p.id, "code": room.code, "ph": room.phase, "key": p.key,
              "stage": stage_info(room), "cfg": cfg_msg(), "practice": 1}))
    broadcast(room, lobby_msg(room))
    return room


def create_room(p, delay):
    if len(ROOMS) >= MAX_ROOMS:
        p.send(F({"t": "err", "msg": "Too many tournaments running right now."}))
        return None
    delay = max(MIN_DELAY, min(MAX_DELAY, int(delay or MIN_DELAY)))
    room = Room(gen_code(), time.time() + delay)
    ROOMS[room.code] = room
    join_room(p, room)
    return room


def drop_socket(p, w):
    """A phone went away.

    Mid-round we keep the runner - their gold, their place, their score -
    and simply stop showing them, because on fest wifi a dropped socket is
    usually a pocket or a lock screen, not somebody leaving. They have
    RESUME_GRACE seconds to come back to exactly where they were. In the
    lobby there is nothing to preserve, so they just leave.
    """
    room = p.room
    if p.w is not w:
        return                      # a newer socket already took this runner over
    if room is None:
        return
    if room.phase == "lobby":
        room.players.pop(p.id, None)
        p.room = None
        broadcast(room, lobby_msg(room))
        return
    p.gone = time.monotonic()
    p.last_o = None


def resume_player(w, code, key):
    """Bring a dropped runner back to exactly where they left off."""
    room = ROOMS.get(str(code or "").strip().upper())
    if room is None:
        w.write(F({"t": "err", "msg": "That tournament is no longer running."}))
        return None
    for p in room.players.values():
        if p.key == key:
            old = p.w
            p.w = w
            p.gone = None
            p.last_o = None
            p.lm = time.monotonic()
            p.tok = 1.0
            if old is not None and old is not w and not old.transport.is_closing():
                old.transport.close()     # the stale socket goes
            p.send(F({"t": "w", "id": p.id, "code": room.code, "ph": room.phase, "key": p.key,
                      "stage": stage_info(room), "cfg": cfg_msg(), "resumed": 1}))
            if room.phase == "play" and room.world:
                p.send(F({"t": "n", "stage": stage_info(room),
                          "secs": max(1, int(room.ends_at - time.time())), **world_msg(room)}))
                p.send(pos_msg(p, True))
                p.send(F({"t": "banked", "added": 0, "bank": p.banked, "trips": p.trips}))
                for line in room.feed[-6:]:
                    p.send(F({"t": "feed", "x": line}))
            else:
                p.send(lobby_msg(room))
            return p
    w.write(F({"t": "err", "msg": "We could not find your place in that tournament."}))
    return None


def sweep_gone(room, now):
    """Runners who never came back are let go once their grace is up."""
    for p in [q for q in room.players.values() if q.gone and now - q.gone > RESUME_GRACE]:
        room.players.pop(p.id, None)
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
                    elif m.get("mode") == "practice":
                        if create_practice(p) is None:
                            p = None
                    elif create_room(p, m.get("delay")) is None:
                        p = None
                elif t == "resume":
                    p = resume_player(w, m.get("code"), str(m.get("key") or ""))
                elif t == "admin":
                    adm = join_admin(w, str(m.get("code") or "").strip().upper())
                continue
            if p and t == "m":
                d, s = m.get("d"), m.get("s")
                if type(d) is int and 0 <= d < 4 and type(s) is int:
                    on_move(p, d, s)
            elif p and t == "em":
                e = m.get("e")
                if type(e) is int and 0 <= e < len(EMOTES):
                    on_emote(p, e)
            elif p and t == "say":
                on_say(p, m.get("x"))
            elif adm and t == "ann":
                on_announce(adm, m.get("x"))
            elif adm and t == "ctl":
                admin_control(adm, str(m.get("k") or ""), m.get("v"))
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, OSError):
        pass
    finally:
        if p:
            drop_socket(p, w)
        if adm and adm.room:
            adm.room.admins.discard(adm)
        w.close()


PAGES = {"/": "index.html", "/index.html": "index.html", "/admin": "admin.html",
         "/painted.js": "painted.js",
         "/atlas.js": "atlas.js",
         "/qr.js": "qr.js",
         "/board": "board.html"}
TYPES = {".html": b"text/html; charset=utf-8", ".js": b"application/javascript; charset=utf-8"}


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
                body, status = f.read(), b"200 OK"
            ctype = TYPES[".js" if fname.endswith(".js") else ".html"]
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
    restored = load_snapshot()
    server = await asyncio.start_server(handle, HOST, PORT, backlog=2048)
    asyncio.create_task(game_loop())
    ip = lan_ip()
    print("THE LAST GARDEN   ->  http://%s:%d   (local: http://localhost:%d)" % (ip, PORT, PORT))
    print("Admin aerial view ->  http://%s:%d/admin" % (ip, PORT))
    print("Big screen        ->  http://%s:%d/board?code=CODE" % (ip, PORT))
    if restored:
        print("Restored %d tournament(s) from the last snapshot - runners can reconnect."
              % restored)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
