import type { ApiResponse, ChainConfig } from "@/types"

export const CHAINS: ChainConfig[] = [
  { id: 'base',    name: 'Base',    color: '#0052FF', explorer: (a: string) => `https://base.blockscout.com/address/${a}` },
  { id: 'polygon', name: 'Polygon', color: '#8247E5', explorer: (a: string) => `https://polygon.blockscout.com/address/${a}` },
  { id: 'bnb',     name: 'BNB',     color: '#F0B90B', explorer: (a: string) => `https://bscscan.com/address/${a}` },
  { id: 'kaia',    name: 'Kaia',    color: '#56447A', explorer: (a: string) => `https://kaiascan.io/address/${a}` },
  { id: 'lisk',    name: 'Lisk',    color: '#2F68F8', explorer: (a: string) => `https://blockscout.lisk.com/address/${a}` },
  { id: 'solana',  name: 'Solana',  color: '#9945FF', explorer: (a: string) => `https://solscan.io/account/${a}` },
]

export const CHAIN_LABELS: Record<string, string> = {
  base: 'Base', polygon: 'Polygon', bnb: 'BNB', kaia: 'Kaia', lisk: 'Lisk', solana: 'Solana',
}

export function truncate(a: string): string {
  return a.length > 16 ? a.slice(0, 6) + '...' + a.slice(-4) : a
}

export function formatBal(b: string | number): string {
  const s = typeof b === 'string' ? b : String(b)
  const n = parseFloat(s.replace(/,/g, ''))
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n > 0) return n.toFixed(2)
  return '0'
}

export async function fetchHolders(): Promise<ApiResponse> {
  const res = await fetch('/api/holders')
  return res.json()
}
