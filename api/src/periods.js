"use strict";

// Time periods for counters, in Vienna time (CROWFORGE is based there; DST handled).
// Keys: "all", "d2026-11-27", "w2026-48" (ISO week, Monday start), "m2026-11".

const TZ = "Europe/Vienna";
const PERIODS = ["all", "day", "week", "month"];

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function viennaParts(ms) {
  const p = Object.fromEntries(partsFormatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of Vienna to UTC at that instant, in ms (+1 h in winter, +2 h in summer). */
function offsetMs(ms) {
  const p = viennaParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local midnight in Vienna for that calendar date (month/day may overflow). */
function viennaMidnight(y, m, d) {
  const naive = Date.UTC(y, m - 1, d);
  const first = naive - offsetMs(naive);
  return naive - offsetMs(first);
}

const pad = (n) => String(n).padStart(2, "0");

/** ISO week of the calendar date (y, m, d). */
function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // Thursday of this week decides the year
  const weekYear = date.getUTCFullYear();
  const week = Math.ceil(((date - Date.UTC(weekYear, 0, 1)) / 86400000 + 1) / 7);
  return { weekYear, week };
}

/**
 * period: all|day|week|month, offset: 0 = current, -1 = previous.
 * Returns { period, key, startsAt, endsAt } (ISO strings, null for "all").
 */
function periodInfo(period, offset = 0, now = Date.now()) {
  if (period === "all") return { period, key: "all", startsAt: null, endsAt: null };
  const t = viennaParts(now);
  let start;
  let end;
  let key;
  if (period === "day") {
    const d = new Date(Date.UTC(t.y, t.m - 1, t.d + offset));
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    start = viennaMidnight(y, m, day);
    end = viennaMidnight(y, m, day + 1);
    key = `d${y}-${pad(m)}-${pad(day)}`;
  } else if (period === "week") {
    const dow = (new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(t.y, t.m - 1, t.d - dow + 7 * offset));
    const [y, m, day] = [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
    start = viennaMidnight(y, m, day);
    end = viennaMidnight(y, m, day + 7);
    const { weekYear, week } = isoWeek(y, m, day);
    key = `w${weekYear}-${pad(week)}`;
  } else if (period === "month") {
    const first = new Date(Date.UTC(t.y, t.m - 1 + offset, 1));
    const [y, m] = [first.getUTCFullYear(), first.getUTCMonth() + 1];
    start = viennaMidnight(y, m, 1);
    end = viennaMidnight(y, m + 1, 1);
    key = `m${y}-${pad(m)}`;
  } else {
    throw new Error("Unknown period " + period);
  }
  return { period, key, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

/** Keys of all periods an add at `now` counts towards. */
function currentKeys(now = Date.now()) {
  return PERIODS.map((p) => periodInfo(p, 0, now).key);
}

module.exports = { PERIODS, periodInfo, currentKeys, viennaMidnight };
