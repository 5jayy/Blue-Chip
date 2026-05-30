"use strict";
require("dotenv").config();

const { Connection, PublicKey, Keypair, VersionedTransaction, SystemProgram, Transaction } = require("@solana/web3.js");
const axios       = require("axios");
const bs58        = require("bs58");
const TelegramBot = require("node-telegram-bot-api");
const { getTrendSignal, ema, rsi } = require("./indicators");

// ── Config ─────────────────────────────────────────────────────
const PRIVATE_KEY        = process.env.PRIVATE_KEY;
const HELIUS_API_KEY     = process.env.HELIUS_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const JUPITER_QUOTE = "https://public.jupiterapi.com/quote";
const JUPITER_SWAP  = "https://public.jupiterapi.com/swap";
const SOL_MINT      = "So11111111111111111111111111111111111111112";
const USDC_MINT     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Blue chip token mints on Solana
const TOKENS = {
  SOL:  SOL_MINT,
  wBTC: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // wBTC
  wETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // wETH
  BNB:  "9gP2kCy3wA1ctvYWQk75guqXuzoJGjjGPSPB4PdO3mz1",  // wBNB
};

const CONFIG = {
  rpcUrl:             `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  buyPercent:         parseFloat(process.env.BUY_PERCENT ?? "10"),
  maxPositionPercent: parseFloat(process.env.MAX_POSITION_PERCENT ?? "30"),
  stopLossPct:        parseFloat(process.env.STOP_LOSS_PCT ?? "5"),
  takeProfitPct:      parseFloat(process.env.TAKE_PROFIT_PCT ?? "15"),
  slippageBps:        100,
  priorityFeeLamports:100000,
  sweepPct:           parseFloat(process.env.SWEEP_PCT ?? "25"),
  sweepAddress:       process.env.SWEEP_ADDRESS ?? "4XyC7sodMEUaDHUhud47C9EmTE1PmidWNx85TmhSe5Qd",
  scanIntervalMs:     60000,   // check every 1 minute
  priceHistoryLength: 50,      // keep 50 candles
};

let wallet, connection, telegram;
const positions     = new Map(); // mint → { entryPrice, amount, entryTime }
const priceHistory  = new Map(); // mint → [prices]

// ── Helpers ────────────────────────────────────────────────────
function lamportsToSol(l) { return l / 1e9; }
function solToLamports(s) { return Math.floor(s * 1e9); }

async function notify(msg) {
  try {
    await telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
  } catch (e) {
    console.error("[TG]", e.message);
  }
}

async function getBalance() {
  try {
    return await connection.getBalance(wallet.publicKey);
  } catch { return 0; }
}

// ── Price fetching via Jupiter ──────────────────────────────────
async function getPrice(mint) {
  try {
    const res = await axios.get(`https://public.jupiterapi.com/price?ids=${mint}`, { timeout: 5000 });
    return res.data?.data?.[mint]?.price ?? null;
  } catch { return null; }
}

async function updatePriceHistory(mint, symbol) {
  const price = await getPrice(mint);
  if (!price) return;
  if (!priceHistory.has(mint)) priceHistory.set(mint, []);
  const history = priceHistory.get(mint);
  history.push(price);
  if (history.length > CONFIG.priceHistoryLength) history.shift();
  console.log(`[PRICE] ${symbol}: $${price.toFixed(4)} | history: ${history.length} candles`);
}

// ── Jupiter swap ───────────────────────────────────────────────
async function jupiterSwap(inputMint, outputMint, lamounts) {
  const quoteRes = await axios.get(JUPITER_QUOTE, {
    params: {
      inputMint,
      outputMint,
      amount: lamounts,
      slippageBps: CONFIG.slippageBps,
    },
    timeout: 10000,
  });
  const quote = quoteRes.data;
  if (!quote || quote.error) throw new Error("Quote failed: " + (quote?.error ?? "unknown"));

  const swapRes = await axios.post(JUPITER_SWAP, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: CONFIG.priorityFeeLamports,
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx    = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  return { sig, outAmount: quote.outAmount };
}

// ── Sweep profits to Ledger ────────────────────────────────────
async function sweepProfit(profitLamports) {
  if (profitLamports <= 0 || !CONFIG.sweepAddress) return;
  try {
    const sweepAmount = Math.floor(profitLamports * CONFIG.sweepPct / 100);
    if (sweepAmount < 10000) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey:   new PublicKey(CONFIG.sweepAddress),
        lamports:   sweepAmount,
      })
    );
    const sig = await connection.sendTransaction(tx, [wallet]);
    const profitSol = lamportsToSol(sweepAmount);
    await notify(`💸 *Profit Sweep*\nSent ${profitSol.toFixed(4)} SOL (${CONFIG.sweepPct}%) to Ledger\n🔗 [Solscan](https://solscan.io/tx/${sig})`);
  } catch (e) {
    console.error("[SWEEP]", e.message);
  }
}

// ── Buy a token ────────────────────────────────────────────────
async function buyToken(mint, symbol, price) {
  if (positions.has(mint)) return;
  const balanceLamports = await getBalance();
  const balanceSol      = lamportsToSol(balanceLamports);

  // Check max position limit
  const totalInPositions = positions.size * CONFIG.buyPercent / 100 * balanceSol;
  if (totalInPositions / balanceSol * 100 >= CONFIG.maxPositionPercent) {
    console.log(`[SKIP] Max position limit reached`);
    return;
  }

  const buyLamports = Math.floor(balanceLamports * CONFIG.buyPercent / 100);
  if (buyLamports < 10000) { console.log("[SKIP] Balance too low"); return; }

  console.log(`[BUY] ${symbol} @ $${price.toFixed(4)} | ${lamportsToSol(buyLamports).toFixed(4)} SOL`);

  try {
    const { sig, outAmount } = await jupiterSwap(SOL_MINT, mint, buyLamports);
    positions.set(mint, {
      symbol,
      entryPrice:   price,
      entryLamports: buyLamports,
      amount:       outAmount,
      entryTime:    Date.now(),
    });

    await notify(
      `🟢 *TREND BUY* — ${symbol}\n` +
      `💰 Spent: ${lamportsToSol(buyLamports).toFixed(4)} SOL\n` +
      `📈 Entry: $${price.toFixed(4)}\n` +
      `🎯 TP: +${CONFIG.takeProfitPct}% | SL: -${CONFIG.stopLossPct}%\n` +
      `🔗 [Solscan](https://solscan.io/tx/${sig})`
    );
  } catch (e) {
    console.error(`[BUY ERROR] ${symbol}:`, e.message);
    await notify(`⚠️ Buy failed for ${symbol}: ${e.message}`);
  }
}

// ── Sell a token ───────────────────────────────────────────────
async function sellToken(mint, reason) {
  const pos = positions.get(mint);
  if (!pos) return;

  const currentPrice = await getPrice(mint);
  if (!currentPrice) return;

  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  console.log(`[SELL] ${pos.symbol} | reason: ${reason} | PnL: ${pnlPct.toFixed(2)}%`);

  try {
    // Sell token back to SOL
    const { sig } = await jupiterSwap(mint, SOL_MINT, pos.amount);
    positions.delete(mint);

    const profitLamports = Math.floor(pos.entryLamports * pnlPct / 100);

    await notify(
      `${pnlPct >= 0 ? "🔴" : "📉"} *TREND SELL* — ${pos.symbol}\n` +
      `📊 PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n` +
      `💡 Reason: ${reason}\n` +
      `⏱ Held: ${Math.floor((Date.now() - pos.entryTime) / 60000)}m\n` +
      `🔗 [Solscan](https://solscan.io/tx/${sig})`
    );

    if (profitLamports > 0) {
      await sweepProfit(profitLamports);
    }
  } catch (e) {
    console.error(`[SELL ERROR] ${pos.symbol}:`, e.message);
    await notify(`⚠️ Sell failed for ${pos.symbol}: ${e.message}`);
  }
}

// ── Main scan loop ─────────────────────────────────────────────
async function scan() {
  for (const [symbol, mint] of Object.entries(TOKENS)) {
    await updatePriceHistory(mint, symbol);
    const history = priceHistory.get(mint) ?? [];
    if (history.length < 26) continue;

    const signal       = getTrendSignal(history);
    const currentPrice = history[history.length - 1];
    const pos          = positions.get(mint);

    console.log(`[SCAN] ${symbol} | signal: ${signal} | price: $${currentPrice.toFixed(4)} | position: ${pos ? "YES" : "no"}`);

    if (signal === "BUY" && !pos) {
      await buyToken(mint, symbol, currentPrice);
    } else if (pos) {
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      if (pnlPct >= CONFIG.takeProfitPct) {
        await sellToken(mint, `Take Profit +${pnlPct.toFixed(1)}%`);
      } else if (pnlPct <= -CONFIG.stopLossPct) {
        await sellToken(mint, `Stop Loss ${pnlPct.toFixed(1)}%`);
      } else if (signal === "SELL") {
        await sellToken(mint, `Trend Reversal`);
      }
    }

    // Small delay between tokens
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Heartbeat ──────────────────────────────────────────────────
async function heartbeat() {
  const balanceLamports = await getBalance();
  const balanceSol      = lamportsToSol(balanceLamports);
  const posCount        = positions.size;
  const posNames        = posCount > 0 ? [...positions.values()].map(p => p.symbol).join(", ") : "none";

  await notify(
    `💓 *Trend Bot Heartbeat*\n` +
    `💰 Balance: ${balanceSol.toFixed(4)} SOL\n` +
    `📊 Open positions: ${posCount} (${posNames})\n` +
    `🔄 Scanning: SOL, wBTC, wETH, BNB`
  );
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  if (!PRIVATE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !HELIUS_API_KEY) {
    throw new Error("Missing required env vars: PRIVATE_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
  }

  wallet     = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  connection = new Connection(CONFIG.rpcUrl, { commitment: "confirmed" });
  telegram   = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

  const balanceLamports = await getBalance();
  const balanceSol      = lamportsToSol(balanceLamports);

  await notify(
    `📈 *Blue-Chip Trend Bot ONLINE*\n` +
    `👛 Wallet: \`${wallet.publicKey.toBase58().slice(0, 8)}...\`\n` +
    `💰 Balance: ${balanceSol.toFixed(4)} SOL\n` +
    `🎯 Tokens: SOL, wBTC, wETH, BNB\n` +
    `📊 Strategy: EMA9/EMA21 + RSI\n` +
    `✅ Buy: +${CONFIG.buyPercent}% of balance\n` +
    `🎯 TP: +${CONFIG.takeProfitPct}% | SL: -${CONFIG.stopLossPct}%\n` +
    `💸 Sweep: ${CONFIG.sweepPct}% profits to Ledger`
  );

  console.log("[INIT] Blue-Chip Trend Bot started.");
  console.log(`[INIT] Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`[INIT] Balance: ${balanceSol.toFixed(4)} SOL`);
}

// ── Start ──────────────────────────────────────────────────────
(async () => {
  await init();

  // Warm up price history before first scan
  console.log("[WARMUP] Building price history...");
  for (let i = 0; i < 10; i++) {
    for (const [symbol, mint] of Object.entries(TOKENS)) {
      await updatePriceHistory(mint, symbol);
      await new Promise(r => setTimeout(r, 1000));
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("[START] Scanning...");
  await scan();
  setInterval(scan, CONFIG.scanIntervalMs);
  setInterval(heartbeat, 3600000); // hourly heartbeat
})();
