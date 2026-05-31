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
  BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", XRP: "XRP-USD",
  ADA: "ADA-USD", AVAX: "AVAX-USD", LINK: "LINK-USD", DOT: "DOT-USD",
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
  scanIntervalMs: 900000, priceHistoryLength: 50,
  ledgerPct: 35, usdPct: 35, reinvestPct: 30,
};

var telegram, privateKey;
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

function loadKey() {
  var raw = CB_SECRET;
  console.log("[AUTH] Secret starts with: " + raw.substring(0, 30) + "...");
  console.log("[AUTH] Secret length: " + raw.length);
  var pem = raw.replace(/\\n/g, "\n");
  if (pem.indexOf("-----") === -1) {
    pem = "-----BEGIN EC PRIVATE KEY-----\n" + pem + "\n-----END EC PRIVATE KEY-----";
  }
  try {
    privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
    console.log("[AUTH] Key type: " + privateKey.asymmetricKeyType);
    return true;
  } catch(e1) {
    console.log("[AUTH] EC format failed: " + e1.message);
    try {
      var pem2 = pem.replace("EC PRIVATE KEY", "PRIVATE KEY");
      privateKey = crypto.createPrivateKey({ key: pem2, format: "pem" });
      console.log("[AUTH] Key type (PKCS8): " + privateKey.asymmetricKeyType);
      return true;
    } catch(e2) {
      console.log("[AUTH] PKCS8 format failed: " + e2.message);
      console.log("[AUTH] Trying raw base64...");
      try {
        var b64 = raw.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\n/g, "").replace(/\s/g, "");
        var der = Buffer.from(b64, "base64");
        privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        console.log("[AUTH] Key type (DER): " + privateKey.asymmetricKeyType);
        return true;
      } catch(e3) {
        try {
          var der2 = Buffer.from(b64, "base64");
          privateKey = crypto.createPrivateKey({ key: der2, format: "der", type: "sec1" });
          console.log("[AUTH] Key type (SEC1): " + privateKey.asymmetricKeyType);
          return true;
        } catch(e4) {
          console.error("[AUTH] All formats failed");
          console.error("[AUTH] Last error: " + e4.message);
          return false;
        }
      }
    }
  }
}

function base64url(buf) { return buf.toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"); }

function getJWT(method, path) {
  var uri = method.toUpperCase() + " " + "api.coinbase.com" + path;
  var now = Math.floor(Date.now() / 1000);
  var nonce = crypto.randomBytes(16).toString("hex");
  var alg = privateKey.asymmetricKeyType === "ed25519" ? "EdDSA" : "ES256";
  var header = { alg: alg, kid: CB_KEY, nonce: nonce, typ: "JWT" };
  var payload = { sub: CB_KEY, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [uri] };
  var headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  var payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  var msg = headerB64 + "." + payloadB64;
  var sig;
  if (alg === "ES256") {
    var derSig = crypto.sign("sha256", Buffer.from(msg), privateKey);
    // Convert DER to raw R||S format for JWT
    var r = derSig.subarray(4, 4 + derSig[3]);
    var sOffset = 4 + derSig[3] + 2;
    var s = derSig.subarray(sOffset, sOffset + derSig[sOffset - 1]);
    // Pad to 32 bytes each
    var rPad = Buffer.alloc(32); r.copy(rPad, 32 - r.length);
    var sPad = Buffer.alloc(32); s.copy(sPad, 32 - s.length);
    sig = Buffer.concat([rPad, sPad]);
  } else {
    sig = crypto.sign(null, Buffer.from(msg), privateKey);
  }
  return msg + "." + base64url(sig);
}

function cbRequest(method, path, body) {
  var token = getJWT(method, path);
  var config = {
    method: method, url: BASE_URL + path,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    timeout: 10000,
  };
  if (body) config.data = body;
  return axios(config).then(function(res) { return res.data; });
}

function getPrice(productId) {
  return axios.get("https://api.coinbase.com/v2/prices/" + productId + "/spot", { timeout: 8000 }).then(function(res) {
    return parseFloat(res.data.data.amount);
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

async function loadAccounts() {
  try {
    var res = await cbRequest("GET", "/v2/accounts?limit=100");
    (res.data || []).forEach(function(a) { accounts[a.currency.code] = a.id; });
    console.log("[ACCOUNTS] Loaded " + Object.keys(accounts).length);
  } catch(e) { console.error("[ACCOUNTS]", e.response ? e.response.status : e.message); }
}

async function getUsdBalance() {
  try {
    var res = await cbRequest("GET", "/v2/accounts?limit=100");
    var usd = (res.data || []).find(function(a) { return a.currency.code === "USD"; });
    return usd ? parseFloat(usd.balance.amount) : 0;
  } catch(e) { return 0; }
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

async function sendToLedger(coin, amount) {
  var address = LEDGER[coin];
  if (!address || !accounts[coin]) return;
  try {
    await cbRequest("POST", "/v2/accounts/" + accounts[coin] + "/transactions", { type: "send", to: address, amount: amount.toString(), currency: coin });
    await notify("💸 *Profit → Ledger*\nSent " + amount.toFixed(6) + " " + coin);
  } catch(e) { console.error("[LEDGER]", e.message); }
}

async function splitProfit(coin, productId, totalCoinProfit, price) {
  if (totalCoinProfit <= 0) return;
  var ledgerAmount = totalCoinProfit * CONFIG.ledgerPct / 100;
  var usdAmount = totalCoinProfit * CONFIG.usdPct / 100;
  var reinvest = totalCoinProfit * CONFIG.reinvestPct / 100;
  if (LEDGER[coin] && ledgerAmount > 0) await sendToLedger(coin, ledgerAmount);
  if (usdAmount > 0) { try { await marketSell(productId, usdAmount); } catch(e) {} }
  await notify("📊 *Split* " + coin + "\n💸35% Ledger\n💵35% USD\n🔄30% Reinvest");
}

async function buyToken(coin, productId, price) {
  if (positions[coin]) return;
  var usdBal = await getUsdBalance();
  var buyUsd = usdBal * CONFIG.buyPercent / 100;
  if (buyUsd < 1) { console.log("[SKIP] USD too low: $" + usdBal.toFixed(2)); return; }
  console.log("[BUY] " + coin + " @ $" + price.toFixed(2) + " | $" + buyUsd.toFixed(2));
  try {
    await marketBuy(productId, buyUsd);
    positions[coin] = { productId: productId, entryPrice: price, entryUsd: buyUsd, coinAmount: buyUsd / price, entryTime: Date.now() };
    savePositions();
    await notify("🟢 *BUY* " + coin + " $" + buyUsd.toFixed(2) + " @ $" + price.toFixed(2));
  } catch(e) { console.error("[BUY ERROR]", e.response ? JSON.stringify(e.response.data) : e.message); }
}

async function sellToken(coin, reason) {
  var pos = positions[coin];
  if (!pos) return;
  var price = await getPrice(pos.productId);
  if (!price) return;
  var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  var profitCoin = pos.coinAmount * (pnl / 100);
  try {
    await marketSell(pos.productId, pos.coinAmount);
    delete positions[coin]; savePositions();
    await notify((pnl >= 0 ? "🔴" : "📉") + " *SELL* " + coin + " PnL:" + pnl.toFixed(2) + "% " + reason);
    if (profitCoin > 0) await splitProfit(coin, pos.productId, profitCoin, price);
  } catch(e) { console.error("[SELL ERROR]", e.message); }
}

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function scan() {
  for (var t of Object.entries(TOKENS)) {
    var coin = t[0], productId = t[1];
    await updatePriceHistory(coin, productId);
    var history = priceHistory[coin] || [];
    if (history.length < 26) { console.log("[SCAN] " + coin + " | waiting (" + history.length + "/26)"); await delay(2000); continue; }
    var signal = getTrendSignal(history), price = history[history.length - 1], pos = positions[coin];
    console.log("[SCAN] " + coin + " | " + signal + " | $" + price.toFixed(2) + " | " + (pos ? "HOLDING" : "none"));
    if (signal === "BUY" && !pos) await buyToken(coin, productId, price);
    if (pos) {
      var pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (pnl >= CONFIG.takeProfitPct) await sellToken(coin, "TP");
      else if (pnl <= -CONFIG.stopLossPct) await sellToken(coin, "SL");
      else if (signal === "SELL") await sellToken(coin, "Reversal");
    }
    await delay(2000);
  }
}

async function heartbeat() {
  var usdBal = await getUsdBalance();
  var posNames = Object.keys(positions).length > 0 ? Object.keys(positions).join(", ") : "none";
  await notify("💓 *Heartbeat*\n💰$" + usdBal.toFixed(2) + " | " + Object.keys(positions).length + " positions (" + posNames + ")");
}

async function init() {
  if (!CB_KEY || !CB_SECRET) throw new Error("Missing COINBASE_API_KEY or COINBASE_API_SECRET");
  if (!loadKey()) throw new Error("Failed to load private key");
  if (TG_TOKEN && TG_CHAT) { telegram = new TelegramBot(TG_TOKEN, { polling: false }); console.log("[TG] Telegram connected"); }
  await loadAccounts();
  var usdBal = await getUsdBalance();
  loadPositions();
  console.log("[INIT] Blue-Chip Trend Bot v2 (Coinbase)");
  console.log("[INIT] USD: $" + usdBal.toFixed(2));
  await notify("📈 *Blue-Chip Bot ONLINE*\n🏦Coinbase\n💰$" + usdBal.toFixed(2) + "\n🎯BTC ETH SOL XRP ADA AVAX LINK DOT");
}

init().then(async function() {
  console.log("[WARMUP] Building price history...");
  for (var w = 0; w < 10; w++) {
    for (var t of Object.entries(TOKENS)) { await updatePriceHistory(t[0], t[1]); await delay(1000); }
    await delay(5000);
  }
  console.log("[START] Scanning...");
  await scan(); setInterval(scan, CONFIG.scanIntervalMs); setInterval(heartbeat, 3600000);
}).catch(function(e) { console.error("[FATAL]", e.message); process.exit(1); });
