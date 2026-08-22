/**
 * Turns wallet, RPC and contract failures into short, human sentences.
 */

const CONTRACT_ERRORS: Record<number, string> = {
  1: "This collection has already been initialized.",
  2: "The contract has not been initialized yet.",
  3: "Only the collection admin can do that.",
  4: "The collection has reached its maximum supply.",
  5: "That token does not exist.",
  6: "Royalty must be between 0% and 25%.",
  7: "Add at least one item to the batch.",
  8: "That batch is too large for a single transaction.",
  9: "Unknown rarity tag.",
  10: "Name and metadata URI are both required.",
  11: "You are not the owner of that token.",
}

export function friendlyError(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ((error as { message?: string } | null)?.message ?? "")

  const message = raw || "Something went wrong."
  const lower = message.toLowerCase()

  const contractCode = message.match(/Error\(Contract, #(\d+)\)/)
  if (contractCode) {
    const mapped = CONTRACT_ERRORS[Number(contractCode[1])]
    if (mapped) return mapped
  }

  if (lower.includes("not found") && lower.includes("wallet")) {
    return "That wallet is not installed. Install it, then reload this page."
  }
  if (lower.includes("no wallet") || lower.includes("wallet is not available")) {
    return "No Stellar wallet detected. Install Freighter or connect a mobile wallet."
  }
  if (
    lower.includes("user rejected") ||
    lower.includes("user declined") ||
    lower.includes("denied") ||
    lower.includes("cancel")
  ) {
    return "You rejected the request in your wallet."
  }
  if (lower.includes("insufficient") || lower.includes("underfunded") || lower.includes("tx_insufficient_balance")) {
    return "Not enough XLM to cover the network fee. Fund your testnet account and try again."
  }
  if (lower.includes("account not found") || lower.includes("resource_missing")) {
    return "This account does not exist on the network yet. Fund it with the testnet friendbot first."
  }
  if (lower.includes("tx_too_late") || lower.includes("expired")) {
    return "The transaction expired before it was submitted. Please try again."
  }
  if (lower.includes("tx_bad_seq")) {
    return "Sequence number conflict. Wait a moment and retry."
  }
  if (lower.includes("network") && lower.includes("mismatch")) {
    return "Your wallet is on a different network. Switch it to Testnet."
  }
  if (lower.includes("fetch failed") || lower.includes("networkerror") || lower.includes("timeout")) {
    return "Could not reach the Stellar RPC endpoint. Check your connection and retry."
  }

  return message.length > 180 ? `${message.slice(0, 177)}…` : message
}
