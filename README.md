# cyberpunk-data

EUR prices for the **Cyberpunk TCG**, joined from Cardmarket's public price guide onto the
printing keys [The Lab](https://github.com/michalkiral/portfolio)'s Cyberpunk Collection app
uses, and served over jsDelivr.

There is no card data here. The catalog comes live from the official database
(`api.netdeck.gg`), which is CORS-open and needs no key. This repo exists for one reason:
**Cardmarket cannot be read from a browser.** `downloads.s3.cardmarket.com` sends no
`Access-Control-Allow-Origin` and answers `403` to the CORS preflight, so a static site
cannot fetch it. A nightly Action can.

## Data layout

```
data/
  prices/summary.json   # { updatedAt, source, cardCount, cards: { <printingKey>: { eur, cm, d7, d30 } } }
  prices/history.json   # { days: { "YYYY-MM-DD": { <printingKey>: eur } } }  — rolling 120 days
  report.json           # { updatedAt, stats, unresolved }  — what the join refused to pair
overrides/
  cm-expansions.json    # Cardmarket idExpansion -> our set code
  cm-pins.json          # Cardmarket idProduct -> our printing key (hand-checked)
```

`printingKey` is `cardId:setCode:collectorNumber` and must stay identical to `printingKey` in
the app's `lib/catalog.ts`. It is the contract between the two repos.

## Why the history file matters

Cardmarket publishes `avg1`, `avg7` and `avg30` for other games. **For Cyberpunk they are null
on every row.** So movers, `d7`/`d30` and any value-over-time chart can only come from a series
we accumulate ourselves, and it can only ever start from the first run — a day not recorded is
a day that cannot be recovered later.

## The join

Cardmarket's bulk files carry `idProduct, name, idCategory, idExpansion, idMetacard, dateAdded`
— **no rarity and no expansion name** — and cardmarket.com answers 403 to every non-browser
client, so the product page cannot fill the gaps. The join is built from what the two sides
independently agree on, in three stages:

1. **Product name → card.** Exact. Every one of the 151 card names matches a product name, in
   the form `"Name - Subname"`.
2. **idExpansion → set.** Recorded in `overrides/cm-expansions.json`. The build *verifies* it
   rather than deriving it: each recorded set must still be among the best matches by name and
   multiplicity profile, or the build fails. The alt arts are what make this possible — before
   they were loaded, Beta and Retail held identical name sets and tied at 100%; with them,
   Welcome to Night City — Beta scores **99.4%** against Retail's 84.4%.
3. **Within a (card, set) group → which printing.** Our printings ranked by rarity tier against
   Cardmarket's products ranked by price.

### Why stage 3 is not the mistake that sank the One Piece version

The OPTCG attempt at this was dropped partly because its join ranked products by **our own
price**, which came from the same upstream. A wrong pairing therefore agreed with itself, and
no check could see it fail.

Here the two signals are **independent**: the rarity tier comes from the card database, the
price from Cardmarket. Disagreement is evidence. The join **flags** it instead of resolving it,
and refuses a group whenever:

- the two sides hold different numbers of things (`count-mismatch`)
- both sides cannot be ranked unambiguously (`tied-rank`) — two same-rarity siblings six cents
  apart is a coin flip, and a coin flip is what a pin is for
- a product carries no trend price (`unpriced-product`)
- a pin names a printing that no longer exists (`pin-target-missing`)

Alt arts are a **rarity tier** in this game, not a finish: `finish` is null on all 509
printings, and the `Iconic Legend` / `Iconic Other` / `Iconic Secret` tiers are the alt arts.

### Current state

```
printings: 509 | cm products: 296 | price rows: 317
paired: 209 (209 automatic, 0 pinned) | flagged: 8 | products in unmapped expansions: 35
priced printings: 209 of 509
```

**209 of 509 is not a failure.** Cardmarket lists only what is sellable, and the game does not
reach retail until November 2026 — so the retail sets have no products at all, and many beta
products have never sold and carry no trend. A printing with no price shows a dash in the app,
never a zero.

`idExpansion 6722` (35 products, 6 duplicate names inside it, 2 priced) matches no single set —
best score 31.6% — and is deliberately left unmapped and unpriced.

### What needs a hand today

Four groups, all correctly refused:

| Group | Why |
| --- | --- |
| `tetratonic rippler` @ The Heist starter | Cardmarket sells it; **the card database does not have the card**. Nothing to pin to. |
| `rebecca having a moment` @ PRM01 | We hold two printings (005, 007, both Nova Rare), Cardmarket lists one. |
| `v streetkid` @ WTNC Beta | β005a and β005b are both Rare, at €0.24 and €0.30. |
| `johnny silverhand never stop fighting` @ WTNC Beta | We hold 2 beta printings, Cardmarket has 3 products in that expansion. |

A pin is a **pairing, never a price**. Upstream corrects itself — Limitless once had a One Piece
card's base and alt values crossed and repaired it within a day — so a stored price would keep
re-applying and silently turn a corrected number back into a wrong one.

## Pipeline

```bash
npm test      # the join, unit-tested with fixtures
npm run report  # run the whole join against live data and print what it refused; writes nothing
npm run build   # the same, and write data/
```

Roughly 170 requests per run: the filter schema, 15 set listings, 151 per-card endpoints (the
only ones that populate `printings`), and 2 Cardmarket downloads totalling ~110 KB.

## Expiry to watch

Stage 2 currently leans on retail not existing yet. **When retail ships in November 2026** a
twin expansion appears, the profiles move, and `verifyExpansions` fails the build rather than
letting prices re-point silently. That failure is the signal to record the new mapping by hand.
