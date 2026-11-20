const test = require("node:test");
const assert = require("node:assert");
const S = require("../score.js");

// A tiny league: X (the fan's team), R (its rival), A and B, plus an outsider O from another conference.
function fixture(over = {}) {
  const team = (id, extra = {}) => ({ id, abbr: id, name: id, short: id, conf: "4", record: [6, 4, 4, 3], fpi: 10, rank: null, pickable: true, ...extra });
  const data = {
    season: 2026, week: 12,
    confs: { 4: { name: "Big 12", p4: true }, 8: { name: "SEC", p4: true } },
    teams: [team("X", { rank: 11 }), team("R", { rank: 6 }), team("A", { rank: 9 }), team("B"), team("O", { conf: "8" })],
    games: [
      // X beat B in week 3.
      { id: "g0", week: 3, date: "2026-09-12T19:00Z", home: "X", away: "B", conf: true, done: true, winner: "X", homeScore: 30, awayScore: 20 },
      { id: "g1", week: 12, date: "2026-11-21T19:00Z", home: "A", away: "B", conf: true, done: false, pHome: 0.6 },
      { id: "g2", week: 12, date: "2026-11-21T22:00Z", home: "R", away: "O", conf: false, done: false, pHome: 0.8 },
      { id: "g3", week: 12, date: "2026-11-22T01:00Z", home: "X", away: "A", conf: true, done: false, pHome: 0.5 },
    ],
    confOdds: {
      4: {
        name: "Big 12", url: "https://titlepaths.com/",
        teams: { X: { p: 0.4 }, R: { p: 0.9 }, A: { p: 0.5 }, B: { p: 0.01 } },
        // X's odds: 30% if A beats B, 55% if B wins.
        games: { g1: { X: [0.3, 0.55], R: [0.92, 0.88] }, g3: { X: [0.6, 0.1] } },
      },
    },
    ...over,
  };
  return S.index(data);
}
const fan = (ix, rivals = []) => ({ team: "X", rivals, rivalsOf: () => [] });

test("stars rise with the raw value and keep its sign", () => {
  const steps = S.STAR_STEPS.conf;
  assert.strictEqual(S.toStars(0, steps), 0);
  assert.ok(S.toStars(0.02, steps) > S.toStars(0.01, steps));
  assert.strictEqual(S.toStars(-1, steps), -5);
  assert.strictEqual(S.toStars(0.07, steps), 3);
});

test("conference signal roots for the result that helps your title odds", () => {
  const ix = fixture();
  const r = S.scoreGame(ix, fan(ix), ix.data.games[1]);
  const conf = r.signals.find((s) => s.key === "conf");
  assert.ok(conf.stars < 0, "B winning helps X, and B is the away team");
  assert.strictEqual(r.pick, "B");
  assert.match(conf.short, /B win is .* for your Big 12 title shot/);
  assert.match(conf.text, /30% if A wins, 55% if B wins/);
});

test("résumé signal wants a team you beat to win", () => {
  const ix = fixture();
  const r = S.scoreGame(ix, fan(ix), ix.data.games[1]);
  const res = r.signals.find((s) => s.key === "resume");
  assert.ok(res.stars < 0, "B is away; X beat B, so X wants B to win");
});

test("own game is pinned first and picks your team", () => {
  const ix = fixture();
  const { rows } = S.scoreWeek(ix, fan(ix), 12);
  assert.strictEqual(rows[0].game.id, "g3");
  assert.strictEqual(rows[0].pick, "X");
  assert.ok(rows[0].mine);
});

test("rivals signal roots against a rival", () => {
  const ix = fixture();
  const r = S.scoreGame(ix, fan(ix, ["R"]), ix.data.games[2]);
  assert.strictEqual(r.pick, "O");
  assert.ok(r.heart);
  assert.match(r.signals.find((s) => s.key === "rivals").short, /^A loss|^It'd|^They're/);
  assert.deepStrictEqual(r.rival, { id: "R", playing: true }, "rooting against R, who is playing");
});

test("two rivals playing each other: no pick from rivals, just a note", () => {
  const ix = fixture();
  const s = S.scoreGame(ix, fan(ix, ["A", "B"]), ix.data.games[1]).signals.find((x) => x.key === "rivals");
  assert.ok(s.both);
  assert.strictEqual(s.stars, 0);
});

test("own game carries no stars", () => {
  const ix = fixture();
  assert.strictEqual(S.scoreGame(ix, fan(ix), ix.data.games[3]).stars, null);
});

test("headline names the stakes and the teams to pull for", () => {
  const ix = fixture();
  const { rows } = S.scoreWeek(ix, fan(ix), 12);
  const h = S.headline(ix, fan(ix), 12, rows);
  assert.match(h.stake, /X is in the thick of the Big 12 race: 40%/);
  assert.match(h.pull, /^Beat A/);
});

test("live interest: an underdog leading late is flagged", () => {
  const ix = fixture();
  const g = { ...ix.data.games[1], state: "in", period: 4, homeScore: 10, awayScore: 17, pHome: 0.8 };
  const r = S.scoreGame(ix, fan(ix), g);
  const li = S.liveInterest(ix, r);
  assert.match(li.why, /Upset watch: B leads in the 4th/);
  assert.strictEqual(li.going, "yes");
});

test("a rival's title odds count in games it isn't playing", () => {
  const ix = fixture();
  const r = S.scoreGame(ix, fan(ix, ["R"]), ix.data.games[1]);
  const riv = r.signals.find((s) => s.key === "rivals");
  assert.ok(riv.stars < 0, "R is better off when A wins, so root for B");
});

test("conference reputation only counts non-conference games of your league", () => {
  const ix = fixture();
  const rep = S.scoreGame(ix, fan(ix), ix.data.games[2]).signals.find((s) => s.key === "rep");
  assert.ok(rep && rep.stars > 0 && rep.soft, "R is a Big 12 team at home against the SEC");
  assert.ok(!S.scoreGame(ix, fan(ix), ix.data.games[1]).signals.find((s) => s.key === "rep"));
});

test("ranking signal: a team ranked just above you losing helps", () => {
  const ix = fixture();
  // A is No. 9, X is No. 11: A losing to unranked B helps X.
  const rank = S.scoreGame(ix, fan(ix), ix.data.games[1]).signals.find((s) => s.key === "rank");
  assert.ok(rank.stars < 0);
});

test("conflicting strong signals are flagged", () => {
  const ix = fixture();
  // Make B a team X lost to... and still want A to lose: flip X's odds so conf wants A.
  ix.data.confOdds[4].games.g1.X = [0.6, 0.3];
  const r = S.scoreGame(ix, fan(ix), ix.data.games[1]);
  assert.ok(r.conflict);
});

test("finished games score whether your pick won", () => {
  const ix = fixture();
  const g = ix.data.games[1];
  Object.assign(g, { done: true, winner: "B", homeScore: 10, awayScore: 20 });
  const r = S.scoreGame(ix, fan(ix), g);
  assert.strictEqual(r.result, "won");
});

test("live odds: a tie at kickoff keeps the line; a late deficit sinks the favorite", () => {
  const ix = fixture();
  const g = (o) => ({ home: "A", away: "B", pHome: 0.9, state: "in", ...o });
  assert.ok(Math.abs(S.liveP(ix, g({ period: 1, clock: "15:00", homeScore: 0, awayScore: 0 })) - 0.9) < 0.01);
  assert.ok(S.liveP(ix, g({ period: 4, clock: "3:00", homeScore: 10, awayScore: 17 })) < 0.1);
  assert.strictEqual(S.liveP(ix, g({ liveP: 0.42, homeScore: 0, awayScore: 0 })), 0.42, "ESPN's live number wins");
});

test("live re-scoring: an upset under way in a game you care about climbs", () => {
  const ix = fixture();
  const pre = ix.data.games[1];
  Object.assign(pre, { pHome: 0.9 });
  const before = S.scoreGame(ix, fan(ix), pre);
  const live = { ...pre, state: "in", period: 4, clock: "4:00", homeScore: 10, awayScore: 20 };
  const after = S.scoreGame(ix, fan(ix), live);
  assert.ok(after.pNow < 0.1);
  assert.strictEqual(after.preStars, before.stars);
  assert.ok(after.priority > before.priority * 1.2, `${after.priority} vs ${before.priority}`);
});

test("live odds come from the last point of ESPN's chart when there is one", () => {
  const ix = fixture();
  const g = { home: "A", away: "B", pHome: 0.9, state: "in", period: 2, clock: "5:00", homeScore: 0, awayScore: 0, wp: { pts: [[0, 900], [1500, 612]], final: false } };
  assert.strictEqual(S.liveP(ix, g), 0.612);
});

// Rankings move relative to each other: a team below you beating an unranked team only passes
// you if you lose; a team above you losing only drops below you if you win.
function ladderFixture() {
  const ix = fixture();
  const d = ix.data;
  d.teams.push({ id: "C", abbr: "C", name: "C", short: "C", conf: "8", record: [8, 2, 5, 2], fpi: 12, rank: 13, pickable: true },
    { id: "D", abbr: "D", name: "D", short: "D", conf: "8", record: [5, 5, 3, 4], fpi: 0, rank: null, pickable: true },
    { id: "E", abbr: "E", name: "E", short: "E", conf: "8", record: [9, 1, 6, 1], fpi: 15, rank: 9, pickable: true });
  // X (No. 11) hosts unranked B this week, 70% to win.
  Object.assign(d.games[3], { away: "B", pHome: 0.7 });
  d.games.push({ id: "g5", week: 12, date: "2026-11-21T20:00Z", home: "D", away: "C", conf: true, done: false, pHome: 0.4 },
    { id: "g6", week: 12, date: "2026-11-21T21:00Z", home: "D", away: "E", conf: true, done: false, pHome: 0.2 });
  return S.index(d);
}

test("rankings: a team below you beating an unranked team only matters if you lose", () => {
  const ix = ladderFixture();
  const s = S.scoreGame(ix, fan(ix), ix.data.games.find((g) => g.id === "g5")).signals.find((x) => x.key === "rank");
  assert.ok(s, "still a reason to root for D");
  assert.match(s.text, /No\. 13 C beating unranked D won't lift it past you \(No\. 11\) unless you lose to B/);
});

test("rankings: a team above you losing helps, as long as you win", () => {
  const ix = ladderFixture();
  const r = S.scoreGame(ix, fan(ix), ix.data.games.find((g) => g.id === "g6"));
  const s = r.signals.find((x) => x.key === "rank");
  assert.strictEqual(r.pick, "D");
  assert.match(s.text, /No\. 9 E losing to unranked D could drop it below you \(No\. 11\), as long as you beat B/);
});

test("rankings: if you've already won, the 'only if you lose' case has no effect", () => {
  const ix = ladderFixture();
  Object.assign(ix.data.games[3], { done: true, winner: "X", homeScore: 30, awayScore: 10 });
  const s = S.scoreGame(ix, fan(ix), ix.data.games.find((g) => g.id === "g5")).signals.find((x) => x.key === "rank");
  assert.ok(!s, "C can't pass X this week");
});

test("headline names both biggest games when they're within half a star", () => {
  const ix = fixture();
  const f = fan(ix, ["R"]);
  const { rows } = S.scoreWeek(ix, f, 12);
  const others = rows.filter((r) => !r.mine);
  others.forEach((r, i) => { r.stars = [4.5, 4][i] ?? 1; });
  let h = S.headline(ix, f, 12, rows);
  assert.strictEqual(h.biggest.length, 2);
  assert.match(h.talk, /^Two biggest games you're not in, about even: /);
  others[1].stars = 3;
  h = S.headline(ix, f, 12, rows);
  assert.strictEqual(h.biggest.length, 1);
  assert.match(h.talk, /^Biggest game you're not in: /);
});

test("résumé: only ranked or top-30 opponents count, and only for a team in the hunt", () => {
  const ix = fixture();
  const byId = (id) => ix.data.teams.find((t) => t.id === id);
  byId("X").sor = 12;
  byId("B").sor = 60; // X beat B, but B is nowhere near the poll
  ["R", "A", "O"].forEach((id, i) => { byId(id).sor = 20 + i; });
  let s = S.scoreGame(ix, fan(ix), ix.data.games[1]).signals.find((x) => x.key === "resume");
  assert.ok(!s, "a win over a team ranked 60th in résumé doesn't count");
  byId("B").sor = 28;
  s = S.scoreGame(S.index(ix.data), fan(ix), ix.data.games[1]).signals.find((x) => x.key === "resume");
  assert.match(s.text, /could get it ranked/);
  byId("X").sor = 70;
  byId("X").rank = null;
  s = S.scoreGame(S.index(ix.data), fan(ix), ix.data.games[1]).signals.find((x) => x.key === "resume");
  assert.ok(!s, "an unranked team outside the top 30 has no résumé to protect");
});

test("ladder: a ranked favorite against an unranked team is routine, unless an upset is under way", () => {
  const ix = ladderFixture();
  const g6 = ix.data.games.find((g) => g.id === "g6"); // unranked D hosts No. 9 E, which is 80% to win
  assert.strictEqual(S.scoreGame(ix, fan(ix), g6).routine, true);
  const live = { ...g6, state: "in", period: 4, clock: "5:00", homeScore: 24, awayScore: 17 };
  assert.strictEqual(S.scoreGame(ix, fan(ix), live).routine, false, "D leads late: worth watching");
});

test("ladder: two ranked teams near you meeting is not routine", () => {
  const ix = ladderFixture();
  ix.data.games.push({ id: "g7", week: 12, date: "2026-11-21T23:00Z", home: "C", away: "E", conf: true, done: false, pHome: 0.45 });
  const ix2 = S.index(ix.data);
  const r = S.scoreGame(ix2, fan(ix2), ix2.data.games.find((g) => g.id === "g7"));
  assert.strictEqual(r.group, "rank");
  assert.strictEqual(r.routine, false);
});

test("headline for a past week gives your result, not 'Beat X'", () => {
  const ix = fixture();
  Object.assign(ix.data.games[3], { done: true, winner: "A", homeScore: 17, awayScore: 24 });
  const { rows } = S.scoreWeek(S.index(ix.data), fan(ix), 12);
  const h = S.headline(ix, fan(ix), 12, rows);
  assert.match(h.pull, /^Lost to A 17-24/);
});

test("a rival affected from the outside is named, but not as playing", () => {
  const ix = fixture();
  const r = S.scoreGame(ix, fan(ix, ["R"]), ix.data.games[1]);
  const s = r.signals.find((x) => x.key === "rivals");
  assert.deepStrictEqual(s.rivals, ["R"]);
  assert.strictEqual(s.playing, null);
});

test("a split involving a rival is said in fan terms", () => {
  const ix = fixture();
  ix.data.confOdds[4].games.g1.X = [0.6, 0.3];
  const r = S.scoreGame(ix, fan(ix, ["R"]), ix.data.games[1]);
  if (r.split) assert.doesNotMatch(r.split, /rivals says|matters more/);
});

test("teams you've played: a heavy favorite against an unranked team is chalk", () => {
  const ix = fixture();
  const g = ix.data.games[1]; // A hosts B; X beat B
  Object.assign(g, { pHome: 0.15 }); // B is an 85% favorite on the road
  ix.data.confOdds[4].games.g1 = {}; // no title-race reason, so the résumé leads
  ix.data.teams.find((t) => t.id === "A").rank = null;
  const r = S.scoreGame(S.index(ix.data), fan(ix), g);
  assert.strictEqual(r.group, "resume");
  assert.strictEqual(r.routine, true);
  const live = { ...g, state: "in", period: 4, clock: "4:00", homeScore: 24, awayScore: 20 };
  assert.strictEqual(S.scoreGame(S.index(ix.data), fan(ix), live).routine, false, "upset under way");
  Object.assign(g, { pHome: 0.45 });
  assert.strictEqual(S.scoreGame(S.index(ix.data), fan(ix), g).routine, false, "a real game");
});

test("a card's reason always agrees with its pick", () => {
  const ix = fixture();
  ix.data.confOdds[4].games.g1.X = [0.6, 0.3]; // title race says A; résumé and rankings say B
  const r = S.scoreGame(ix, fan(ix, ["R"]), ix.data.games[1]);
  const lead = r.signals.find((s) => s.short === r.reason);
  assert.ok(lead && lead.rel > 0, `reason "${r.reason}" should support the pick`);
});

test("FCS teams never move in the rankings, and don't count for league pride", () => {
  const ix = fixture();
  ix.data.teams.push({ id: "F", abbr: "F", name: "F", short: "F", conf: "29", record: [5, 5, 3, 3], fpi: null, rank: null, pickable: false });
  ix.data.games.push({ id: "g8", week: 12, date: "2026-11-21T18:00Z", home: "R", away: "F", conf: false, done: false, pHome: 0.98 });
  const ix2 = S.index(ix.data);
  const r = S.scoreGame(ix2, fan(ix2), ix2.data.games.find((g) => g.id === "g8"));
  const rank = r.signals.find((s) => s.key === "rank");
  assert.ok(!rank || !/^F /.test(rank.text), "F can't climb past anyone");
  assert.ok(!r.signals.find((s) => s.key === "rep"), "no league pride against an FCS team");
});

test("a finished game keeps its title-race reason, rebuilt from the odds recorded at the final", () => {
  const ix = fixture();
  const g = ix.data.games[1]; // X: 30% if A wins, 55% if B wins; A is a 60% favorite
  const before = S.scoreGame(ix, fan(ix), g);
  Object.assign(g, { done: true, winner: "B", homeScore: 10, awayScore: 20 });
  delete ix.data.confOdds[4].games.g1; // Title Paths drops a finished game from its odds
  ix.data.confOdds[4].moved = { g1: { X: [0.40, 0.55] } }; // and records before/after instead
  const after = S.scoreGame(S.index(ix.data), fan(ix), g);
  const conf = after.signals.find((s) => s.key === "conf");
  assert.ok(conf, "title-race reason kept");
  assert.strictEqual(after.pick, before.pick, "same pick");
  assert.ok(Math.abs(after.stars - before.stars) <= 0.5, `rating about the same (${before.stars} -> ${after.stars})`);
  assert.match(conf.text, /40% before, 55% after B won/);
});

// ---- aftermath: records before and after a finished game ----

function afterFixture() {
  const team = (id, conf = "4") => ({ id, abbr: id, name: id, short: id, conf, record: [0, 0], fpi: 10, rank: null, pickable: true });
  const g = (id, date, home, away, winner, conf = false) => ({ id, week: 1, date, home, away, conf, done: true, winner, homeScore: 1, awayScore: 0 });
  return S.index({
    season: 2026, week: 5,
    confs: { 4: { name: "Big 12", p4: true }, 8: { name: "SEC", p4: true }, 18: { name: "FBS Independents" } },
    teams: [team("X"), team("B"), team("C"), team("O", "8"), team("P", "8"), team("ND", "18"), team("ARMY", "18"), team("F", "999")].map((t) => (t.id === "ND" ? { ...t, id: "87" } : t)),
    games: [
      g("a", "2026-09-05T19:00Z", "X", "B", "X", true), // X beat B
      g("b", "2026-09-06T19:00Z", "B", "O", "B"), // league 1-0
      g("c", "2026-09-07T19:00Z", "C", "P", "P"), // league 1-1
      g("d", "2026-09-08T19:00Z", "B", "87", "87"), // Notre Dame counts: league 1-2
      g("e", "2026-09-09T19:00Z", "C", "ARMY", "C"), // other independents don't
      g("f", "2026-09-10T19:00Z", "C", "F", "C"), // nor FCS
      g("h", "2026-09-12T19:00Z", "O", "B", "B"), // the game under test
      g("i", "2026-09-20T19:00Z", "B", "P", "P"), // after it: not counted
    ],
  });
}

test("a cross-league result moves your league's record, counted up to that game", () => {
  const ix = afterFixture();
  const h = ix.data.games.find((x) => x.id === "h");
  const a = S.aftermath(ix, { team: "X" }, h);
  const rep = a.find((x) => x.key === "rep");
  assert.deepStrictEqual(rep.items[0], { tag: "Big 12", was: [1, 2], now: [2, 2], good: true });
});

test("no league line for an unfinished game or a conference game", () => {
  const ix = afterFixture();
  const h = { ...ix.data.games.find((x) => x.id === "h") };
  assert.deepStrictEqual(S.aftermath(ix, { team: "X" }, { ...h, done: false }), []);
  assert.ok(!S.aftermath(ix, { team: "X" }, { ...h, conf: true }).some((x) => x.key === "rep"));
});

// A league of eight, ranked by the CFP on Nov 3; each team has played three games by then.
function rankFixture(extra = []) {
  const ids = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];
  const teams = ids.map((id, i) => ({ id, abbr: id, short: id, conf: "4", fpi: 20 - 3 * i, rank: i < 6 ? i + 1 : null }));
  const games = [];
  let n = 0;
  const day = (d) => `2026-${d}T19:00Z`;
  // Three rounds before the poll: the better team wins at home.
  for (const [d, pairs] of [["10-10", [[0, 1], [2, 3], [4, 5], [6, 7]]], ["10-17", [[0, 2], [1, 3], [4, 6], [5, 7]]], ["10-24", [[0, 3], [1, 2], [4, 7], [5, 6]]]]) {
    for (const [h, a] of pairs) games.push({ id: "p" + n++, week: 8, date: day(d), home: ids[h], away: ids[a], conf: true, done: true, winner: ids[h] });
  }
  games.push(...extra.map((g, k) => ({ id: "x" + k, week: 10, date: day(g.d), home: g.home, away: g.away, conf: true, done: true, winner: g.winner })));
  return S.index({ season: 2026, week: 10, poll: { poll: "CFP", date: "2026-11-03T08:00Z" }, confs: { 4: { name: "Big 12", p4: true } }, teams, games });
}
const rankLine = (ix, team, gid) => (S.aftermath(ix, { team }, ix.data.games.find((g) => g.id === gid)).find((x) => x.key === "rank") || {}).items || [];

test("losing to an unranked team drops your estimated poll rank and SOR", () => {
  const ix = rankFixture([{ d: "11-07", home: "T7", away: "T3", winner: "T7" }]);
  const [cfp, sor] = rankLine(ix, "T3", "x0");
  assert.strictEqual(cfp.tag, "CFP");
  assert.strictEqual(cfp.was, 3);
  assert.ok(cfp.now >= 6, `fell from 3 to ${cfp.now}`); // below everyone ranked 4-6
  assert.strictEqual(cfp.good, false);
  assert.strictEqual(sor.tag, "SOR");
  assert.ok(sor.now > sor.was && !sor.good);
});

test("a team ranked just above you losing moves you up", () => {
  const ix = rankFixture([{ d: "11-07", home: "T8", away: "T4", winner: "T8" }]);
  const cfp = rankLine(ix, "T5", "x0").find((x) => x.tag === "CFP");
  assert.deepStrictEqual([cfp.was, cfp.now, cfp.good], [5, 4, true]);
});

test("games before the poll don't move the poll estimate, and SOR waits for three games", () => {
  const ix = rankFixture([{ d: "11-01", home: "T8", away: "T4", winner: "T8" }]);
  assert.ok(!rankLine(ix, "T5", "x0").some((x) => x.tag === "CFP"));
  assert.deepStrictEqual(rankLine(ix, "T1", "p4"), []); // T1's second game
});
