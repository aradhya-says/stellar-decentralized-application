/**
 * Server-only conversions between app types and Soroban ScVals.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import type { MintRequestInput, NftToken, Rarity } from "@/types"
import { RARITIES } from "@/types"

export function addressToScVal(address: string) {
  return new Address(address).toScVal()
}

export function u32(value: number) {
  return nativeToScVal(Math.trunc(value), { type: "u32" })
}

export function i128(value: string | number | bigint) {
  return nativeToScVal(BigInt(value), { type: "i128" })
}

export function str(value: string) {
  return nativeToScVal(value, { type: "string" })
}

export function sym(value: string) {
  return nativeToScVal(value, { type: "symbol" })
}

/**
 * Soroban structs are ScMaps keyed by symbols, sorted by key.
 * MintRequest fields sort as: name, rarity, uri.
 */
export function mintRequestToScVal(req: MintRequestInput) {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("name"), val: str(req.name) }),
    new xdr.ScMapEntry({ key: sym("rarity"), val: sym(req.rarity) }),
    new xdr.ScMapEntry({ key: sym("uri"), val: str(req.uri) }),
  ])
}

export function mintRequestVecToScVal(reqs: MintRequestInput[]) {
  return xdr.ScVal.scvVec(reqs.map(mintRequestToScVal))
}

function toRarity(value: unknown): Rarity {
  const raw = String(value ?? "common").toLowerCase()
  return (RARITIES as readonly string[]).includes(raw) ? (raw as Rarity) : "common"
}

/** Normalizes a decoded `TokenView` struct into the app's NftToken shape. */
export function toNftToken(raw: Record<string, unknown>): NftToken {
  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ""),
    uri: String(raw.uri ?? ""),
    rarity: toRarity(raw.rarity),
    owner: String(raw.owner ?? ""),
    minter: String(raw.minter ?? ""),
    mintedAt: Number(raw.minted_at ?? 0) * 1000,
  }
}
