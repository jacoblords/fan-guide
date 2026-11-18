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
  assert.match(r.signals.find((s) => s.key === "rivals").short, /R .*loss/);
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
