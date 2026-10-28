import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as R from "../engine/risk.js";
const C = JSON.parse(fs.readFileSync(new URL("../engine/config.json", import.meta.url)));
const g = C.gambler, d = C.desk;

test("post table: fixed 2% of book over +50%, +50%, rug -90% ends ~flat ($1,002)", () => {
  let b = 1000; const book = [];
  for (const r of [0.5, 0.5, -0.9]) { b += R.positionSize(b, g) * r; book.push(Math.round(b)); }
  assert.deepEqual(book, [1010, 1020, 1002]);
});
test("post table: size-off-last-result (5/10/20%) is what we refuse: ends $883", () => {
  let b = 1000; for (const [f, r] of [[0.05, 0.5], [0.10, 0.5], [0.20, -0.9]]) b += b * f * r;
  assert.equal(Math.round(b), 883);
});
test("sizing takes no trade history (signature is book, config only)", () => assert.equal(R.positionSize.length, 2));
const ok = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, lpBurned: true, top10Pct: 20, liquidityUsd: 40000 };
test("gates: clean token passes", () => assert.equal(R.gates(ok, g).pass, true));
for (const [k, v] of [["mintAuthorityRevoked", false], ["freezeAuthorityRevoked", false], ["lpBurned", false], ["top10Pct", 31], ["liquidityUsd", 9999],
  ["mintAuthorityRevoked", null], ["freezeAuthorityRevoked", null], ["lpBurned", null], ["top10Pct", null], ["liquidityUsd", null]])
  test(`gate rejects (not scores) when ${k}=${v}`, () => assert.equal(R.gates({ ...ok, [k]: v }, g).pass, false));
test("post test: copy skipped when leader is too far ahead (0.0010 -> 0.0013, max 15%)", () => {
  const r = R.chase(0.0010, 0.0013, C.spy.maxChasePct); assert.equal(r.skip, true); assert.equal(Math.round(r.pct), 30);
});
test("chase at exactly 15% is allowed", () => assert.equal(R.chase(0.0010, 0.00115, 15).skip, false));
test("post latency example: +60% chase -> leader 2.0x = you +25%, leader 1.4x = you -12.5%", () => {
  assert.equal(R.copyPnlPct(0.0010, 0.0016, 2.0), 25); assert.ok(Math.abs(R.copyPnlPct(0.0010, 0.0016, 1.4) + 12.5) < 1e-9);
});
test("spy: demote after 3 consecutive losing copies; win resets", () => {
  let w = {}; w = R.spyAfter(w, false, C.spy); w = R.spyAfter(w, false, C.spy); w = R.spyAfter(w, true, C.spy);
  assert.equal(w.demoted, false); for (let i = 0; i < 3; i++) w = R.spyAfter(w, false, C.spy); assert.equal(w.demoted, true);
});
const st = { book: 1, dayStartBook: 1, consecutiveLosses: 0, feedTimeSec: 100 };
test("breaker: daily loss cap fires", () => assert.equal(R.breakers({ ...st, book: 0.9 }, d, 100).dailyLoss, true));
test("breaker: quiet desk does not block", () => assert.equal(R.breakers(st, d, 100).blockEntries, false));
test("breaker: consecutive losses fires", () => assert.equal(R.breakers({ ...st, consecutiveLosses: 3 }, d, 100).blockEntries, true));
test("breaker: feed lag fires when stale", () => assert.equal(R.breakers(st, d, 100 + d.feedLagMaxSec + 1).feedLag, true));
test("breaker: feed lag fires when feed time unknown", () => assert.equal(R.breakers({ ...st, feedTimeSec: null }, d, 100).feedLag, true));
test("breaker: KILL blocks entries", () => assert.equal(R.breakers({ ...st, kill: true }, d, 100).blockEntries, true));
test("breaker: liquidity drop forces exit even when price is fine", () => assert.equal(R.exitFor({ entryPrice: 1, entryLiq: 20000 }, 1.2, 9000, g, d), "LIQUIDITY DROP"));
test("exits: TP and SL", () => {
  assert.equal(R.exitFor({ entryPrice: 1, entryLiq: 1 }, 2.6, 1, g, d), "TP HIT");
  assert.equal(R.exitFor({ entryPrice: 1, entryLiq: 1 }, 0.69, 1, g, d), "STOP LOSS");
});
test("house: disabled by default, 0 launches, never holds supply", () => {
  const h = R.house(C.house); assert.equal(h.launchesAllowed, 0); assert.equal(h.holdsOwnSupply, false);
});
test("house: break-even needs fee x volume >= 2 x cost", () => {
  const base = { ...C.house, enabled: true, dailyLaunchBudget: 3, feeRate: 0.01, costPerLaunchUsd: 5, feesTodayUsd: 0, costsTodayUsd: 0 };
  assert.equal(R.house({ ...base, expectedVolumePerTokenUsd: 999 }).launchesAllowed, 0);
  assert.equal(R.house({ ...base, expectedVolumePerTokenUsd: 1000 }).launchesAllowed, 3);
});
test("house: hard stop when fees < cost", () => assert.equal(R.house({ ...C.house, enabled: true, dailyLaunchBudget: 3, expectedVolumePerTokenUsd: 1e6, feesTodayUsd: 1, costsTodayUsd: 2 }).launchesAllowed, 0));
test("FMEA sheet sorted worst RPN first", () => {
  const s = R.sortSheet(JSON.parse(fs.readFileSync(new URL("../engine/fmea.json", import.meta.url))).bots.gambler.failures);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].RPN >= s[i].RPN);
});
