/**
 * A binary min-heap of (key, value) pairs in typed arrays: the open list of the route searches. It grows but never shrinks, and
 * `clear()` keeps the storage, so a search that runs every few seconds allocates nothing after the first.
 */
export class MinHeap {
  private keys = new Float64Array(512);
  private vals = new Int32Array(512);
  size = 0;
  /** The key of the pair `pop()` returned last. */
  popped = 0;

  clear() {
    this.size = 0;
  }

  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** The value with the smallest key (its key is in `popped`). Call only when `size > 0`. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    this.popped = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= key) break;
        keys[i] = keys[m];
        vals[i] = vals[m];
        i = m;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}
