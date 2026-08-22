#!/usr/bin/env bash
#
# Build, deploy and initialize the Forge NFT minter on Stellar Testnet.
#
# Prerequisites
#   rustup target add wasm32v1-none      (wasm32-unknown-unknown for Rust < 1.85)
#   cargo install --locked stellar-cli
#
# Usage
#   ./scripts/deploy.sh                       # uses the "forge-admin" identity
#   IDENTITY=my-key ./scripts/deploy.sh
#
set -euo pipefail

IDENTITY="${IDENTITY:-forge-admin}"
NETWORK="${NETWORK:-testnet}"
COLLECTION_NAME="${COLLECTION_NAME:-Forge Genesis}"
COLLECTION_SYMBOL="${COLLECTION_SYMBOL:-FORGE}"
ROYALTY_BPS="${ROYALTY_BPS:-500}"
MAX_SUPPLY="${MAX_SUPPLY:-10000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$ROOT_DIR/contracts/nft-minter"
WASM="$CONTRACT_DIR/target/wasm32v1-none/release/nft_minter.wasm"

info() { printf '\033[1;33m→\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v stellar >/dev/null 2>&1 || fail "stellar CLI not found. Install it with: cargo install --locked stellar-cli"

info "Configuring $NETWORK identity: $IDENTITY"
if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  stellar keys generate --global "$IDENTITY" --network "$NETWORK" --fund
fi
ADMIN_ADDRESS="$(stellar keys address "$IDENTITY")"
stellar keys fund "$IDENTITY" --network "$NETWORK" >/dev/null 2>&1 || true
info "Admin address: $ADMIN_ADDRESS"

info "Running contract tests"
(cd "$CONTRACT_DIR" && cargo test --quiet)

info "Building WASM"
(cd "$CONTRACT_DIR" && stellar contract build)
[ -f "$WASM" ] || WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/nft_minter.wasm"
[ -f "$WASM" ] || fail "WASM artifact not found. Check the build output above."

info "Optimizing WASM"
stellar contract optimize --wasm "$WASM" >/dev/null 2>&1 || true
OPTIMIZED="${WASM%.wasm}.optimized.wasm"
[ -f "$OPTIMIZED" ] && WASM="$OPTIMIZED"

info "Deploying to $NETWORK"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK")"

[ -n "$CONTRACT_ID" ] || fail "Deployment failed."
info "Contract ID: $CONTRACT_ID"

info "Initializing collection"
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --name "$COLLECTION_NAME" \
  --symbol "$COLLECTION_SYMBOL" \
  --royalty_bps "$ROYALTY_BPS" \
  --max_supply "$MAX_SUPPLY"

ENV_FILE="$ROOT_DIR/.env.local"
info "Writing NEXT_PUBLIC_STELLAR_CONTRACT_ID to .env.local"
if [ -f "$ENV_FILE" ] && grep -q '^NEXT_PUBLIC_STELLAR_CONTRACT_ID=' "$ENV_FILE"; then
  tmp="$(mktemp)"
  sed "s|^NEXT_PUBLIC_STELLAR_CONTRACT_ID=.*|NEXT_PUBLIC_STELLAR_CONTRACT_ID=$CONTRACT_ID|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
else
  {
    echo "NEXT_PUBLIC_STELLAR_NETWORK=testnet"
    echo "NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org"
    echo "NEXT_PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org"
    echo "NEXT_PUBLIC_STELLAR_CONTRACT_ID=$CONTRACT_ID"
  } >> "$ENV_FILE"
fi

cat <<EOF

Deployment complete.

  Contract ID   $CONTRACT_ID
  Admin         $ADMIN_ADDRESS
  Network       $NETWORK
  Explorer      https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID

Next steps
  1. Add NEXT_PUBLIC_STELLAR_CONTRACT_ID=$CONTRACT_ID to your Vercel project env vars.
  2. Restart the dev server so the app leaves demo mode.
EOF
