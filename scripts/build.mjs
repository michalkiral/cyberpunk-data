// Nightly build: read our printings from the card database, read Cardmarket's
// public price guide, pair them, write the prices the app fetches.
//
// Cardmarket cannot be read from the browser — downloads.s3.cardmarket.com
// sends no Access-Control-Allow-Origin and 403s the CORS preflight — which is
// the whole reason this repo exists.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinPrices, normalizeName, scoreExpansions } from "./join.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARDS = "https://api.netdeck.gg/api/cards/cyberpunk";
const CM = "https://downloads.s3.cardmarket.com/productCatalog";

/** Cyberpunk is idGame 23 — found by reading categoryName out of each game's product list. */
const GAME = 23;

/** Days of EUR history kept. Cardmarket publishes no rolling averages for this
 * game (avg1/avg7/avg30 are null on every row), so this series is the only
 * source of movers, d7/d30 and the value chart — and it can only ever start
 * accumulating from the first run. */
const HISTORY_DAYS = 120;

/** Per-card requests in flight. A third party's free API, not ours to hammer. */
const CONCURRENCY = 8;

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return response.json();
}

async function pool(items, worker) {
  const out = [];
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      out.push(await worker(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return out;
}

/**
 * Every printing, as the app sees it. The set listing returns one row per card
 * per set and leaves `printings` empty, so a card printed twice in one set
 * hides its alt art there; only the per-card endpoint has them.
 */
async function fetchPrintings() {
  const { filters } = await getJson(`${CARDS}/filters`);
  const sets = filters.find((f) => f.key === "set")?.options ?? [];
  if (sets.length === 0) {
    throw new Error("card database published no sets — refusing to build against nothing");
  }

  const slugs = new Set();
  for (const set of sets) {
    let offset = 0;
    for (;;) {
      const page = await getJson(`${CARDS}?limit=100&offset=${offset}&set=${encodeURIComponent(set.code)}`);
      const items = page.items ?? [];
      for (const item of items) {
        if (item.slug) {
          slugs.add(item.slug);
        }
      }
      if (items.length < 100) {
        break;
      }
      offset += 100;
    }
  }

  const details = await pool([...slugs], (slug) =>
    getJson(`${CARDS}/${encodeURIComponent(slug)}`).catch(() => null),
  );

  const printings = [];
  for (const detail of details) {
    if (!detail) {
      continue;
    }
    const cardName = detail.subname ? `${detail.name} - ${detail.subname}` : detail.name;
    for (const printing of detail.printings ?? []) {
      printings.push({
        cardId: detail.external_id,
        cardName,
        setCode: printing.set?.code ?? "",
        collectorNumber: printing.collector_number,
        rarity: printing.rarity ?? "",
      });
    }
  }
  return printings;
}

async function fetchCardmarket() {
  const [guide, singles] = await Promise.all([
    getJson(`${CM}/priceGuide/price_guide_${GAME}.json`),
    getJson(`${CM}/productList/products_singles_${GAME}.json`),
  ]);
  return { priceRows: guide.priceGuides ?? [], products: singles.products ?? [] };
}

async function readOverride(name, fallback) {
  try {
    return JSON.parse(await readFile(join(ROOT, "overrides", name), "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * The recorded expansion mapping is a judgement, not a computation, so the
 * build verifies rather than re-derives it: each recorded set must still be
 * among the best matches for its expansion. When retail ships in November a
 * twin expansion appears and the profiles move — this is what makes that
 * announce itself instead of quietly re-pointing every price.
 */
function verifyExpansions(expansions, report) {
  const problems = [];
  for (const row of report) {
    const recorded = expansions[row.idExpansion];
    if (!recorded) {
      continue;
    }
    const best = row.ranked[0]?.score ?? 0;
    const mine = row.ranked.find((r) => r.setCode === recorded)?.score ?? 0;
    if (mine < best - 1e-9) {
      problems.push(
        `expansion ${row.idExpansion} is recorded as ${recorded} (${(mine * 100).toFixed(1)}%) ` +
          `but ${row.ranked[0].setCode} now matches better (${(best * 100).toFixed(1)}%)`,
      );
    }
  }
  return problems;
}

function movement(history, key, days) {
  const dates = Object.keys(history).sort();
  if (dates.length < 2) {
    return 0;
  }
  const today = history[dates[dates.length - 1]]?.[key];
  const thenDate = dates[Math.max(0, dates.length - 1 - days)];
  const then = history[thenDate]?.[key];
  if (!today || !then || then === 0) {
    return 0;
  }
  return Math.round(((today - then) / then) * 1000) / 10;
}

async function main() {
  const reportOnly = process.argv.includes("--report");

  const [printings, { priceRows, products }] = await Promise.all([
    fetchPrintings(),
    fetchCardmarket(),
  ]);
  console.log(`printings: ${printings.length} | cm products: ${products.length} | price rows: ${priceRows.length}`);

  const expansions = await readOverride("cm-expansions.json", {});
  const pins = await readOverride("cm-pins.json", {});
  const scored = scoreExpansions(products, printings);

  const problems = verifyExpansions(expansions, scored);
  if (problems.length > 0) {
    console.error("\nEXPANSION MAPPING NO LONGER HOLDS:");
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error("\nReview overrides/cm-expansions.json before this build is trusted.");
    process.exit(1);
  }

  const { prices, unresolved, stats } = joinPrices({
    products,
    priceRows,
    printings,
    expansions,
    pins,
  });

  console.log(
    `\npaired: ${stats.paired} (${stats.automatic} automatic, ${stats.pinned} pinned) | ` +
      `flagged: ${stats.flagged} | products in unmapped expansions: ${stats.unmappedExpansion}`,
  );
  console.log(`priced printings: ${Object.keys(prices).length} of ${printings.length}`);

  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} group(s) need a pin:`);
    for (const row of unresolved) {
      const ours = (row.ours ?? []).map((p) => `${p.collectorNumber}/${p.rarity}`).join(", ");
      const theirs = (row.theirs ?? []).map((p) => `${p.idProduct}@${p.trend}`).join(", ");
      console.log(`  ${row.reason.padEnd(18)} ${row.key}
      ours   [${ours}]
      theirs [${theirs}]`);
    }
  }

  if (reportOnly) {
    console.log("\n--report: nothing written.");
    console.log("\nexpansion scores:");
    for (const row of scored) {
      const top = row.ranked
        .slice(0, 2)
        .map((r) => `${r.setCode} ${(r.score * 100).toFixed(1)}%`)
        .join("  ");
      console.log(`  ${row.idExpansion} (${row.products}) -> ${top}`);
    }
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const historyPath = join(ROOT, "data", "prices", "history.json");
  let history = {};
  try {
    history = JSON.parse(await readFile(historyPath, "utf8")).days ?? {};
  } catch {
    history = {};
  }
  history[today] = Object.fromEntries(
    Object.entries(prices).map(([key, value]) => [key, value.eur]),
  );
  const kept = Object.keys(history).sort().slice(-HISTORY_DAYS);
  history = Object.fromEntries(kept.map((date) => [date, history[date]]));

  const cards = {};
  for (const [key, value] of Object.entries(prices)) {
    cards[key] = {
      eur: value.eur,
      cm: value.cm,
      d7: movement(history, key, 7),
      d30: movement(history, key, 30),
    };
  }

  await mkdir(join(ROOT, "data", "prices"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "prices", "summary.json"),
    `${JSON.stringify({ updatedAt: today, source: `cardmarket.com price guide (idGame ${GAME})`, cardCount: Object.keys(cards).length, cards }, null, 0)}\n`,
  );
  await writeFile(historyPath, `${JSON.stringify({ days: history }, null, 0)}\n`);
  await writeFile(
    join(ROOT, "data", "report.json"),
    `${JSON.stringify({ updatedAt: today, stats, unresolved }, null, 2)}\n`,
  );
  console.log(`\nwrote data/prices/summary.json (${Object.keys(cards).length} printings)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
