// Mirror card thumbnails so the app stops depending on signed art.
//
// The card database serves art as CloudFront URLs signed for about five
// minutes. That one fact forces the app to hold its catalog in memory only (a
// stored URL is dead by the time it is read), to re-fetch the whole catalog
// just to re-sign every URL, and to track which URL failed so a fresh one can
// be retried. It also makes a shareable collage impossible: the signed URLs
// send no Access-Control-Allow-Origin, so a canvas drawing them is tainted and
// toBlob() throws.
//
// A mirrored thumbnail is stable, cacheable and CORS-clean, and at 240px it is
// about a sixth of the bytes a grid pulls today.
//
// Only thumbnails are mirrored. The card page renders art in a ~308px column
// and looks better with the full-resolution original, which costs us nothing to
// keep loading live.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";

const CARDS = "https://api.netdeck.gg/api/cards/cyberpunk";
const OUT_DIR = "data/images";
const THUMB_DIR = join(OUT_DIR, "thumb");
const INDEX = join(OUT_DIR, "index.json");

/** Wide enough for the largest grid tile on a 2x display; see CardGrid. */
const THUMB_WIDTH = 240;

/** Requests in flight. A third party's free API, not ours to hammer. */
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
 * What the art at a URL is, independent of its signature. The path ends
 * `render-<hash>.webp`, and that hash changes when the art is re-rendered — so
 * it is what decides whether a mirrored copy is stale. The query string is
 * deliberately ignored: it holds the expiry and signature, which differ on every
 * request and say nothing about the image.
 */
function renderHash(imageUrl) {
  const path = imageUrl.split("?")[0];
  const file = path.slice(path.lastIndexOf("/") + 1);
  const match = /^render-(.+)\.webp$/.exec(file);
  // A URL shaped differently still has to produce a stable key, or every run
  // would re-download it.
  return match ? match[1] : createHash("sha1").update(path).digest("hex").slice(0, 12);
}

/**
 * Every printing with art, as the app sees it. The set listing returns one row
 * per card per set and leaves `printings` empty, so only the per-card endpoint
 * has the alt arts.
 */
async function fetchPrintings() {
  const { filters } = await getJson(`${CARDS}/filters`);
  const sets = filters.find((f) => f.key === "set")?.options ?? [];
  if (sets.length === 0) {
    throw new Error("card database published no sets — refusing to mirror against nothing");
  }

  const slugs = new Set();
  for (const set of sets) {
    let offset = 0;
    for (;;) {
      const page = await getJson(
        `${CARDS}?limit=100&offset=${offset}&set=${encodeURIComponent(set.code)}`,
      );
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
    for (const printing of detail.printings ?? []) {
      if (printing.id && printing.image_url) {
        printings.push({ id: printing.id, imageUrl: printing.image_url });
      }
    }
  }
  return printings;
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(INDEX, "utf-8"));
  } catch {
    return {};
  }
}

async function mirror(printing) {
  const response = await fetch(printing.imageUrl);
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${printing.id}`);
  }
  const source = Buffer.from(await response.arrayBuffer());
  const thumb = await sharp(source).resize({ width: THUMB_WIDTH }).webp({ quality: 82 }).toBuffer();
  const file = join(THUMB_DIR, `${printing.id}.webp`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, thumb);
  return thumb.length;
}

async function main() {
  const printings = await fetchPrintings();
  const index = await readIndex();
  const live = new Map(printings.map((p) => [p.id, renderHash(p.imageUrl)]));

  // Only what is new or re-rendered. Art almost never changes, so a nightly run
  // normally downloads nothing at all.
  const stale = printings.filter((p) => index[p.id] !== live.get(p.id));
  console.log(`${printings.length} printings, ${stale.length} to mirror`);

  let bytes = 0;
  let failed = 0;
  const results = await pool(stale, async (printing) => {
    try {
      const size = await mirror(printing);
      index[printing.id] = live.get(printing.id);
      return size;
    } catch (error) {
      // One dead URL must not cost the whole run: the rest still land, and the
      // next run retries this one because its hash never got recorded.
      console.warn(`warn: ${error.message}`);
      failed += 1;
      return 0;
    }
  });
  for (const size of results) {
    bytes += size;
  }

  // A printing the database has dropped keeps neither its file nor its entry,
  // or the mirror would grow forever and the index would promise art that the
  // app can no longer ask for.
  let removed = 0;
  for (const id of Object.keys(index)) {
    if (!live.has(id)) {
      delete index[id];
      await unlink(join(THUMB_DIR, `${id}.webp`)).catch(() => undefined);
      removed += 1;
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(INDEX, `${JSON.stringify(index, null, 0)}\n`);

  const files = await readdir(THUMB_DIR).catch(() => []);
  console.log(
    `mirrored ${stale.length - failed}, failed ${failed}, removed ${removed}, ` +
      `${files.length} files, +${(bytes / 1024 / 1024).toFixed(1)} MB this run`,
  );

  // A run that could mirror nothing at all is a broken run, not an empty one.
  if (stale.length > 0 && failed === stale.length) {
    throw new Error("every download failed — leaving the mirror as it was");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
