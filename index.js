"use strict";
require("dotenv").config();

var crypto = require("crypto");
var fs = require("fs");
var axios = require("axios");
var TelegramBot = require("node-telegram-bot-api");
var indicators = require("./indicators");
var getTrendSignal = indicators.getTrendSignal;

// ── Config ─────────────────────────────────────────────────────
var CB_KEY    = process.env.COINBASE_API_KEY;
var CB_SECRET = process.env.COINBASE_API_SECRET;
var TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
var TG_CHAT   = process.env.TELEGRAM_CHAT_ID;

var BASE_URL = "https://api.coinbase.com";

// Top 10 coins to trade (Coinbase product IDs)
var TOKENS = {
  BTC:  "BTC-USD",
  ETH:  "ETH-USD",
  SOL:  "SOL-USD",
  XRP:  "XRP-USD",
  ADA:  "ADA-USD",
  AVAX: "AVAX-USD",
  LINK: "LINK-USD",
  DOT:  "DOT-USD",
};

// Ledger addresses per coin
var LEDGER = {
  BTC: "bc1q7ljgn47r994ukatg979kha6mv93fut30sf935a",
  SOL: "4XyC7sodMEUaDHUhud47C9EmTE1PmidWNx85TmhSe5Qd",
  ETH: "0x612F207B16CB11C1231E24AfefAe9905986592f7",
};

var CONFIG = {
  buyPercent: parseFloat(process.env.BUY_PERCENT || "10"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "5"),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "15"),
  scanIntervalMs: 900000,       // 15 minutes
  priceHistoryLength: 50,
  ledgerPct: 35,                // 35% profit to Ledger
  usdPct: 35,                   // 35% profit stays as USD
  reinvestPct: 30,              // 30% reinvest
};

var telegram;
var positions = {};
var priceHistory = {};
var accounts = {};              // currency -> account_id
var POSITIONS_FILE = "/app/data/positions.json";

// ── Persistence ────────────────────────────────────────────────
function savePositions() {
  try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions)); } catch(e) {}
}

function loadPositions() {
  try {
    positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
    var c = Object.keys(positions).length;
    if (c > 0) console.log("[LOAD] Restored " + c + " positions from disk");
  } catch(e) { positions = {}; }
}

// ── Coinbase Auth ──────────────────────────────────────────────
function cbSign(method, path, body) {
  var timestamp = Math.floor(Date.now() / 1000).toString();
  var message = timestamp + method.toUpperCase() + path + (body || "");
  var signature = crypto.createHmac("sha256", CB_SECRET).update(message).digest("hex");
  return {
    "CB-ACCESS-KEY": CB_KEY,
    "CB-ACCESS-SIGN": signature,
    "CB-ACCESS-TIMESTAMP": timestamp,
    "Content-Type": "application/json",
  };
}

function cbRequest(method, path, body) {
  var bodyStr = body ? JSON.stringify(body) : "";
  var headers = cbSign(method, path, bodyStr);
  var config = {
    method: method,
    url: BASE_URL + path,
    headers: headers,
    timeout: 10000,
  };
  if (body) config.data = body;
  return axios(config).then(function(res) { return res.data; });
}

// ── Telegram ───────────────────────────────────────────────────
function notify(msg) {
  return telegram.sendMessage(TG_CHAT, msg, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(function(e) { console.error("[TG]", e.message); });
}

// ── Account helpers ────────────────────────────────────────────
function loadAccounts() {
  return cbRequest("GET", "/v2/accounts?limit=100").then(function(res) {
    var accts = res.data || [];
    accts.forEach(function(a) {
      accounts[a.currency.code] = a.id;
    });
    console.log("[ACCOUNTS] Loaded " + Object.keys(accounts).length + " accounts");
  }).catch(function(e) { console.error("[ACCOUNTS]", e.message); });
}

function getUsdBalance() {
  return cbRequest("GET", "/v2/accounts").then(function(res) {
    var usd = (res.data || []).find(function(a) { return a.currency.code === "USD"; });
    return usd ? parseFloat(usd.balance.amount) : 0;
  }).catch(function() { return 0; });
}

function getCoinBalance(coin) {
  return cbRequest("GET", "/v2/accounts").then(function(res) {
    var acct = (res.data || []).find(function(a) { return a.currency.code === coin; });
    return acct ? parseFloat(acct.balance.amount) : 0;
  }).catch(function() { return 0; });
}

// ── Price data ─────────────────────────────────────────────────
function getPrice(productId) {
  return cbRequest("GET", "/api/v3/brokerage/products/" + productId).then(function(res) {
    return parseFloat(res.price);
  }).catch(function() { return null; });
}

function updatePriceHistory(coin, productId) {
  return getPrice(productId).then(function(price) {
    if (!price) { console.log("[PRICE] " + coin + ": failed to fetch"); return; }
    if (!priceHistory[coin]) priceHistory[coin] = [];
    priceHistory[coin].push(price);
    if (priceHistory[coin].length > CONFIG.priceHistoryLength) priceHistory[coin].shift();
    console.log("[PRICE] " + coin + ": $" + price.toFixed(2) + " | history: " + priceHistory[coin].length + " candles");
  });
}

// ── Trading ────────────────────────────────────────────────────
function marketBuy(productId, usdAmount) {
  var orderId = "bot-" + Date.now();
  return cbRequest("POST", "/api/v3/brokerage/orders", {
    client_order_id: orderId,
    product_id: productId,
    side: "BUY",
    order_configuration: {
      market_market_ioc: {
        quote_size: usdAmount.toFixed(2),
      },
    },
  });
}

function marketSell(productId, coinAmount) {
  var orderId = "bot-" + Date.now();
  return cbRequest("POST", "/api/v3/brokerage/orders", {
    client_order_id: orderId,
    product_id: productId,
    side: "SELL",
    order_configuration: {
      market_market_ioc: {
        base_size: coinAmount.toString(),
      },
    },
  });
}

// ── Send to Ledger ─────────────────────────────────────────────
function sendToLedger(coin, amount) {
  var address = LEDGER[coin];
  if (!address || !accounts[coin]) {
    console.log("[LEDGER] No address or account for " + coin);
    return Promise.resolve();
  }
  return cbRequest("POST", "/v2/accounts/" + accounts[coin] + "/transactions", {
    type: "send",
    to: address,
    amount: amount.toString(),
    currency: coin,
  }).then(function(res) {
    console.log("[LEDGER] Sent " + amount + " " + coin + " to Ledger");
    return notify("💸 *Profit → Ledger*\nSent " + amount.toFixed(6) + " " + coin + " to Ledger\n📍 " + address.slice(0, 12) + "...");
  }).catch(function(e) {
    console.error("[LEDGER]", e.response ? JSON.stringify(e.response.data) : e.message);
  });
}

// ── Profit split ───────────────────────────────────────────────
function splitProfit(coin, productId, totalCoinProfit, price) {
  if (totalCoinProfit <= 0) return Promise.resolve();

  var ledgerAmount = totalCoinProfit * CONFIG.ledgerPct / 100;   // 35% to Ledger as coin
  var usdAmount = totalCoinProfit * CONFIG.usdPct / 100;         // 35% sell for USD
  var reinvest = totalCoinProfit * CONFIG.reinvestPct / 100;     // 30% keep as coin

  var usdValue = totalCoinProfit * price;
  console.log("[PROFIT] " + coin + " | total: " + totalCoinProfit.toFixed(6) + " ($" + usdValue.toFixed(2) + ")");
  console.log("[PROFIT] 35% Ledger: " + ledgerAmount.toFixed(6) + " " + coin);
  console.log("[PROFIT] 35% USD: $" + (usdAmount * price).toFixed(2));
  console.log("[PROFIT] 30% Reinvest: " + reinvest.toFixed(6) + " " + coin);

  var p = Promise.resolve();

  // Send 35% to Ledger (as coin)
  if (LEDGER[coin] && ledgerAmount > 0) {
    p = p.then(function() { return sendToLedger(coin, ledgerAmount); });
  }

  // Sell 35% for USD (stays in Coinbase for bank withdrawal)
  if (usdAmount > 0) {
    p = p.then(function() {
      return marketSell(productId, usdAmount).then(function() {
        console.log("[USD] Sold " + usdAmount.toFixed(6) + " " + coin + " for ~$" + (usdAmount * price).toFixed(2));
        return notify("💵 *Profit → USD*\nSold " + usdAmount.toFixed(6) + " " + coin + " for ~$" + (usdAmount * price).toFixed(2) + "\nAvailable for bank withdrawal");
      }).catch(function(e) { console.error("[USD SELL]", e.message); });
    });
  }

  // 30% stays as coin — no action needed
  return p.then(function() {
    return notify("📊 *Profit Split Complete* — " + coin + "\n💸 35% → Ledger: " + ledgerAmount.toFixed(6) + " " + coin + "\n💵 35% → USD: ~$" + (usdAmount * price).toFixed(2) + "\n🔄 30% → Reinvest: " + reinvest.toFixed(6) + " " + coin);
  });
}

// ── Buy ────────────────────────────────────────────────────────
function buyToken(coin, productId, price) {
  if (positions[coin]) return Promise.resolve();
  return getUsdBalance().then(function(usdBal) {
    var buyUsd = usdBal * CONFIG.buyPercent / 100;
    if (buyUsd < 1) { console.log("[SKIP] USD balance too low: $" + usdBal.toFixed(2)); return; }

    console.log("[BUY] " + coin + " @ $" + price.toFixed(2) + " | $" + buyUsd.toFixed(2));

    return marketBuy(productId, buyUsd).then(function(res) {
      var coinAmount = buyUsd / price;
      positions[coin] = {
        productId: productId,
        entryPrice: price,
        entryUsd: buyUsd,
        coinAmount: coinAmount,
        entryTime: Date.now(),
      };
      savePositions();
      return notify("🟢 *TREND BUY* — " + coin + "\n💰 Spent: $" + buyUsd.toFixed(2) + "\n📈 Entry: $" + price.toFixed(2) + "\n🎯 TP: +" + CONFIG.takeProfitPct + "% | SL: -" + CONFIG.stopLossPct + "%");
    }).catch(function(e) {
      console.error("[BUY ERROR]", e.response ? JSON.stringify(e.response.data) : e.message);
      return notify("⚠️ Buy failed for " + coin + ": " + e.message);
    });
  });
}

// ── Sell ────────────────────────────────────────────────────────
function sellToken(coin, reason) {
  var pos = positions[coin];
  if (!pos) return Promise.resolve();

  return getPrice(pos.productId).then(function(price) {
    if (!price) return;
    var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    var profitCoin = pos.coinAmount * (pnl / 100);

    console.log("[SELL] " + coin + " | " + reason + " | PnL: " + pnl.toFixed(2) + "%");

    return marketSell(pos.productId, pos.coinAmount).then(function(res) {
      delete positions[coin];
      savePositions();

      return notify((pnl >= 0 ? "🔴" : "📉") + " *TREND SELL* — " + coin + "\n📊 PnL: " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%\n💡 Reason: " + reason + "\n💰 Value: $" + (pos.coinAmount * price).toFixed(2)).then(function() {
        if (profitCoin > 0) {
          return splitProfit(coin, pos.productId, profitCoin, price);
        }
      });
    }).catch(function(e) {
      console.error("[SELL ERROR]", e.response ? JSON.stringify(e.response.data) : e.message);
      return notify("⚠️ Sell failed for " + coin + ": " + e.message);
    });
  });
}

// ── Scan ───────────────────────────────────────────────────────
function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function scan() {
  var tokens = Object.entries(TOKENS);
  var i = 0;
  function next() {
    if (i >= tokens.length) return Promise.resolve();
    var coin = tokens[i][0];
    var productId = tokens[i][1];
    i++;
    return updatePriceHistory(coin, productId).then(function() {
      var history = priceHistory[coin] || [];
      if (history.length < 26) {
        console.log("[SCAN] " + coin + " | waiting for data (" + history.length + "/26)");
        return delay(2000).then(next);
      }
      var signal = getTrendSignal(history);
      var price = history[history.length - 1];
      var pos = positions[coin];
      console.log("[SCAN] " + coin + " | signal: " + signal + " | price: $" + price.toFixed(2) + " | position: " + (pos ? "YES" : "no"));

      if (signal === "BUY" && !pos) {
        return buyToken(coin, productId, price).then(function() { return delay(2000).then(next); });
      }
      if (pos) {
        var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        if (pnl >= CONFIG.takeProfitPct) return sellToken(coin, "Take Profit +" + pnl.toFixed(1) + "%").then(function() { return delay(2000).then(next); });
        if (pnl <= -CONFIG.stopLossPct) return sellToken(coin, "Stop Loss " + pnl.toFixed(1) + "%").then(function() { return delay(2000).then(next); });
        if (signal === "SELL") return sellToken(coin, "Trend Reversal").then(function() { return delay(2000).then(next); });
      }
      return delay(2000).then(next);
    });
  }
  return next();
}

// ── Heartbeat ──────────────────────────────────────────────────
function heartbeat() {
  return getUsdBalance().then(function(usdBal) {
    var posNames = Object.keys(positions).length > 0 ? Object.keys(positions).join(", ") : "none";
    return notify("💓 *Trend Bot Heartbeat*\n💰 USD Balance: $" + usdBal.toFixed(2) + "\n📊 Open positions: " + Object.keys(positions).length + " (" + posNames + ")\n🔄 Scanning: BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT");
  });
}

// ── Init ───────────────────────────────────────────────────────
function init() {
  if (!CB_KEY || !CB_SECRET || !TG_TOKEN || !TG_CHAT) {
    throw new Error("Missing env vars: COINBASE_API_KEY, COINBASE_API_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
  }
  telegram = new TelegramBot(TG_TOKEN, { polling: false });

  return loadAccounts().then(function() {
    return getUsdBalance();
  }).then(function(usdBal) {
    loadPositions();
    console.log("[INIT] Blue-Chip Trend Bot v2 started (Coinbase)");
    console.log("[INIT] USD Balance: $" + usdBal.toFixed(2));
    console.log("[INIT] Trading: " + Object.keys(TOKENS).join(", "));
    return notify(
      "📈 *Blue-Chip Trend Bot ONLINE*\n" +
      "🏦 Exchange: Coinbase\n" +
      "💰 USD Balance: $" + usdBal.toFixed(2) + "\n" +
      "🎯 Tokens: BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT\n" +
      "📊 Strategy: EMA9/EMA21 + RSI14\n" +
      "🎯 TP: +" + CONFIG.takeProfitPct + "% | SL: -" + CONFIG.stopLossPct + "%\n" +
      "💸 Profit: 35% Ledger | 35% USD | 30% Reinvest"
    );
  });
}

// ── Start ──────────────────────────────────────────────────────
init().then(function() {
  console.log("[WARMUP] Building price history...");
  var warmup = 0;
  function doWarmup() {
    if (warmup >= 10) {
      console.log("[START] Scanning...");
      scan();
      setInterval(scan, CONFIG.scanIntervalMs);
      setInterval(heartbeat, 3600000);
      return;
    }
    warmup++;
    var p = Promise.resolve();
    Object.entries(TOKENS).forEach(function(t) {
      p = p.then(function() { return updatePriceHistory(t[0], t[1]); }).then(function() { return delay(1000); });
    });
    p.then(function() { return delay(5000); }).then(doWarmup);
  }
  doWarmup();
}).catch(function(e) {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
