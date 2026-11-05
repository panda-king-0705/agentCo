import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBaZi, jieDay } from "../../src/cognition/brain/self-management/bazi.ts";

test("day pillar: reference and known dates", () => {
  assert.equal(computeBaZi("1900-01-01T12:00:00Z").pillars[2], "甲戌");
  assert.equal(computeBaZi("2000-01-01T12:00:00Z").pillars[2], "戊午");
  assert.equal(computeBaZi("2000-01-01").dayMaster, "戊");
  assert.equal(computeBaZi("2000-01-01").dayMasterElement, "earth");
  // 1949-10-01 is 甲子 day.
  assert.equal(computeBaZi("1949-10-01T15:00:00+08:00").pillars[2], "甲子");
});

test("year pillar changes at Lìchūn, not Jan 1", () => {
  assert.equal(computeBaZi("1984-03-01T10:00:00Z").pillars[0], "甲子");
  assert.equal(computeBaZi("1984-02-05T10:00:00Z").pillars[0], "甲子");
  assert.equal(computeBaZi("1984-01-20T10:00:00Z").pillars[0], "癸亥");
  assert.equal(computeBaZi("2024-02-10T10:00:00Z").pillars[0], "甲辰");
  assert.equal(computeBaZi("2024-02-03T10:00:00Z").pillars[0], "癸卯");
});

test("month pillar follows solar terms and the 五虎遁 rule", () => {
  assert.equal(computeBaZi("2024-02-10T10:00:00Z").pillars[1], "丙寅"); // 甲 year → 丙寅
  assert.equal(computeBaZi("2024-03-10T10:00:00Z").pillars[1], "丁卯");
  assert.equal(computeBaZi("2024-12-20T10:00:00Z").pillars[1], "丙子");
  assert.equal(computeBaZi("2025-01-10T10:00:00Z").pillars[1], "丁丑"); // still 甲辰 year
  assert.equal(computeBaZi("2025-01-03T10:00:00Z").pillars[1], "丙子");
  assert.equal(jieDay(2024, 0), 4); // Lìchūn 2024-02-04
  assert.equal(jieDay(2025, 0), 3); // Lìchūn 2025-02-03
});

test("hour pillar: 2-hour branches, 23:00 starts 子, 五鼠遁 stems", () => {
  const noon = computeBaZi("2000-01-01T12:00:00Z"); // 戊 day, 午 hour → 戊午
  assert.equal(noon.pillars[3], "戊午");
  assert.equal(computeBaZi("2000-01-01T00:30:00Z").pillars[3], "壬子");
  assert.equal(computeBaZi("2000-01-01T01:30:00Z").pillars[3], "癸丑");
  // 23:00 on a 戊 day belongs to the next (己) day's 子 hour → 甲子.
  assert.equal(computeBaZi("2000-01-01T23:30:00Z").pillars[3], "甲子");
});

test("five elements count the eight characters", () => {
  const c = computeBaZi("2024-02-10T10:00:00Z");
  const total = Object.values(c.elements).reduce((a, b) => a + b, 0);
  assert.equal(total, 8);
  assert.equal(c.pinyin[0], "jia-chen");
  assert.equal(c.birth, "2024-02-10T10:00:00Z");
  // Deterministic.
  assert.deepEqual(computeBaZi("2024-02-10T10:00:00Z"), c);
});

test("utcOffsetMinutes shifts the wall clock", () => {
  // 1999-12-31T20:00Z is 2000-01-01 04:00 in UTC+8.
  assert.equal(computeBaZi("1999-12-31T20:00:00Z", 480).pillars[2], "戊午");
  assert.throws(() => computeBaZi("not a date", 0));
});
