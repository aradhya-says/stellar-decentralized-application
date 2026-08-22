#!/usr/bin/env bash
#
# Build + test the Soroban contract without deploying.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$ROOT_DIR/contracts/nft-minter"

command -v stellar >/dev/null 2>&1 || {
  echo "stellar CLI not found. Install it with: cargo install --locked stellar-cli" >&2
  exit 1
}

cd "$CONTRACT_DIR"
cargo fmt --check || echo "note: run 'cargo fmt' to format the contract"
cargo test
stellar contract build

echo
echo "WASM artifacts:"
find target -name 'nft_minter*.wasm' -print
