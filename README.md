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
  prices/summary.json   # { updatedAt, source, cardCount, cards: { <printingKey>: PriceRow } }
  report.json           # { updatedAt, stats, unresolved }  — what the join refused to pair
overrides/
  cm-expansions.json    # Cardmarket idExpansion -> our set code
  cm-pins.json          # Cardmarket idProduct -> our printing key (hand-checked)
```

`printingKey` is `cardId:setCode:collectorNumber` and must stay identical to `printingKey` in
the app's `lib/catalog.ts`. It is the contract between the two repos.

A `PriceRow` carries every figure Cardmarket publishes for the paired product, so a reader can
check the app against the source instead of wondering why two numbers disagree:

| field | Cardmarket calls it | note |
| --- | --- | --- |
| `eur` | Price Trend | the headline, and what all value math uses |
| `low` | **From** | the cheapest current listing — usually well below trend |
| `avg` | all-time average sell price | |
| `avg1`, `avg7`, `avg30` | 1/7/30-days average price | **null on every Cyberpunk row today** — nothing has sold often enough |
| `cm` | — | the `idProduct` this was paired with: the audit trail for a price |
| `d7`, `d30` | — | how far `eur` sits above `avg7` / `avg30`; null until Cardmarket computes those |

The three numbers that look inconsistent but are not: for Adam Smasher β141, `low` is €60,
`eur` (trend) is €73, and a holding of 2 copies is worth €146. Different measures, not a
disagreement.

## This build keeps no state

Everything here is recomputed from one nightly download. There is no accumulated series, and a
missed run costs nothing — the next one is just as complete.

That is deliberate. Cardmarket already tracks sales over 1, 7 and 30 days and publishes the
averages, so keeping a parallel daily series would duplicate their work and make a missed night
a permanent hole. `d7` and `d30` are derived from their own averages: how far the trend sits
above `avg7` / `avg30`.

**Today every Cyberpunk row reads null for those**, because they are averages of real sales and
the game is pre-retail. They populate on Cardmarket's side as the game sells — for One Piece
they are filled on 11,448 of 12,518 rows. The app shows a dash until then.

The one thing this design gives up is a portfolio-value-over-time chart, which would need a
series nobody publishes. The app does not draw one (`history={null}`), so nothing is lost today;
if it is ever wanted, that is the moment to decide whether it is worth becoming stateful for.

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
- a pin names a printing that no longer exists (`pin-target-missing`)

A product with **no trend price is ignored rather than flagged**: it can never contribute a
price, so letting it count toward a group's size only blocked pairs that were otherwise
unambiguous. Removing it took the paired count from 209 to 211 and the residue from 4 groups
to 2.

Alt arts are a **rarity tier** in this game, not a finish: `finish` is null on all 509
printings, and the `Iconic Legend` / `Iconic Other` / `Iconic Secret` tiers are the alt arts.

### Current state

```
printings: 509 | cm products: 296 | price rows: 317
paired: 215 (211 automatic, 4 pinned) | flagged: 0 | products in unmapped expansions: 35
priced printings: 215 of 509
```

**215 of 509 is not a failure.** Cardmarket lists only what is sellable, and the game does not
reach retail until November 2026 — so the retail sets have no products at all, and many beta
products have never sold and carry no trend. A printing with no price shows a dash in the app,
never a zero.

`idExpansion 6722` (35 products, 6 duplicate names inside it, 2 priced) matches no single set —
best score 31.6% — and is deliberately left unmapped and unpriced.

### What needed a hand, and how it was settled

Nothing is refused today. Four products were pinned by hand on 2026-09-18:

| Group | Why the join would not decide it |
| --- | --- |
| `rebecca having a moment` @ PRM01 | We hold two printings (005, 007, both Nova Rare), Cardmarket lists one priced product. |
| `v streetkid` @ WTNC Beta | β005a and β005b are both Rare, at €0.24 and €0.30 — price cannot separate same-tier printings, and by design this join refuses to try. |

Both were resolved by reading `Number` off the Cardmarket product page, which carries the
collector number even though the bulk files do not.

**Read the expansion, never the number alone.** Cardmarket strips the `β` prefix, so its
`Number: 005a` is our `β005a` in a Beta expansion and our `005a` in a Retail one — and **146 of
172 beta printings share a stripped number with a retail printing**. The set always comes from
`cm-expansions.json`, and the page's `Printed in` line is the cross-check. The admin console's
**Cyberpunk price pins** module enforces this: it only offers the printings of the set the
product's expansion already resolved to.

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
