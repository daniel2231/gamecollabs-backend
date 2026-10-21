import { Collab } from "../models/collab.js";
import { Property } from "../models/entities.js";
import { revalidate } from "../lib/outbound.js";
import { syncHostPlatforms } from "../services/collabs.js";
import { taxonomy } from "../services/taxonomy.js";

/**
 * One-off move of platforms from collabs to their host games: each game gets the most specific
 * union of its collabs' platforms (added to what it already lists), then every collab copies
 * its game's list. Run it once when deploying game-level platforms, before collabs are re-saved.
 */
export async function backfillGamePlatforms(opts: { dryRun: boolean }) {
  const tax = await taxonomy();
  const byGame = new Map<string, { sets: Map<string, number>; keys: string[] }>();
  /** Collabs whose platforms have nowhere to go (no linked host). */
  const orphaned: string[] = [];
  for await (const c of Collab.find({ "platforms.0": { $exists: true } }).select({ slug: 1, parties: 1, platforms: 1 }).lean().cursor()) {
    const hosts = c.parties.filter((p) => p.role === "host" && p.propertyId);
    if (!hosts.length) orphaned.push(c.slug);
    for (const h of hosts) {
      const entry = byGame.get(h.propertyId!.toString()) ?? { sets: new Map<string, number>(), keys: [] as string[] };
      const set = JSON.stringify(c.platforms);
      entry.sets.set(set, (entry.sets.get(set) ?? 0) + 1);
      entry.keys.push(...c.platforms);
      byGame.set(h.propertyId!.toString(), entry);
    }
  }

  const games = await Property.find({ _id: { $in: [...byGame.keys()] } });
  const changes: { slug: string; from: string[]; to: string[]; collabSets: Record<string, number> }[] = [];
  const notGames: string[] = [];
  for (const game of games) {
    const entry = byGame.get(game._id.toString())!;
    if (!tax.expand([game.kind]).includes("partner_category.game")) {
      notGames.push(game.slug);
      continue;
    }
    const to = tax.mostSpecific([...game.platforms, ...entry.keys].filter((k) => !tax.problemWith(k, "platform", { allowDeprecated: true })));
    if (JSON.stringify(to) === JSON.stringify(game.platforms)) continue;
    changes.push({ slug: game.slug, from: game.platforms, to, collabSets: Object.fromEntries(entry.sets) });
    if (!opts.dryRun) {
      game.platforms = to;
      await game.save();
    }
  }

  let collabsUpdated = 0;
  if (!opts.dryRun) {
    const { updated, tags } = await syncHostPlatforms();
    collabsUpdated = updated;
    if (tags.length) revalidate(["collabs", ...tags]);
  }
  return {
    dryRun: opts.dryRun,
    games: changes.length,
    /** Games whose collabs disagreed: worth a look, the union may include a platform the game lost. */
    mixed: changes.filter((c) => Object.keys(c.collabSets).length > 1).map((c) => c.slug),
    changes,
    collabsUpdated,
    notGames,
    orphaned,
  };
}
