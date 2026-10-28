# Grok Desk
Failure-mode-engineered Solana memecoin desk on GitHub Actions. PAPER by default. Not financial advice.
- `MODE` repo variable: `PAPER` (default) or `LIVE`. `KILL=true` blocks all new entries (exits still run).
- Optional secret `RPC_URL` (e.g. Helius). The public RPC rate-limits, and failed checks reject trades.
- Spy wallets: `engine/spy_wallets.json`. House launching is disabled (budget 0) and has no launch code.
