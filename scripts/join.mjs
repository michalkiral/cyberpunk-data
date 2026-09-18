// Pairing Cardmarket products with our printings. Pure: no fetching, no files.
//
// Cardmarket's bulk downloads carry `idProduct, name, idCategory, idExpansion,
// idMetacard, dateAdded` and nothing else — no rarity, no expansion name — and
// cardmarket.com answers 403 to every non-browser client, so the product page
// cannot fill the gaps. The join therefore has to be built out of what the two
// sides independently agree on.

/** Card names match exactly once punctuation and case are ignored. */
export function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The app's printing key. Must stay identical to lib/catalog.ts printingKey. */
export function printingKey(cardId, setCode, collectorNumber) {
  if (!setCode) {
    return cardId;
  }
  return collectorNumber ? `${cardId}:${setCode}:${collectorNumber}` : `${cardId}:${setCode}`;
}

/**
 * How special a printing is. Alt arts are a rarity TIER in this game, not a
 * finish — `finish` is null on all 509 printings — and the Iconic tiers are the
 * alt arts. Anything unknown sorts as a base printing, which is the safe
 * default: it can only ever cause a flag, never a silent pairing.
 */
const TIER = {
  Common: 0,
  Uncommon: 0,
  Rare: 0,
  Epic: 0,
  Secret: 0,
  "Nova Rare": 1,
  "Iconic Other": 2,
  "Iconic Legend": 2,
  "Iconic Secret": 2,
};

export function tierOf(rarity) {
  return TIER[rarity] ?? 0;
}

/**
 * How well a Cardmarket expansion's contents match one of our sets, over names
 * AND how many products each name has. The multiplicities are what make this
 * work: before alt arts were loaded, Beta and Retail held identical name sets
 * and tied at 100%. With them, Welcome to Night City — Beta scores 99.4% and
 * Retail 84.4%.
 */
export function profileScore(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let shared = 0;
  let total = 0;
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    shared += Math.min(x, y);
    total += Math.max(x, y);
  }
  return total === 0 ? 0 : shared / total;
}

function countByName(items, nameOf) {
  const counts = {};
  for (const item of items) {
    const key = nameOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Scores every Cardmarket expansion against every one of our sets. The result
 * is a REPORT, not a decision: the mapping itself lives in
 * `overrides/cm-expansions.json` because it is a judgement that should not
 * change silently. The build compares the two and fails if a recorded mapping
 * is no longer the best match — which is how the retail launch in November,
 * when a twin expansion appears, will announce itself instead of quietly
 * re-pointing every price.
 */
export function scoreExpansions(products, printings) {
  const byExpansion = new Map();
  for (const product of products) {
    const list = byExpansion.get(product.idExpansion) ?? [];
    list.push(product);
    byExpansion.set(product.idExpansion, list);
  }
  const bySet = new Map();
  for (const printing of printings) {
    const list = bySet.get(printing.setCode) ?? [];
    list.push(printing);
    bySet.set(printing.setCode, list);
  }

  const report = [];
  for (const [idExpansion, group] of byExpansion) {
    const profile = countByName(group, (p) => normalizeName(p.name));
    const ranked = [...bySet.entries()]
      .map(([setCode, list]) => ({
        setCode,
        printings: list.length,
        score: profileScore(profile, countByName(list, (p) => normalizeName(p.cardName))),
      }))
      .sort((a, b) => b.score - a.score);
    report.push({ idExpansion, products: group.length, ranked });
  }
  return report.sort((a, b) => b.products - a.products);
}

/**
 * Pairs each Cardmarket product with one of our printings.
 *
 * Three stages, each checkable on its own:
 *
 *   1. product name → card. Exact; every card name matches a product name.
 *   2. idExpansion → set, from the recorded mapping.
 *   3. within a (card, set) group → which printing. Our printings ranked by
 *      rarity tier against Cardmarket's products ranked by price.
 *
 * Stage 3 is NOT the heuristic that sank the OPTCG version of this work. There,
 * products were ranked by OUR price, which came from the same upstream, so a
 * wrong pairing agreed with itself and nothing could detect it. Here the rarity
 * tier comes from the card database and the price from Cardmarket: two
 * independent sources. Disagreement is therefore evidence, and this function
 * FLAGS it rather than resolving it.
 *
 * A group is only paired automatically when the counts match and both sides
 * rank unambiguously. Same-tier siblings are never guessed at — six cents
 * between two Rares is a coin flip, and a coin flip is what a pin is for.
 */
export function joinPrices({ products, priceRows, printings, expansions, pins = {} }) {
  const priceOf = new Map(priceRows.map((row) => [row.idProduct, row]));
  const trendOf = (product) => priceOf.get(product.idProduct)?.trend ?? null;

  const ourGroups = new Map();
  for (const printing of printings) {
    const key = `${printing.setCode}|${normalizeName(printing.cardName)}`;
    const list = ourGroups.get(key) ?? [];
    list.push(printing);
    ourGroups.set(key, list);
  }

  const theirGroups = new Map();
  for (const product of products) {
    const setCode = expansions[product.idExpansion];
    if (!setCode) {
      continue;
    }
    const key = `${setCode}|${normalizeName(product.name)}`;
    const list = theirGroups.get(key) ?? [];
    list.push(product);
    theirGroups.set(key, list);
  }

  const prices = {};
  const unresolved = [];
  const stats = { paired: 0, pinned: 0, automatic: 0, flagged: 0, unmappedExpansion: 0 };

  for (const product of products) {
    if (!expansions[product.idExpansion]) {
      stats.unmappedExpansion += 1;
    }
  }

  const assign = (printing, product, how) => {
    const row = priceOf.get(product.idProduct);
    if (!row || row.trend === null || row.trend === undefined) {
      return;
    }
    // Every figure Cardmarket publishes for the product, not just the headline.
    // `low` is the "From" price on their page and `avg1`/`avg7`/`avg30` are the
    // averages it lists as N/A when nothing has sold — showing all of them is
    // what lets a reader check us against the source instead of wondering why
    // one number disagrees with another that measures something else.
    prices[printingKey(printing.cardId, printing.setCode, printing.collectorNumber)] = {
      eur: row.trend,
      low: row.low ?? null,
      avg: row.avg ?? null,
      avg1: row.avg1 ?? null,
      avg7: row.avg7 ?? null,
      avg30: row.avg30 ?? null,
      cm: product.idProduct,
    };
    stats.paired += 1;
    stats[how] += 1;
  };

  for (const [key, theirs] of theirGroups) {
    const ours = ourGroups.get(key) ?? [];

    // A pin always wins. It is a hand-checked pairing, so it also rescues a
    // group the automatic stages refuse to touch.
    const pinnedHere = theirs.filter((product) => pins[String(product.idProduct)]);
    for (const product of pinnedHere) {
      const wanted = pins[String(product.idProduct)];
      const printing = ours.find(
        (p) => printingKey(p.cardId, p.setCode, p.collectorNumber) === wanted,
      );
      if (printing) {
        assign(printing, product, "pinned");
      } else {
        unresolved.push({ key, reason: "pin-target-missing", idProduct: product.idProduct, wanted });
      }
    }
    // A product with no trend price can never produce a price, so it must not
    // count toward the group's size either — letting it do so blocked pairs
    // that were otherwise unambiguous (a card with two printings and two priced
    // products plus one that has never sold).
    const theirsLeft = theirs.filter(
      (product) => !pins[String(product.idProduct)] && trendOf(product) !== null,
    );
    const oursLeft = ours.filter(
      (p) =>
        !Object.values(pins).includes(printingKey(p.cardId, p.setCode, p.collectorNumber)),
    );
    if (theirsLeft.length === 0) {
      continue;
    }

    const describeOurs = (list) =>
      list.map((p) => ({
        key: printingKey(p.cardId, p.setCode, p.collectorNumber),
        collectorNumber: p.collectorNumber,
        rarity: p.rarity,
      }));
    const describeTheirs = (list) =>
      list.map((product) => ({ idProduct: product.idProduct, trend: trendOf(product) }));

    if (oursLeft.length === 0) {
      unresolved.push({
        key,
        reason: "no-printing",
        ours: [],
        theirs: describeTheirs(theirsLeft),
      });
      stats.flagged += theirsLeft.length;
      continue;
    }

    // Exactly one each way: there is no choice to make, so no ranking is used
    // and nothing can be got wrong.
    if (theirsLeft.length === 1 && oursLeft.length === 1) {
      assign(oursLeft[0], theirsLeft[0], "automatic");
      continue;
    }

    if (theirsLeft.length !== oursLeft.length) {
      unresolved.push({
        key,
        reason: "count-mismatch",
        ours: describeOurs(oursLeft),
        theirs: describeTheirs(theirsLeft),
      });
      stats.flagged += theirsLeft.length;
      continue;
    }

    const trends = theirsLeft.map(trendOf);
    const tiers = oursLeft.map((p) => tierOf(p.rarity));
    if (new Set(tiers).size !== oursLeft.length || new Set(trends).size !== trends.length) {
      unresolved.push({
        key,
        reason: "tied-rank",
        ours: describeOurs(oursLeft),
        theirs: describeTheirs(theirsLeft),
      });
      stats.flagged += theirsLeft.length;
      continue;
    }

    const byTier = [...oursLeft].sort((a, b) => tierOf(a.rarity) - tierOf(b.rarity));
    const byPrice = [...theirsLeft].sort((a, b) => trendOf(a) - trendOf(b));
    for (let i = 0; i < byTier.length; i += 1) {
      assign(byTier[i], byPrice[i], "automatic");
    }
  }

  return { prices, unresolved, stats };
}
