/**
 * A lock-free hand-off of the newest snapshot from the sim worker to the main thread through a
 * SharedArrayBuffer. Three slots, each guarded by a sequence number (a seqlock): the writer makes
 * it odd while writing and even when done, and the reader retries when the number changed under
 * its copy. The writer never waits for the reader.
 */

const CONTROL_INTS = 4; // [0] latest slot, [1] writes
const SLOTS = 3;

export class SnapshotRing {
  private readonly control: Int32Array;
  private readonly seq: Int32Array[] = [];
  private readonly data: Uint8Array[] = [];
  private lastRead = -1;

  constructor(
    readonly buffer: SharedArrayBuffer,
    readonly snapBytes: number,
  ) {
    this.control = new Int32Array(buffer, 0, CONTROL_INTS);
    const stride = SnapshotRing.slotStride(snapBytes);
    for (let i = 0; i < SLOTS; i++) {
      const base = CONTROL_INTS * 4 + i * stride;
      this.seq.push(new Int32Array(buffer, base, 1));
      this.data.push(new Uint8Array(buffer, base + 16, snapBytes));
    }
  }

  private static slotStride(snapBytes: number) {
    return 16 + Math.ceil(snapBytes / 16) * 16;
  }

  static create(snapBytes: number): SnapshotRing {
    const sab = new SharedArrayBuffer(CONTROL_INTS * 4 + SLOTS * SnapshotRing.slotStride(snapBytes));
    const ring = new SnapshotRing(sab, snapBytes);
    Atomics.store(ring.control, 0, -1);
    return ring;
  }

  write(src: Uint8Array) {
    const latest = Atomics.load(this.control, 0);
    const slot = (latest + 1) % SLOTS;
    const seq = this.seq[slot];
    const s = Atomics.load(seq, 0);
    Atomics.store(seq, 0, s + 1); // odd: being written
    this.data[slot].set(src.subarray(0, this.snapBytes));
    Atomics.store(seq, 0, s + 2);
    Atomics.store(this.control, 0, slot);
    Atomics.add(this.control, 1, 1);
  }

  /** Copies the newest snapshot into `dst`. False when nothing new has been written since the last read. */
  read(dst: Uint8Array): boolean {
    const writes = Atomics.load(this.control, 1);
    if (writes === this.lastRead) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const slot = Atomics.load(this.control, 0);
      if (slot < 0) return false;
      const seq = this.seq[slot];
      const before = Atomics.load(seq, 0);
      if (before & 1) continue;
      dst.set(this.data[slot]);
      if (Atomics.load(seq, 0) === before) {
        this.lastRead = writes;
        return true;
      }
    }
    return false;
  }
}
