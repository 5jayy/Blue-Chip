"use strict";
require("dotenv").config();

var crypto = require("crypto");
var fs = require("fs");
var axios = require("axios");
var TelegramBot = require("node-telegram-bot-api");
var indicators = require("./indicators");
var getTrendSignal = indicators.getTrendSignal;

var CB_KEY    = process.env.COINBASE_API_KEY;
var CB_SECRET = process.env.COINBASE_API_SECRET;
var TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
var TG_CHAT   = process.env.TELEGRAM_CHAT_ID;
var BASE_URL  = "https://api.coinbase.com";

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

var LEDGER = {
  BTC: "bc1q7ljgn47r994ukatg979kha6mv93fut30sf935a",
  SOL: "4XyC7sodMEUaDHUhud47C9EmTE1PmidWNx85TmhSe5Qd",
  ETH: "0x612F207B16CB11C1231E24AfefAe9905986592f7",
};

var CONFIG = {
  buyPercent: parseFloat(process.env.BUY_PERCENT || "10"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "5"),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "15"),
  scanIntervalMs: 900000,
  priceHistoryLength: 50,
  ledgerPct: 35,
  usdPct: 35,
  reinvestPct: 30,
};

var telegram;
var positions = {};
var priceHistory = {};
var accounts = {};
var POSITIONS_FILE = "/app/data/positions.json";

function savePositions() { try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions)); } catch(e) {} }
function loadPositions() { try { positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); var c = Object.keys(positions).length; if (c > 0) console.log("[LOAD] Restored " + c + " positions"); } catch(e) { positions = {}; } }

function notify(msg) {
  if (!telegram || !TG_CHAT) { console.log("[LOG] " + msg.replace(/\*/g, "").replace(/\n/g, " | ")); return Promise.resolve(); }
  return telegram.sendMessage(TG_CHAT, msg, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(function(e) { console.error("[TG]", e.message); });
}

function cbSign(method, path, body) {
  var timestamp = Math.floor(Date.now() / 1000).toString();
  var message = timestamp + method.toUpperCase() + path + (body || "");
  var secretBuffer = Buffer.from(CB_SECRET, "base64");
  var signature = crypto.createHmac("sha256", secretBuffer).update(message).digest("hex");
  return { "CB-ACCESS-KEY": CB_KEY, "CB-ACCESS-SIGN": signature, "CB-ACCESS-TIMESTAMP": timestamp, "Content-Type": "application/json" };
}

function cbRequest(method, path, body) {
  var bodyStr = body ? JSON.stringify(body) : "";
  var headers = cbSign(method, path, bodyStr);
  var config = { method: method, url: BASE_URL + path, headers: headers, timeout: 10000 };
  if (body) config.data = body;
  return axios(config).then(function(res) { return res.data; });
}

function loadAccounts() {
  return cbRequest("GET", "/v2/accounts?limit=100").then(function(res) {
    (res.data || []).forEach(function(a) { accounts[a.currency.code] = a.id; });
    console.log("[ACCOUNTS] Loaded " + Object.keys(accounts).length);
  }).catch(function(e) { console.error("[ACCOUNTS]", e.message); });
}

function getUsdBalance() {
  return cbRequest("GET", "/v2/accounts").then(function(res) {
    var usd = (res.data || []).find(function(a) { return a.currency.code === "USD"; });
    return usd ? parseFloat(usd.balance.amount) : 0;
  }).catch(function() { return 0; });
}

function getPrice(productId) {
  return cbRequest("GET", "/api/v3/brokerage/products/" + productId).then(function(res) {
    return parseFloat(res.price);
  }).catch(function() { return null; });
}

function updatePriceHistory(coin, productId) {
  return getPrice(productId).then(function(price) {
    if (!price) { console.log("[PRICE] " + coin + ": failed"); return; }
    if (!priceHistory[coin]) priceHistory[coin] = [];
    priceHistory[coin].push(price);
    if (priceHistory[coin].length > CONFIG.priceHistoryLength) priceHistory[coin].shift();
    console.log("[PRICE] " + coin + ": $" + price.toFixed(2) + " | history: " + priceHistory[coin].length);
  });
}

function marketBuy(productId, usdAmount) {
  return cbRequest("POST", "/api/v3/brokerage/orders", {
    client_order_id: "bot-" + Date.now(), product_id: productId, side: "BUY",
    order_configuration: { market_market_ioc: { quote_size: usdAmount.toFixed(2) } },
  });
}

function marketSell(productId, coinAmount) {
  return cbRequest("POST", "/api/v3/brokerage/orders", {
    client_order_id: "bot-" + Date.now(), product_id: productId, side: "SELL",
    order_configuration: { market_market_ioc: { base_size: coinAmount.toString() } },
  });
}

function sendToLedger(coin, amount) {
  var address = LEDGER[coin];
  if (!address || !accounts[coin]) { console.log("[LEDGER] No address for " + coin); return Promise.resolve(); }
  return cbRequest("POST", "/v2/accounts/" + accounts[coin] + "/transactions", {
    type: "send", to: address, amount: amount.toString(), currency: coin,
  }).then(function() {
    console.log("[LEDGER] Sent " + amount.toFixed(6) + " " + coin);
    return notify("💸 *Profit → Ledger*\nSent " + amount.toFixed(6) + " " + coin + "\n📍 " + address.slice(0, 12) + "...");
  }).catch(function(e) { console.error("[LEDGER]", e.response ? JSON.stringify(e.response.data) : e.message); });
}

function splitProfit(coin, productId, totalCoinProfit, price) {
  if (totalCoinProfit <= 0) return Promise.resolve();
  var ledgerAmount = totalCoinProfit * CONFIG.ledgerPct / 100;
  var usdAmount = totalCoinProfit * CONFIG.usdPct / 100;
  var reinvest = totalCoinProfit * CONFIG.reinvestPct / 100;
  console.log("[PROFIT] " + coin + " | total: " + totalCoinProfit.toFixed(6) + " ($" + (totalCoinProfit * price).toFixed(2) + ")");
  var p = Promise.resolve();
  if (LEDGER[coin] && ledgerAmount > 0) p = p.then(function() { return sendToLedger(coin, ledgerAmount); });
  if (usdAmount > 0) p = p.then(function() {
    return marketSell(productId, usdAmount).then(function() {
      return notify("💵 *Profit → USD*\nSold " + usdAmount.toFixed(6) + " " + coin + " for ~$" + (usdAmount * price).toFixed(2));
    }).catch(function(e) { console.error("[USD SELL]", e.message); });
  });
  return p.then(function() {
    return notify("📊 *Profit Split* — " + coin + "\n💸 35% Ledger: " + ledgerAmount.toFixed(6) + " " + coin + "\n💵 35% USD: ~$" + (usdAmount * price).toFixed(2) + "\n🔄 30% Reinvest: " + reinvest.toFixed(6) + " " + coin);
  });
}

function buyToken(coin, productId, price) {
  if (positions[coin]) return Promise.resolve();
  return getUsdBalance().then(function(usdBal) {
    var buyUsd = usdBal * CONFIG.buyPercent / 100;
    if (buyUsd < 1) { console.log("[SKIP] USD too low: $" + usdBal.toFixed(2)); return; }
    console.log("[BUY] " + coin + " @ $" + price.toFixed(2) + " | $" + buyUsd.toFixed(2));
    return marketBuy(productId, buyUsd).then(function() {
      positions[coin] = { productId: productId, entryPrice: price, entryUsd: buyUsd, coinAmount: buyUsd / price, entryTime: Date.now() };
      savePositions();
      return notify("🟢 *TREND BUY* — " + coin + "\n💰 Spent: $" + buyUsd.toFixed(2) + "\n📈 Entry: $" + price.toFixed(2) + "\n🎯 TP: +" + CONFIG.takeProfitPct + "% | SL: -" + CONFIG.stopLossPct + "%");
    }).catch(function(e) { console.error("[BUY ERROR]", e.response ? JSON.stringify(e.response.data) : e.message); return notify("⚠️ Buy failed: " + coin + " — " + e.message); });
  });
}

function sellToken(coin, reason) {
  var pos = positions[coin];
  if (!pos) return Promise.resolve();
  return getPrice(pos.productId).then(function(price) {
    if (!price) return;
    var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    var profitCoin = pos.coinAmount * (pnl / 100);
    console.log("[SELL] " + coin + " | " + reason + " | PnL: " + pnl.toFixed(2) + "%");
    return marketSell(pos.productId, pos.coinAmount).then(function() {
      delete positions[coin];
      savePositions();
      return notify((pnl >= 0 ? "🔴" : "📉") + " *TREND SELL* — " + coin + "\n📊 PnL: " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%\n💡 Reason: " + reason + "\n💰 Value: $" + (pos.coinAmount * price).toFixed(2)).then(function() {
        if (profitCoin > 0) return splitProfit(coin, pos.productId, profitCoin, price);
      });
    }).catch(function(e) { console.error("[SELL ERROR]", e.response ? JSON.stringify(e.response.data) : e.message); return notify("⚠️ Sell failed: " + coin + " — " + e.message); });
  });
}

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function scan() {
  var tokens = Object.entries(TOKENS); var i = 0;
  function next() {
    if (i >= tokens.length) return Promise.resolve();
    var coin = tokens[i][0]; var productId = tokens[i][1]; i++;
    return updatePriceHistory(coin, productId).then(function() {
      var history = priceHistory[coin] || [];
      if (history.length < 26) { console.log("[SCAN] " + coin + " | waiting (" + history.length + "/26)"); return delay(2000).then(next); }
      var signal = getTrendSignal(history); var price = history[history.length - 1]; var pos = positions[coin];
      console.log("[SCAN] " + coin + " | " + signal + " | $" + price.toFixed(2) + " | " + (pos ? "HOLDING" : "no position"));
      if (signal === "BUY" && !pos) return buyToken(coin, productId, price).then(function() { return delay(2000).then(next); });
      if (pos) {
        var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        if (pnl >= CONFIG.takeProfitPct) return sellToken(coin, "TP +" + pnl.toFixed(1) + "%").then(function() { return delay(2000).then(next); });
        if (pnl <= -CONFIG.stopLossPct) return sellToken(coin, "SL " + pnl.toFixed(1) + "%").then(function() { return delay(2000).then(next); });
        if (signal === "SELL") return sellToken(coin, "Trend Reversal").then(function() { return delay(2000).then(next); });
      }
      return delay(2000).then(next);
    });
  }
  return next();
}

function heartbeat() {
  return getUsdBalance().then(function(usdBal) {
    var posNames = Object.keys(positions).length > 0 ? Object.keys(positions).join(", ") : "none";
    return notify("💓 *Trend Bot Heartbeat*\n💰 USD: $" + usdBal.toFixed(2) + "\n📊 Positions: " + Object.keys(positions).length + " (" + posNames + ")\n🔄 Scanning: BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT");
  });
}

function init() {
  if (!CB_KEY || !CB_SECRET) throw new Error("Missing COINBASE_API_KEY or COINBASE_API_SECRET");
  if (TG_TOKEN && TG_CHAT) { telegram = new TelegramBot(TG_TOKEN, { polling: false }); console.log("[TG] Telegram connected"); }
  return loadAccounts().then(function() { return getUsdBalance(); }).then(function(usdBal) {
    loadPositions();
    console.log("[INIT] Blue-Chip Trend Bot v2 (Coinbase)");
    console.log("[INIT] USD Balance: $" + usdBal.toFixed(2));
    console.log("[INIT] Coins: " + Object.keys(TOKENS).join(", "));
    return notify("📈 *Blue-Chip Trend Bot ONLINE*\n🏦 Exchange: Coinbase\n💰 USD: $" + usdBal.toFixed(2) + "\n🎯 BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT\n📊 EMA9/EMA21 + RSI14\n🎯 TP: +" + CONFIG.takeProfitPct + "% | SL: -" + CONFIG.stopLossPct + "%\n💸 35% Ledger | 35% USD | 30% Reinvest");
  });
}

init().then(function() {
  console.log("[WARMUP] Building price history...");
  var warmup = 0;
  function doWarmup() {
    if (warmup >= 10) { console.log("[START] Scanning..."); scan(); setInterval(scan, CONFIG.scanIntervalMs); setInterval(heartbeat, 3600000); return; }
    warmup++;
    var p = Promise.resolve();
    Object.entries(TOKENS).forEach(function(t) { p = p.then(function() { return updatePriceHistory(t[0], t[1]); }).then(function() { return delay(1000); }); });
    p.then(function() { return delay(5000); }).then(doWarmup);
  }
  doWarmup();
}).catch(function(e) { console.error("[FATAL]", e.message); process.exit(1); });
