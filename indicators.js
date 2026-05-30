"use strict";

/**
 * Calculate Exponential Moving Average
 */
function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    emaVal = prices[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

/**
 * Calculate RSI
 */
function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const recent = changes.slice(-period);
  const gains  = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = Math.abs(recent.filter(c => c < 0).reduce((a, b) => a + b, 0)) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

/**
 * Detect trend signal from price array
 * Returns: 'BUY' | 'SELL' | 'HOLD'
 */
function getTrendSignal(prices) {
  if (prices.length < 26) return 'HOLD';

  const ema9  = ema(prices, 9);
  const ema21 = ema(prices, 21);
  const rsiVal = rsi(prices, 14);
  const price  = prices[prices.length - 1];

  if (!ema9 || !ema21 || !rsiVal) return 'HOLD';

  const bullish = ema9 > ema21 && price > ema9 && rsiVal > 50 && rsiVal < 70;
  const bearish = ema9 < ema21 || rsiVal > 75 || rsiVal < 30;

  if (bullish) return 'BUY';
  if (bearish) return 'SELL';
  return 'HOLD';
}

module.exports = { ema, rsi, getTrendSignal };
