# 📈 Blue-Chip Trend Bot v2 (Coinbase)

Trades the top 8 cryptocurrencies on Coinbase using EMA/RSI trend indicators.

## Coins
BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT

## Strategy
- EMA9/EMA21 crossover + RSI14
- Buy when uptrend confirmed
- Sell on reversal, +15% TP, or -5% SL
- Scans every 15 minutes

## Profit Split
- 35% → Ledger (as the coin)
- 35% → USD (stays on Coinbase for bank withdrawal)
- 30% → Reinvest (stays as the coin)

## Deploy
```bash
fly secrets set COINBASE_API_KEY="your_key" -a blue-chip-trend-bot
fly secrets set COINBASE_API_SECRET="your_secret" -a blue-chip-trend-bot
fly secrets set TELEGRAM_BOT_TOKEN="your_token" -a blue-chip-trend-bot
fly secrets set TELEGRAM_CHAT_ID="your_chat_id" -a blue-chip-trend-bot
fly deploy
```
