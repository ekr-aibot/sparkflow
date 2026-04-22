import { describe, it, expect } from "vitest";

/**
 * Both engine-daemon and frontend-daemon maintain a bounded ring buffer of
 * PTY output. The appender must keep `ring.length <= cap` even when a single
 * incoming chunk is larger than the cap — the earlier "is ring+chunk over
 * cap? then subarray the ring" pattern silently leaked oversized chunks
 * because subarray on an empty buffer returns empty. The new
 * concat-then-trim pattern below is mirrored in both daemons.
 */
// Matches the identical code in src/dashboard/engine-daemon.ts and
// src/dashboard/frontend-daemon.ts (kept in sync manually — this test proves
// the algorithm is correct; the daemons' copies are trivially identical).
function append(ring: Uint8Array, chunk: Uint8Array, cap: number): Uint8Array {
  const next = Buffer.concat([ring, chunk]);
  return next.length > cap ? next.subarray(next.length - cap) : next;
}

describe("ring buffer append", () => {
  const CAP = 1024;

  it("keeps small sequential writes under the cap", () => {
    let ring: Uint8Array = Buffer.alloc(0);
    for (let i = 0; i < 20; i++) {
      ring = append(ring, Buffer.alloc(50, i), CAP);
    }
    expect(ring.length).toBeLessThanOrEqual(CAP);
  });

  it("caps at exactly the limit when overflow happens", () => {
    let ring: Uint8Array = Buffer.alloc(0);
    ring = append(ring, Buffer.alloc(CAP + 100, 0x41), CAP);
    expect(ring.length).toBe(CAP);
  });

  it("does not exceed cap when a single chunk is larger than cap (regression)", () => {
    const ring: Uint8Array = append(Buffer.alloc(0), Buffer.alloc(CAP * 5, 0x42), CAP);
    expect(ring.length).toBe(CAP);
  });

  it("retains the most recent bytes after overflow", () => {
    let ring: Uint8Array = append(Buffer.alloc(0), Buffer.alloc(CAP, 0x41), CAP);
    ring = append(ring, Buffer.from([0x01, 0x02, 0x03]), CAP);
    expect(ring.length).toBe(CAP);
    // Last three bytes must be the new chunk.
    expect(ring[CAP - 3]).toBe(0x01);
    expect(ring[CAP - 2]).toBe(0x02);
    expect(ring[CAP - 1]).toBe(0x03);
  });
});
