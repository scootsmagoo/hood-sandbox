/**
 * Polite HTTP for the grid prefetch (docs/contracts/city-tiles.md section 10): one request at a time per client, a minimum gap
 * between requests, endpoint rotation, exponential backoff with jitter on 429/502/503/504, network errors and timeouts,
 * Retry-After honoured, a client timeout per request, and nothing written to the cache unless the response validated. The
 * clock, the sleep, the random source and fetch are injectable, so the tests run it with a fake fetch and no waiting.
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const USER_AGENT = 'hood-sandbox-pipeline/0.2 (Hood Sandbox city grid prefetch: offline tile bake for a browser game of real Atlanta)';

export interface HttpDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  log: (msg: string) => void;
}

const nativeFetch = globalThis.fetch;
export const realDeps = (): HttpDeps => ({
  fetch: (url, init) => nativeFetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  random: Math.random,
  log: (m) => console.log(m),
});

export interface RetryPolicy {
  /** attempts per item, across endpoints */
  attempts: number;
  /** the first backoff, ms; it doubles per attempt */
  baseMs: number;
  /** the largest backoff, ms */
  capMs: number;
  /** a request is abandoned after this, ms */
  timeoutMs: number;
  /** at least this long between the starts of two requests of a client, ms */
  minGapMs: number;
}

export const OVERPASS_POLICY: RetryPolicy = { attempts: 6, baseMs: 5000, capMs: 300_000, timeoutMs: 180_000, minGapMs: 2000 };
export const DEM_POLICY: RetryPolicy = { attempts: 6, baseMs: 5000, capMs: 300_000, timeoutMs: 180_000, minGapMs: 1000 };

/** The wait before retry number `attempt + 1` (attempt counts from 0): base * 2^attempt, capped, times a jitter in [0.75, 1.25). */
export function backoffMs(attempt: number, policy: Pick<RetryPolicy, 'baseMs' | 'capMs'>, random: () => number): number {
  const b = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.min(policy.capMs, Math.round(b * (0.75 + 0.5 * random())));
}

/** A Retry-After header (seconds, or an HTTP date) as ms from `now`; null when absent or unreadable. */
export function retryAfterMs(h: string | null | undefined, now: number): number | null {
  if (!h) return null;
  const s = h.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** HTTP statuses that the backoff is meant for (busy, rate limited, gateway trouble). */
export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Worth another try, on the next endpoint after a backoff: everything but a 400 (the query itself is wrong). A mirror that
 * answers 403 or 404 is skipped in favour of the next one, not given up on.
 */
export const retryableStatus = (status: number): boolean => RETRYABLE.has(status) || status !== 400;

/** Checks an Overpass answer: JSON with an `elements` array, and no remark saying the query died (Overpass answers 200 then). */
export function validateOverpass(text: string): { ok: true } | { ok: false; reason: string } {
  let j: { elements?: unknown; remark?: unknown };
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON (${(e as Error).message.slice(0, 80)}): ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.elements)) return { ok: false, reason: 'no elements array' };
  const remark = typeof j.remark === 'string' ? j.remark : '';
  if (/runtime error|timed out/i.test(remark)) return { ok: false, reason: `remark: ${remark.slice(0, 200)}` };
  return { ok: true };
}

export class AttemptError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfter: number | null = null) {
    super(message);
  }
}

/** One client per host family: requests are serialised and spaced by `minGapMs`. */
export class PoliteClient {
  private lastStart = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();
  /** the endpoint that answered last (the next item starts there) */
  private preferred = 0;
  readonly stats = { requests: 0, retries: 0, waitedMs: 0 };

  constructor(readonly policy: RetryPolicy, readonly deps: HttpDeps = realDeps()) {}

  /** Runs `fn` (one request) after the gap since the last request of this client; requests never overlap. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastStart + this.policy.minGapMs - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.lastStart = this.deps.now();
      this.stats.requests++;
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * One request with the client timeout, which covers reading the body too (`read`); a timeout or a network error is a
   * retryable AttemptError.
   */
  async once<T = Response>(url: string, init: RequestInit, read: (res: Response) => Promise<T> = async (r) => r as unknown as T): Promise<T> {
    return this.serial(async () => {
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          ctl.abort();
          rej(new AttemptError(`timed out after ${this.policy.timeoutMs / 1000} s`, true));
        }, this.policy.timeoutMs);
      });
      try {
        return await Promise.race([this.deps.fetch(url, { ...init, signal: ctl.signal }).then(read), timeout]);
      } catch (e) {
        if (e instanceof AttemptError) throw e;
        throw new AttemptError(`network: ${(e as Error).message}`, true);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }

  /**
   * Tries `attempt(endpoint)` up to `policy.attempts` times, rotating through `endpoints` after each failure and backing off
   * (the larger of the backoff and the server's Retry-After). Returns the first success; throws the last error.
   */
  async withRetries<T>(what: string, endpoints: readonly string[], attempt: (endpoint: string) => Promise<T>): Promise<T> {
    let last: unknown;
    let cursor = this.preferred;
    for (let k = 0; k < this.policy.attempts; k++) {
      const ei = this.pick(endpoints, cursor);
      cursor = ei + 1;
      const ep = endpoints[ei];
      try {
        const v = await attempt(ep);
        this.preferred = ei;
        this.refusals.delete(ep);
        return v;
      } catch (e) {
        last = e;
        const ae = e instanceof AttemptError ? e : new AttemptError((e as Error).message, true);
        // a mirror that refuses us (403, 404) twice running is left out for the rest of the run
        if (/^HTTP 40[34]$/.test(ae.message)) this.refusals.set(ep, (this.refusals.get(ep) ?? 0) + 1);
        if (!ae.retryable || k + 1 >= this.policy.attempts) {
          this.deps.log(`${what}: attempt ${k + 1} on ${host(ep)} failed (${ae.message}); giving up`);
          break;
        }
        const wait = Math.min(this.policy.capMs, Math.max(backoffMs(k, this.policy, this.deps.random), ae.retryAfter ?? 0));
        this.deps.log(`${what}: attempt ${k + 1} on ${host(ep)} failed (${ae.message}); retrying in ${(wait / 1000).toFixed(1)} s`);
        this.stats.retries++;
        this.stats.waitedMs += wait;
        await this.deps.sleep(wait);
      }
    }
    throw last;
  }

  /** How often each endpoint refused us in a row. */
  private readonly refusals = new Map<string, number>();

  /** The next endpoint from `from` on (cyclically) that has not refused us twice running; any endpoint when all have. */
  private pick(endpoints: readonly string[], from: number): number {
    const n = Math.max(1, endpoints.length);
    for (let k = 0; k < n; k++) {
      const i = (from + k) % n;
      if ((this.refusals.get(endpoints[i]) ?? 0) < 2) return i;
    }
    return from % n;
  }
}

const host = (u: string | undefined) => {
  try {
    return new URL(u ?? '').host;
  } catch {
    return String(u);
  }
};

/** Writes a file so that a reader never sees half of it (a temporary file, then a rename). */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface CachedResult {
  status: 'cached' | 'fetched' | 'failed';
  bytes: number;
  error?: string;
}

/** Fetches an Overpass query into `file` unless it is there already. A failed or partial answer is never written. */
export async function fetchOverpassToCache(client: PoliteClient, endpoints: readonly string[], query: string, file: string, what: string): Promise<CachedResult> {
  if (existsSync(file)) return { status: 'cached', bytes: statSync(file).size };
  try {
    const text = await client.withRetries(what, endpoints, async (url) => {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT, accept: 'application/json' },
        body: 'data=' + encodeURIComponent(query),
      };
      const body = await client.once(url, init, async (res) => {
        if (!res.ok) {
          const ra = retryAfterMs(res.headers.get('retry-after'), client.deps.now());
          // drain the body so the connection is released
          await res.text().catch(() => '');
          throw new AttemptError(`HTTP ${res.status}`, retryableStatus(res.status), ra);
        }
        try {
          return await res.text();
        } catch (e) {
          throw new AttemptError(`body: ${(e as Error).message}`, true);
        }
      });
      const v = validateOverpass(body);
      if (!v.ok) throw new AttemptError(v.reason, true);
      return body;
    });
    writeAtomic(file, text);
    return { status: 'fetched', bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { status: 'failed', bytes: 0, error: (e as Error).message };
  }
}
