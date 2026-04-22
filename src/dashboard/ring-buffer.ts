/**
 * Bounded ring buffer appender used by the frontend and engine daemons to
 * keep a trailing window of PTY output without unbounded growth.
 *
 * The earlier subarray-first pattern silently leaked oversized single
 * chunks (subarray on an empty buffer returns empty, so the whole chunk
 * was retained); concat-then-trim guarantees the returned buffer is
 * always at most `cap` bytes long.
 */
export function appendRing(ring: Uint8Array, chunk: Uint8Array, cap: number): Buffer {
  const next = Buffer.concat([ring, chunk]);
  return next.length > cap ? Buffer.from(next.subarray(next.length - cap)) : next;
}

/** Shared ring-buffer cap for the dashboard daemons. */
export const RING_BUFFER_BYTES = 64 * 1024;
