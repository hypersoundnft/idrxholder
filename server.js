const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const CONTRACT = '0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22';
const CONTRACT2 = '0x649a2da7b28e0d54c13d5eff95d3a660652742cc'; // Polygon + BNB
const SOL_MINT = 'idrxZcP8xiKkYk6XGD4uz1dxEYCWSgKDHqgjsBbwDur';
const TOP_N = 20;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS = 2;
const CACHE_TTL = 600_000;

const RPC_KAIA = process.env.RPC_KAIA || 'https://klaytn.drpc.org';
const RPC_BNB = process.env.RPC_BNB || 'https://bsc.drpc.org';

let cache = { data: null, ts: 0 };
let _reqId = 1;

// ── RPC helper ──────────────────────────────────────────────────
let _rpcStagger = 0;
async function rpc(url, method, params) {
  await new Promise(r => setTimeout(r, 100 + (_rpcStagger++ % 30) * 5));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _reqId++, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error('RPC returned non-JSON: ' + text.slice(0, 60)); }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function parseAddr(hex) { return '0x' + hex.slice(26).toLowerCase(); }

// ── Detect RPC capabilities ────────────────────────────────────
async function detectRPC(rpcUrl, contractAddr) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);

  for (const size of [10000, 1000, 100, 50, 10, 1]) {
    const from = latest - BigInt(size) > 0n ? latest - BigInt(size) : 0n;
    let success = false;
    for (let retry = 0; retry < 3 && !success; retry++) {
      try {
        await rpc(rpcUrl, 'eth_getLogs', [{
          address: contractAddr, topics: [TRANSFER_TOPIC],
          fromBlock: `0x${from.toString(16)}`, toBlock: `0x${latest.toString(16)}`,
        }]);
        success = true;
      } catch (e) {
        const msg = e.message.toLowerCase();
        if (msg.includes('pruned')) throw new Error('RPC is pruned — needs an archive node');
        if (msg.includes('range') || msg.includes('limited') || msg.includes('max')) break;
        if (msg.includes('timeout') || msg.includes('too many') || msg.includes('rate limit') || msg.includes('temporary')) {
          await new Promise(r => setTimeout(r, 500 * (retry + 1)));
          continue;
        }
        throw e;
      }
    }
    if (!success) continue;
    return size;
  }
  throw new Error('RPC unavailable or incompatible');
}

// ── EVM: binary search for first transfer block ─────────────────
async function findFirstTransfer(rpcUrl, batchSize, contractAddr, knownFloor = 0n) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  let lo = knownFloor, hi = latest;

  if (lo >= hi) { lo = 0n; hi = latest; } // fallback

  while (lo + BigInt(batchSize) < hi) {
    const mid = (lo + hi) / 2n;
    const from = mid;
    const to = mid + BigInt(batchSize) - 1n > hi ? hi : mid + BigInt(batchSize) - 1n;
    let logs = [];
    try {
      logs = await rpc(rpcUrl, 'eth_getLogs', [{
        address: contractAddr, topics: [TRANSFER_TOPIC],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
      }]);
    } catch (e) {
      const msg = e.message.toLowerCase();
      if (msg.includes('rate') || msg.includes('too many') || msg.includes('temporary') || msg.includes('timeout')) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          logs = await rpc(rpcUrl, 'eth_getLogs', [{
            address: contractAddr, topics: [TRANSFER_TOPIC],
            fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
          }]);
        } catch (_) {}
      }
    }
    if (logs.length > 0) hi = to;
    else lo = to + 1n;
  }

  for (let b = lo; b <= hi; b++) {
    const logs = await rpc(rpcUrl, 'eth_getLogs', [{
      address: contractAddr, topics: [TRANSFER_TOPIC],
      fromBlock: `0x${b.toString(16)}`, toBlock: `0x${b.toString(16)}`,
    }]);
    if (logs.length > 0) return b;
  }
  return null;
}

// ── EVM: smart scan (backward from tip, or forward from floor) ──
async function fetchEVM(rpcUrl, contractAddr, knownFloor = 0n) {
  const batchSize = await detectRPC(rpcUrl, contractAddr);

  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  const balances = new Map();
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const MAX_BATCHES = 300; // ~3M blocks at 10K batch, fits in Vercel 10s hobby limit

  let lo = knownFloor > 0n ? knownFloor : 0n;
  let totalBatches = 0;

  if (knownFloor > 0n) {
    // Forward scan from known deployment block to tip
    let from = knownFloor;
    while (from <= latest && totalBatches < MAX_BATCHES) {
      const to = from + BigInt(batchSize) - 1n > latest ? latest : from + BigInt(batchSize) - 1n;
      const logs = await rpc(rpcUrl, 'eth_getLogs', [{
        address: contractAddr, topics: [TRANSFER_TOPIC],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
      }]);
      totalBatches++;
      for (const log of logs) {
        const f = parseAddr(log.topics[1]), t = parseAddr(log.topics[2]);
        const v = BigInt(log.data);
        if (f !== zeroAddr) balances.set(f, (balances.get(f) || 0n) - v);
        if (t !== zeroAddr) balances.set(t, (balances.get(t) || 0n) + v);
      }
      from = to + 1n;
    }
  } else {
    // Backward scan from tip — stops after 5 consecutive empty batches
    let tip = latest;
    let emptyStreak = 0;
    while (tip > lo && totalBatches < MAX_BATCHES) {
      const from = tip - BigInt(batchSize) > lo ? tip - BigInt(batchSize) : lo;
      const logs = await rpc(rpcUrl, 'eth_getLogs', [{
        address: contractAddr, topics: [TRANSFER_TOPIC],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${tip.toString(16)}`,
      }]);
      totalBatches++;
      for (const log of logs) {
        const f = parseAddr(log.topics[1]), t = parseAddr(log.topics[2]);
        const v = BigInt(log.data);
        if (f !== zeroAddr) balances.set(f, (balances.get(f) || 0n) - v);
        if (t !== zeroAddr) balances.set(t, (balances.get(t) || 0n) + v);
      }
      if (logs.length === 0) { emptyStreak++; if (emptyStreak >= 5) break; }
      else emptyStreak = 0;
      tip = from - 1n;
    }
  }

  if (balances.size === 0) return [];
  const holders = [];
  for (const [addr, bal] of balances) if (bal > 0n) holders.push({ address: addr, balance: bal });
  holders.sort((a, b) => b.balance > a.balance ? 1 : -1);
  const total = holders.reduce((s, h) => s + h.balance, 0n);
  return holders.slice(0, TOP_N).map(h => ({
    address: h.address,
    balance: (Number(h.balance) / Math.pow(10, DECIMALS)).toFixed(DECIMALS),
    raw: h.balance.toString(),
    percentage: total > 0n ? Number((h.balance * 10000n) / total) / 100 : 0,
  }));
}

// ── Block explorers ──────────────────────────────────────────────
async function fetchViaBlockscout(explorerUrl) {
  const res = await fetch(explorerUrl, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (!data.items || data.items.length === 0) throw new Error('No data from explorer');
  const holders = data.items.slice(0, TOP_N).map(h => ({
    address: h.address.hash,
    balance: (Number(h.value) / Math.pow(10, DECIMALS)).toFixed(DECIMALS),
    raw: h.value,
    percentage: 0,
  }));
  const total = holders.reduce((s, h) => s + parseFloat(h.balance), 0);
  holders.forEach(h => h.percentage = total > 0 ? Math.round((parseFloat(h.balance) / total) * 10000) / 100 : 0);
  return holders;
}

// ── Solana ──────────────────────────────────────────────────────
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  if (n === 0n) return '1';
  let result = '';
  while (n > 0n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  for (const b of buf) { if (b === 0) result = '1' + result; else break; }
  return result;
}

async function fetchSolana() {
  const response = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getProgramAccounts',
      params: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', {
        encoding: 'base64',
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: SOL_MINT } }],
      }],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  const holders = [];
  for (const acc of json.result || []) {
    const d = Buffer.from(acc.account.data[0], 'base64');
    const owner = bs58Encode(d.slice(32, 64));
    const amt = d.readBigUInt64LE(64);
    if (amt > 0n) holders.push({ address: owner, balance: amt });
  }
  holders.sort((a, b) => b.balance > a.balance ? 1 : -1);
  const total = holders.reduce((s, h) => s + h.balance, 0n);
  return holders.slice(0, TOP_N).map(h => ({
    address: h.address,
    balance: (Number(h.balance) / 1e9).toFixed(6),
    raw: h.balance.toString(),
    percentage: total > 0 ? Math.round(((Number(h.balance) / 1e9) / (Number(total) / 1e9)) * 10000) / 100 : 0,
  }));
}

// ── Chains ──────────────────────────────────────────────────────
const CHAINS = [
  { id: 'base',    name: 'Base',
    fetch: () => fetchViaBlockscout('https://base.blockscout.com/api/v2/tokens/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22/holders'),
    explorer: `https://base.blockscout.com/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'polygon', name: 'Polygon',
    fetch: () => fetchViaBlockscout(`https://polygon.blockscout.com/api/v2/tokens/${CONTRACT2}/holders`),
    explorer: `https://polygon.blockscout.com/token/${CONTRACT2}?a=` },
  { id: 'bnb',     name: 'BNB',
    fetch: () => fetchEVM(RPC_BNB, CONTRACT2),
    explorer: `https://bscscan.com/token/${CONTRACT2}?a=` },
  { id: 'kaia',    name: 'Kaia',
    fetch: () => fetchEVM(RPC_KAIA, CONTRACT, 210_686_000n),
    explorer: `https://kaiascan.io/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'lisk',    name: 'Lisk',
    fetch: () => fetchViaBlockscout('https://blockscout.lisk.com/api/v2/tokens/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22/holders'),
    explorer: `https://blockscout.lisk.com/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'solana',  name: 'Solana',
    fetch: () => fetchSolana(),
    explorer: 'https://solscan.io/account/' },
];

async function fetchAll() {
  const results = {};
  await Promise.allSettled(CHAINS.map(async (c) => {
    try {
      const holders = await Promise.race([
        c.fetch(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout (30s)')), 30000))
      ]);
      results[c.id] = { name: c.name, holders, error: null };
    } catch (err) {
      results[c.id] = { name: c.name, holders: [], error: err.message };
    }
  }));
  return results;
}

app.get('/api/holders', async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return res.json(cache.data);
  const raw = await fetchAll();

  const combined = new Map();
  for (const [id, chain] of Object.entries(raw)) {
    if (chain.error) continue;
    for (const h of chain.holders) {
      const key = id === 'solana' ? 'sol:' + h.address : h.address.toLowerCase();
      const ex = combined.get(key) || { address: h.address, totalBal: 0, chains: [], isSol: false };
      ex.totalBal += parseFloat(h.balance);
      if (id === 'solana') { ex.isSol = true; ex.address = h.address; }
      if (!ex.chains.includes(id)) ex.chains.push(id);
      combined.set(key, ex);
    }
  }
  const combHolders = [...combined.values()]
    .filter(h => h.totalBal > 0)
    .sort((a, b) => b.totalBal - a.totalBal)
    .slice(0, TOP_N);
  const combTotal = combHolders.reduce((s, h) => s + h.totalBal, 0);
  const formatted = combHolders.map(h => ({
    address: h.address,
    balance: formatBalStr(h.totalBal),
    raw: h.totalBal.toString(),
    percentage: combTotal > 0 ? Math.round((h.totalBal / combTotal) * 10000) / 100 : 0,
    chains: h.chains,
  }));
  cache.data = { ...raw, combined: { name: 'Total (All EVM)', holders: formatted, error: null } };
  cache.ts = Date.now();
  res.json(cache.data);
});

function formatBalStr(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.use((err, req, res, next) => { res.status(500).json({ error: err.message || 'Internal error' }); });

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`IDRX Dashboard at http://localhost:${PORT}
  Base, Lisk: Blockscout API — Solana: public RPC — Kaia: set RPC_KAIA env var`));
}
