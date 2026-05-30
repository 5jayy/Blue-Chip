# 📈 Blue-Chip Trend Bot

Trades SOL, wBTC, wETH, BNB on Solana using EMA/RSI trend indicators. Slow, consistent growth strategy.

## Strategy
- **EMA 9 / EMA 21 crossover** — confirms uptrend
- **RSI 14** — filters overbought/oversold
- **Buy signal**: EMA9 > EMA21, price above EMA9, RSI 50-70
- **Sell signal**: EMA crossdown, RSI > 75 (overbought), or hit TP/SL

## Setup

```bash
# 1. Install deps
npm install

# 2. Copy env
cp .env.example .env

# 3. Fill in .env with your keys

# 4. Run locally
npm start
```

## .env values

| Key | Description |
|-----|-------------|
| `PRIVATE_KEY` | Phantom wallet private key (base58) |
| `HELIUS_API_KEY` | From helius.dev |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `BUY_PERCENT` | % of balance per trade (default: 10) |
| `STOP_LOSS_PCT` | Stop loss % (default: 5) |
| `TAKE_PROFIT_PCT` | Take profit % (default: 15) |
| `SWEEP_PCT` | % of profits to Ledger (default: 25) |
| `SWEEP_ADDRESS` | Your Ledger wallet address |

## Deploy to Fly.io

```bash
fly auth login
fly launch --name blue-chip-trend-bot --no-deploy
fly secrets set PRIVATE_KEY="..."
fly secrets set HELIUS_API_KEY="..."
fly secrets set TELEGRAM_BOT_TOKEN="..."
fly secrets set TELEGRAM_CHAT_ID="..."
fly secrets set BUY_PERCENT="10"
fly secrets set STOP_LOSS_PCT="5"
fly secrets set TAKE_PROFIT_PCT="15"
fly secrets set SWEEP_PCT="25"
fly secrets set SWEEP_ADDRESS="4XyC7sodMEUaDHUhud47C9EmTE1PmidWNx85TmhSe5Qd"
fly deploy
fly logs
```
