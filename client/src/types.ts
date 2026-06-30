export interface Holder {
  address: string
  balance: string
  raw: string
  percentage: number
  chains?: string[]
}

export type ChainId = 'base' | 'polygon' | 'bnb' | 'kaia' | 'lisk' | 'solana' | 'combined'

export interface ChainResult {
  name: string
  holders: Holder[]
  error: string | null
}

export type ApiResponse = Record<ChainId, ChainResult>

export interface ChainConfig {
  id: ChainId
  name: string
  color: string
  explorer: (addr: string) => string
}
