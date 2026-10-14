/**
 * Finds the law tables for a tile: the tile id (`atlanta/m1-five-points`) names its city pack
 * (`data/cities/atlanta/jurisdictions.json`). The packs are bundled lazily, one chunk each, so the
 * engine names no city. A tile whose city has no pack (the procedural test ground) gets the generic one.
 */
import defaultLaw from '../../shared/data/defaultLaw.json';
import { cityOfTile, parseJurisdictions, type LawData } from '../../shared/law';

const packs = import.meta.glob('/data/cities/*/jurisdictions.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

export const GENERIC_LAW: LawData = parseJurisdictions(defaultLaw);

/** The city pack's law for a tile id, or the generic law when the city has none. */
export async function loadLawForTile(tileId: string): Promise<LawData> {
  const city = cityOfTile(tileId);
  const load = city ? packs[`/data/cities/${city}/jurisdictions.json`] : undefined;
  if (!load) return GENERIC_LAW;
  return parseJurisdictions(await load());
}
