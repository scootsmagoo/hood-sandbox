import path from 'node:path';
import { cachedFile } from '../cache.js';
import type { TileConfig } from '../config.js';

/** What Wikidata knows about a building that a tile can use (its labels of style and material are English words, never baked as text). */
export interface WikidataFacts {
  id: string;
  /** inception year (P571) */
  year: number | null;
  /** architectural style labels (P149) */
  styles: string[];
  /** material labels (P186) */
  materials: string[];
  /** number of floors above ground (P1101) */
  floors: number | null;
  /** height in metres (P2048) */
  height: number | null;
  /** an architect is recorded (P84) */
  hasArchitect: boolean;
}

interface Claim {
  mainsnak?: { datavalue?: { value?: any } };
}
type Claims = Record<string, Claim[]>;

const UA = 'hood-sandbox-pipeline/0.1 (building facts; ponyfarts@protonmail.com)';
const FOOT = 'Q3710';

const values = (claims: Claims, p: string): any[] => (claims[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);
const qidOf = (v: any): string | null => (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null);

/** Reads the facts of one entity from its claims; `labelOf` turns a referenced item into its English label. */
export function factsOfEntity(id: string, claims: Claims, labelOf: (q: string) => string | null): WikidataFacts {
  let year: number | null = null;
  for (const v of values(claims, 'P571')) {
    const m = /^[+-](\d{4})/.exec(String(v?.time ?? ''));
    if (m) {
      year = parseInt(m[1], 10);
      break;
    }
  }
  const labels = (p: string) => values(claims, p).map((v) => qidOf(v)).filter((q): q is string => !!q).map((q) => labelOf(q)).filter((l): l is string => !!l);
  const amount = (p: string): number | null => {
    const v = values(claims, p)[0];
    if (!v || v.amount == null) return null;
    const n = parseFloat(v.amount);
    if (!Number.isFinite(n)) return null;
    return String(v.unit ?? '').endsWith(FOOT) ? n * 0.3048 : n;
  };
  const floors = amount('P1101');
  return {
    id,
    year,
    styles: labels('P149'),
    materials: labels('P186'),
    floors: floors != null && floors > 0 && floors < 200 ? Math.round(floors) : null,
    height: amount('P2048'),
    hasArchitect: values(claims, 'P84').length > 0,
  };
}

async function retry<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = 2000 * 2 ** a;
      console.warn(`${what}: attempt ${a + 1} failed (${(e as Error).message})${a + 1 < tries ? `; retrying in ${wait / 1000}s` : ''}`);
      if (a + 1 < tries) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function getEntities(ids: string[], props: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (let i = 0; i < ids.length; i += 40) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=${props}&languages=en&ids=${ids.slice(i, i + 40).join('|')}`;
    const d = await retry('wikidata', async () => {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { entities?: Record<string, any> };
    });
    Object.assign(out, d.entities ?? {});
  }
  return out;
}

/**
 * The Wikidata facts of the given item ids, cached in `wikidata-facts.json` of the tile's cache (the ids it was made for are
 * part of it, so a new id re-queries). Empty when Wikidata cannot be reached and nothing is cached: a bake never fails for it.
 */
export async function fetchWikidataFacts(cfg: TileConfig, ids: string[]): Promise<Map<string, WikidataFacts>> {
  const want = [...new Set(ids)].sort();
  const result = new Map<string, WikidataFacts>();
  if (!want.length) return result;
  const file = path.join(cfg.cacheDir, 'wikidata-facts.json');
  try {
    let buf = await cachedFile(file, async () => JSON.stringify(await queryFacts(want)));
    let data = JSON.parse(buf.toString('utf8')) as { facts: WikidataFacts[] };
    const have = new Set(data.facts.map((f) => f.id));
    if (want.some((q) => !have.has(q))) {
      // the cache was made for other ids: extend it
      const more = await queryFacts(want.filter((q) => !have.has(q)));
      data = { facts: [...data.facts, ...more.facts] };
      buf = Buffer.from(JSON.stringify(data));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, buf);
    }
    for (const f of data.facts) result.set(f.id, f);
  } catch (e) {
    console.warn(`wikidata unavailable (${(e as Error).message}); no year, style or floors from it`);
  }
  return result;
}

async function queryFacts(ids: string[]): Promise<{ facts: WikidataFacts[] }> {
  const ents = await getEntities(ids, 'claims');
  // the labels of the styles and materials the claims point at
  const refs = new Set<string>();
  for (const e of Object.values(ents)) {
    for (const p of ['P149', 'P186']) for (const v of values((e.claims ?? {}) as Claims, p)) {
      const q = qidOf(v);
      if (q) refs.add(q);
    }
  }
  const labelEnts = refs.size ? await getEntities([...refs], 'labels') : {};
  const labelOf = (q: string): string | null => (labelEnts[q]?.labels?.en?.value as string | undefined) ?? null;
  const facts = ids.map((id) => factsOfEntity(id, (ents[id]?.claims ?? {}) as Claims, labelOf));
  return { facts };
}
