"use strict";

function ema(prices, period) {
  if (prices.length < period) return null;
  var k = 2 / (period + 1);
  var emaVal = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (var i = period; i < prices.length; i++) {
    emaVal = prices[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(prices, period) {
  period = period || 14;
  if (prices.length < period + 1) return null;
  var changes = [];
  for (var i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  var recent = changes.slice(-period);
  var gains = recent.filter(function(c) { return c > 0; }).reduce(function(a, b) { return a + b; }, 0) / period;
  var losses = Math.abs(recent.filter(function(c) { return c < 0; }).reduce(function(a, b) { return a + b; }, 0)) / period;
  if (losses === 0) return 100;
  var rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function getTrendSignal(prices) {
  if (prices.length < 26) return "HOLD";
  var ema9 = ema(prices, 9);
  var ema21 = ema(prices, 21);
  var rsiVal = rsi(prices, 14);
  var price = prices[prices.length - 1];
  if (!ema9 || !ema21 || !rsiVal) return "HOLD";
  var bullish = ema9 > ema21 && price > ema9 && rsiVal > 50 && rsiVal < 70;
  var bearish = ema9 < ema21 || rsiVal > 75 || rsiVal < 30;
  if (bullish) return "BUY";
  if (bearish) return "SELL";
  return "HOLD";
}

module.exports = { ema: ema, rsi: rsi, getTrendSignal: getTrendSignal };
