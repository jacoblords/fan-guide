/* Fan guide scoring: for one fan (a team and its rivals), how much each game matters and who
 * to root for, broken into signals that can disagree.
 *
 * Every signal returns a signed, continuous star value on a 0-5 scale: positive means root for
 * the home team. Each also carries a plain one-line reason (`short`, for the collapsed card) and
 * the numbers behind it (`text`, for the expanded card).
 *
 * Signals:
 *   conf    exact: how the result moves your conference title-game odds (Title Paths)
 *   rank    estimate: teams near you in the rankings losing, or passing you by winning
 *   resume  estimate: teams you played winning makes your record look better
 *   rep     soft: your conference's non-conference results
 *   rivals  heart: your rivals losing, or games that hurt their title odds
 * plus `spectacle` (not a rooting signal): ranked teams, a close line, prime time.
 */
(function (root) {
  "use strict";

  const SIGNALS = [
    { key: "conf", label: "Title race", group: "Conference title race", kind: "head" },
    { key: "rank", label: "Rankings", group: "Playoff ladder", kind: "head" },
    { key: "resume", label: "Teams you played", group: "Teams you've played", kind: "head" },
    { key: "rep", label: "League pride", group: "League pride", kind: "head", soft: true },
    { key: "rivals", label: "Rivals", group: "Rival watch", kind: "heart" },
  ];
  const DEFAULT_WEIGHTS = { conf: 1, rank: 0.8, resume: 0.6, rep: 0.3, rivals: 0.8 };

  // Raw value at which a signal earns 1..5 stars; interpolated in between, capped at 5.
  const STAR_STEPS = {
    conf: [0.01, 0.03, 0.07, 0.15, 0.3], // change in title-game odds
    rank: [0.2, 0.5, 1, 1.6, 2.4], // expected ranking spots gained
    resume: [0.5, 1, 1.8, 2.6, 3.5], // leverage units
    rep: [0.6, 1.2, 1.8, 2.4, 3], // soft: tops out around 2 stars in practice
    rivals: [0.8, 1.6, 2.5, 3.5, 4.5], // pain units
  };

  // Overall "how much to care" stars from a game's priority, and how many games a week may
  // have five (the rest are capped at four and a half).
  const OVERALL_STEPS = [1, 2, 3, 4.5, 6.5];
  const MAX_FIVES = 3;

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
  const poss = (n) => (n.endsWith("s") ? n + "'" : n + "'s");

  /** FBS: in one of the FBS conferences the data lists (independents included). FCS teams carry
   * their own conference ids in ESPN's data, so "has a conference" isn't enough. */
  const isFBS = (ix, tid) => { const t = ix.teams.get(tid); return !!(t && t.conf && ix.data.confs[t.conf]); };

  /** ESPN's pre-game odds for the home team, or an FPI-based stand-in. */
  function pHome(ix, g) {
    if (g.pHome != null) return g.pHome;
    const f = (tid) => {
      const t = ix.teams.get(tid);
      return t && t.fpi != null ? t.fpi : -15; // FCS or unknown
    };
    return sigmoid((f(g.home) - f(g.away) + (g.neutral ? 0 : 2.5)) / 7.5);
  }

  // Normal CDF (Abramowitz-Stegun 7.1.26), accurate to about 1e-7.
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  const MARGIN_SD = 14; // spread of a college game's final margin around the line, in points

  /** Seconds of regulation left (overtime counts as five minutes). */
  function secondsLeft(g) {
    const period = g.period || 1;
    const m = /^(\d+):(\d+)/.exec(g.clock || "");
    const clock = m ? +m[1] * 60 + +m[2] : 900;
    return period >= 5 ? 300 : (4 - period) * 900 + clock;
  }

  /** The home team's chance to win right now. ESPN's live number when the fetcher has it
   * (`g.liveP`, or the last point of the `g.wp` chart); otherwise the pre-game line, shrunk by the time left, plus the current margin. */
  function liveP(ix, g) {
    if (g.state !== "in") return pHome(ix, g);
    if (g.liveP != null) return g.liveP;
    const pts = g.wp && g.wp.pts;
    if (pts && pts.length) return pts[pts.length - 1][1] / 1000; // ESPN's latest in-game number
    if (g.homeScore == null) return pHome(ix, g);
    const pre = Math.min(0.995, Math.max(0.005, pHome(ix, g)));
    const line = (MARGIN_SD * Math.log(pre / (1 - pre))) / 1.702; // expected home margin before kickoff
    const f = Math.max(secondsLeft(g) / 3600, 0.004);
    const margin = g.homeScore - g.awayScore;
    return normCdf((margin + line * f) / (MARGIN_SD * Math.sqrt(f)));
  }

  // ---- signals -----------------------------------------------------------------------------

  function confSignal(ix, fan, g) {
    const X = ix.teams.get(fan.team);
    const race = X && ix.data.confOdds[X.conf];
    const mine = race && race.teams[fan.team];
    let swing = race && race.games[g.id] && race.games[g.id][fan.team];
    let done = null;
    // A finished game is gone from Title Paths' odds; rebuild its swing from what Title Paths
    // recorded at the final (odds before, and after), so the game keeps its reason and rating:
    // after - before = (1 - p) x (odds if the winner wins - odds if the loser wins), where p is
    // the winner's pre-game chance.
    const mv = race && race.moved && race.moved[g.id] && race.moved[g.id][fan.team];
    if (!swing && mv && g.done && g.winner) {
      const p = pHome(ix, g), pw = g.winner === g.home ? p : 1 - p;
      const d = Math.max(-1, Math.min(1, (mv[1] - mv[0]) / Math.max(1 - pw, 0.02)));
      const ifW = mv[1], ifL = Math.max(0, Math.min(1, mv[1] - d));
      swing = g.winner === g.home ? [ifW, ifL] : [ifL, ifW];
      done = { before: mv[0], after: mv[1] };
    }
    if (!swing || swing[0] == null || (!done && (!mine || mine.clinched || mine.eliminated))) return null;
    const [ifH, ifA] = swing;
    const raw = ifH - ifA;
    if (Math.abs(raw) < 0.005) return null;
    const winner = name(ix, raw > 0 ? g.home : g.away);
    const d = Math.abs(raw);
    const size = d >= 0.15 ? "huge" : d >= 0.07 ? "big" : d >= 0.02 ? "good" : "a little good";
    let short = `${winner} win is ${size} for your ${race.name} title shot`;
    if (g.home === fan.team || g.away === fan.team) {
      const [ifWin, ifLose] = g.home === fan.team ? [ifH, ifA] : [ifA, ifH];
      short = ifWin >= 0.995 && ifLose < 0.995 ? `Win and you're in the ${race.name} title game`
        : ifLose <= 0.005 && ifWin > 0.005 ? `Lose and you're out of the ${race.name} title race`
        : `Title-game odds: ${pct(ifWin)} with a win, ${pct(ifLose)} with a loss`;
    }
    if (done) {
      short = g.home === fan.team || g.away === fan.team
        ? `Title-game odds went ${pct(done.before)} → ${pct(done.after)}`
        : `${winner} win was ${size} for your ${race.name} title shot`;
      return { raw, short, text: `${race.name} title-game odds: ${pct(done.before)} before, ${pct(done.after)} after ${name(ix, g.winner)} won`, link: race.url };
    }
    return {
      raw,
      short,
      text: `${race.name} title-game odds: ${pct(ifH)} if ${name(ix, g.home)} wins, ${pct(ifA)} if ${name(ix, g.away)} wins`,
      link: race.url,
    };
  }

  // ---- rankings ----------------------------------------------------------------------------
  // Teams move relative to each other, so whether a game can change your spot depends on who
  // each side beats and on your own result. A team's movement this week, in ranking spots (up
  // positive): a win over a ranked team lifts it, more if that team was ranked higher; a win over
  // an unranked team about holds; a loss drops it, more as a bigger favorite, less to a better
  // ranked team. Unranked teams sit at 26.
  const UNRANKED = 26;
  const RANK_NOISE = 0.7; // how sharp "passes" is, in spots

  function movement(ix, tid, opp, won, pWin) {
    const r = (ix.teams.get(tid) || {}).rank || UNRANKED;
    const ro = (ix.teams.get(opp) || {}).rank || null;
    if (won) return ro ? Math.min(6, 1.5 + Math.max(0, r - ro) * 0.25) : 0.3;
    if (ro && ro < r) return -1.5; // lost to a better ranked team
    return -(2 + (ro ? 3 : 5) * pWin); // an upset loss costs more
  }

  /** Your own game this week as [chance, your movement] outcomes ([[1, 0]] for a bye). */
  function myOutcomes(ix, fan, week) {
    const g = ix.data.games.find((x) => x.week === week && !x.canceled && (x.home === fan.team || x.away === fan.team));
    if (!g) return { game: null, outcomes: [[1, 0]] };
    const opp = g.home === fan.team ? g.away : g.home;
    const p = g.home === fan.team ? pHome(ix, g) : 1 - pHome(ix, g);
    const up = movement(ix, fan.team, opp, true, p), down = movement(ix, fan.team, opp, false, p);
    if (g.done && g.winner) return { game: g, opp, outcomes: [[1, g.winner === fan.team ? up : down]] };
    return { game: g, opp, outcomes: [[p, up], [1 - p, down]], up, down, p };
  }

  /** Chance T ends the week on the other side of you, given each side's movement. Above you:
   * the chance it falls below (good for you). Below you: the chance it climbs past (bad). */
  function crosses(rT, rX, dT, dX) {
    return rT < rX ? sigmoid((dX - dT - (rX - rT)) / RANK_NOISE) : sigmoid((dT - dX - (rT - rX)) / RANK_NOISE);
  }

  function rankSignal(ix, fan, g, p) {
    const X = ix.teams.get(fan.team);
    if (!X) return null;
    if (!X.rank && !inHunt(ix, fan.team)) return null; // no ranking in play
    const rX = X.rank || UNRANKED;
    const mine = myOutcomes(ix, fan, g.week);
    // Your gain in ranking terms if `winner` beats `loser`, for one outcome of your own game.
    const gainIf = (winner, loser, pW, dX) => {
      let v = 0;
      for (const [tid, won] of [[winner, true], [loser, false]]) {
        const T = ix.teams.get(tid);
        if (tid === fan.team || !T || !isFBS(ix, tid) || !T.rank && !won) continue; // FCS teams don't get ranked
        const rT = T.rank || UNRANKED + 0.5; // an unranked team has to climb into the poll first
        if (rT === rX) continue;
        const dT = movement(ix, tid, won ? loser : winner, won, won ? pW : 1 - pW);
        const c = crosses(rT, rX, dT, dX);
        v += rT < rX ? c - crosses(rT, rX, 0, 0) : -(c - crosses(rT, rX, 0, 0));
      }
      return v;
    };
    const expect = (winner, loser, pW) => mine.outcomes.reduce((s, [q, dX]) => s + q * gainIf(winner, loser, pW, dX), 0);
    const ifH = expect(g.home, g.away, p), ifA = expect(g.away, g.home, 1 - p);
    let raw = ifH - ifA;
    const nearLine = X.rank && lines(ix.data.season).some((L) => Math.abs(rX - L) <= 2);
    raw *= X.rank ? (nearLine ? 1.3 : 1) : 0.5;
    if (Math.abs(raw) < 0.1) return null; // under half a star: not worth a sentence

    // Explain the team that matters most, and whether it depends on your own result.
    const want = raw > 0 ? g.home : g.away, other = want === g.home ? g.away : g.home;
    const rw = (ix.teams.get(want) || {}).rank, ro = (ix.teams.get(other) || {}).rank;
    // The team you're rooting against: above you, its loss helps; below you, its win threatens.
    const subject = { tid: other, kind: ro && ro < rX ? "loss" : "win" };
    const S = subject.tid, sName = name(ix, S), sRank = (ix.teams.get(S) || {}).rank;
    const oppDesc = (tid) => { const t = ix.teams.get(tid) || {}; return t.rank ? `No. ${t.rank} ${name(ix, tid)}` : t.short || t.school ? `unranked ${name(ix, tid)}` : "its opponent"; };
    const you = X.rank ? `No. ${X.rank}` : "unranked";
    // How much it hinges on your game: the effect if you win vs if you lose.
    let hinge = null;
    if (mine.outcomes.length === 2) {
      const eff = (dX) => Math.abs(gainIf(g.home, g.away, p, dX) - gainIf(g.away, g.home, 1 - p, dX));
      const ifWin = eff(mine.up), ifLose = eff(mine.down);
      if (ifLose > 0.25 && ifWin < 0.35 * ifLose) hinge = "lose";
      else if (ifWin > 0.25 && ifLose < 0.35 * ifWin) hinge = "win";
    }
    const myOpp = mine.opp ? name(ix, mine.opp) : null;
    let short, text;
    if (subject.kind === "loss") {
      short = hinge === "win" ? `${sName} loss could move you up, if you beat ${myOpp}` : `${sName} loss could move you up the rankings`;
      text = `${sRank ? "No. " + sRank + " " : ""}${sName} losing to ${oppDesc(want)} could drop it below you (${you})${hinge === "win" ? `, as long as you beat ${myOpp}` : ""}`;
    } else if (hinge === "lose") {
      short = `${sName} win only threatens your spot if you lose`;
      text = `${sRank ? "No. " + sRank + " " : ""}${sName} beating ${oppDesc(want)} won't lift it past you (${you}) unless you lose to ${myOpp}`;
    } else {
      short = ro || rw ? `${sName} win over ${oppDesc(want)} could lift it past you` : `${sName} win could lift it past you`;
      text = `${sRank ? "No. " + sRank + " " : ""}${sName} beating ${oppDesc(want)} could lift it past you (${you})${mine.game && !mine.game.done ? `, more so if you lose to ${myOpp}` : ""}`;
    }
    // A playoff line only gets a mention when this game could move you across it.
    for (const L of X.rank ? lines(ix.data.season) : []) {
      if (subject.kind === "loss" && rX === L + 1) text += `, which would move you into the top ${L}`;
      if (subject.kind === "win" && rX === L && hinge !== "lose") text += `, which would push you out of the top ${L}`;
    }
    return { raw, short, text, ladder: true };
  }

  // A team's standing for résumé purposes: ranked, or in the top 30 of ESPN's Strength of Record
  // (FPI rank when the data has no SOR). Beating, or losing to, anyone below that line barely
  // registers with the committee, so their games don't count.
  const RESUME_LINE = 30;
  function resumeRank(ix, tid) {
    const t = ix.teams.get(tid);
    if (!t) return null;
    if (ix.hasSor === undefined) ix.hasSor = ix.data.teams.some((x) => x.sor != null);
    return ix.hasSor ? t.sor ?? null : ix.fpiRank.get(tid) ?? null;
  }
  const inHunt = (ix, tid) => {
    const t = ix.teams.get(tid);
    const r = resumeRank(ix, tid);
    return !!(t && (t.rank || (r != null && r <= RESUME_LINE)));
  };

  function resumeLeverage(ix, oid) {
    const O = ix.teams.get(oid);
    if (!O || !isFBS(ix, oid) || !inHunt(ix, oid)) return null;
    if (O.rank && O.rank >= 20) return { L: 2, why: "keeps it in the Top 25" };
    if (O.rank) return { L: 1.5, why: "" };
    return { L: 1.7, why: "could get it ranked" };
  }

  function resumeSignal(ix, fan, g) {
    if (!inHunt(ix, fan.team)) return null; // a résumé only matters to a team in the ranking hunt
    const games = ix.played.get(fan.team) || [];
    let raw = 0;
    const notes = [], shorts = [];
    for (const [tid, sign] of [[g.home, 1], [g.away, -1]]) {
      if (tid === fan.team) continue;
      const met = games.find((x) => x.home === tid || x.away === tid);
      if (!met) continue;
      const beat = met.winner === fan.team;
      const lev = resumeLeverage(ix, tid);
      if (!lev) continue;
      const { L, why } = lev;
      raw += sign * L * (beat ? 1 : 0.6);
      const mine = met.home === fan.team ? met.homeScore : met.awayScore;
      const theirs = met.home === fan.team ? met.awayScore : met.homeScore;
      const score = mine != null ? ` ${mine}-${theirs}` : "";
      const n = name(ix, tid);
      shorts.push(beat ? `You beat ${n}; ${poss(n)} wins make that look better` : `You lost to ${n}; the better ${n} looks, the better that loss looks`);
      notes.push(`${beat ? "Beat" : "Lost to"} ${n}${score} in week ${met.week}${why ? `; a win here ${why}` : ""}`);
    }
    if (!notes.length) return null;
    return { raw, short: shorts.join(". "), text: notes.join(". ") };
  }

  function repSignal(ix, fan, g) {
    const X = ix.teams.get(fan.team);
    const H = ix.teams.get(g.home), A = ix.teams.get(g.away);
    if (!X || !X.conf || X.conf === "18" || !H || !A || g.conf || H.conf === A.conf) return null;
    const mineH = H.conf === X.conf && g.home !== fan.team;
    const mineA = A.conf === X.conf && g.away !== fan.team;
    if (mineH === mineA) return null;
    const theirTeam = mineH ? A : H;
    if (!theirTeam.conf || !ix.data.confs[theirTeam.conf] || (theirTeam.conf === "18" && theirTeam.id !== "87")) return null; // FCS or independents
    const ours = mineH ? H : A, theirs = mineH ? A : H;
    const confs = ix.data.confs;
    const theirsP4 = (confs[theirs.conf] || {}).p4 || theirs.id === "87";
    const L = 1 + (theirsP4 ? 0.5 : 0) + (H.rank || A.rank ? 0.5 : 0);
    const cn = (c) => (confs[c] || {}).name || "their league";
    const other = theirs.id === "87" ? "Notre Dame" : `the ${cn(theirs.conf)}`;
    return {
      raw: mineH ? L : -L,
      soft: true,
      short: `One for the ${cn(X.conf)} against ${other}`,
      text: `${ours.short} is a ${cn(X.conf)} team; league records against other leagues shape how the committee sees everyone in it`,
    };
  }

  /** How much a loss hurts rival R, with plain reasons. Driven by real stakes, so a sure
   * winner with little riding on the game doesn't rate as much pain. */
  function rivalPain(ix, fan, R, g, pRwin) {
    const T = ix.teams.get(R);
    let pain = 0.5;
    const why = [];
    const race = T && ix.data.confOdds[T.conf];
    const sw = race && race.games[g.id] && race.games[g.id][R];
    let title = null;
    if (sw && sw[0] != null) {
      const [ifH, ifA] = sw;
      const [ifWin, ifLose] = g.home === R ? [ifH, ifA] : [ifA, ifH];
      const d = ifWin - ifLose;
      if (d > 0.005) {
        pain += Math.min(3, d * 12);
        title = { ifWin, ifLose, d, conf: race.name };
        if (d >= 0.05) why.push(d >= 0.25 ? `it would wreck their ${race.name} title hopes` : `it would hurt their ${race.name} title hopes`);
      }
    }
    if (T && T.rank) {
      pain += T.rank <= 12 ? 0.7 : 0.3;
      if (T.rank <= 12) why.push(`it would cost them their No. ${T.rank} spot`);
    }
    const left = ix.remaining.get(R) || 0;
    if (T && T.record[0] === 5) {
      pain += left <= 1 ? 1.5 : 0.7;
      why.push(left <= 1 ? "it would end their bowl hopes" : "they're stuck on 5 wins");
    }
    const opp = g.home === R ? g.away : g.home;
    const theirRivals = (fan.rivalsOf && fan.rivalsOf(R)) || [];
    if (theirRivals.includes(opp)) {
      pain += 1;
      why.push(`it'd come against their own rival, ${name(ix, opp)}`);
    }
    pain += 0.5 * pRwin; // losing as the favorite stings more
    return { pain, why, title };
  }

  function rivalsSignal(ix, fan, g, p) {
    let raw = 0;
    const notes = [], shorts = [], about = [];
    const inGame = fan.rivals.filter((R) => R !== fan.team && (g.home === R || g.away === R));
    if (inGame.length === 2) {
      return { raw: 0, short: `Both your rivals: one of them loses`, text: `${name(ix, g.away)} and ${name(ix, g.home)} are both on your rivals list`, both: true, rivals: inGame };
    }
    // "it would hurt their..." -> "A loss would hurt their..."
    const lossLine = (w) => !w ? "Your rival loses" : w.startsWith("it would ") ? "A loss " + w.slice(3) : w.startsWith("it'd ") ? "It'd " + w.slice(5) : w.charAt(0).toUpperCase() + w.slice(1);
    for (const R of fan.rivals) {
      if (R === fan.team) continue;
      if (g.home === R || g.away === R) {
        const pRwin = g.home === R ? p : 1 - p;
        const { pain, why } = rivalPain(ix, fan, R, g, pRwin);
        raw += g.home === R ? -pain : pain;
        about.push(R);
        shorts.push(lossLine(why[0]));
        const tt = rivalPain(ix, fan, R, g, pRwin).title;
        notes.push([`${name(ix, R)} loses ${pct(1 - pRwin)} of the time`, tt && `${tt.conf} title-game odds ${pct(tt.ifWin)} with a win, ${pct(tt.ifLose)} with a loss`, ...why.slice(1)].filter(Boolean).join(". "));
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
          about.push(R);
          const helps = name(ix, d > 0 ? g.away : g.home);
          shorts.push(`${helps} win dents ${poss(name(ix, R))} ${race.name} title hopes`);
          notes.push(`${poss(name(ix, R))} ${race.name} title-game odds: ${pct(sw[0])} if ${name(ix, g.home)} wins, ${pct(sw[1])} if ${name(ix, g.away)} wins`);
        }
      }
    }
    return shorts.length ? { raw, short: shorts.join(". "), text: notes.join(". "), rivals: about, playing: inGame[0] || null } : null;
  }

  function spectacle(ix, g, p) {
    const rk = [g.home, g.away].filter((t) => (ix.teams.get(t) || {}).rank).length;
    const close = 1 - Math.abs(2 * p - 1);
    const h = new Date(g.date).getUTCHours();
    const prime = g.timeValid !== false && (h >= 23 || h < 4) ? 0.5 : 0;
    return rk + 2 * close + prime;
  }

  // ---- per game and per week --------------------------------------------------------------

  /** Scores one game. Stakes (what each result does for the fan) come from the pre-game odds;
   * how much the game deserves attention also depends on how likely those stakes are to come
   * true, and for a game under way that uses the live odds. So a long-shot upset with real
   * stakes climbs the list as it starts to happen. */
  function scoreGame(ix, fan, g) {
    const p = pHome(ix, g);
    const pNow = liveP(ix, g);
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
      if (Math.abs(stars) < 0.25 && !r.both) continue; // too small to mention
      total += w * stars;
      spread += w * Math.abs(stars);
      signals.push({ key: s.key, label: s.label, group: s.group, kind: s.kind, soft: !!(s.soft || r.soft), stars, weighted: w * stars, short: r.short, text: r.text, link: r.link, both: !!r.both, rivals: r.rivals || null, playing: r.playing || null });
    }
    const pick = mine ? fan.team : total > 0.05 ? g.home : total < -0.05 ? g.away : null;
    const sign = pick === g.home ? 1 : pick === g.away ? -1 : 0;
    for (const s of signals) s.rel = sign ? s.stars * sign : Math.abs(s.stars); // toward the pick
    // Strongest reason first; it's the one the collapsed card shows.
    signals.sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted));
    const strong = signals.filter((s) => Math.abs(s.weighted) >= 0.75);
    const conflict = !mine && strong.some((s) => s.stars > 0) && strong.some((s) => s.stars < 0);
    let split = null;
    if (conflict) {
      const forPick = strong.find((s) => s.rel > 0), against = strong.find((s) => s.rel < 0);
      if (forPick && against) {
        const other = pick === g.home ? g.away : g.home;
        const phrase = { conf: "your title race", rank: "your ranking", resume: "the teams you've played", rep: "league pride" };
        const say = (sg) => (sg.key === "rivals" && sg.rivals && sg.rivals.length ? `hurting ${name(ix, sg.rivals[0])}` : phrase[sg.key] || sg.label.toLowerCase());
        split = `Split: ${say(forPick)} says ${name(ix, pick)}; ${say(against)} says ${name(ix, other)}. Going with ${say(forPick)}.`;
      }
    }
    const u = (q) => 0.35 + 0.65 * Math.sqrt(4 * q * (1 - q));
    const spec = spectacle(ix, g, p);
    const stakes = Math.abs(total) + 0.5 * (spread - Math.abs(total));
    // Live: still in doubt, or already swung a long way from what was expected (an upset that's
    // actually happening is news even once it's nearly decided).
    const liveFactor = g.state === "in" ? Math.max(u(pNow), Math.min(1, 0.35 + 0.9 * Math.abs(pNow - p))) : u(p);
    const priority = mine ? 100 : stakes * liveFactor + 0.25 * spec;
    const prePriority = mine ? 100 : stakes * u(p) + 0.25 * spec;
    const result = g.done && !g.canceled && g.winner && pick ? (g.winner === pick ? "won" : "lost") : null;
    // The card's reason (and its radar group) is the strongest signal that agrees with the pick,
    // so the line under "Root for X" never argues against X; a disagreeing signal shows as Split.
    const lead = (pick && signals.find((s) => s.rel > 0)) || signals[0];
    const group = mine ? "mine" : lead ? lead.key : null;
    return {
      game: g, p, pNow, pick, mine, total, priority,
      stars: mine ? null : Math.round(toStars(priority, OVERALL_STEPS) * 2) / 2,
      preStars: mine ? null : Math.round(toStars(prePriority, OVERALL_STEPS) * 2) / 2,
      signals, conflict, split, spectacle: spec,
      group,
      rival: rivalOf(signals, pick, mine),
      routine: group === "rank" ? routineLadder(ix, fan, g, p, pNow) : group === "resume" ? routineResume(ix, g, p, pNow, pick) : false,
      routinePre: group === "rank" ? routineLadder(ix, fan, { ...g, state: "pre" }, p, p) : group === "resume" ? routineResume(ix, { ...g, state: "pre" }, p, p, pick) : false,
      reason: lead ? lead.short : null,
      heart: signals.some((s) => s.kind === "heart"),
      result,
    };
  }

  /** The rival a card is about: a rival who is playing and whom you're rooting against, whatever
   * reason leads; or, when the rival reason leads, the rival a result elsewhere would hurt. */
  function rivalOf(signals, pick, mine) {
    const s = signals.find((x) => x.key === "rivals" && x.rivals && x.rivals.length && !x.both);
    if (mine || !s) return null;
    if (s.playing && s.playing !== pick) return { id: s.playing, playing: true };
    if (!s.playing && signals[0] === s) return { id: s.rivals[0], playing: false };
    return null;
  }

  /** A playoff-ladder game that's business as usual: a ranked team expected to beat an unranked
   * one. It only matters when two ranked teams near you meet (a win can lift one past you, a loss
   * drop one below you), or when an upset is under way (the pre-game underdog is at 40% or
   * better live) or has happened. Ranks within 6 spots count as near; an unranked fan sits at 26. */
  const LADDER_NEAR = 6;
  /** An upset under way (the pre-game underdog at 40% or better live) or finished (it won). */
  function upsetShowing(g, dog, pDogNow) {
    if (g.state === "in") return pDogNow >= 0.4;
    return !!(g.done && !g.canceled && g.winner === dog);
  }
  function routineLadder(ix, fan, g, p, pNow) {
    const X = ix.teams.get(fan.team);
    const rX = (X && X.rank) || 26;
    const rH = (ix.teams.get(g.home) || {}).rank, rA = (ix.teams.get(g.away) || {}).rank;
    const clash = rH && rA && [rH, rA].some((r) => Math.abs(r - rX) <= LADDER_NEAR);
    const dogHome = p < 0.5;
    return !clash && !upsetShowing(g, dogHome ? g.home : g.away, dogHome ? pNow : 1 - pNow);
  }

  /** A Teams-you've-played game that's chalk: the team you want to win is a heavy favorite (75%
   * or better) against an unranked opponent, so the expected result does little for your record.
   * Shown anyway when it faces a ranked team or an upset is under way or has happened. */
  const CHALK_FAVORITE = 0.75;
  function routineResume(ix, g, p, pNow, pick) {
    if (!pick) return false;
    const opp = pick === g.home ? g.away : g.home;
    if ((ix.teams.get(opp) || {}).rank) return false;
    const pPick = pick === g.home ? p : 1 - p;
    return pPick >= CHALK_FAVORITE && !upsetShowing(g, opp, pick === g.home ? 1 - pNow : pNow);
  }

  /** Every game of `week`, scored for `fan` = {team, rivals: [ids], weights?, rivalsOf?}. */
  function scoreWeek(ix, fan, week) {
    const games = ix.data.games.filter((g) => g.week === week && !g.canceled);
    const rows = games.map((g) => scoreGame(ix, fan, g));
    rows.sort((a, b) => b.priority - a.priority || a.game.date.localeCompare(b.game.date));
    // Five stars are kept for the few games that matter most.
    let fives = 0;
    for (const r of rows) {
      if (r.stars === 5 && ++fives > MAX_FIVES) r.stars = 4.5;
      if (r.preStars === 5 && r.stars < 5) r.preStars = Math.min(r.preStars, 4.5);
    }
    const decided = rows.filter((r) => r.result && !r.mine && r.stars >= 2);
    return {
      rows,
      tally: { won: decided.filter((r) => r.result === "won").length, lost: decided.filter((r) => r.result === "lost").length },
    };
  }

  /** The "this week" summary: where your team stands, plus the games to pull for. */
  function headline(ix, fan, week, rows) {
    const X = ix.teams.get(fan.team);
    const n = name(ix, fan.team);
    const race = X && ix.data.confOdds[X.conf];
    const st = race && race.teams[fan.team];
    const own = rows.find((r) => r.mine);
    let stake;
    if (st && st.clinched) stake = `${n} has clinched a spot in the ${race.name} title game.`;
    else if (st && st.eliminated) stake = `${n} is out of the ${race.name} title race${X.rank ? `, but at No. ${X.rank} there's still ranking to play for` : ""}.`;
    else if (st && st.p != null) {
      const p = st.p;
      const mood = p >= 0.7 ? "in control of" : p >= 0.3 ? "in the thick of" : p >= 0.05 ? "hanging on in" : "on the edge of";
      stake = `${n} is ${mood} the ${race.name} race: ${pct(p)} to reach the title game.`;
    } else if (X && X.rank) stake = `${n} is No. ${X.rank}, and this week is about the rankings.`;
    else stake = `${n} is playing for pride and a bowl this week.`;
    const played = (r) => r.game.done && !r.game.canceled && r.game.winner;
    const picks = rows.filter((r) => !r.mine && r.pick && r.stars >= 3 && !r.conflict && !played(r)).slice(0, 3);
    let pull = "";
    if (own && played(own)) {
      const g = own.game, opp = g.home === fan.team ? g.away : g.home;
      const [us, them] = g.home === fan.team ? [g.homeScore, g.awayScore] : [g.awayScore, g.homeScore];
      pull = `${g.winner === fan.team ? "Beat" : "Lost to"} ${name(ix, opp)}${us != null ? ` ${us}-${them}` : ""}`;
    } else if (own) {
      const opp = own.game.home === fan.team ? own.game.away : own.game.home;
      pull = `Beat ${name(ix, opp)}`;
    }
    if (picks.length) {
      const list = picks.map((r) => name(ix, r.pick));
      const joined = list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0];
      pull = pull ? `${pull}, and pull for ${joined}.` : `Pull for ${joined}.`;
    } else if (pull) pull += ".";
    // The biggest game you're not in; when the next one is within half a star, both, since the
    // order between them is closer to a coin flip than a ranking.
    const others = rows.filter((r) => !r.mine && !(r.game.done && r.game.winner) && r.stars >= 3);
    const big = others.slice(0, others.length > 1 && others[1].stars >= others[0].stars - 0.5 ? 2 : 1);
    const matchup = (r) => `${name(ix, r.game.away)} ${r.game.neutral ? "vs" : "at"} ${name(ix, r.game.home)}`;
    let talk = null;
    if (big.length === 2) talk = `Two biggest games you're not in, about even: ${matchup(big[0])} and ${matchup(big[1])}.`;
    else if (big.length) talk = `Biggest game you're not in: ${matchup(big[0])}. ${big[0].reason}.`;
    return { stake, pull, picks, talk, biggest: big.map((r) => r.game.id) };
  }

  /** Live interest: how much a game in progress deserves attention right now. Rewards games
   * the fan already cares about, close late games, and underdogs leading. */
  function liveInterest(ix, r) {
    const g = r.game;
    if (g.state !== "in" || g.homeScore == null) return null;
    const margin = g.homeScore - g.awayScore;
    const period = g.period || 1;
    const late = Math.min(1, period / 4);
    const close = 1 - Math.min(1, Math.abs(margin) / 17);
    const leader = margin > 0 ? g.home : margin < 0 ? g.away : null;
    const pLeader = leader === g.home ? r.p : leader === g.away ? 1 - r.p : null;
    const upset = pLeader != null && pLeader < 0.35;
    const changes = g.leadChanges || 0;
    // r.stars already reflects the live odds; the rest rewards drama the odds don't capture.
    const score = (r.mine ? 10 : r.stars || 0) * (0.4 + 0.6 * close * late) + (upset ? 1.5 * late : 0) + Math.min(1, changes * 0.2);
    const climbed = !r.mine && r.stars != null && r.preStars != null ? r.stars - r.preStars : 0;
    let why = null;
    const q = period >= 5 ? "OT" : ["1st", "2nd", "3rd", "4th"][period - 1];
    if (upset && Math.abs(margin) > 0) why = `Upset watch: ${name(ix, leader)} leads in the ${q}`;
    else if (margin === 0 && period >= 3) why = `Tied in the ${q}`;
    else if (Math.abs(margin) <= 8 && period >= 4) why = `One-score game in the ${q}`;
    else if (changes >= 4) why = `${changes} lead changes`;
    const going = r.pick && leader ? (leader === r.pick ? "yes" : "no") : null;
    return { score, why, hot: !!why && (r.mine || (r.stars || 0) >= 2), going, upset, climbed };
  }

  // ---- after the final: records before and after a finished game -------------------------

  /** Games in the order they were played (kickoff, then id, so a tie still has an order). */
  const before = (a, b) => a.date < b.date || (a.date === b.date && String(a.id) < String(b.id));

  /** Which leagues a game is between, if it counts for league pride: two FBS teams from different
   * conferences, independents left out except Notre Dame (as repSignal counts them). */
  function crossLeague(ix, g) {
    const H = ix.teams.get(g.home), A = ix.teams.get(g.away);
    if (!H || !A || g.conf || !isFBS(ix, H.id) || !isFBS(ix, A.id) || H.conf === A.conf) return null;
    const ok = (t) => t.conf !== "18" || t.id === "87";
    return ok(H) && ok(A) ? [H.conf, A.conf] : null;
  }

  /** A conference's record against other leagues from the finished games played before g. */
  function leagueBefore(ix, conf, g) {
    const r = [0, 0];
    for (const x of ix.data.games) {
      if (!x.done || x.canceled || !x.winner || !before(x, g)) continue;
      const c = crossLeague(ix, x);
      if (!c || (c[0] !== conf && c[1] !== conf)) continue;
      r[ix.teams.get(x.winner).conf === conf ? 0 : 1]++;
    }
    return r;
  }

  // ---- estimated SOR and poll rank -----------------------------------------------------
  // Fitted to ESPN's weekly history for 2024 to 2026 (tools/backtest.py). ESPN's Strength of
  // Record is the chance an average Top 25 team would have your record or better against your
  // schedule, with each game's odds from FPI. With these settings the estimate lands within
  // about 0.7 places of ESPN's SOR rank across its Top 25, and its weekly move within about
  // 1.3 places, direction right nine times in ten.
  const SOR = { top25: 18, hfa: 3.5, sd: 15, fcs: -25 };
  // The poll a week on: last week's rank, plus 6 places a loss (10 to an unranked team), less one
  // a win over a ranked team, blended with the SOR estimate (the committee leans on résumé more
  // than AP voters do). Backtested within about 1.0 places of the CFP and 1.35 of the AP,
  // direction right about nine times in ten.
  const POLL = { loss: 6, badLoss: 4, bigWin: 1, sorAP: 0.05, sorCFP: 0.15, pool: 30 };

  /** Chance of at least k wins from games won with chances ps. */
  function atLeast(ps, k) {
    let dist = [1];
    for (const p of ps) {
      const nd = new Array(dist.length + 1).fill(0);
      dist.forEach((q, i) => { nd[i] += q * (1 - p); nd[i + 1] += q * p; });
      dist = nd;
    }
    return dist.slice(k).reduce((a, b) => a + b, 0);
  }

  /** Ranks from values, smallest first (ties by id, so the order is stable). */
  const ranksOf = (vals) => new Map([...vals].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([t], i) => [t, i + 1]));

  /** Estimated SOR ranks of every FBS team from the finished games keep() lets in. */
  function sorRanks(ix, keep) {
    const rec = new Map();
    for (const t of ix.data.teams) if (isFBS(ix, t.id)) rec.set(t.id, { ps: [], w: 0 });
    for (const g of ix.data.games) {
      if (!g.done || g.canceled || !g.winner || !keep(g)) continue;
      const site = g.neutral ? 0 : 1;
      for (const [t, o, s] of [[g.home, g.away, site], [g.away, g.home, -site]]) {
        const r = rec.get(t);
        if (!r) continue;
        const fo = (ix.teams.get(o) || {}).fpi;
        r.ps.push(normCdf((SOR.top25 - (fo ?? SOR.fcs) + SOR.hfa * s) / SOR.sd));
        if (g.winner === t) r.w++;
      }
    }
    return ranksOf([...rec].map(([t, r]) => [t, atLeast(r.ps, r.w)]));
  }

  /** Estimated poll ranks after the finished games keep() lets in that came after the poll. */
  function pollRanks(ix, keep, sor) {
    const poll = ix.data.poll || {};
    if (!poll.date || !poll.poll) return null;
    const a = poll.poll === "CFP" ? POLL.sorCFP : POLL.sorAP;
    const rk = (t) => (ix.teams.get(t) || {}).rank || null;
    const key = new Map();
    for (const t of ix.data.teams) {
      const s = sor.get(t.id);
      if (!rk(t.id) && !(s <= POLL.pool)) continue;
      const prev = rk(t.id) || 26 + (s - 1) * 0.3;
      key.set(t.id, (1 - a) * prev + a * s);
    }
    for (const g of ix.data.games) {
      if (!g.done || g.canceled || !g.winner || g.date < poll.date || !keep(g)) continue;
      const l = g.winner === g.home ? g.away : g.home;
      if (key.has(l)) key.set(l, key.get(l) + POLL.loss + (rk(g.winner) ? 0 : POLL.badLoss));
      if (key.has(g.winner) && rk(l)) key.set(g.winner, key.get(g.winner) - POLL.bigWin);
    }
    return ranksOf([...key]);
  }

  /** The fan's estimated poll and SOR ranks just before a finished game and just after it. */
  function estimates(ix, fan, g) {
    const memo = (ix.estMemo ||= new Map());
    let m = memo.get(g.id);
    if (!m) {
      const pre = (x) => before(x, g), post = (x) => x === g || before(x, g);
      const s0 = sorRanks(ix, pre), s1 = sorRanks(ix, post);
      const counts = ix.data.poll && ix.data.poll.date && g.date >= ix.data.poll.date;
      m = { s0, s1, p0: counts ? pollRanks(ix, pre, s0) : null, p1: counts ? pollRanks(ix, post, s1) : null };
      memo.set(g.id, m);
    }
    const t = fan.team;
    return { poll: (ix.data.poll || {}).poll, sor: [m.s0.get(t), m.s1.get(t)], rank: m.p0 ? [m.p0.get(t) || null, m.p1.get(t) || null] : null };
  }

  /**
   * The real moves a finished game of the fan's own made, once ESPN has published them:
   * { poll: { kind, move: [was, now] }, sor: [was, now] }, each missing until it's out (or when it can't be told
   * apart from another game of theirs). The poll is the one the page shows, from the release just
   * before the game to the first one after, so it's the week's move; the fan's only game that
   * week is the game. SOR snapshots are matched by games played, since ESPN fills in the current
   * week's as games finish.
   */
  function actual(ix, fan, g) {
    const t = fan.team, h = ix.data.history;
    if (!h || (g.home !== t && g.away !== t)) return {};
    const mine = ix.played.get(t) || [];
    const out = {};
    // Games before the committee's first Top 25 show the AP poll's move instead.
    for (const kind of new Set([(ix.data.poll || {}).poll, "AP"])) {
      const rel = h[kind] || [];
      const b = rel.filter((r) => r.date && r.date <= g.date).pop();
      const a = rel.find((r) => r.date && r.date > g.date);
      if (!b || !a) continue;
      if (!mine.some((x) => x !== g && x.date > b.date && x.date < a.date)) out.poll = { kind, move: [b.ranks[t] || null, a.ranks[t] || null] };
      break;
    }
    const n = mine.filter((x) => before(x, g)).length;
    const at = (k) => (h.SOR || []).filter((r) => r.ranks[t] && r.ranks[t][1] === k);
    const s0 = at(n).pop(), s1 = at(n + 1)[0];
    if (s0 && s1) out.sor = [s0.ranks[t][0], s1.ranks[t][0]];
    return out;
  }

  /**
   * What a finished game did for the fan beyond the title race: [{ key, label, items: [{ tag,
   * was, now, good }] }], a record as [wins, losses] and a rank as a number (null: unranked).
   *   rep   the fan's league against other leagues, when the game was one of those
   *   rank  the fan's poll rank (games since the poll only) and SOR rank (once the fan
   *         has played three games), when either moved and is near enough to matter (poll Top
   *         25, SOR Top 40). Estimated (est: true) until ESPN publishes the real move (see
   *         actual); labeled "Est. rank" while every item is an estimate, else "Rank".
   */
  function aftermath(ix, fan, g) {
    const X = ix.teams.get(fan.team);
    if (!X || !g.done || g.canceled || !g.winner) return [];
    const out = [];
    const c = crossLeague(ix, g);
    if (c && X.conf !== "18" && (c[0] === X.conf || c[1] === X.conf)) {
      const was = leagueBefore(ix, X.conf, g), won = ix.teams.get(g.winner).conf === X.conf;
      const cn = (ix.data.confs[X.conf] || {}).name || "Your league";
      out.push({ key: "rep", label: "Vs other leagues", items: [{ tag: cn, was, now: won ? [was[0] + 1, was[1]] : [was[0], was[1] + 1], good: won }] });
    }
    if (isFBS(ix, fan.team)) {
      const e = estimates(ix, fan, g), real = actual(ix, fan, g), items = [];
      const top = (r) => (r && r <= 25 ? r : null);
      const rank = real.poll ? real.poll.move : e.rank;
      if (rank && top(rank[0]) !== top(rank[1])) {
        const [w, n] = rank.map(top);
        items.push({ tag: real.poll ? real.poll.kind : e.poll, was: w, now: n, good: (n || 26) < (w || 26), est: !real.poll });
      }
      const [s0, s1] = real.sor || e.sor;
      // Early on SOR is mostly noise (every 1-0 team ties), so it waits for three games played.
      const seen = (ix.played.get(fan.team) || []).filter((x) => before(x, g)).length;
      if (seen >= 3 && s0 && s1 && s0 !== s1 && Math.min(s0, s1) <= 40) items.push({ tag: "SOR", was: s0, now: s1, good: s1 < s0, est: !real.sor });
      if (items.length) out.push({ key: "rank", label: items.every((it) => it.est) ? "Est. rank" : "Rank", items });
    }
    return out;
  }

  /** Default rivals from rivals.json (by abbreviation), as team ids. */
  function defaultRivals(ix, rivalsJson, tid) {
    const t = ix.teams.get(tid);
    return ((t && rivalsJson[t.abbr]) || []).map((a) => ix.byAbbr.get(a)).filter(Boolean);
  }

  const api = { SIGNALS, DEFAULT_WEIGHTS, STAR_STEPS, lines, toStars, index, pHome, liveP, name, scoreGame, scoreWeek, headline, liveInterest, defaultRivals, pct, aftermath };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FanScore = api;
})(typeof self !== "undefined" ? self : this);
