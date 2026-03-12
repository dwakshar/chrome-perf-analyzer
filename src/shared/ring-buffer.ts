// ─────────────────────────────────────────────────────────────────────────────
// ring-buffer.ts
//
// Fixed-capacity circular buffer that overwrites the oldest entry when full.
// Used to cap in-memory network request storage during long profiling sessions.
// ─────────────────────────────────────────────────────────────────────────────

export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private readonly capacity: number;
  private head = 0; // Points to next write slot
  private _size = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("RingBuffer capacity must be >= 1");
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** Append an item. Overwrites the oldest item if at capacity. */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** Replace an existing item by reference-equal match, or push if not found. */
  upsert(item: T, predicate: (existing: T) => boolean): void {
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head - this._size + i + this.capacity) % this.capacity;
      if (this.buffer[idx] !== undefined && predicate(this.buffer[idx] as T)) {
        this.buffer[idx] = item;
        return;
      }
    }
    this.push(item);
  }

  /** Find a single item matching the predicate, or undefined. */
  find(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head - this._size + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined && predicate(item)) return item;
    }
    return undefined;
  }

  /** Return all items in insertion order (oldest → newest). */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head - this._size + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  /** Return all items matching the predicate. */
  filter(predicate: (item: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  get size(): number {
    return this._size;
  }
  get isFull(): boolean {
    return this._size === this.capacity;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this._size = 0;
  }
}
