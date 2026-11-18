#!/usr/bin/env python3
"""Builds a data.json-shaped fixture offline from files already downloaded:
Title Paths' page-data.json for each league (full seasons for the Power 4 and Pac-12 teams,
ESPN odds, CFP rankings, FPI, exact conference odds) plus one ESPN FBS scoreboard week for the
games no league page covers. No network calls.

Usage: tools/fixture_from_titlepaths.py <dir with big12.json sec.json ...> <scoreboard.json> <week> > fixture.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fetch  # noqa: E402

src, sb_path, week = sys.argv[1], sys.argv[2], int(sys.argv[3])
pages = {lg: json.load(open(os.path.join(src, f"{lg}.json"))) for lg in fetch.TP_LEAGUES}

teams, games = {}, {}
for lg, d in pages.items():
    conf = fetch.TP_LEAGUES[lg][1]
    for t in d["teams"]:
        teams[t["id"]] = {"id": t["id"], "abbr": t["abbr"], "name": t["name"], "short": t["short"],
                          "school": t["short"], "color": t["color"], "alt": t["alt"],
                          "logo": f"https://a.espncdn.com/i/teamlogos/ncaa/500/{t['id']}.png",
                          "logoDark": f"https://a.espncdn.com/i/teamlogos/ncaa/500-dark/{t['id']}.png",
                          "conf": conf}
    for g in d.get("games") or []:
        games[g["id"]] = {"id": g["id"], "week": g["week"], "date": g["date"], "home": g["home"], "away": g["away"],
                          "neutral": g.get("neutral", False), "conf": bool(g.get("confFlag", g.get("conf"))),
                          "done": g["completed"], "canceled": g.get("canceled", False), "winner": g.get("winner"),
                          "homeScore": g.get("homeScore"), "awayScore": g.get("awayScore"),
                          "timeValid": g.get("timeValid", True), "tv": g.get("tv"), "spread": g.get("spread"),
                          "status": None, "note": None, "pHome": g.get("pHome")}

# Opponents outside the five leagues, and week-13 games between them, from the scoreboard.
sb = json.load(open(sb_path))
for e in sb["events"]:
    c = e["competitions"][0]
    comp = {x["homeAway"]: x for x in c["competitors"]}
    h, a = comp["home"], comp["away"]
    if "TBD" in (h["team"].get("abbreviation"), a["team"].get("abbreviation")):
        continue
    for x in (h, a):
        t = x["team"]
        teams.setdefault(t["id"], {"id": t["id"], "abbr": t["abbreviation"], "name": t["displayName"],
                                   "short": t.get("shortDisplayName"), "school": t.get("location"),
                                   "color": fetch.hexcolor(t.get("color"), "666666"),
                                   "alt": fetch.hexcolor(t.get("alternateColor"), "999999"),
                                   "logo": t.get("logo"), "logoDark": t.get("logoDark"), "conf": t.get("conferenceId")})
    if e["id"] not in games:
        odds = (c.get("odds") or [{}])[0] or {}
        games[e["id"]] = {"id": e["id"], "week": 13, "date": e["date"], "home": h["team"]["id"], "away": a["team"]["id"],
                          "neutral": bool(c.get("neutralSite")), "conf": bool(c.get("conferenceCompetition")),
                          "done": False, "canceled": False, "winner": None, "homeScore": None, "awayScore": None,
                          "timeValid": c.get("timeValid", True) is not False, "tv": c.get("broadcast"),
                          "spread": odds.get("details"), "status": None, "note": None, "pHome": None}
# Opponents only Title Paths knows by id (FCS and G6 teams in early-season games).
for g in games.values():
    for tid in (g["home"], g["away"]):
        teams.setdefault(tid, {"id": tid, "abbr": None, "name": None, "short": None, "school": None,
                               "color": "#666666", "alt": "#999999", "logo": None, "logoDark": None, "conf": None})

first = pages["big12"]
fpi = {}
for d in pages.values():
    fpi.update(d.get("fpi") or {})
ranks = (first.get("cfp") or {}).get("ranks") or {}
games_l = sorted(games.values(), key=lambda g: (g["date"], g["id"]))
rec = fetch.records(games_l)
for tid, t in teams.items():
    t["record"] = rec.get(tid, [0, 0, 0, 0])
    t["fpi"] = fpi.get(tid)
    t["rank"] = ranks.get(tid)
    t["pickable"] = bool(fetch.CONFS.get(t["conf"] or "", ("", False))[1]) or tid == fetch.NOTRE_DAME

conf_odds = {}
for lg, d in pages.items():
    ex = d.get("exact") or {}
    if not ex.get("teams"):
        continue
    conf = fetch.TP_LEAGUES[lg][1]
    tt, gg = {}, {}
    for t in ex["teams"]:
        tt[t["id"]] = {"p": t.get("p"), "first": t.get("first"), "clinched": bool(t.get("clinched")),
                       "eliminated": bool(t.get("eliminated"))}
        for gid, x in zip(ex["gameIds"], t.get("games") or []):
            gg.setdefault(gid, {})[t["id"]] = [x.get("pH"), x.get("pA")]
    conf_odds[conf] = {"league": lg, "name": fetch.CONFS[conf][0], "url": fetch.TITLE_PATHS + fetch.TP_LEAGUES[lg][0],
                       "computedAt": ex.get("computedAt"), "teams": tt, "games": gg}

json.dump({
    "schema": 1, "season": first["season"], "week": week, "weeks": list(range(1, week + 2)), "lastWeek": 13,
    "fetchedAt": first["fetchedAt"], "espnCalls": 0, "calendar": first["calendar"],
    "confs": {k: {"name": v[0], "p4": v[1]} for k, v in fetch.CONFS.items()},
    "poll": {"poll": "CFP" if ranks else None, "date": (first.get("cfp") or {}).get("date")},
    "teams": sorted(teams.values(), key=lambda t: t["name"] or ""),
    "games": games_l, "confOdds": conf_odds, "fixture": True,
}, sys.stdout, separators=(",", ":"))
