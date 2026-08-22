export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const
export type Rarity = (typeof RARITIES)[number]

export const MAX_BATCH = 25
export const MAX_ROYALTY_BPS = 2500

export interface CollectionConfig {
  admin: string
  name: string
  symbol: string
  royaltyBps: number
  maxSupply: number
}

export interface CollectionState extends CollectionConfig {
  totalSupply: number
  rarityCounts: Record<Rarity, number>
}

export interface NftToken {
  id: number
  name: string
  uri: string
  rarity: Rarity
  owner: string
  minter: string
  mintedAt: number
}

export interface MintRequestInput {
  name: string
  uri: string
  rarity: Rarity
}

export type ContractEventType = "mint" | "batch" | "transfer" | "royalty" | "init"

export interface ContractEvent {
  id: string
  type: ContractEventType
  action: string
  address: string
  ledger: number
  timestamp: number
  tokenIds: number[]
  txHash?: string
}

export type TxStatus = "building" | "signing" | "pending" | "success" | "failed"

export interface TxRecord {
  id: string
  label: string
  status: TxStatus
  hash?: string
  error?: string
  tokenIds?: number[]
  createdAt: number
  updatedAt: number
}

export interface AccountSummary {
  address: string
  exists: boolean
  xlm: string
  subentries: number
  network: string
}
