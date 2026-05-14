/**
 * Parses a quota/rate-limit error message for a stated reset time.
 *
 * Returns the number of seconds to wait, or null when no recognized form is found.
 * Recognized forms:
 *   "retry after N seconds"
 *   "retry after N minutes"
 *   "resets H:MM(am|pm) (TZ)"  — e.g. "resets 11:30am (America/Los_Angeles)"
 *
 * The `now` parameter is injectable for testing (defaults to new Date()).
 * On unrecognized timezone, returns null rather than throwing.
 */
export function extractQuotaResetSeconds(text: string, now: Date = new Date()): number | null {
  const secMatch = /retry after (\d+) seconds?/i.exec(text);
  if (secMatch) return parseInt(secMatch[1], 10);

  const minMatch = /retry after (\d+) minutes?/i.exec(text);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;

  const resetMatch = /resets (\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (resetMatch) {
    let hour = parseInt(resetMatch[1], 10);
    const minute = parseInt(resetMatch[2], 10);
    const ampm = resetMatch[3].toLowerCase();
    const tz = resetMatch[4];

    if (ampm === "am") {
      if (hour === 12) hour = 0;
    } else {
      if (hour !== 12) hour += 12;
    }

    return computeSecondsUntilReset(hour, minute, tz, now);
  }

  return null;
}

function computeSecondsUntilReset(hour24: number, minute: number, tz: string, now: Date): number | null {
  try {
    const fmt = (timeZone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

    // Throws RangeError for unrecognized timezone — caught below and returns null.
    const tzFormatter = fmt(tz);
    const utcFormatter = fmt("UTC");

    const tzParts = tzFormatter.formatToParts(now);
    const utcParts = utcFormatter.formatToParts(now);

    const getNum = (parts: Intl.DateTimeFormatPart[], type: string) =>
      parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);

    const curYear = getNum(tzParts, "year");
    const curMonth = getNum(tzParts, "month"); // 1-indexed
    const curDay = getNum(tzParts, "day");
    const curHour = getNum(tzParts, "hour") % 24; // guard against h24 "24" for midnight

    // Compute the UTC offset for `now` in minutes by treating both formatted
    // times as if they were naive UTC timestamps and diffing them.
    const tzMs = Date.UTC(
      curYear, curMonth - 1, curDay, curHour, getNum(tzParts, "minute"), 0
    );
    const utcMs = Date.UTC(
      getNum(utcParts, "year"),
      getNum(utcParts, "month") - 1,
      getNum(utcParts, "day"),
      getNum(utcParts, "hour") % 24,
      getNum(utcParts, "minute"),
      0
    );
    const offsetMinutes = (tzMs - utcMs) / 60000;

    // "Today at hour24:minute in tz" expressed as UTC milliseconds.
    const todayTargetMs =
      Date.UTC(curYear, curMonth - 1, curDay, hour24, minute, 0) - offsetMinutes * 60000;

    let secondsUntil = (todayTargetMs - now.getTime()) / 1000;

    // Add a 60-second buffer so the quota window has fully cleared before we
    // retry. This also prevents scheduling "tomorrow" when we wake up just 1-2
    // seconds after the stated reset time (a common occurrence when the prior
    // wait was computed from the same reset message).
    secondsUntil += 60;

    // If the reset time (plus buffer) has already passed today, assume tomorrow.
    if (secondsUntil <= 0) secondsUntil += 24 * 3600;

    return Math.round(secondsUntil);
  } catch {
    return null;
  }
}
