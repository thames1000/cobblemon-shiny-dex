#!/usr/bin/env python3
"""
Batch the vanilla /locate command over RCON → a JSON ShinyDex HQ loads as
BIT-EXACT structure positions. No server mod required — RCON is a stock
Minecraft server feature.

Enable RCON in server.properties (Multicraft: Files → Config, or edit directly):
    enable-rcon=true
    rcon.password=<choose-one>
    rcon.port=25575
…and make sure that port is reachable from where you run this (your PC if the
host exposes it, otherwise run this script on the host itself → --host 127.0.0.1).

Usage:
    # nearest of every overworld structure from spawn (fast: 1 /locate each):
    python3 locate.py --host SERVER_IP --port 25575 --password PW --center 0 0

    # just a few, from a point:
    python3 locate.py --host ... --password PW --center 3256 3320 --only ltsurge,rudi,brock

    # find ALL instances in an area (slower; grid sweep):
    python3 locate.py --host ... --password PW --center 0 0 --sweep 8000 1200

    # nether / end:
    python3 locate.py --host ... --password PW --dim nether

Output: structures-located-<dim>.json  →  load it in ShinyDex HQ → Seed Map → 📡 Load located.
"""
import argparse, json, os, re, socket, struct, sys

def recvn(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("RCON connection closed")
        buf += chunk
    return buf

def rcon_send(sock, req_id, typ, body):
    data = struct.pack("<ii", req_id, typ) + body.encode("utf-8") + b"\x00\x00"
    sock.sendall(struct.pack("<i", len(data)) + data)

def rcon_read(sock):
    (length,) = struct.unpack("<i", recvn(sock, 4))
    payload = recvn(sock, length)
    req_id, typ = struct.unpack("<ii", payload[:8])
    return req_id, typ, payload[8:-2].decode("utf-8", "replace")

def rcon_command(sock, cmd):
    rcon_send(sock, 2, 2, cmd)
    return rcon_read(sock)[2]

DIM_CMD = {"overworld": "minecraft:overworld", "nether": "minecraft:the_nether", "end": "minecraft:the_end"}
LOC_RE = re.compile(r"is at \[(-?\d+), ~?,? ?(-?\d+)\] \((\d+) blocks? away\)")

def locate(sock, sid, dim, x, z):
    cmd = f"execute in {DIM_CMD[dim]} positioned {x} 64 {z} run locate structure {sid}"
    m = LOC_RE.search(rcon_command(sock, cmd))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=25575)
    ap.add_argument("--password", required=True)
    ap.add_argument("--center", nargs=2, type=int, default=[0, 0], metavar=("X", "Z"))
    ap.add_argument("--dim", default="overworld", choices=["overworld", "nether", "end"])
    ap.add_argument("--only", default="", help="comma-separated structure ids (or short names) to limit to")
    ap.add_argument("--sweep", nargs=2, type=int, default=None, metavar=("RADIUS", "STEP"),
                    help="find ALL instances within RADIUS of center, probing every STEP blocks")
    ap.add_argument("--structures-file",
                    default=os.path.join(os.path.dirname(__file__), "..", "..", "js", "data", "worldgen", "structures.json"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    structs = [s for s in json.load(open(a.structures_file))
               if (s.get("dim") or "overworld") == a.dim and s.get("id")]
    if a.only:
        want = set(a.only.split(","))
        structs = [s for s in structs if s["id"] in want or s["id"].split("/")[-1] in want]
    cx, cz = a.center

    sock = socket.create_connection((a.host, a.port), timeout=60)
    rcon_send(sock, 7, 3, a.password)
    if rcon_read(sock)[0] == -1:
        print("RCON auth failed — check rcon.password / that RCON is enabled."); sys.exit(1)
    print(f"Connected. Locating {len(structs)} structure(s) in {a.dim} from ({cx},{cz})"
          + (f" — sweep r{a.sweep[0]} step{a.sweep[1]}" if a.sweep else "") + " …")

    located = {}
    for s in structs:
        sid = s["id"]
        try:
            if a.sweep:
                R, STEP = a.sweep
                found = {}
                for gx in range(cx - R, cx + R + 1, STEP):
                    for gz in range(cz - R, cz + R + 1, STEP):
                        r = locate(sock, sid, a.dim, gx, gz)
                        if r:
                            found[(r[0], r[1])] = True
                located[sid] = [[x, z] for (x, z) in found]
                print(f"  {sid}: {len(located[sid])} instance(s)")
            else:
                r = locate(sock, sid, a.dim, cx, cz)
                if r:
                    located[sid] = {"x": r[0], "z": r[1], "dist": r[2]}
                    print(f"  {sid}: ({r[0]}, {r[1]})  {r[2]} blk")
                else:
                    print(f"  {sid}: none found in range")
        except Exception as e:
            print(f"  {sid}: error {e}")
    sock.close()

    out = a.out or f"structures-located-{a.dim}.json"
    json.dump({"dimension": DIM_CMD[a.dim], "center": {"cx": cx, "cz": cz},
               "mode": "sweep" if a.sweep else "nearest", "located": located},
              open(out, "w"), indent=1)
    print(f"Wrote {out} — load it in ShinyDex HQ → Seed Map → 📡 Load located.")

if __name__ == "__main__":
    main()
