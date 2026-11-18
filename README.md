# Rooting Guide (working name)

Pick your college football team and see this week's games that matter to you: who to root
for, and why, from signals that can disagree. A companion to [Title Paths](https://titlepaths.com),
which supplies the exact conference-race odds.

## How a game is scored

For your team X and a game A vs B, each signal gives a signed 0–5 star value (positive: root
for the home team), from [`score.js`](score.js):

| Signal | What it measures | Basis |
|---|---|---|
| Conference race | Your title-game odds if A wins vs if B wins | **Exact**, from Title Paths' published `exact` block |
| Rankings | Teams ranked just above you losing (and falling below you), or teams below you winning and passing you; heavier near the playoff lines (4 and 12 now; 8, 16, 24 from 2027) | Estimate |
| Résumé | Teams you beat (or lost to) winning; more when it gets them ranked or bowl-eligible | Estimate |
| Conference reputation | Your league's non-conference results | Soft |
| Rivals | Your rivals losing (pain: their title odds, ranking, bowl hopes, losing to their own rival, losing as the favorite), and other games that dent their title odds | Heart |

The weighted signals add up to the pick. A game is a **Split** when strong signals point
different ways. A game's overall stars weigh the stakes by how uncertain the game is, plus a
little for spectacle (ranked teams, a close line, prime time); only three games a week get five. Your own game is always first, with no stars.
Weights default to `DEFAULT_WEIGHTS` and fans can adjust them on the page; rivals default to
[`rivals.json`](rivals.json) (by ESPN abbreviation) and fans can edit them. Both are kept in
the browser.

## The page

One page, with detail on demand, for both the casual fan and the die-hard:

- **This week:** where your team stands in one sentence, who to pull for, and the biggest game
  you're not in (`headline()` in `score.js`).
- **Live now** (game days): games under way, ordered by `liveInterest()`, which multiplies a
  game's stars by how close and how late it is, plus upsets in progress and lead changes. At most
  one card pulses, and at most one low-rated game gets in (a late upset with a side to take).
- **Your game**, then **Must-watch**: up to five games of three stars or more, no more than two
  from any one signal, in kickoff order.
- **Also on your radar:** the rest, grouped by their strongest signal (title race, playoff
  ladder, rival watch, teams you've played, league pride) as collapsed one-line rows.
- **Final:** finished games and whether they went your way.

A card shows the pick and its single strongest reason; **Why** opens a tug-of-war bar per signal
(colored by the team it pulls toward), the numbers behind each, and the win odds. "⇄ Split" marks
games whose strong signals disagree, with a sentence saying which wins. Rivals and weights live
behind the gear. `?demo=live` fakes finished and in-progress games for this week, to see the
game-day layout without real scores.

## Data

[`fetch.py`](fetch.py) writes `data.json`: every game with an FBS team this season (ESPN
scoreboard, one call a week), ESPN's matchup-predictor odds for this week's and next week's
games, the CFP Top 25 (or the AP poll before it starts), FPI, and Title Paths' conference odds.
Visitors only read the static file. [`.github/workflows/update.yml`](.github/workflows/update.yml)
runs the tests, fetches and deploys to GitHub Pages.

`tools/fixture_from_titlepaths.py` builds the same shape offline from Title Paths' published
`page-data.json` files plus one ESPN scoreboard; the `data.json` committed now is such a
fixture (week 12 of 2026, marked as test data on the page).

## Develop

```bash
node --test test/
python3 -m http.server 8765
```

## Not done yet

- A committee model to replace the ranking and résumé heuristics, backtested against the CFP's weekly rankings.
- Real live updates: polling (or Title Paths' live-scores worker), in-game win-probability charts, and lead-change counts. `fetch.py` already records state, period, clock and in-game scores.
- Postseason and bowl weeks.
- A real name and domain.
