import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  joinPrices,
  movement,
  normalizeName,
  printingKey,
  profileScore,
  tierOf,
} from "./join.mjs";

const printing = (cardId, setCode, collectorNumber, rarity, cardName) => ({
  cardId,
  setCode,
  collectorNumber,
  rarity,
  cardName,
});

const product = (idProduct, name, idExpansion) => ({ idProduct, name, idExpansion });

const EXPANSIONS = { 6714: "wtncbeta" };

describe("normalizeName", () => {
  it("ignores the punctuation the two sides disagree about", () => {
    assert.equal(normalizeName("Judy Álvarez - Braindance Maestro"), normalizeName("judy álvarez  braindance maestro"));
  });
});

describe("profileScore", () => {
  it("separates two sets that hold the same names in different numbers", () => {
    const cardmarket = { judy: 2, v: 1 };
    const beta = { judy: 2, v: 1 };
    const retail = { judy: 1, v: 1 };

    assert.equal(profileScore(cardmarket, beta), 1);
    assert.ok(profileScore(cardmarket, retail) < 1);
  });
});

describe("joinPrices", () => {
  it("pairs a lone product with a lone printing, with no ranking involved", () => {
    const { prices, stats } = joinPrices({
      products: [product(1, "Judy", 6714)],
      priceRows: [{ idProduct: 1, trend: 12.5 }],
      printings: [printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy")],
      expansions: EXPANSIONS,
    });

    assert.equal(prices["cb-judy:wtncbeta:β108"].eur, 12.5);
    assert.equal(prices["cb-judy:wtncbeta:β108"].cm, 1);
    assert.equal(stats.automatic, 1);
  });

  it("carries every figure Cardmarket publishes, not just the headline", () => {
    const { prices } = joinPrices({
      products: [product(1, "Judy", 6714)],
      priceRows: [{ idProduct: 1, trend: 73, low: 60, avg: null, avg1: null, avg7: 12, avg30: 15 }],
      printings: [printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy")],
      expansions: EXPANSIONS,
    });

    assert.deepEqual(prices["cb-judy:wtncbeta:β108"], {
      eur: 73,
      low: 60,
      avg: null,
      avg1: null,
      avg7: 12,
      avg30: 15,
      d7: movement(73, 12),
      d30: movement(73, 15),
      cm: 1,
    });
  });

  it("gives the dearer product to the Iconic printing", () => {
    const { prices } = joinPrices({
      products: [product(1, "Judy", 6714), product(2, "Judy", 6714)],
      priceRows: [
        { idProduct: 1, trend: 10 },
        { idProduct: 2, trend: 440 },
      ],
      printings: [
        printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy"),
        printing("cb-judy", "wtncbeta", "β157", "Iconic Legend", "Judy"),
      ],
      expansions: EXPANSIONS,
    });

    assert.equal(prices["cb-judy:wtncbeta:β108"].eur, 10);
    assert.equal(prices["cb-judy:wtncbeta:β157"].eur, 440);
  });

  it("refuses to guess between two printings of the same rarity", () => {
    const { prices, unresolved, stats } = joinPrices({
      products: [product(1, "V", 6714), product(2, "V", 6714)],
      priceRows: [
        { idProduct: 1, trend: 0.24 },
        { idProduct: 2, trend: 0.3 },
      ],
      printings: [
        printing("cb-v", "wtncbeta", "β005a", "Rare", "V"),
        printing("cb-v", "wtncbeta", "β005b", "Rare", "V"),
      ],
      expansions: EXPANSIONS,
    });

    assert.deepEqual(prices, {});
    assert.equal(unresolved[0].reason, "tied-rank");
    assert.equal(stats.flagged, 2);
  });

  it("flags a group whose sizes disagree rather than pairing part of it", () => {
    const { prices, unresolved } = joinPrices({
      products: [product(1, "Judy", 6714), product(2, "Judy", 6714)],
      priceRows: [
        { idProduct: 1, trend: 10 },
        { idProduct: 2, trend: 440 },
      ],
      printings: [printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy")],
      expansions: EXPANSIONS,
    });

    assert.deepEqual(prices, {});
    assert.equal(unresolved[0].reason, "count-mismatch");
  });

  it("lets a pin settle a group the ranking will not touch", () => {
    const { prices, stats } = joinPrices({
      products: [product(1, "V", 6714), product(2, "V", 6714)],
      priceRows: [
        { idProduct: 1, trend: 0.24 },
        { idProduct: 2, trend: 0.3 },
      ],
      printings: [
        printing("cb-v", "wtncbeta", "β005a", "Rare", "V"),
        printing("cb-v", "wtncbeta", "β005b", "Rare", "V"),
      ],
      expansions: EXPANSIONS,
      pins: { 1: "cb-v:wtncbeta:β005a", 2: "cb-v:wtncbeta:β005b" },
    });

    assert.equal(prices["cb-v:wtncbeta:β005a"].eur, 0.24);
    assert.equal(prices["cb-v:wtncbeta:β005b"].eur, 0.3);
    assert.equal(stats.pinned, 2);
  });

  it("reports a pin whose printing no longer exists instead of dropping it", () => {
    const { unresolved } = joinPrices({
      products: [product(1, "V", 6714)],
      priceRows: [{ idProduct: 1, trend: 1 }],
      printings: [printing("cb-v", "wtncbeta", "β005a", "Rare", "V")],
      expansions: EXPANSIONS,
      pins: { 1: "cb-v:wtncbeta:GONE" },
    });

    assert.equal(unresolved[0].reason, "pin-target-missing");
  });

  it("prices nothing from an expansion that has no recorded set", () => {
    const { prices, stats } = joinPrices({
      products: [product(1, "Judy", 9999)],
      priceRows: [{ idProduct: 1, trend: 12.5 }],
      printings: [printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy")],
      expansions: EXPANSIONS,
    });

    assert.deepEqual(prices, {});
    assert.equal(stats.unmappedExpansion, 1);
  });

  it("ignores a product that has never sold, rather than letting it block the group", () => {
    const { prices } = joinPrices({
      products: [product(1, "Judy", 6714), product(2, "Judy", 6714), product(3, "Judy", 6714)],
      priceRows: [
        { idProduct: 1, trend: 10 },
        { idProduct: 2, trend: null },
        { idProduct: 3, trend: 440 },
      ],
      printings: [
        printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy"),
        printing("cb-judy", "wtncbeta", "β157", "Iconic Legend", "Judy"),
      ],
      expansions: EXPANSIONS,
    });

    assert.equal(prices["cb-judy:wtncbeta:β108"].eur, 10);
    assert.equal(prices["cb-judy:wtncbeta:β157"].eur, 440);
  });

  it("leaves a printing unpriced when its product has never sold", () => {
    const { prices } = joinPrices({
      products: [product(1, "Judy", 6714)],
      priceRows: [{ idProduct: 1, trend: null }],
      printings: [printing("cb-judy", "wtncbeta", "β108", "Epic", "Judy")],
      expansions: EXPANSIONS,
    });

    assert.deepEqual(prices, {});
  });
});

describe("printingKey", () => {
  it("matches the shape the app stores", () => {
    assert.equal(printingKey("cb-judy", "wtncbeta", "β157"), "cb-judy:wtncbeta:β157");
  });
});

describe("tierOf", () => {
  it("puts the Iconic tiers above the base rarities", () => {
    assert.ok(tierOf("Iconic Legend") > tierOf("Epic"));
    assert.ok(tierOf("Iconic Secret") > tierOf("Secret"));
  });

  it("treats an unknown rarity as a base printing, which can only cause a flag", () => {
    assert.equal(tierOf("Brand New Tier"), 0);
  });
});

describe("movement", () => {
  it("measures the trend against an average Cardmarket itself publishes", () => {
    assert.equal(movement(110, 100), 10);
    assert.equal(movement(90, 100), -10);
  });

  it("says nothing when they have not computed that average", () => {
    // Every Cyberpunk row today: these are averages of real sales, and the game
    // is pre-retail. Null renders as a dash rather than claiming a flat price.
    assert.equal(movement(73, null), null);
    assert.equal(movement(73, undefined), null);
    assert.equal(movement(null, 12), null);
  });
});
