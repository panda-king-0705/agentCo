/**
 * Role Arrangement › Eight Characters and Five Elements (八字五行).
 *
 * Pure and deterministic: casts the four sexagenary pillars (year, month, day,
 * hour) for a timestamp and counts the five elements over the eight
 * characters. OrgService stores the result in `persona.baZi` at creation
 * (the agent's createdAt is its "birth").
 *
 * Conventions (approximations, documented):
 * - The chart is cast on the wall-clock time written in the ISO string (an
 *   explicit offset such as +08:00 is honoured; "Z" means UTC wall time), or
 *   on UTC shifted by `utcOffsetMinutes` when that argument is given.
 * - Year boundary: Lìchūn (立春, ≈ Feb 4). Month boundaries: the 12 "jié"
 *   solar terms, dated with the standard 0.2422-day coefficient formula for
 *   1900-2099 (accurate to ±1 day; the hour of the term is ignored), fixed
 *   dates outside that range.
 * - Day pillar: 1900-01-01 is 甲戌 (cycle index 10), counted in calendar days.
 * - Hour pillar: 2-hour branches, 23:00 starts 子; the 23:00 hour takes its
 *   stem from the next day (the day pillar itself changes at midnight).
 */
import type { BaZiChart, FiveElement } from "../../../../../../packages/shared/src/index.ts";

export const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"] as const;
export const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"] as const;
const STEM_PINYIN = ["jia", "yi", "bing", "ding", "wu", "ji", "geng", "xin", "ren", "gui"];
const BRANCH_PINYIN = ["zi", "chou", "yin", "mao", "chen", "si", "wu", "wei", "shen", "you", "xu", "hai"];

const STEM_ELEMENT: FiveElement[] = ["wood", "wood", "fire", "fire", "earth", "earth", "metal", "metal", "water", "water"];
const BRANCH_ELEMENT: FiveElement[] = [
  "water", "earth", "wood", "wood", "earth", "fire", "fire", "earth", "metal", "metal", "earth", "water",
];

/**
 * The 12 jié terms that open each month, in month order starting with 寅 (Lìchūn).
 * month: calendar month (1-12); c20/c21: century coefficients; fixed: fallback day.
 */
const JIE_TERMS: { name: string; month: number; c20: number; c21: number; fixed: number }[] = [
  { name: "立春", month: 2, c20: 4.6295, c21: 3.87, fixed: 4 }, // 寅
  { name: "惊蛰", month: 3, c20: 6.3826, c21: 5.63, fixed: 6 }, // 卯
  { name: "清明", month: 4, c20: 5.59, c21: 4.81, fixed: 5 }, // 辰
  { name: "立夏", month: 5, c20: 6.318, c21: 5.52, fixed: 6 }, // 巳
  { name: "芒种", month: 6, c20: 6.5, c21: 5.678, fixed: 6 }, // 午
  { name: "小暑", month: 7, c20: 7.928, c21: 7.108, fixed: 7 }, // 未
  { name: "立秋", month: 8, c20: 8.35, c21: 7.5, fixed: 8 }, // 申
  { name: "白露", month: 9, c20: 8.44, c21: 7.646, fixed: 8 }, // 酉
  { name: "寒露", month: 10, c20: 9.098, c21: 8.318, fixed: 8 }, // 戌
  { name: "立冬", month: 11, c20: 8.218, c21: 7.438, fixed: 7 }, // 亥
  { name: "大雪", month: 12, c20: 7.9, c21: 7.18, fixed: 7 }, // 子
  { name: "小寒", month: 1, c20: 6.11, c21: 5.4055, fixed: 6 }, // 丑 (next calendar year)
];

/** Day of `month` on which the jié term falls in calendar `year`. */
export function jieDay(year: number, termIndex: number): number {
  const term = JIE_TERMS[termIndex];
  if (!term) throw new RangeError(`no solar term ${termIndex}`);
  if (year < 1900 || year > 2099) return term.fixed;
  const y = year % 100;
  const c = year >= 2000 ? term.c21 : term.c20;
  // Jan/Feb terms fall before Feb 29, so the leap correction uses the previous year.
  // (2000 is a leap year, so y=0 gives floor(-0.25) = -1 as the formula expects; 1900 is not.)
  const leaps = term.month <= 2 ? (year === 1900 ? 0 : Math.floor((y - 1) / 4)) : Math.floor(y / 4);
  return Math.floor(y * 0.2422 + c) - leaps;
}

export function sexagenaryName(index: number): string {
  const i = mod(index, 60);
  return `${STEMS[i % 10]}${BRANCHES[i % 12]}`;
}

function sexagenaryPinyin(index: number): string {
  const i = mod(index, 60);
  return `${STEM_PINYIN[i % 10]}-${BRANCH_PINYIN[i % 12]}`;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
}

/** Reads the wall-clock fields written in an ISO string (or UTC + offset when given). */
export function wallClock(birthIso: string, utcOffsetMinutes?: number): WallClock {
  if (utcOffsetMinutes === undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2}))?)?/.exec(birthIso.trim());
    if (m) {
      return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: m[4] ? Number(m[4]) : 0 };
    }
  }
  const t = Date.parse(birthIso);
  if (Number.isNaN(t)) throw new RangeError(`computeBaZi: not a date: ${birthIso}`);
  const d = new Date(t + (utcOffsetMinutes ?? 0) * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}

/**
 * Month number counted from 寅 (0 = 寅 month … 11 = 丑 month) and the solar year
 * (Lìchūn-based) the date belongs to.
 */
export function solarMonth(w: WallClock): { solarYear: number; monthIndex: number } {
  const ord = w.month * 100 + w.day; // comparable within one calendar year
  const lichun = 200 + jieDay(w.year, 0);
  const solarYear = ord >= lichun ? w.year : w.year - 1;
  // Walk the terms of the solar year: 寅..子 fall in solarYear, 丑 in solarYear+1.
  let monthIndex = 11; // default 丑 (Jan, after 小寒) or 子 depending on below
  if (w.year === solarYear) {
    monthIndex = 0;
    for (let i = 1; i <= 10; i++) {
      const term = JIE_TERMS[i]!;
      if (ord >= term.month * 100 + jieDay(w.year, i)) monthIndex = i;
    }
  } else {
    // Between Jan 1 and Lìchūn: 子 month until 小寒, then 丑.
    monthIndex = ord >= 100 + jieDay(w.year, 11) ? 11 : 10;
  }
  return { solarYear, monthIndex };
}

const DAY_MS = 86_400_000;
const REF_DAY = Date.UTC(1900, 0, 1); // 甲戌, index 10

function dayIndex(year: number, month: number, day: number): number {
  const days = Math.round((Date.UTC(year, month - 1, day) - REF_DAY) / DAY_MS);
  return mod(10 + days, 60);
}

export function computeBaZi(birthIso: string, utcOffsetMinutes?: number): BaZiChart {
  const w = wallClock(birthIso, utcOffsetMinutes);
  const { solarYear, monthIndex } = solarMonth(w);

  const yearIdx = mod(solarYear - 4, 60); // 1984 = 甲子 (0)
  const yearStem = yearIdx % 10;
  // 五虎遁: the 寅 month stem is (yearStem·2 + 2) mod 10.
  const monthStem = mod(yearStem * 2 + 2 + monthIndex, 10);
  const monthBranch = mod(2 + monthIndex, 12);
  const monthIdx = sexagenaryIndex(monthStem, monthBranch);

  const dayIdx = dayIndex(w.year, w.month, w.day);

  const hourBranch = Math.floor((w.hour + 1) / 2) % 12;
  // 五鼠遁: the 子 hour stem is (dayStem mod 5)·2; 23:00 belongs to the next day's 子 hour.
  const stemDayIdx = w.hour === 23 ? mod(dayIdx + 1, 60) : dayIdx;
  const hourStem = mod(((stemDayIdx % 10) % 5) * 2 + hourBranch, 10);
  const hourIdx = sexagenaryIndex(hourStem, hourBranch);

  const indices = [yearIdx, monthIdx, dayIdx, hourIdx] as const;
  const elements: Record<FiveElement, number> = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const i of indices) {
    elements[STEM_ELEMENT[i % 10]!] += 1;
    elements[BRANCH_ELEMENT[i % 12]!] += 1;
  }
  const dayStem = dayIdx % 10;
  return {
    birth: birthIso,
    pillars: [sexagenaryName(yearIdx), sexagenaryName(monthIdx), sexagenaryName(dayIdx), sexagenaryName(hourIdx)],
    pinyin: [sexagenaryPinyin(yearIdx), sexagenaryPinyin(monthIdx), sexagenaryPinyin(dayIdx), sexagenaryPinyin(hourIdx)],
    dayMaster: STEMS[dayStem]!,
    dayMasterElement: STEM_ELEMENT[dayStem]!,
    elements,
  };
}

/** The cycle index (0..59) with the given stem and branch (they must share parity). */
function sexagenaryIndex(stem: number, branch: number): number {
  for (let i = 0; i < 60; i++) if (i % 10 === stem && i % 12 === branch) return i;
  throw new RangeError(`invalid stem/branch pair ${stem}/${branch}`);
}

export function elementOfStem(stem: string): FiveElement | null {
  const i = STEMS.indexOf(stem as (typeof STEMS)[number]);
  return i < 0 ? null : STEM_ELEMENT[i]!;
}
