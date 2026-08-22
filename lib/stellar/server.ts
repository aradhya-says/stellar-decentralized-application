/**
 * Server-only Soroban access layer.
 *
 * Reads are simulated with a throwaway source account so they never require a
 * connected wallet. Writes are built + prepared here, signed in the browser by
 * StellarWalletsKit, then submitted back through this module.
 */
import "server-only"

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk"

import { stellarConfig } from "./config"
import { toNftToken, u32 } from "./scval"
import type { CollectionState, ContractEvent, ContractEventType, NftToken, Rarity } from "@/types"
import { RARITIES } from "@/types"

const READ_LEDGER_WINDOW = 8_000

let cachedServer: rpc.Server | null = null

export function getServer() {
  if (!cachedServer) {
    cachedServer = new rpc.Server(stellarConfig.rpcUrl, {
      allowHttp: stellarConfig.rpcUrl.startsWith("http://"),
    })
  }
  return cachedServer
}

function requireContractId() {
  if (!stellarConfig.contractId) {
    throw new Error("NEXT_PUBLIC_STELLAR_CONTRACT_ID is not set.")
  }
  return stellarConfig.contractId
}

function getContract() {
  return new Contract(requireContractId())
}

/** Simulate a read-only contract call and decode the result. */
export async function simulateRead<T = unknown>(fn: string, args: xdr.ScVal[] = []): Promise<T> {
  const server = getServer()
  const source = new Account(Keypair.random().publicKey(), "0")

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(getContract().call(fn, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error)
  }
  if (!sim.result?.retval) {
    throw new Error(`No value returned from ${fn}()`)
  }
  return scValToNative(sim.result.retval) as T
}

/**
 * Build + prepare an invocation. The returned XDR is ready for the wallet to
 * sign; simulation errors surface here before the user is ever prompted.
 */
export async function buildInvocation(source: string, fn: string, args: xdr.ScVal[]) {
  const server = getServer()
  const account = await server.getAccount(source)

  const tx = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * 100).toString(),
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(getContract().call(fn, ...args))
    .setTimeout(180)
    .build()

  const prepared = await server.prepareTransaction(tx)
  return prepared.toXDR()
}

export async function submitSignedXdr(signedXdr: string) {
  const server = getServer()
  const tx = TransactionBuilder.fromXDR(signedXdr, stellarConfig.networkPassphrase)
  const sent = await server.sendTransaction(tx)

  if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER") {
    const detail = sent.errorResult ? JSON.stringify(sent.errorResult.result().switch().name) : sent.status
    throw new Error(`Submission rejected by the network (${detail}).`)
  }
  return { hash: sent.hash, status: sent.status }
}

export type TxLookup =
  | { status: "pending" }
  | { status: "success"; returnValue: unknown; ledger: number }
  | { status: "failed"; error: string }

export async function lookupTransaction(hash: string): Promise<TxLookup> {
  const server = getServer()
  const result = await server.getTransaction(hash)

  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return { status: "pending" }
  }
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      status: "success",
      ledger: result.ledger,
      returnValue: result.returnValue ? scValToNative(result.returnValue) : null,
    }
  }
  return {
    status: "failed",
    error: result.resultXdr?.result().switch().name ?? "Transaction failed on-chain.",
  }
}

// --------------------------------------------------------------- collection

export async function readCollectionState(): Promise<CollectionState> {
  const [config, totalSupply, ...counts] = await Promise.all([
    simulateRead<Record<string, unknown>>("config"),
    simulateRead<number>("total_supply"),
    ...RARITIES.map((rarity) =>
      simulateRead<number>("rarity_count", [
        xdr.ScVal.scvSymbol(rarity),
      ]).catch(() => 0),
    ),
  ])

  const rarityCounts = RARITIES.reduce(
    (acc, rarity, index) => {
      acc[rarity] = Number(counts[index] ?? 0)
      return acc
    },
    {} as Record<Rarity, number>,
  )

  return {
    admin: String(config.admin ?? ""),
    name: String(config.name ?? "Untitled collection"),
    symbol: String(config.symbol ?? ""),
    royaltyBps: Number(config.royalty_bps ?? 0),
    maxSupply: Number(config.max_supply ?? 0),
    totalSupply: Number(totalSupply ?? 0),
    rarityCounts,
  }
}

export async function readTokens(start: number, limit: number): Promise<NftToken[]> {
  const raw = await simulateRead<Record<string, unknown>[]>("list", [u32(start), u32(limit)])
  return (raw ?? []).map(toNftToken)
}

export async function readTokensOf(owner: string): Promise<number[]> {
  const { Address } = await import("@stellar/stellar-sdk")
  const ids = await simulateRead<number[]>("tokens_of", [new Address(owner).toScVal()])
  return (ids ?? []).map(Number)
}

// ------------------------------------------------------------------- events

const EVENT_ACTIONS: Record<ContractEventType, (data: unknown) => string> = {
  init: () => "Collection initialized",
  mint: (data) => {
    const [, rarity] = Array.isArray(data) ? data : []
    return rarity ? `Minted 1 ${String(rarity)} token` : "Minted 1 token"
  },
  batch: (data) => {
    const [count] = Array.isArray(data) ? data : []
    return `Batch minted ${Number(count ?? 0)} tokens`
  },
  transfer: () => "Transferred a token",
  royalty: (data) => {
    const [, next] = Array.isArray(data) ? data : []
    return `Royalty set to ${(Number(next ?? 0) / 100).toFixed(2)}%`
  },
}

function eventTokenIds(type: ContractEventType, data: unknown): number[] {
  const values = (Array.isArray(data) ? data : [data]).map(Number).filter((n) => Number.isFinite(n))
  if (type === "mint") return values.slice(0, 1)
  if (type === "batch" && values.length >= 3) {
    const [, first, last] = values
    const ids: number[] = []
    for (let id = first; id <= last && ids.length < 50; id += 1) ids.push(id)
    return ids
  }
  if (type === "transfer") return values.slice(0, 1)
  return []
}

export async function readEvents(limit = 40): Promise<ContractEvent[]> {
  const server = getServer()
  const contractId = requireContractId()
  const latest = await server.getLatestLedger()
  const startLedger = Math.max(1, latest.sequence - READ_LEDGER_WINDOW)

  const response = await server.getEvents({
    startLedger,
    filters: [{ type: "contract", contractIds: [contractId] }],
    limit: Math.min(limit, 200),
  })

  return response.events
    .map((event): ContractEvent | null => {
      const topics = event.topic.map((topic) => {
        try {
          return scValToNative(topic)
        } catch {
          return null
        }
      })

      const type = String(topics[0] ?? "") as ContractEventType
      if (!EVENT_ACTIONS[type]) return null

      const data = (() => {
        try {
          return scValToNative(event.value)
        } catch {
          return null
        }
      })()

      const address = topics.slice(1).find((topic) => typeof topic === "string" && topic.startsWith("G"))

      return {
        id: event.id,
        type,
        action: EVENT_ACTIONS[type](data),
        address: String(address ?? ""),
        ledger: event.ledger,
        timestamp: new Date(event.ledgerClosedAt).getTime(),
        tokenIds: eventTokenIds(type, data),
        txHash: event.txHash,
      }
    })
    .filter((event): event is ContractEvent => event !== null)
    .reverse()
}

// ------------------------------------------------------------------ account

export async function readAccount(address: string) {
  const response = await fetch(`${stellarConfig.horizonUrl}/accounts/${address}`, {
    cache: "no-store",
  })

  if (response.status === 404) {
    return {
      address,
      exists: false,
      xlm: "0",
      subentries: 0,
      network: stellarConfig.networkLabel,
    }
  }
  if (!response.ok) {
    throw new Error(`Horizon returned ${response.status}`)
  }

  const account = (await response.json()) as {
    balances: { asset_type: string; balance: string }[]
    subentry_count: number
  }
  const native = account.balances.find((balance) => balance.asset_type === "native")

  return {
    address,
    exists: true,
    xlm: native?.balance ?? "0",
    subentries: account.subentry_count ?? 0,
    network: stellarConfig.networkLabel,
  }
}
