import { describe, it, expect } from "vitest";
import { appendRing } from "../../src/dashboard/ring-buffer.js";

describe("appendRing", () => {
  const CAP = 1024;

  it("keeps small sequential writes under the cap", () => {
    let ring: Uint8Array = Buffer.alloc(0);
    for (let i = 0; i < 20; i++) {
      ring = appendRing(ring, Buffer.alloc(50, i), CAP);
    }
    expect(ring.length).toBeLessThanOrEqual(CAP);
  });

  it("caps at exactly the limit when overflow happens", () => {
    let ring: Uint8Array = Buffer.alloc(0);
    ring = appendRing(ring, Buffer.alloc(CAP + 100, 0x41), CAP);
    expect(ring.length).toBe(CAP);
  });

  it("does not exceed cap when a single chunk is larger than cap (regression)", () => {
    const ring: Uint8Array = appendRing(Buffer.alloc(0), Buffer.alloc(CAP * 5, 0x42), CAP);
    expect(ring.length).toBe(CAP);
  });

  it("retains the most recent bytes after overflow", () => {
    let ring: Uint8Array = appendRing(Buffer.alloc(0), Buffer.alloc(CAP, 0x41), CAP);
    ring = appendRing(ring, Buffer.from([0x01, 0x02, 0x03]), CAP);
    expect(ring.length).toBe(CAP);
    expect(ring[CAP - 3]).toBe(0x01);
    expect(ring[CAP - 2]).toBe(0x02);
    expect(ring[CAP - 1]).toBe(0x03);
  });
});
