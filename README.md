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

The weighted signals add up to the pick. A game is **Conflicted** when strong signals point
different ways. A game's overall stars weigh the stakes by how uncertain the game is, plus a
little for spectacle (ranked teams, a close line, prime time). Your own game is always first.
Weights default to `DEFAULT_WEIGHTS` and fans can adjust them on the page; rivals default to
[`rivals.json`](rivals.json) (by ESPN abbreviation) and fans can edit them. Both are kept in
the browser.

The page has three card styles to compare: per-signal **stars** (negative when a signal pulls
against the pick), a **tug-of-war** bar per signal, and **chips** with a single meter.

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
- Live scores during games (Title Paths' worker pattern), and postseason/bowl weeks.
- A real name and domain.
