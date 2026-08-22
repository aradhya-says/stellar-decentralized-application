/**
 * Network + contract configuration. Safe to import from client and server.
 */

export type StellarNetwork = "testnet" | "public"

const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet") as StellarNetwork

const DEFAULTS: Record<
  StellarNetwork,
  { passphrase: string; rpc: string; horizon: string; explorer: string }
> = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet",
  },
  public: {
    passphrase: "Public Global Stellar Network ; September 2015",
    rpc: "https://mainnet.sorobanrpc.com",
    horizon: "https://horizon.stellar.org",
    explorer: "https://stellar.expert/explorer/public",
  },
}

export const stellarConfig = {
  network: NETWORK,
  networkLabel: NETWORK === "public" ? "Mainnet" : "Testnet",
  networkPassphrase: DEFAULTS[NETWORK].passphrase,
  rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? DEFAULTS[NETWORK].rpc,
  horizonUrl: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? DEFAULTS[NETWORK].horizon,
  explorerUrl: DEFAULTS[NETWORK].explorer,
  contractId: process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID ?? "",
} as const

/** True once a real deployed contract id is configured. */
export const isContractConfigured = /^C[A-Z2-7]{55}$/.test(stellarConfig.contractId)

export function txUrl(hash: string) {
  return `${stellarConfig.explorerUrl}/tx/${hash}`
}

export function accountUrl(address: string) {
  return `${stellarConfig.explorerUrl}/account/${address}`
}

export function contractUrl(contractId = stellarConfig.contractId) {
  return `${stellarConfig.explorerUrl}/contract/${contractId}`
}

export function truncate(address: string, lead = 4, tail = 4) {
  if (!address) return ""
  if (address.length <= lead + tail + 3) return address
  return `${address.slice(0, lead)}…${address.slice(-tail)}`
}
