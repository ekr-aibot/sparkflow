import { describe, it, expect } from "vitest";
import { extractQuotaResetSeconds } from "../../src/runtime/quota-reset.js";

describe("extractQuotaResetSeconds", () => {
  it("returns null for empty string", () => {
    expect(extractQuotaResetSeconds("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractQuotaResetSeconds("   ")).toBeNull();
  });

  it("returns null when no recognized form is present", () => {
    expect(extractQuotaResetSeconds("something went wrong")).toBeNull();
  });

  describe("retry after N seconds", () => {
    it("parses 'retry after 30 seconds'", () => {
      expect(extractQuotaResetSeconds("retry after 30 seconds")).toBe(30);
    });

    it("parses 'retry after 1 second' (singular)", () => {
      expect(extractQuotaResetSeconds("retry after 1 second")).toBe(1);
    });

    it("is case-insensitive", () => {
      expect(extractQuotaResetSeconds("Retry After 60 Seconds")).toBe(60);
    });

    it("works embedded in a longer message", () => {
      expect(extractQuotaResetSeconds("Rate limit exceeded. Please retry after 45 seconds.")).toBe(45);
    });
  });

  describe("retry after N minutes", () => {
    it("parses 'retry after 5 minutes'", () => {
      expect(extractQuotaResetSeconds("retry after 5 minutes")).toBe(300);
    });

    it("parses 'retry after 1 minute' (singular)", () => {
      expect(extractQuotaResetSeconds("retry after 1 minute")).toBe(60);
    });

    it("is case-insensitive", () => {
      expect(extractQuotaResetSeconds("Retry After 2 Minutes")).toBe(120);
    });
  });

  describe("resets HH:MM(am|pm) (TZ)", () => {
    // Use a fixed "now" in America/Los_Angeles (UTC-8 in winter / UTC-7 in DST).
    // We pick a reference time well before the reset to avoid edge cases.
    // All wall-clock reset results include a 60-second buffer.

    it("returns positive seconds for a future reset time today", () => {
      // now = 2024-01-15 09:00:00 UTC = 01:00:00 AM PST (UTC-8)
      // reset = 11:30am PST = 19:30 UTC → delta = 10.5 hours = 37800 s + 60s buffer = 37860s
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "You've hit your limit · resets 11:30am (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
      expect(result).toBeCloseTo(37860, -2);
    });

    it("wraps to tomorrow when reset time has already passed today (beyond buffer)", () => {
      // now = 2024-01-15T21:00:00Z = 1pm PST (UTC-8)
      // reset = 11:30am PST = 19:30 UTC (today) → 1.5h past + 60s buffer = still past → wraps
      // delta ≈ 24h - 1.5h + 60s = 81060s
      const now = new Date("2024-01-15T21:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 11:30am (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
      expect(result).toBeCloseTo(81060, -2);
    });

    it("does NOT wrap to tomorrow when only 1 second past the reset time", () => {
      // now = 2024-01-15T23:50:01Z = 3:50:01pm PST (UTC-8)
      // reset = 3:50pm PST = 23:50:00 UTC → secondsUntil = -1 + 60 buffer = 59s (not tomorrow)
      // This is the exact scenario from issue #128.
      const now = new Date("2024-01-15T23:50:01Z");
      const result = extractQuotaResetSeconds(
        "You've hit your limit · resets 3:50pm (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(200);
    });

    it("handles pm times correctly", () => {
      // now = 2024-01-15T09:00:00Z = 01:00am PST
      // reset = 3:00pm PST = 23:00 UTC → delta = 14h = 50400s + 60s buffer = 50460s
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 3:00pm (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(50460, -2);
    });

    it("handles 12:00pm (noon) correctly", () => {
      // now = 2024-01-15T09:00:00Z = 01:00am PST
      // reset = 12:00pm PST = noon = 20:00 UTC → delta = 11h = 39600s + 60s buffer = 39660s
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 12:00pm (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(39660, -2);
    });

    it("handles 12:00am (midnight) correctly", () => {
      // now = 2024-01-15T09:00:00Z = 01:00am PST
      // reset = 12:00am PST = midnight = 08:00 UTC (next day) → wraps to tomorrow
      // delta ≈ 23h + 60s buffer = 82860s
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 12:00am (America/Los_Angeles)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(82860, -2);
    });

    it("returns null for an unrecognized timezone", () => {
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 11:30am (Not/A_Real_Timezone)",
        now
      );
      expect(result).toBeNull();
    });

    it("works with UTC timezone", () => {
      // now = 2024-01-15T09:00:00Z
      // reset = 11:30am UTC = 11:30 UTC → delta = 2.5h = 9000s + 60s buffer = 9060s
      const now = new Date("2024-01-15T09:00:00Z");
      const result = extractQuotaResetSeconds(
        "resets 11:30am (UTC)",
        now
      );
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(9060, -2);
    });
  });

  it("prefers 'retry after N seconds' over 'retry after N minutes' when both present", () => {
    // seconds pattern appears first in the code
    expect(extractQuotaResetSeconds("retry after 30 seconds. Also retry after 5 minutes")).toBe(30);
  });
});
