#!/usr/bin/env python3
"""Builds data.json for the fan guide: every FBS game this season, ESPN's win odds for this
week's and next week's games, the latest rankings and FPI, and Title Paths' conference-race
odds (how each remaining conference game moves every team's title-game odds).

Visitors never call ESPN; this runs on a schedule and the page reads the file it writes.
Usage: python3 fetch.py [--out data.json] [--season 2026] [--now 2026-11-18T12:00Z]
"""
import argparse
import bisect
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
TITLE_PATHS = "https://titlepaths.com/"
UA = "fan-guide (github actions; hourly-ish)"

# ESPN conference ids, with whether each is Power 4 (it weighs how much a league's results
# against other leagues reflect on yours).
CONFS = {
    "1": ("ACC", True), "4": ("Big 12", True), "5": ("Big Ten", True), "8": ("SEC", True),
    "9": ("Pac-12", False), "151": ("American", False), "12": ("Conference USA", False),
    "15": ("MAC", False), "17": ("Mountain West", False), "37": ("Sun Belt", False),
    "18": ("FBS Independents", False),
}
NOTRE_DAME = "87"
# The leagues whose fans can pick their team: the Power 4, plus the Pac-12, which Title Paths
# covers too. And Notre Dame.
PICKABLE = {"1", "4", "5", "8", "9"}


def pickable(t):
    return (t.get("conf") or "") in PICKABLE or t["id"] == NOTRE_DAME
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


WP_POINTS = 120  # win-probability points kept per game: plenty for a 300px chart


def play_seconds(play):
    """Game time at a play, in seconds from kickoff: 15-minute quarters; overtime (no clock in
    college) gets two minutes a period after regulation. Same as Title Paths' fetch_data.py."""
    period = ((play.get("period") or {}).get("number")) or 1
    if period > 4:
        return 3600 + (period - 4) * 120
    m, _, sec = ((play.get("clock") or {}).get("displayValue") or "15:00").partition(":")
    try:
        left = int(m) * 60 + int(sec or 0)
    except ValueError:
        left = 900
    return (period - 1) * 900 + max(0, 900 - left)


def in_order(pts):
    """The points on the longest run of plays whose game time never goes back: ESPN files a play
    out of place now and then, and its odds belong to some other moment. Same as Title Paths'."""
    tails, ends, prev = [], [], []
    for i, (t, _) in enumerate(pts):
        k = bisect.bisect_right(tails, t)
        prev.append(ends[k - 1] if k else -1)
        if k == len(tails):
            tails.append(t); ends.append(i)
        else:
            tails[k], ends[k] = t, i
    keep, i = [], ends[-1] if ends else -1
    while i >= 0:
        keep.append(i); i = prev[i]
    return [pts[i] for i in reversed(keep)]


def fetch_winprob(gid):
    """ESPN's in-game win probability for one game: up to WP_POINTS [seconds from kickoff, home
    win odds in thousandths] points, plus whether ESPN calls the game over."""
    try:
        d = get(f"{SITE}/summary?event={gid}")
    except Exception as e:  # noqa: BLE001 - one game's chart shouldn't stop the run
        print(f"  win probability {gid} unavailable: {e}", file=sys.stderr)
        return gid, None
    drives = d.get("drives") or {}
    plays = {}
    for dr in (drives.get("previous") or []) + ([drives["current"]] if drives.get("current") else []):
        for pl in dr.get("plays") or []:
            plays[pl.get("id")] = pl
    pts = []
    for w in d.get("winprobability") or []:
        pl = plays.get(w.get("playId"))
        if pl is None or w.get("homeWinPercentage") is None:
            continue
        pts.append([play_seconds(pl), round(w["homeWinPercentage"] * 1000)])
    pts = in_order(pts)
    if len(pts) > WP_POINTS:
        keep = sorted({round(k * (len(pts) - 1) / (WP_POINTS - 1)) for k in range(WP_POINTS)})
        pts = [pts[k] for k in keep]
    comp = ((d.get("header") or {}).get("competitions") or [{}])[0]
    stype = (comp.get("status") or {}).get("type") or {}
    return gid, {"pts": pts, "final": bool(stype.get("completed"))}


def fetch_fpi(season):
    """ESPN's power index: FPI, and the rank of its résumé measure ("accomplishment", which
    ESPN publishes as Strength of Record), by team id."""
    pi = get(f"{CORE}/seasons/{season}/powerindex?limit=300")
    fpi, sor = {}, {}
    for it in pi["items"]:
        tid = it["team"]["$ref"].split("/teams/")[1].split("?")[0]
        p = {x["name"]: x.get("value") for x in it["predictives"]}
        if p.get("fpi") is not None:
            fpi[tid] = round(p["fpi"], 2)
        if p.get("accomplishmentrank") is not None:
            sor[tid] = int(p["accomplishmentrank"])
    return fpi, sor


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


def get_or_none(url):
    """get(), but None for a release ESPN hasn't published (404)."""
    try:
        return get(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def tid_of(ref):
    return ref.split("/teams/")[1].split("?")[0]


POLLS = {"AP": 1, "CFP": 21}


def fetch_history(season, week, last, prev):
    """Every weekly release so far, so a finished game can show the real move it made:
      AP, CFP  [{week, date, ranks: {id: rank}}]: the Top 25 released before that week's games
      SOR      [{week, ranks: {id: [rank, games played]}}]: ESPN's snapshot after that week's
               games (it fills in as they're played; the page matches it by games played)
    Releases older than last week are taken from the previous run's data when it has them."""
    out = {}
    for kind, num in POLLS.items():
        keep = {r["week"]: r for r in prev.get(kind, []) if r["week"] < week - 1}
        def one(w):
            # Week 1's poll is the preseason one, which ESPN files under the preseason.
            d = get_or_none(f"{CORE}/seasons/{season}/types/{1 if w == 1 else 2}/weeks/{w}/rankings/{num}")
            if not d or not d.get("ranks"):
                return None
            return {"week": w, "date": d.get("date"),
                    "ranks": {tid_of(x["team"]["$ref"]): int(x["current"]) for x in d["ranks"]}}
        need = [w for w in range(1, min(week + 1, last + 1) + 1) if w not in keep]
        got = [r for r in pmap(one, need) if r]
        out[kind] = sorted([*keep.values(), *got], key=lambda r: r["week"])
    keep = {r["week"]: r for r in prev.get("SOR", []) if r["week"] < week - 1}
    def snap(w):
        d = get_or_none(f"{CORE}/seasons/{season}/types/2/weeks/{w}/powerindex?limit=300")
        ranks = {}
        for it in (d or {}).get("items") or []:
            p = {x["name"]: x.get("value") for x in it["predictives"]}
            if p.get("accomplishmentrank") is not None and p.get("numwins") is not None:
                ranks[tid_of(it["team"]["$ref"])] = [int(p["accomplishmentrank"]), int(p["numwins"] + (p.get("numlosses") or 0))]
        return {"week": w, "ranks": ranks} if ranks else None
    got = [r for r in pmap(snap, [w for w in range(1, week + 1) if w not in keep]) if r]
    out["SOR"] = sorted([*keep.values(), *got], key=lambda r: r["week"])
    return out


def fetch_title_paths():
    """Title Paths' conference odds, by ESPN conference id:
    {"teams": {id: {"p": title-game odds, "first": odds of finishing first, "clinched", "eliminated"}},
     "games": {game id: {team id: [odds if home wins, odds if away wins]}},
     "moved": {game id: {team id: [odds before, odds after]}} for finished games}
    A league with no odds published (its season is over) still carries its finished games' moves."""
    out = {}
    for league, (path, conf) in TP_LEAGUES.items():
        try:
            d = get(f"{TITLE_PATHS}{path}page-data.json")
        except Exception as e:  # noqa: BLE001 - one league down shouldn't stop the run
            print(f"  title paths {league} unavailable: {e}", file=sys.stderr)
            continue
        ex = d.get("exact") or {}
        r4 = lambda v: round(v, 4) if isinstance(v, (int, float)) else None
        teams, games = {}, {}
        for t in ex.get("teams") or []:
            teams[t["id"]] = {"p": r4(t.get("p")), "first": r4(t.get("first")),
                              "clinched": bool(t.get("clinched")), "eliminated": bool(t.get("eliminated"))}
            for gid, g in zip(ex.get("gameIds") or [], t.get("games") or []):
                games.setdefault(gid, {})[t["id"]] = [r4(g.get("pH")), r4(g.get("pA"))]
        # What each finished game did to every team's title-game odds, as Title Paths recorded
        # it when the game went final: {game id: {team id: [before, after]}}.
        moved = {}
        for g in d.get("games") or []:
            m = g.get("moved")
            if isinstance(m, dict):
                ok = {tid: [r4(v[0]), r4(v[1])] for tid, v in m.items()
                      if isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v)}
                if ok:
                    moved[g["id"]] = ok
        if not teams and not moved:
            continue
        out[conf] = {"league": league, "name": CONFS[conf][0], "url": f"{TITLE_PATHS}{path}",
                     "computedAt": ex.get("computedAt"), "teams": teams, "games": games, "moved": moved}
    return out


def live_url():
    """The live-scores worker the page polls during games (Title Paths' Cloudflare worker),
    from the LIVE_URL repository variable. Unset or malformed: none, and the page doesn't poll."""
    url = (os.environ.get("LIVE_URL") or "").strip().rstrip("/")
    return url if re.fullmatch(r"https://[a-z0-9][a-z0-9.-]*[a-z0-9](:\d+)?", url) else None


def live_ids(data):
    """live-ids.json for Title Paths' live-scores worker, which asks ESPN only about games some
    site lists: every FBS game this week and next that isn't over."""
    week = data["week"]
    return {"fbs": sorted({g["id"] for g in data["games"]
                           if week <= g["week"] <= week + 1 and not g["done"] and not g.get("canceled")
                           and re.fullmatch(r"\d{1,12}", str(g["id"]))})}


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
    ap.add_argument("--prev", help="the previously published data.json, to reuse finished games' charts")
    ap.add_argument("--live-ids-from", metavar="DATA", help="only write live-ids.json (to --out) from this data.json")
    args = ap.parse_args()
    if args.live_ids_from:
        with open(args.live_ids_from) as f:
            ids = live_ids(json.load(f))
        with open(args.out, "w") as f:
            json.dump(ids, f, separators=(",", ":"))
        print(f"{len(ids['fbs'])} live ids -> {args.out}")
        return
    now = parse(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    season = args.season or (now.year if now.month >= 3 else now.year - 1)

    calendar = fetch_calendar(season)
    week = current_week(calendar, now)
    last = max(c["week"] for c in calendar)
    teams = {}
    weeks = list(range(1, last + 1))  # the whole regular season, so the page can look ahead
    games = [g for gs in pmap(lambda w: fetch_week(season, w, teams), weeks) for g in gs]

    prev_games, prev_hist = {}, {}
    if args.prev:
        try:
            with open(args.prev) as f:
                prev = json.load(f)
            prev_games = {g["id"]: g for g in prev.get("games", [])}
            prev_hist = prev.get("history") or {}
        except (OSError, ValueError) as e:
            print(f"  previous data unreadable: {e}", file=sys.stderr)

    # ESPN's matchup predictor for this week and next, before kickoff; later weeks use FPI on the
    # page. Once a game starts, the pre-game odds and line it had are kept from the previous run,
    # so the page rates (and places) the game the same during and after it as before it.
    upcoming = [g for g in games if week <= g["week"] <= week + 1 and not g["done"] and g["state"] != "in"]
    preds = dict(pmap(fetch_prediction, [g["id"] for g in upcoming]))
    for g in games:
        prev = prev_games.get(g["id"]) or {}
        g["pHome"] = preds.get(g["id"]) if g["id"] in preds else prev.get("pHome")
        if not g.get("spread") and prev.get("spread"):
            g["spread"] = prev["spread"]  # ESPN drops the line at kickoff

    # Win-probability charts for this week's games under way or over. A finished game's chart is
    # taken from the previous run when it has one, so each is fetched once after the final.
    prev_wp = {gid: g["wp"] for gid, g in prev_games.items() if (g.get("wp") or {}).get("final")}
    started = [g for g in games if g["week"] == week and (g["state"] == "in" or g["done"]) and not g["canceled"]]
    need = [g["id"] for g in started if g["id"] not in prev_wp]
    wps = dict(pmap(fetch_winprob, need))
    for g in started:
        wp = prev_wp.get(g["id"]) or wps.get(g["id"])
        if wp and len(wp["pts"]) >= 2:
            g["wp"] = wp

    fpi, sor = fetch_fpi(season)
    rankings = fetch_rankings(season)
    conf_odds = fetch_title_paths()
    try:
        history = fetch_history(season, week, last, prev_hist)
    except Exception as e:  # the real moves are extra; the page falls back to its estimates
        print(f"  ranking history failed, keeping the last: {e}", file=sys.stderr)
        history = prev_hist

    rec = records(games)
    for tid, t in teams.items():
        t["record"] = rec.get(tid, [0, 0, 0, 0])
        t["fpi"] = fpi.get(tid)
        t["sor"] = sor.get(tid)
        t["rank"] = rankings["ranks"].get(tid)
        t["pickable"] = pickable(t)

    data = {
        "schema": 1, "season": season, "week": week, "weeks": weeks, "lastWeek": last,
        "fetchedAt": iso(now), "espnCalls": calls,
        "calendar": calendar,
        "confs": {k: {"name": v[0], "p4": v[1]} for k, v in CONFS.items()},
        "poll": {k: v for k, v in rankings.items() if k != "ranks"},
        "teams": sorted(teams.values(), key=lambda t: t["name"] or ""),
        "games": sorted(games, key=lambda g: (g["date"], g["id"])),
        "confOdds": conf_odds,
        "history": history,
        "liveUrl": live_url(),
    }
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"week {week}: {len(games)} games, {len(teams)} teams, {len(conf_odds)} conference races, "
          f"{calls} calls -> {args.out}")


if __name__ == "__main__":
    main()
