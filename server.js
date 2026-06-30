const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const CONTRACT = '0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22';
const SOL_MINT = 'idrxZcP8xiKkYk6XGD4uz1dxEYCWSgKDHqgjsBbwDur';
const TOP_N = 20;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS = 2;
const CACHE_TTL = 600_000;

const RPC_BASE    = process.env.RPC_BASE    || null;
const RPC_POLYGON = process.env.RPC_POLYGON || null;
const RPC_BNB     = process.env.RPC_BNB     || null;
const RPC_KAIA    = process.env.RPC_KAIA    || null;

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

// ── Detect RPC capabilities (probes from largest to smallest) ──
async function detectRPC(rpcUrl) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);

  // Try large (10K) first, fall back to smaller — with retry on rate limits
  for (const size of [10000, 2000, 500, 100, 50, 10, 1]) {
    const from = latest - BigInt(size) > 0n ? latest - BigInt(size) : 0n;
    let success = false;
    for (let retry = 0; retry < 3 && !success; retry++) {
      try {
        await rpc(rpcUrl, 'eth_getLogs', [{
          address: CONTRACT, topics: [TRANSFER_TOPIC],
          fromBlock: `0x${from.toString(16)}`, toBlock: `0x${latest.toString(16)}`,
        }]);
        success = true;
      } catch (e) {
        const msg = e.message.toLowerCase();
        if (msg.includes('pruned')) throw new Error('RPC is pruned — needs an archive node');
        if (msg.includes('range') || msg.includes('limited') || msg.includes('max')) break; // try smaller
        if (msg.includes('timeout') || msg.includes('too many') || msg.includes('rate limit') || msg.includes('temporary')) {
          await new Promise(r => setTimeout(r, 500 * (retry + 1))); // backoff
          continue;
        }
        throw e;
      }
    }
    if (!success) continue;

    // Check archive access with a tiny range 100K blocks back
    if (latest > 100_000n) {
      const testFrom = latest - BigInt(100_000);
      const to = testFrom + 49n > latest ? latest : testFrom + 49n;
      try {
        await rpc(rpcUrl, 'eth_getLogs', [{
          address: CONTRACT, topics: [TRANSFER_TOPIC],
          fromBlock: `0x${testFrom.toString(16)}`, toBlock: `0x${to.toString(16)}`,
        }]);
      } catch (e) {
        if (e.message.toLowerCase().includes('pruned')) throw new Error('RPC is pruned — needs an archive node');
        // archive check failed but RPC still usable for recent data
      }
    }
    return { batchSize: size };
  }
  throw new Error('RPC unavailable or incompatible');
}

// ── EVM: binary search for first transfer block ─────────────────
async function findFirstTransfer(rpcUrl, batchSize) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  let lo = 0n, hi = latest;

  while (lo + BigInt(batchSize) < hi) {
    const mid = (lo + hi) / 2n;
    const from = mid;
    const to = mid + BigInt(batchSize) - 1n > hi ? hi : mid + BigInt(batchSize) - 1n;
    try {
      const logs = await rpc(rpcUrl, 'eth_getLogs', [{
        address: CONTRACT, topics: [TRANSFER_TOPIC],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
      }]);
      if (logs.length > 0) hi = to;
      else lo = to + 1n;
    } catch (_) {
      // if range too large, halve it
      hi = mid;
    }
  }

  // Pinpoint exact block
  for (let b = lo; b <= hi; b++) {
    const logs = await rpc(rpcUrl, 'eth_getLogs', [{
      address: CONTRACT, topics: [TRANSFER_TOPIC],
      fromBlock: `0x${b.toString(16)}`, toBlock: `0x${b.toString(16)}`,
    }]);
    if (logs.length > 0) return b;
  }
  return null;
}

// ── EVM: auto-detect + parallel scan ───────────────────────────
async function fetchEVM(rpcUrl) {
  const { batchSize } = await detectRPC(rpcUrl);

  const firstBlock = await findFirstTransfer(rpcUrl, batchSize);
  if (firstBlock === null) return [];

  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  const balances = new Map();
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const CONCURRENCY = batchSize <= 100 ? 10 : 6; // avoid rate limiting on free RPCs

  // Build range chunks — scan from firstBlock forward.
  // With small batch sizes (e.g. 50), cap at 500K blocks so the scan completes in time.
  const maxScanBlocks = batchSize <= 100 ? 500_000n : (latest - firstBlock);
  const scanEnd = firstBlock + maxScanBlocks > latest ? latest : firstBlock + maxScanBlocks;
  const ranges = [];
  for (let b = firstBlock; b <= scanEnd; b += BigInt(batchSize)) {
    const to = b + BigInt(batchSize) - 1n > scanEnd ? scanEnd : b + BigInt(batchSize) - 1n;
    ranges.push({ from: b, to });
  }

  // Process in concurrent batches
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const chunk = ranges.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(r => 
      rpc(rpcUrl, 'eth_getLogs', [{
        address: CONTRACT, topics: [TRANSFER_TOPIC],
        fromBlock: `0x${r.from.toString(16)}`, toBlock: `0x${r.to.toString(16)}`,
      }])
    ));
    for (let j = 0; j < results.length; j++) {
      const logs = results[j].status === 'fulfilled' ? results[j].value : [];
      for (const log of logs) {
        const f = parseAddr(log.topics[1]), t = parseAddr(log.topics[2]);
        const v = BigInt(log.data);
        if (f !== zeroAddr) balances.set(f, (balances.get(f) || 0n) - v);
        if (t !== zeroAddr) balances.set(t, (balances.get(t) || 0n) + v);
      }
    }
  }

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

// ── Lisk ────────────────────────────────────────────────────────
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
// Note: 1rpc.io Base is a pruned node — needs an archive RPC for historical holders.
// Polygon & BNB: same address has no contract deployed on those chains.
const CHAINS = [
  { id: 'base',    name: 'Base',
    fetch: RPC_BASE ? () => fetchEVM(RPC_BASE) : () => { throw new Error('Configure RPC_BASE env var'); },
    explorer: `https://basescan.org/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'polygon', name: 'Polygon',
    fetch: RPC_POLYGON ? () => fetchEVM(RPC_POLYGON) : () => { throw new Error('No contract at this address'); },
    explorer: '' },
  { id: 'bnb',     name: 'BNB',     fetch: () => { throw new Error('No contract at this address'); }, explorer: '' },
  { id: 'kaia',    name: 'Kaia',
    fetch: RPC_KAIA ? () => fetchEVM(RPC_KAIA) : () => { throw new Error('Configure RPC_KAIA env var'); },
    explorer: `https://kaiascan.io/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'lisk',    name: 'Lisk',    fetch: () => fetchLisk(),   explorer: `https://blockscout.lisk.com/token/0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22?a=` },
  { id: 'solana',  name: 'Solana',  fetch: () => fetchSolana(), explorer: 'https://solscan.io/account/' },
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

  // Combined: aggregate same EVM address across chains (excl Solana)
  const combined = new Map();
  for (const [id, chain] of Object.entries(raw)) {
    if (id === 'solana' || chain.error) continue;
    for (const h of chain.holders) {
      const a = h.address.toLowerCase();
      const ex = combined.get(a) || { address: h.address, totalRaw: 0n, chains: [] };
      ex.totalRaw += BigInt(h.raw);
      if (!ex.chains.includes(id)) ex.chains.push(id);
      combined.set(a, ex);
    }
  }
  const combHolders = [...combined.values()]
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
  const combTotal = combHolders.reduce((s, h) => s + parseFloat(h.balance), 0);
  combHolders.forEach(h => h.percentage = combTotal > 0 ? Math.round((parseFloat(h.balance) / combTotal) * 10000) / 100 : 0);

  cache.data = { ...raw, combined: { name: 'Total (All EVM)', holders: combHolders, error: null } };
  cache.ts = Date.now();
  res.json(cache.data);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { res.status(500).json({ error: err.message || 'Internal error' }); });

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`IDRX Dashboard at http://localhost:${PORT}
  RPCs: Base(1rpc) Polygon(1rpc) BNB(1rpc) Kaia(env) Lisk(Blockscout) Solana(public)`));
}
