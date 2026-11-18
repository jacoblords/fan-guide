/* Fan guide scoring: for one fan (a team and its rivals), how much each game matters and who
 * to root for, broken into signals that can disagree.
 *
 * Every signal returns a signed, continuous star value on a 0-5 scale: positive means root for
 * the home team. The page re-signs them relative to the overall pick, so a signal pulling the
 * other way shows as negative stars.
 *
 * Signals:
 *   conf    exact: how the result moves your conference title-game odds (Title Paths)
 *   rank    estimate: teams near you in the rankings losing, or passing you by winning
 *   resume  estimate: teams you beat (or lost to) winning makes your record look better
 *   rep     soft: your conference's non-conference results
 *   rivals  heart: your rivals losing, or games that hurt their title odds
 * plus `spectacle` (not a rooting signal): ranked teams, a close line, prime time.
 */
(function (root) {
  "use strict";

  const SIGNALS = [
    { key: "conf", label: "Conference race", kind: "head" },
    { key: "rank", label: "Rankings", kind: "head" },
    { key: "resume", label: "Résumé", kind: "head" },
    { key: "rep", label: "Conference reputation", kind: "head", soft: true },
    { key: "rivals", label: "Rivals", kind: "heart" },
  ];
  const DEFAULT_WEIGHTS = { conf: 1, rank: 0.8, resume: 0.6, rep: 0.3, rivals: 0.8 };

  // Raw value at which a signal earns 1..5 stars; interpolated in between, capped at 5.
  const STAR_STEPS = {
    conf: [0.01, 0.03, 0.07, 0.15, 0.3], // change in title-game odds
    rank: [0.2, 0.5, 1, 1.6, 2.4], // expected ranking spots gained
    resume: [0.5, 1, 1.8, 2.6, 3.5], // résumé leverage units
    rep: [0.6, 1.2, 1.8, 2.4, 3], // soft: tops out around 2 stars in practice
    rivals: [0.8, 1.6, 2.5, 3.5, 4.5], // pain units
  };

  // Overall "how much to care" stars from a game's priority.
  const OVERALL_STEPS = [0.75, 1.5, 2.25, 3, 4];

  // Ranking lines that matter: the 12-team bracket's byes (top 4) and bubble (about 12); from
  // 2027 the 24-team bracket's byes (8), home games (16) and the field (24).
  const lines = (season) => (season >= 2027 ? [8, 16, 24] : [4, 12]);

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const pct = (p) => (p >= 0.995 && p < 1 ? ">99%" : p > 0 && p < 0.005 ? "<1%" : Math.round(p * 100) + "%");

  function toStars(raw, steps) {
    const x = Math.abs(raw);
    if (!x) return 0;
    let s;
    if (x < steps[0]) s = x / steps[0];
    else if (x >= steps[4]) s = 5;
    else {
      const i = steps.findIndex((t, j) => x >= t && x < steps[j + 1]);
      s = i + 1 + (x - steps[i]) / (steps[i + 1] - steps[i]);
    }
    return Math.sign(raw) * s;
  }

  /** Indexes built once per data file. */
  function index(data) {
    const teams = new Map(data.teams.map((t) => [t.id, t]));
    const fpiRank = new Map(
      data.teams.filter((t) => t.fpi != null).sort((a, b) => b.fpi - a.fpi).map((t, i) => [t.id, i + 1])
    );
    const played = new Map(); // team id -> completed games
    const remaining = new Map(); // team id -> count of unplayed games
    for (const g of data.games) {
      for (const tid of [g.home, g.away]) {
        if (g.done && !g.canceled && g.winner) {
          if (!played.has(tid)) played.set(tid, []);
          played.get(tid).push(g);
        } else if (!g.done) remaining.set(tid, (remaining.get(tid) || 0) + 1);
      }
    }
    const byAbbr = new Map(data.teams.filter((t) => t.abbr).map((t) => [t.abbr, t.id]));
    return { data, teams, fpiRank, played, remaining, byAbbr };
  }

  function name(ix, tid) {
    const t = ix.teams.get(tid);
    return (t && (t.short || t.school || t.abbr)) || "their opponent";
  }
  function ranked(ix, tid) {
    const t = ix.teams.get(tid);
    const n = name(ix, tid);
    return t && t.rank ? `No. ${t.rank} ${n}` : n;
  }

  /** ESPN's pre-game odds for the home team, or an FPI-based stand-in. */
  function pHome(ix, g) {
    if (g.pHome != null) return g.pHome;
    const f = (tid) => {
      const t = ix.teams.get(tid);
      return t && t.fpi != null ? t.fpi : -15; // FCS or unknown
    };
    return sigmoid((f(g.home) - f(g.away) + (g.neutral ? 0 : 2.5)) / 7.5);
  }

  // ---- signals -----------------------------------------------------------------------------

  function confSignal(ix, fan, g) {
    const X = ix.teams.get(fan.team);
    const race = X && ix.data.confOdds[X.conf];
    const mine = race && race.teams[fan.team];
    const swing = race && race.games[g.id] && race.games[g.id][fan.team];
    if (!mine || !swing || mine.clinched || mine.eliminated || swing[0] == null) return null;
    const [ifH, ifA] = swing;
    const raw = ifH - ifA;
    if (Math.abs(raw) < 0.005) return null;
    return {
      raw,
      text: `${race.name} title-game odds: ${pct(ifH)} if ${name(ix, g.home)} wins, ${pct(ifA)} if ${name(ix, g.away)} wins`,
      link: race.url,
    };
  }

  function rankSignal(ix, fan, g, p) {
    const X = ix.teams.get(fan.team);
    if (!X) return null;
    const rX = X.rank || 26;
    const rOf = (tid) => (ix.teams.get(tid) || {}).rank || null;
    // T loses: chance it falls below you.
    const fallBelow = (tid, pWin) => {
      const rT = rOf(tid);
      if (tid === fan.team || !rT || rT >= rX) return 0;
      const drop = 3 + 6 * pWin; // a loss as a big favorite costs more
      return sigmoid((drop - (rX - rT)) / 1.5);
    };
    // T wins: chance it climbs past you.
    const passUp = (tid, pWin, opp) => {
      if (tid === fan.team) return 0;
      const rT = rOf(tid);
      const oppRanked = !!rOf(opp);
      if (rT && rT > rX) {
        const gain = 1 + 4 * (1 - pWin) + (oppRanked ? 2 : 0);
        return sigmoid((gain - (rT - rX)) / 1.5);
      }
      if (!rT && oppRanked && rX >= 18) return 0.35 * Math.min(1, (rX - 17) / 8);
      return 0;
    };
    const h = g.home, a = g.away;
    const ifH = fallBelow(a, 1 - p) - passUp(h, p, a);
    const ifA = fallBelow(h, p) - passUp(a, 1 - p, h);
    let raw = ifH - ifA;
    const nearLine = lines(ix.data.season).some((L) => Math.abs(rX - L) <= 2);
    raw *= X.rank ? (nearLine ? 1.5 : 1) : 0.5;
    if (Math.abs(raw) < 0.03) return null;
    // Explain the biggest term.
    const terms = [
      [fallBelow(a, 1 - p), `${ranked(ix, a)} losing could drop it below you`],
      [fallBelow(h, p), `${ranked(ix, h)} losing could drop it below you`],
      [passUp(h, p, a), `${ranked(ix, h)} winning could lift it past you`],
      [passUp(a, 1 - p, h), `${ranked(ix, a)} winning could lift it past you`],
    ].sort((x, y) => y[0] - x[0]);
    const you = X.rank ? `No. ${X.rank}` : "unranked";
    return { raw, text: `${terms[0][1]} (you're ${you}${nearLine && X.rank ? ", near a playoff line" : ""})` };
  }

  function resumeLeverage(ix, oid) {
    const O = ix.teams.get(oid);
    if (!O || !O.conf) return { L: 0.3, why: "" };
    let L = 1;
    const why = [];
    if (O.rank && O.rank >= 15) {
      L += 1;
      why.push("keeps it in the Top 25");
    } else if (O.rank) L += 0.5;
    else if ((ix.fpiRank.get(oid) || 999) <= 35 || O.record[0] >= 7) {
      L += 0.7;
      why.push("could get it ranked");
    }
    if (O.record[0] === 5) {
      L += 0.8;
      why.push("a 6th win makes it bowl-eligible");
    }
    return { L, why: why.join("; ") };
  }

  function resumeSignal(ix, fan, g) {
    const games = ix.played.get(fan.team) || [];
    let raw = 0;
    const notes = [];
    for (const [tid, sign] of [[g.home, 1], [g.away, -1]]) {
      if (tid === fan.team) continue;
      const met = games.find((x) => x.home === tid || x.away === tid);
      if (!met) continue;
      const beat = met.winner === fan.team;
      const { L, why } = resumeLeverage(ix, tid);
      raw += sign * L * (beat ? 1 : 0.6);
      const mine = met.home === fan.team ? met.homeScore : met.awayScore;
      const theirs = met.home === fan.team ? met.awayScore : met.homeScore;
      const score = mine != null ? ` ${beat ? "W" : "L"} ${mine}-${theirs}` : "";
      notes.push(
        `You ${beat ? "beat" : "lost to"} ${name(ix, tid)}${score} (week ${met.week}): ` +
          `${beat ? "its wins make that win look better" : "its wins make that loss look better"}` +
          (why ? `, and ${why}` : "")
      );
    }
    if (!raw && !notes.length) return null;
    return { raw, text: notes.join(". ") };
  }

  function repSignal(ix, fan, g) {
    const X = ix.teams.get(fan.team);
    const H = ix.teams.get(g.home), A = ix.teams.get(g.away);
    if (!X || !X.conf || X.conf === "18" || !H || !A || g.conf || H.conf === A.conf) return null;
    const mineH = H.conf === X.conf && g.home !== fan.team;
    const mineA = A.conf === X.conf && g.away !== fan.team;
    if (mineH === mineA) return null;
    const ours = mineH ? H : A, theirs = mineH ? A : H;
    const confs = ix.data.confs;
    const theirsP4 = (confs[theirs.conf] || {}).p4 || theirs.id === "87";
    const L = 1 + (theirsP4 ? 0.5 : 0) + (H.rank || A.rank ? 0.5 : 0);
    const cn = (c) => (confs[c] || {}).name || "their league";
    return {
      raw: mineH ? L : -L,
      soft: true,
      text: `${cn(X.conf)} vs ${theirs.id === "87" ? "Notre Dame" : cn(theirs.conf)}: a ${ours.short} win is one for the ${cn(X.conf)}`,
    };
  }

  /** How much a loss hurts rival R, with the reasons. */
  function rivalPain(ix, fan, R, g, pRwin) {
    const T = ix.teams.get(R);
    let pain = 1;
    const why = [];
    const race = T && ix.data.confOdds[T.conf];
    const sw = race && race.games[g.id] && race.games[g.id][R];
    if (sw && sw[0] != null) {
      const [ifH, ifA] = sw;
      const [ifWin, ifLose] = g.home === R ? [ifH, ifA] : [ifA, ifH];
      const d = ifWin - ifLose;
      if (d > 0.005) {
        pain += Math.min(2.5, d * 10);
        why.push(`${race.name} title-game odds ${pct(ifWin)} → ${pct(ifLose)}`);
      }
    }
    if (T && T.rank) {
      pain += T.rank <= 12 ? 1 : 0.5;
      why.push(`No. ${T.rank}, with ranking to lose`);
    }
    const left = ix.remaining.get(R) || 0;
    if (T && T.record[0] === 5) {
      pain += left <= 1 ? 1.5 : 0.7;
      why.push(left <= 1 ? "a loss ends its bowl hopes" : "stuck at 5 wins");
    }
    const opp = g.home === R ? g.away : g.home;
    const theirRivals = (fan.rivalsOf && fan.rivalsOf(R)) || [];
    if (theirRivals.includes(opp)) {
      pain += 1;
      why.push(`losing to its own rival ${name(ix, opp)}`);
    }
    pain += pRwin; // losing as the favorite stings more
    if (pRwin >= 0.75) why.push(`favored at ${pct(pRwin)}`);
    return { pain, why };
  }

  function rivalsSignal(ix, fan, g, p) {
    let raw = 0;
    const notes = [];
    for (const R of fan.rivals) {
      if (R === fan.team) continue;
      if (g.home === R || g.away === R) {
        const pRwin = g.home === R ? p : 1 - p;
        const { pain, why } = rivalPain(ix, fan, R, g, pRwin);
        raw += g.home === R ? -pain : pain;
        notes.push(`${ranked(ix, R)} losing (${pct(1 - pRwin)} chance)${why.length ? ": " + why.join("; ") : ""}`);
        continue;
      }
      // A game R isn't in can still dent R's title odds.
      const T = ix.teams.get(R);
      const race = T && ix.data.confOdds[T.conf];
      const sw = race && race.games[g.id] && race.games[g.id][R];
      const st = race && race.teams[R];
      if (sw && sw[0] != null && st && !st.clinched && !st.eliminated) {
        const d = sw[0] - sw[1];
        if (Math.abs(d) >= 0.01) {
          raw += -d * 10;
          notes.push(
            `${name(ix, R)}'s ${race.name} title-game odds: ${pct(sw[0])} if ${name(ix, g.home)} wins, ${pct(sw[1])} if ${name(ix, g.away)} wins`
          );
        }
      }
    }
    return notes.length ? { raw, text: notes.join(". ") } : null;
  }

  function spectacle(ix, g, p) {
    const rk = [g.home, g.away].filter((t) => (ix.teams.get(t) || {}).rank).length;
    const close = 1 - Math.abs(2 * p - 1);
    const h = new Date(g.date).getUTCHours();
    const prime = g.timeValid !== false && h >= 23 || (h >= 0 && h < 4) ? 0.5 : 0;
    return rk + 2 * close + prime;
  }

  // ---- per game and per week --------------------------------------------------------------

  function scoreGame(ix, fan, g) {
    const p = pHome(ix, g);
    const mine = g.home === fan.team || g.away === fan.team;
    const raw = {
      conf: confSignal(ix, fan, g),
      rank: mine ? null : rankSignal(ix, fan, g, p),
      resume: mine ? null : resumeSignal(ix, fan, g),
      rep: mine ? null : repSignal(ix, fan, g),
      rivals: mine ? null : rivalsSignal(ix, fan, g, p),
    };
    const W = fan.weights || DEFAULT_WEIGHTS;
    const signals = [];
    let total = 0, spread = 0;
    for (const s of SIGNALS) {
      const r = raw[s.key];
      if (!r) continue;
      const stars = toStars(r.raw, STAR_STEPS[s.key]);
      const w = W[s.key] ?? 0;
      total += w * stars;
      spread += w * Math.abs(stars);
      signals.push({ key: s.key, label: s.label, kind: s.kind, soft: !!(s.soft || r.soft), stars, weighted: w * stars, text: r.text, link: r.link });
    }
    let pick = mine ? fan.team : total > 0.05 ? g.home : total < -0.05 ? g.away : null;
    const sign = pick === g.home ? 1 : pick === g.away ? -1 : 0;
    for (const s of signals) {
      s.rel = sign ? s.stars * sign : Math.abs(s.stars); // stars toward the pick
    }
    const strong = signals.filter((s) => Math.abs(s.weighted) >= 0.75);
    const conflict = !mine && strong.some((s) => s.stars > 0) && strong.some((s) => s.stars < 0);
    const u = 0.35 + 0.65 * Math.sqrt(4 * p * (1 - p));
    const spec = spectacle(ix, g, p);
    const priority = mine ? 100 : (Math.abs(total) + 0.5 * (spread - Math.abs(total))) * u + 0.25 * spec;
    const result = g.done && !g.canceled && g.winner && pick ? (g.winner === pick ? "won" : "lost") : null;
    return {
      game: g, p, pick, mine, total, priority,
      stars: mine ? 5 : Math.round(toStars(priority, OVERALL_STEPS) * 2) / 2,
      signals, conflict, spectacle: spec,
      heart: signals.some((s) => s.kind === "heart"),
      result,
    };
  }

  /** Every game of `week`, scored for `fan` = {team, rivals: [ids], weights?, rivalsOf?}. */
  function scoreWeek(ix, fan, week) {
    const games = ix.data.games.filter((g) => g.week === week && !g.canceled);
    const rows = games.map((g) => scoreGame(ix, fan, g));
    rows.sort((a, b) => b.priority - a.priority || a.game.date.localeCompare(b.game.date));
    const decided = rows.filter((r) => r.result && !r.mine && r.priority >= 0.75);
    return {
      rows,
      tally: { won: decided.filter((r) => r.result === "won").length, lost: decided.filter((r) => r.result === "lost").length },
    };
  }

  /** Watch-them-suffer: each rival's game this week, likeliest pain first. */
  function sufferList(ix, fan, week) {
    const out = [];
    for (const R of fan.rivals) {
      for (const g of ix.data.games.filter((x) => x.week === week && !x.canceled && (x.home === R || x.away === R))) {
        if (g.home === fan.team || g.away === fan.team) continue;
        const p = pHome(ix, g);
        const pRwin = g.home === R ? p : 1 - p;
        const { pain, why } = rivalPain(ix, fan, R, g, pRwin);
        out.push({ rival: R, game: g, pLose: 1 - pRwin, pain, expected: pain * (1 - pRwin), why });
      }
    }
    return out.sort((a, b) => b.expected - a.expected);
  }

  /** Default rivals from rivals.json (by abbreviation), as team ids. */
  function defaultRivals(ix, rivalsJson, tid) {
    const t = ix.teams.get(tid);
    return ((t && rivalsJson[t.abbr]) || []).map((a) => ix.byAbbr.get(a)).filter(Boolean);
  }

  const api = { SIGNALS, DEFAULT_WEIGHTS, STAR_STEPS, lines, toStars, index, pHome, scoreGame, scoreWeek, sufferList, defaultRivals, pct };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FanScore = api;
})(typeof self !== "undefined" ? self : this);
