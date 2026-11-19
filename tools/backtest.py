"""Backtest score.js's estimated SOR and poll rank against ESPN's weekly history.

    python3 tools/backtest.py [cache-dir]

Fetches each week's power index (FPI, and SOR as "accomplishment"), finished FBS games, and the
AP and CFP polls for 2024 to now, caching the replies in cache-dir (default .backtest-cache, kept
out of git). Prints how close the settings below, which mirror SOR and POLL in score.js, come.
"""
import json, os, sys, time, urllib.request
from statistics import NormalDist

C = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
S = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
SEASONS = {"2024": range(1, 16), "2025": range(1, 16), "2026": range(1, 13)}
SOR = {"top25": 18, "hfa": 3.5, "sd": 15, "fcs": -25}
POLL = {"loss": 6, "badLoss": 4, "bigWin": 1, "sorAP": 0.05, "sorCFP": 0.15, "pool": 30}
CACHE = sys.argv[1] if len(sys.argv) > 1 else ".backtest-cache"
cdf = NormalDist().cdf


def get(url):
    f = os.path.join(CACHE, url.split("college-football/")[1].replace("/", "_").replace("?", "_")[:200] + ".json")
    if os.path.exists(f):
        return json.load(open(f))
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))
    except Exception:
        return None
    json.dump(d, open(f, "w"))
    time.sleep(0.2)
    return d


def collect():
    os.makedirs(CACHE, exist_ok=True)
    H = {}
    for season, weeks in SEASONS.items():
        for w in weeks:
            pi = {}
            for it in (get(f"{C}/seasons/{season}/types/2/weeks/{w}/powerindex?limit=300") or {}).get("items", []):
                p = {x["name"]: x.get("value") for x in it["predictives"]}
                pi[it["team"]["$ref"].split("/teams/")[1].split("?")[0]] = p
            games = []
            for e in (get(f"{S}/scoreboard?dates={season}&seasontype=2&week={w}&groups=80&limit=300") or {}).get("events", []):
                c = e["competitions"][0]
                if not c["status"]["type"]["completed"]:
                    continue
                h, a = (next(x for x in c["competitors"] if x["homeAway"] == k) for k in ("home", "away"))
                games.append({"home": h["team"]["id"], "away": a["team"]["id"], "hs": int(h["score"]), "as": int(a["score"]), "neutral": c.get("neutralSite", False)})
            polls = {}
            for rid, kind in (("1", "ap"), ("21", "cfp")):
                r = get(f"{C}/seasons/{season}/types/2/weeks/{w}/rankings/{rid}")
                if r and r.get("ranks"):
                    polls[kind] = {x["team"]["$ref"].split("teams/")[1].split("?")[0]: x["current"] for x in r["ranks"]}
            H[(season, w)] = {"pi": pi, "games": games, "polls": polls}
    return H


def at_least(ps, k):
    dist = [1.0]
    for p in ps:
        nd = [0.0] * (len(dist) + 1)
        for i, q in enumerate(dist):
            nd[i] += q * (1 - p)
            nd[i + 1] += q * p
        dist = nd
    return sum(dist[k:])


def ranks(vals):
    return {t: i + 1 for i, t in enumerate(sorted(vals, key=lambda t: (vals[t], t)))}


def sor_ranks(H, season, upto, fpi):
    """Estimated SOR ranks from games through week upto, with each opponent rated by fpi."""
    rec = {t: ([], 0) for t in fpi}
    for w in range(1, upto + 1):
        for g in H[(season, w)]["games"]:
            s = 0 if g["neutral"] else 1
            for t, o, site, won in ((g["home"], g["away"], s, g["hs"] > g["as"]), (g["away"], g["home"], -s, g["as"] > g["hs"])):
                if t in rec:
                    rec[t][0].append(cdf((SOR["top25"] - fpi.get(o, SOR["fcs"]) + SOR["hfa"] * site) / SOR["sd"]))
                    rec[t] = (rec[t][0], rec[t][1] + won)
    return ranks({t: at_least(ps, w) for t, (ps, w) in rec.items()})


def main():
    H = collect()
    fpi = lambda s, w: {t: p["fpi"] for t, p in H[(s, w)]["pi"].items() if p.get("fpi") is not None}
    mean = lambda xs: sum(xs) / len(xs)
    # SOR level: FPI of the same week, ESPN's Top 25.
    lvl = []
    for s, weeks in SEASONS.items():
        for w in weeks[2:]:
            est = sor_ranks(H, s, w, fpi(s, w))
            lvl += [abs(est[t] - p["accomplishmentrank"]) for t, p in H[(s, w)]["pi"].items() if p.get("accomplishmentrank") and p["accomplishmentrank"] <= 25 and t in est]
    print(f"SOR rank, ESPN's Top 25: off by {mean(lvl):.2f} places on average; exact {sum(x == 0 for x in lvl) / len(lvl):.0%}")
    # SOR move over a week, using only the FPI known before it (what the page has at the final).
    mv = []
    for s, weeks in SEASONS.items():
        for w in weeks[3:]:
            f0 = fpi(s, w - 1)
            b, a = sor_ranks(H, s, w - 1, f0), sor_ranks(H, s, w, f0)
            for t, p in H[(s, w)]["pi"].items():
                p0 = H[(s, w - 1)]["pi"].get(t, {}).get("accomplishmentrank")
                if p0 and p0 <= 30 and p.get("accomplishmentrank") and t in a:
                    mv.append((p["accomplishmentrank"] - p0, a[t] - b[t]))
    moved = [m for m in mv if m[0]]
    print(f"SOR weekly move, ESPN's Top 30: off by {mean([abs(x - y) for x, y in mv]):.2f} places (ESPN moved {mean([abs(x) for x, _ in mv]):.2f}); "
          f"direction right {mean([(x > 0) == (y > 0) for x, y in moved]):.0%}")
    # Poll: last poll plus the week's results.
    for kind in ("ap", "cfp"):
        err, dirs = [], []
        a = POLL["sorCFP"] if kind == "cfp" else POLL["sorAP"]
        for s, weeks in SEASONS.items():
            for w in weeks[1:-1]:
                r0, r1 = H[(s, w)]["polls"].get(kind), H.get((s, w + 1), {}).get("polls", {}).get(kind)
                if not r0 or not r1:
                    continue
                sr = sor_ranks(H, s, w, fpi(s, w - 1))
                key = {t: (1 - a) * r0.get(t, 26 + (sr[t] - 1) * 0.3) + a * sr[t] for t in sr if t in r0 or sr[t] <= POLL["pool"]}
                for g in H[(s, w)]["games"]:
                    wn, l = (g["home"], g["away"]) if g["hs"] > g["as"] else (g["away"], g["home"])
                    if l in key:
                        key[l] += POLL["loss"] + (0 if wn in r0 else POLL["badLoss"])
                    if wn in key and l in r0:
                        key[wn] -= POLL["bigWin"]
                est = ranks(key)
                for t in r0:
                    act, e = min(r1.get(t, 26), 26), min(est.get(t, 26), 26)
                    err.append(abs(act - e))
                    if act != r0[t]:
                        dirs.append((act > r0[t]) == (e > r0[t]) and e != r0[t])
        if err:
            print(f"{kind.upper()} rank a week on: off by {mean(err):.2f} places; direction right {mean(dirs):.0%}")


if __name__ == "__main__":
    main()
