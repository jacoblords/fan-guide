#!/usr/bin/env python3
"""Builds data.json for the fan guide: every FBS game this season, ESPN's win odds for this
week's and next week's games, the latest rankings and FPI, and Title Paths' conference-race
odds (how each remaining conference game moves every team's title-game odds).

Visitors never call ESPN; this runs on a schedule and the page reads the file it writes.
Usage: python3 fetch.py [--out data.json] [--season 2026] [--now 2026-11-18T12:00Z]
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
TITLE_PATHS = "https://titlepaths.com/"
UA = "fan-guide (scheduled fetch; a few dozen calls per run)"

# ESPN conference ids. "p4" teams (plus Notre Dame) are the ones a fan can pick as their team.
CONFS = {
    "1": ("ACC", True), "4": ("Big 12", True), "5": ("Big Ten", True), "8": ("SEC", True),
    "9": ("Pac-12", False), "151": ("American", False), "12": ("Conference USA", False),
    "15": ("MAC", False), "17": ("Mountain West", False), "37": ("Sun Belt", False),
    "18": ("FBS Independents", False),
}
NOTRE_DAME = "87"
# Title Paths' leagues: page-data path and the ESPN conference id it covers.
TP_LEAGUES = {"big12": ("", "4"), "sec": ("sec/", "8"), "acc": ("acc/", "1"),
              "big10": ("big10/", "5"), "pac12": ("pac12/", "9")}

calls = 0


def get(url):
    """Polite GET: identifies itself, retries 429/5xx with backoff."""
    global calls
    for attempt in range(4):
        calls += 1
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 2 ** attempt * 5
        except urllib.error.URLError:
            if attempt == 3:
                raise
            wait = 2 ** attempt * 5
        time.sleep(wait)


def pmap(fn, items, workers=4):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%MZ")


def parse(s):
    s = s.replace("Z", "+00:00")
    if len(s) == 22:  # 2026-11-14T17:00+00:00
        s = s[:16] + ":00" + s[16:]
    return dt.datetime.fromisoformat(s)


def hexcolor(v, default):
    v = (v or "").strip().lstrip("#")
    ok = 3 <= len(v) <= 8 and all(c in "0123456789abcdefABCDEF" for c in v)
    return "#" + (v if ok else default)


def fetch_calendar(season):
    d = get(f"{SITE}/scoreboard?groups=80&seasontype=2&week=1&dates={season}&limit=1")
    reg = [c for c in d["leagues"][0]["calendar"] if str(c.get("value")) == "2"][0]
    return [{"week": int(e["value"]), "start": e["startDate"], "end": e["endDate"]} for e in reg["entries"]]


def current_week(calendar, now):
    for c in calendar:
        if parse(c["start"]) <= now <= parse(c["end"]):
            return c["week"]
    future = [c["week"] for c in calendar if parse(c["start"]) > now]
    return future[0] if future else calendar[-1]["week"]


def fetch_week(season, week, teams):
    """Every game with an FBS team that week. Fills `teams` with what the scoreboard says about
    each team (name, colors, logo, conference, poll rank)."""
    d = get(f"{SITE}/scoreboard?groups=80&seasontype=2&week={week}&dates={season}&limit=300")
    out = []
    for e in d.get("events", []):
        c = e["competitions"][0]
        notes = " ".join(n.get("headline", "") for n in c.get("notes") or [])
        if (c.get("type") or {}).get("type") == "conference-championship" or "Championship" in notes:
            continue
        comp = {x["homeAway"]: x for x in c["competitors"]}
        h, a = comp.get("home"), comp.get("away")
        if not h or not a or not h["team"].get("conferenceId") and not a["team"].get("conferenceId"):
            continue  # TBD placeholders (e.g. Pac-12 flex games not yet paired)
        if h["team"].get("abbreviation") == "TBD" or a["team"].get("abbreviation") == "TBD":
            continue
        for x in (h, a):
            t = x["team"]
            teams.setdefault(t["id"], {
                "id": t["id"], "abbr": t.get("abbreviation"), "name": t.get("displayName"),
                "short": t.get("shortDisplayName") or t.get("location"), "school": t.get("location"),
                "color": hexcolor(t.get("color"), "666666"), "alt": hexcolor(t.get("alternateColor"), "999999"),
                "logo": t.get("logo"), "logoDark": t.get("logoDark") or t.get("logo"),
                "conf": t.get("conferenceId"),
            })
        stype = c["status"]["type"]
        done = bool(stype.get("completed"))
        canceled = stype.get("name") in ("STATUS_CANCELED", "STATUS_FORFEIT") and not done
        winner = None
        if done:
            winner = h["team"]["id"] if h.get("winner") else a["team"]["id"] if a.get("winner") else None
        state = stype.get("state")  # "pre", "in" or "post"
        sc = lambda x: int(float(x["score"])) if (done or state == "in") and x.get("score") not in (None, "") else None
        odds = (c.get("odds") or [{}])[0] or {}
        tv = c.get("broadcast") or ", ".join(dict.fromkeys(
            n for b in c.get("broadcasts") or [] for n in b.get("names") or []))
        out.append({
            "id": e["id"], "week": week, "date": e["date"],
            "home": h["team"]["id"], "away": a["team"]["id"],
            "neutral": bool(c.get("neutralSite")), "conf": bool(c.get("conferenceCompetition")),
            "done": done or canceled, "canceled": canceled, "winner": winner,
            "homeScore": sc(h), "awayScore": sc(a),
            "timeValid": c.get("timeValid", True) is not False,
            "tv": tv or None, "spread": odds.get("details") or None,
            "status": stype.get("shortDetail") if state == "in" else None,
            "state": state, "period": c["status"].get("period") if state == "in" else None,
            "clock": c["status"].get("displayClock") if state == "in" else None,
            "note": notes or None,
        })
    return out


def fetch_prediction(gid):
    try:
        p = get(f"{CORE}/events/{gid}/competitions/{gid}/predictor")
        stats = {s["name"]: s.get("value") for s in p["homeTeam"]["statistics"]}
        v = stats.get("gameProjection")
        return gid, (round(v / 100.0, 4) if v is not None else None)
    except Exception as e:  # noqa: BLE001 - one missing prediction shouldn't stop the run
        print(f"  prediction {gid} unavailable: {e}", file=sys.stderr)
        return gid, None


def fetch_fpi(season):
    pi = get(f"{CORE}/seasons/{season}/powerindex?limit=300")
    fpi = {}
    for it in pi["items"]:
        tid = it["team"]["$ref"].split("/teams/")[1].split("?")[0]
        v = next((p.get("value") for p in it["predictives"] if p["name"] == "fpi"), None)
        if v is not None:
            fpi[tid] = round(v, 2)
    return fpi


def fetch_rankings(season):
    """The CFP committee's latest Top 25 if it has started, else the AP poll."""
    d = get(f"{SITE}/rankings?season={season}")
    by = {r.get("type"): r for r in d.get("rankings") or []}
    for kind, label in (("cfp", "CFP"), ("ap", "AP")):
        r = by.get(kind)
        if r and r.get("ranks"):
            return {"poll": label, "date": r.get("date"),
                    "ranks": {x["team"]["id"]: int(x["current"]) for x in r["ranks"]
                              if str(x.get("current", "")).isdigit()}}
    return {"poll": None, "date": None, "ranks": {}}


def fetch_title_paths():
    """Title Paths' exact conference odds, by ESPN conference id:
    {"teams": {id: {"p": title-game odds, "first": odds of finishing first, "clinched", "eliminated"}},
     "games": {game id: {team id: [odds if home wins, odds if away wins]}}}"""
    out = {}
    for league, (path, conf) in TP_LEAGUES.items():
        try:
            d = get(f"{TITLE_PATHS}{path}page-data.json")
        except Exception as e:  # noqa: BLE001 - one league down shouldn't stop the run
            print(f"  title paths {league} unavailable: {e}", file=sys.stderr)
            continue
        ex = d.get("exact") or {}
        if not ex.get("teams"):
            continue
        r4 = lambda v: round(v, 4) if isinstance(v, (int, float)) else None
        teams, games = {}, {}
        for t in ex["teams"]:
            teams[t["id"]] = {"p": r4(t.get("p")), "first": r4(t.get("first")),
                              "clinched": bool(t.get("clinched")), "eliminated": bool(t.get("eliminated"))}
            for gid, g in zip(ex["gameIds"], t.get("games") or []):
                games.setdefault(gid, {})[t["id"]] = [r4(g.get("pH")), r4(g.get("pA"))]
        out[conf] = {"league": league, "name": CONFS[conf][0], "url": f"{TITLE_PATHS}{path}",
                     "computedAt": ex.get("computedAt"), "teams": teams, "games": games}
    return out


def records(games):
    rec = {}
    for g in games:
        if not g["done"] or g["canceled"] or not g["winner"]:
            continue
        for tid in (g["home"], g["away"]):
            r = rec.setdefault(tid, [0, 0, 0, 0])  # wins, losses, conf wins, conf losses
            won = g["winner"] == tid
            r[0 if won else 1] += 1
            if g["conf"]:
                r[2 if won else 3] += 1
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data.json")
    ap.add_argument("--season", type=int)
    ap.add_argument("--now", help="pretend it is this UTC time (testing)")
    args = ap.parse_args()
    now = parse(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    season = args.season or (now.year if now.month >= 3 else now.year - 1)

    calendar = fetch_calendar(season)
    week = current_week(calendar, now)
    last = max(c["week"] for c in calendar)
    teams = {}
    weeks = list(range(1, min(week + 1, last) + 1))
    games = [g for gs in pmap(lambda w: fetch_week(season, w, teams), weeks) for g in gs]

    # ESPN's win odds for the unplayed games of this week and next.
    upcoming = [g for g in games if g["week"] >= week and not g["done"]]
    preds = dict(pmap(fetch_prediction, [g["id"] for g in upcoming]))
    for g in games:
        g["pHome"] = preds.get(g["id"])

    fpi = fetch_fpi(season)
    rankings = fetch_rankings(season)
    conf_odds = fetch_title_paths()

    rec = records(games)
    for tid, t in teams.items():
        t["record"] = rec.get(tid, [0, 0, 0, 0])
        t["fpi"] = fpi.get(tid)
        t["rank"] = rankings["ranks"].get(tid)
        t["pickable"] = bool(CONFS.get(t["conf"] or "", ("", False))[1]) or tid == NOTRE_DAME

    data = {
        "schema": 1, "season": season, "week": week, "weeks": weeks, "lastWeek": last,
        "fetchedAt": iso(now), "espnCalls": calls,
        "calendar": calendar,
        "confs": {k: {"name": v[0], "p4": v[1]} for k, v in CONFS.items()},
        "poll": {k: v for k, v in rankings.items() if k != "ranks"},
        "teams": sorted(teams.values(), key=lambda t: t["name"] or ""),
        "games": sorted(games, key=lambda g: (g["date"], g["id"])),
        "confOdds": conf_odds,
    }
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"week {week}: {len(games)} games, {len(teams)} teams, {len(conf_odds)} conference races, "
          f"{calls} calls -> {args.out}")


if __name__ == "__main__":
    main()
