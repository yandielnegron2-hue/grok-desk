// Every rule here is exercised by test/risk.test.js; a failing test fails the workflow before any trade.
export const positionSize = (book, g) => { const s = book * g.bookFraction; return s >= g.minTradeSol ? s : 0; };

export function gates(c, g) {
  const r = [];
  const need = (v, ok, name, unk) => { if (v == null) r.push(unk); else if (!ok) r.push(name); };
  need(c.mintAuthorityRevoked, c.mintAuthorityRevoked === true, "mint authority active", "mint authority unknown");
  need(c.freezeAuthorityRevoked, c.freezeAuthorityRevoked === true, "freeze authority active", "freeze authority unknown");
  need(c.lpBurned, c.lpBurned === true, "LP not locked", "LP status unknown");
  need(c.top10Pct, c.top10Pct <= g.maxTop10Pct, `Top 10 holders >${g.maxTop10Pct}%`, "top 10 share unknown");
  need(c.liquidityUsd, c.liquidityUsd >= g.minLiquidityUsd, `liquidity < $${g.minLiquidityUsd}`, "liquidity unknown");
  return { pass: r.length === 0, reasons: r };
}

export function chase(leaderEntry, copyQuote, maxChasePct) {
  const pct = (copyQuote / leaderEntry - 1) * 100;
  return { skip: pct > maxChasePct + 1e-9, pct };
}
export const copyPnlPct = (leaderEntry, copyFill, exitMult) => (leaderEntry * exitMult / copyFill - 1) * 100;
export const spyAfter = (w, won, s) => { const n = won ? 0 : (w.losses || 0) + 1; return { ...w, losses: n, demoted: !!w.demoted || n >= s.demoteAfterLosses }; };

export function breakers(st, d, nowSec) {
  const b = {
    dailyLoss: st.dayStartBook > 0 && (st.book / st.dayStartBook - 1) * 100 <= -d.dailyLossCapPct + 1e-9,
    consecutiveLosses: st.consecutiveLosses >= d.maxConsecutiveLosses,
    feedLag: st.feedTimeSec == null || nowSec - st.feedTimeSec > d.feedLagMaxSec,
    kill: !!st.kill,
  };
  return { ...b, blockEntries: Object.values(b).some(Boolean) };
}
export const liquidityDrop = (entryLiq, nowLiq, d) => entryLiq > 0 && (nowLiq == null || (nowLiq / entryLiq - 1) * 100 <= -d.liquidityDropExitPct);
export function exitFor(p, priceNow, liqNow, g, d) {
  if (liquidityDrop(p.entryLiq, liqNow, d)) return "LIQUIDITY DROP";
  if (priceNow == null) return null;
  const pct = (priceNow / p.entryPrice - 1) * 100;
  return pct >= g.takeProfitPct ? "TP HIT" : pct <= g.stopLossPct ? "STOP LOSS" : null;
}

export function house(h) {
  const feePerLaunch = h.feeRate * h.expectedVolumePerTokenUsd;
  const breakEvenOk = feePerLaunch >= h.safetyFactor * h.costPerLaunchUsd;
  const hardStop = h.feesTodayUsd < h.costsTodayUsd;
  const launchesAllowed = h.enabled && breakEvenOk && !hardStop ? h.dailyLaunchBudget : 0;
  return { feePerLaunch, required: h.safetyFactor * h.costPerLaunchUsd, breakEvenOk, hardStop, launchesAllowed, holdsOwnSupply: false };
}
export const rpn = f => f.S * f.L * f.D;
export const sortSheet = fs => [...fs].map(f => ({ ...f, RPN: rpn(f) })).sort((a, b) => b.RPN - a.RPN);
