const express = require('express');
const path = require('path');
const app = express();

// Solana — not using @solana/web3.js (incompatible with Vercel serverless)
// Using raw JSON-RPC calls instead

const PORT = process.env.PORT || 3000;
const CONTRACT = '0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22';
const SOL_MINT = 'idrxZcP8xiKkYk6XGD4uz1dxEYCWSgKDHqgjsBbwDur';
const TOP_N = 20;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS = 2; // IDRX uses 2 decimals on all chains
const CACHE_TTL = 600_000;

// RPC URLs — override via env vars, e.g. RPC_BASE=https://your-base-rpc.com
const RPC_BASE   = process.env.RPC_BASE   || null;
const RPC_POLYGON= process.env.RPC_POLYGON|| null;
const RPC_BNB    = process.env.RPC_BNB    || null;
const RPC_KAIA   = process.env.RPC_KAIA   || null;

let cache = { data: null, ts: 0 };
let reqId = 1;

async function rpc(url, method, params) {
  await new Promise(r => setTimeout(r, 80));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: reqId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function parseAddr(hex) { return '0x' + hex.slice(26).toLowerCase(); }

// ── EVM scan ────────────────────────────────────────────────────
async function fetchEVM(rpcUrl, batchSize) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  const balances = new Map();
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  let tip = latest;
  let found = false;

  while (tip >= 0n) {
    const from = tip - BigInt(batchSize) + 1n > 0n ? tip - BigInt(batchSize) + 1n : 0n;
    const logs = await rpc(rpcUrl, 'eth_getLogs', [{
      address: CONTRACT, topics: [TRANSFER_TOPIC],
      fromBlock: `0x${from.toString(16)}`, toBlock: `0x${tip.toString(16)}`,
    }]);
    for (const log of logs) {
      found = true;
      const f = parseAddr(log.topics[1]), t = parseAddr(log.topics[2]);
      const v = BigInt(log.data);
      if (f !== zeroAddr) balances.set(f, (balances.get(f) || 0n) - v);
      if (t !== zeroAddr) balances.set(t, (balances.get(t) || 0n) + v);
    }
    if (found && logs.length === 0) break;
    if (from === 0n) break;
    tip = from - 1n;
  }

  if (!found) return [];
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

// ── Lisk via Blockscout ─────────────────────────────────────────
async function fetchLisk() {
  const res = await fetch(
    'https://blockscout.lisk.com/api/v2/tokens/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22/holders',
    { signal: AbortSignal.timeout(15000) }
  );
  const data = await res.json();
  if (!data.items || data.items.length === 0) throw new Error('No data from Blockscout');
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

// ── Solana via raw RPC ──────────────────────────────────────────
// Token account layout for SPL Token program (dataSize=165):
//   mint(32) | owner(32) | amount(u64 LE) | ...
async function fetchSolana() {
  const response = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getProgramAccounts',
      params: [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        {
          encoding: 'base64',
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: SOL_MINT } },
          ],
        },
      ],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

  const holders = [];
  for (const acc of json.result || []) {
    const data = Buffer.from(acc.account.data[0], 'base64');
    // offset 32 = owner pubkey (32 bytes), offset 64 = amount (8 bytes LE)
    const owner = data.slice(32, 64).toString('hex');
    // Convert to base58-like address (solana addresses are base58 encoded)
    // Actually we need to decode the pubkey properly. Let's use a simple approach:
    const ownerB58 = bs58Encode(data.slice(32, 64));
    const amount = data.readBigUInt64LE(64);
    if (amount > 0n) holders.push({ address: ownerB58, balance: amount });
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

// Base58 encode for Solana public keys
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  if (n === 0n) return ALPHABET[0];
  let result = '';
  while (n > 0n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  // Leading zero bytes → leading '1's
  for (const b of buf) { if (b === 0) result = '1' + result; else break; }
  return result;
}

// ── Chains ──────────────────────────────────────────────────────
const CHAINS = [
  { id: 'base',    name: 'Base',
    fetch: RPC_BASE    ? () => fetchEVM(RPC_BASE, 10_000) : () => { throw new Error('Set env RPC_BASE'); },
    explorer: 'https://basescan.org/address/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?fromaddress=' },
  { id: 'polygon', name: 'Polygon',
    fetch: () => { throw new Error('Not deployed at this address'); },
    explorer: '' },
  { id: 'bnb',     name: 'BNB',
    fetch: () => { throw new Error('Not deployed at this address'); },
    explorer: '' },
  { id: 'kaia',    name: 'Kaia',
    fetch: RPC_KAIA   ? () => fetchEVM(RPC_KAIA, 10_000) : () => { throw new Error('Set env RPC_KAIA'); },
    explorer: 'https://kaiascan.io/address/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?fromaddress=' },
  { id: 'lisk',    name: 'Lisk',
    fetch: () => fetchLisk(),
    explorer: 'https://blockscout.lisk.com/address/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?fromaddress=' },
  { id: 'solana',  name: 'Solana',
    fetch: () => fetchSolana(),
    explorer: 'https://solscan.io/account/' },
];

async function fetchAll() {
  const results = {};
  await Promise.all(CHAINS.map(async (c) => {
    try {
      const holders = await c.fetch();
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

  // Compute combined: aggregate same EVM address across chains (exclude Solana)
  const combined = new Map();
  for (const [id, chain] of Object.entries(raw)) {
    if (id === 'solana' || chain.error) continue;
    for (const h of chain.holders) {
      const a = h.address.toLowerCase();
      const existing = combined.get(a) || { address: h.address, totalRaw: 0n, chains: [] };
      existing.totalRaw += BigInt(h.raw);
      existing.chains.push(id);
      combined.set(a, existing);
    }
  }

  const combinedHolders = [...combined.values()]
    .filter(h => h.totalRaw > 0n)
    .sort((a, b) => b.totalRaw > a.totalRaw ? 1 : -1)
    .slice(0, TOP_N)
    .map(h => ({
      address: h.address,
      balance: (Number(h.totalRaw) / Math.pow(10, DECIMALS)).toFixed(DECIMALS),
      raw: h.totalRaw.toString(),
      percentage: 0,
      chains: h.chains,
    }));
  const combTotal = combinedHolders.reduce((s, h) => s + parseFloat(h.balance), 0);
  combinedHolders.forEach(h => h.percentage = combTotal > 0 ? Math.round((parseFloat(h.balance) / combTotal) * 10000) / 100 : 0);

  cache.data = { ...raw, combined: { name: 'Total (All EVM)', holders: combinedHolders, error: null } };
  cache.ts = Date.now();
  res.json(cache.data);
});

app.use(express.static(path.join(__dirname, 'public')));
// ── Global error handler (important for Vercel) ──────────────────
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || 'Internal error' });
});

// Export for Vercel
module.exports = app;

// Only listen when run directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`IDRX Dashboard at http://localhost:${PORT}
  Lisk, Solana: ready out of the box
  Base, Kaia: set RPC_BASE and RPC_KAIA env vars (e.g. dRPC, Alchemy, Infura)`));
}
