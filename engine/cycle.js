import fs from "node:fs";
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL as LPS } from "@solana/web3.js";
import bs58 from "bs58";
import * as R from "./risk.js";

const C = JSON.parse(fs.readFileSync("engine/config.json")), G = C.gambler, D = C.desk;
const SPY = JSON.parse(fs.readFileSync("engine/spy_wallets.json")).wallets;
const FMEA = JSON.parse(fs.readFileSync("engine/fmea.json"));
const MODE = /^live$/i.test(process.env.MODE || "") ? "LIVE" : "PAPER";
const KILL = /^(1|true|on|yes)$/i.test(process.env.KILL || "");
const RPC_CUSTOM = !!process.env.RPC_URL;
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const SOL = "So11111111111111111111111111111111111111112", JUP = "https://lite-api.jup.ag/swap/v1";
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJ = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error(`${new URL(u).host} ${r.status}`); return r.json(); };
const S = fs.existsSync("data/state.json") ? JSON.parse(fs.readFileSync("data/state.json")) :
  { paperSol: D.paperStartSol, positions: [], closed: [], log: [], consecutiveLosses: 0, day: null, dayStartBook: null, seen: {}, spy: {}, funnel: { scout: 0, filter: 0, copied: 0, stops: 0, tp: 0 }, kills: {} };
const log = (stage, msg, src = "") => { S.log.unshift({ t: new Date().toISOString(), stage, msg, src }); console.log(stage, msg); };

const kp = process.env.SOLANA_PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY.trim())) : null;
const wallet = kp?.publicKey.toBase58() ?? null;
const balance = async () => { try { return kp ? (await conn.getBalance(kp.publicKey)) / LPS : null; } catch { return null; } };
let walletSol = await balance();

// ---- signals: Telegram public previews ----
async function scrape(ch) {
  const h = await (await fetch("https://t.me/s/" + ch, { headers: { "user-agent": "Mozilla/5.0" } })).text();
  return h.split('class="tgme_widget_message_wrap').slice(1).map(b => {
    const post = b.match(/data-post="([^"]+)"/)?.[1], time = b.match(/datetime="([^"]+)"/)?.[1];
    const raw = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!post || !time || !raw) return null;
    const text = raw.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    const num = s => { if (!s) return null; const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KkMm]?)/); return m ? +m[1] * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1) : null; };
    return { channel: ch, time, link: "https://t.me/" + post, symbol: text.match(/\$([^\d\s$·(.,][^\s$·(.,]{0,19})/)?.[1] ?? null,
      ca: text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/)?.[1] ?? null,
      callMc: num(text.match(/MC ~?\$([\d.,]+\s*[KkMm]?)/)?.[1] || text.match(/\$\S+ · \$([\d.,]+[KkMm])/)?.[1]),
      callLiq: num(text.match(/Liq \$([\d.,]+\s*[KkMm]?)/)?.[1]), text: text.slice(0, 400) };
  }).filter(Boolean);
}
let calls = [], feedTimeSec = null;
for (const ch of ["PumpPillSignals", "SmugCalls", "bitconggems"]) {
  try { calls.push(...await scrape(ch)); feedTimeSec = nowSec(); } catch (e) { log("FEED", `${ch} scrape failed: ${e.message}`); }
}
calls.sort((a, b) => b.time.localeCompare(a.time));

// ---- market + checks ----
async function market(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const d = await getJ("https://api.dexscreener.com/latest/dex/tokens/" + mints.slice(i, i + 30).join(","));
    for (const p of d.pairs || []) { const a = p.baseToken.address, l = p.liquidity?.usd ?? null;
      if (p.chainId === "solana" && (!out[a] || (l || 0) > (out[a].liq || 0))) out[a] = { price: p.priceUsd ? +p.priceUsd : null, liq: l, dex: p.dexId, pair: p.pairAddress, sym: p.baseToken.symbol }; }
  }
  return out;
}
async function checks(mint, m) {
  const c = { liquidityUsd: m?.liq ?? null, lpBurned: m && ["pumpswap", "pumpfun"].includes(m.dex) ? true : null, mintAuthorityRevoked: null, freezeAuthorityRevoked: null, top10Pct: null };
  try {
    const pk = new PublicKey(mint);
    const info = (await conn.getParsedAccountInfo(pk)).value?.data?.parsed?.info;
    if (info) { c.mintAuthorityRevoked = info.mintAuthority == null; c.freezeAuthorityRevoked = info.freezeAuthority == null; }
    const supply = +(await conn.getTokenSupply(pk)).value.uiAmount, top = (await conn.getTokenLargestAccounts(pk)).value;
    const owners = (await conn.getMultipleParsedAccounts(top.map(t => t.address))).value;
    const held = top.filter((t, i) => owners[i]?.data?.parsed?.info?.owner !== m?.pair).slice(0, 10).reduce((s, t) => s + (t.uiAmount || 0), 0);
    c.top10Pct = supply > 0 ? held / supply * 100 : null;
  } catch (e) { c.rpcError = e.message.slice(0, 80); }
  return c;
}
async function swap(inMint, outMint, amount) {
  const q = await getJ(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${D.slippageBps}`);
  const { swapTransaction } = await getJ(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }) });
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64")); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const r = await conn.confirmTransaction(sig, "confirmed"); if (r.value.err) throw new Error("tx failed " + sig);
  return sig;
}

const now = nowSec(), fresh = c => c.ca && now - Date.parse(c.time) / 1000 <= G.maxCallAgeSec;
let mk = {};
try { mk = await market([...new Set([...S.positions.map(p => p.mint), ...calls.filter(fresh).map(c => c.ca)])]); } catch (e) { log("FEED", "DexScreener: " + e.message); }
const val = p => mk[p.mint]?.price && p.entryPrice ? p.sol * mk[p.mint].price / p.entryPrice : p.sol;
const book = () => (MODE === "LIVE" ? walletSol ?? 0 : S.paperSol) + S.positions.reduce((s, p) => s + val(p), 0);
const today = new Date().toISOString().slice(0, 10);
if (S.day !== today) { S.day = today; S.dayStartBook = book(); }

// ---- exits (never blocked) ----
for (const p of [...S.positions]) {
  const why = R.exitFor(p, mk[p.mint]?.price ?? null, mk[p.mint] ? mk[p.mint].liq : null, G, D) || (p.mirror ? "MIRROR EXIT" : null);
  if (!why) continue;
  const v = val(p);
  try {
    if (MODE === "LIVE") {
      const accs = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(p.mint) });
      const raw = accs.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
      if (raw > 0n) p.exitSig = await swap(p.mint, SOL, raw.toString());
    } else S.paperSol += v;
    const won = v > p.sol; S.consecutiveLosses = won ? 0 : S.consecutiveLosses + 1;
    if (why === "STOP LOSS" || why === "LIQUIDITY DROP") S.funnel.stops++; if (why === "TP HIT") S.funnel.tp++;
    if (p.leader) S.spy[p.leader] = R.spyAfter(S.spy[p.leader] || {}, won, C.spy);
    S.closed.unshift({ ...p, exit: why, out: v, t2: new Date().toISOString() }); S.positions = S.positions.filter(x => x !== p);
    log(why, `${p.sym} ${v.toFixed(4)} SOL back (in ${p.sol.toFixed(4)})`, p.src);
  } catch (e) { log("ERROR", `exit ${p.sym}: ${e.message}`); }
}
if (MODE === "LIVE") walletSol = await balance();

const BR = R.breakers({ book: book(), dayStartBook: S.dayStartBook, consecutiveLosses: S.consecutiveLosses, feedTimeSec, kill: KILL }, D, nowSec());
if (MODE === "LIVE" && !kp) BR.blockEntries = true;
const gateLive = {};
async function enter(mint, sym, src, leader) {
  if (S.positions.length >= G.maxOpen || S.positions.some(p => p.mint === mint)) return;
  const m = mk[mint], c = await checks(mint, m), g = R.gates(c, G);
  for (const k of ["mintAuthorityRevoked", "freezeAuthorityRevoked", "lpBurned", "top10Pct", "liquidityUsd"]) gateLive[k] = (gateLive[k] || 0) + (g.reasons.some(r => r.toLowerCase().includes({ mintAuthorityRevoked: "mint", freezeAuthorityRevoked: "freeze", lpBurned: "lp", top10Pct: "top 10", liquidityUsd: "liquidity" }[k])) ? 1 : 0);
  if (!g.pass) { S.funnel.filter++; g.reasons.forEach(r => S.kills[r] = (S.kills[r] || 0) + 1); return log("FILTER KILLED", `${sym}: ${g.reasons.join(" · ")}`, src); }
  let size = R.positionSize(book(), G);
  if (leader) size = Math.min(size, book() * C.spy.perWalletCapFraction - S.positions.filter(p => p.leader === leader).reduce((s, p) => s + p.sol, 0));
  const free = (MODE === "LIVE" ? walletSol ?? 0 : S.paperSol) - D.solReserve;
  if (size < G.minTradeSol || size > free) return log("SKIP", `${sym}: size ${size.toFixed(4)} vs free ${free.toFixed(4)} SOL (reserve ${D.solReserve})`, src);
  try {
    const sig = MODE === "LIVE" ? await swap(SOL, mint, Math.floor(size * LPS)) : (S.paperSol -= size, null);
    S.positions.push({ mint, sym, sol: size, entryPrice: m.price, entryLiq: m.liq, t: new Date().toISOString(), src, leader: leader || null, sig });
    S.funnel.copied++; log(MODE === "LIVE" ? "BUY" : "PAPER BUY", `${sym} ${size.toFixed(4)} SOL @ $${m.price}`, src);
  } catch (e) { log("ERROR", `buy ${sym}: ${e.message}`); }
}

if (BR.blockEntries) log("BREAKER", "entries blocked: " + Object.keys(BR).filter(k => BR[k] && k !== "blockEntries").join(", "));
else {
  for (const c of calls.filter(fresh)) {           // Gambler
    if (S.seen[c.ca]) continue; S.seen[c.ca] = c.time; S.funnel.scout++;
    if (!mk[c.ca]?.price) { S.funnel.filter++; log("FILTER KILLED", `${c.symbol || c.ca.slice(0, 6)}: no DexScreener price`, c.channel); continue; }
    await enter(c.ca, c.symbol || mk[c.ca].sym, "TG " + c.channel); await sleep(400);
  }
  for (const L of SPY) {                            // Spy
    if (S.spy[L.w]?.demoted) continue;
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(L.w), { limit: 5 }); await sleep(400);
      for (const s of sigs) {
        if (S.seen[s.signature] || !s.blockTime) continue; S.seen[s.signature] = 1;
        const lag = nowSec() - s.blockTime; if (lag > C.spy.maxLagSec) continue;
        const tx = (await getJ(conn.rpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }) })).result; await sleep(400); if (!tx?.meta) continue;
        const i = tx.transaction.message.accountKeys.findIndex(k => (k.pubkey?.toBase58?.() ?? k.pubkey) === L.w), solD = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / LPS;
        for (const b of tx.meta.postTokenBalances.filter(b => b.owner === L.w && b.mint !== SOL)) {
          const pre = tx.meta.preTokenBalances.find(x => x.owner === L.w && x.mint === b.mint)?.uiTokenAmount.uiAmount || 0, dTok = (b.uiTokenAmount.uiAmount || 0) - pre;
          if (dTok < 0) S.positions.filter(p => p.leader === L.w && p.mint === b.mint).forEach(p => { p.mirror = true; log("MIRROR", `${L.name} sold ${p.sym}; exiting next cycle`, "spy"); });
          if (dTok > 0 && solD < 0) {
            S.funnel.scout++;
            const q = await getJ(`${JUP}/quote?inputMint=${SOL}&outputMint=${b.mint}&amount=${1e7}&slippageBps=${D.slippageBps}`).catch(() => null);
            if (!q) { log("SKIP", `${L.name}: no quote for ${b.mint.slice(0, 6)}`, "spy"); continue; }
            const ch = R.chase(-solD / dTok, 0.01 / (+q.outAmount / 10 ** b.uiTokenAmount.decimals), C.spy.maxChasePct);
            if (ch.skip) { log("RE-ENTRY SKIPPED", `${L.name} ${b.mint.slice(0, 6)}: chase ${ch.pct.toFixed(1)}% > ${C.spy.maxChasePct}% · lag ${lag}s · wallet ${L.w}`, "spy"); continue; }
            Object.assign(mk, await market([b.mint]).catch(() => ({})));
            if (mk[b.mint]?.price) await enter(b.mint, mk[b.mint].sym, "Spy " + L.name, L.w);
          }
        }
      }
    } catch (e) { log("SPY", `${L.name}: ${e.message.slice(0, 80)}`); }
  }
}

const H = R.house(C.house);
const status = {
  gambler: { "fixed-fraction sizing": `${G.bookFraction * 100}% of book = ${R.positionSize(book(), G).toFixed(4)} SOL`, "reject gates": Object.keys(gateLive).length ? Object.entries(gateLive).map(([k, v]) => `${k}: ${v} rejects`).join(", ") : "armed (no candidates this cycle)" },
  spy: { "max chase": `${C.spy.maxChasePct}%`, "per-wallet cap": `${C.spy.perWalletCapFraction * 100}% of book`, demoted: SPY.filter(l => S.spy[l.w]?.demoted).map(l => l.name).join(", ") || "none" },
  house: { "launches allowed today": H.launchesAllowed, "break-even": `${H.feePerLaunch.toFixed(2)} fee/launch vs ${H.required.toFixed(2)} required`, "hard stop": H.hardStop, "holds own supply": "never (no code path)" },
};
S.hist = [...(S.hist || []), { t: new Date().toISOString(), b: +book().toFixed(6) }].slice(-288); S.log = S.log.slice(0, 150); S.closed = S.closed.slice(0, 100); S.lastRun = new Date().toISOString();
fs.writeFileSync("data/state.json", JSON.stringify(S));
fs.writeFileSync("data/desk.json", JSON.stringify({
  updated: S.lastRun, mode: MODE, kill: KILL, rpcCustom: RPC_CUSTOM, wallet, walletSol, book: book(), paperStart: D.paperStartSol, dayStartBook: S.dayStartBook,
  consecutiveLosses: S.consecutiveLosses, breakers: BR, feedLagSec: feedTimeSec ? nowSec() - feedTimeSec : null, config: C, house: H,
  fmea: Object.fromEntries(FMEA.order.map(k => [k, { ...FMEA.bots[k], failures: R.sortSheet(FMEA.bots[k].failures), live: status[k] }])), order: FMEA.order,
  positions: S.positions.map(p => ({ ...p, priceNow: mk[p.mint]?.price ?? null, value: val(p) })), closed: S.closed.slice(0, 40),
  hist: S.hist, funnel: S.funnel, kills: S.kills, spy: SPY.map(l => ({ ...l, ...(S.spy[l.w] || {}) })), log: S.log.slice(0, 80), calls: calls.slice(0, 80),
}));
console.log("done", MODE, book().toFixed(4), JSON.stringify(BR));
