#![no_std]

//! Forge — a Soroban NFT minting contract.
//!
//! Features
//! - single + batch minting with custom metadata
//! - per-token rarity tagging (common / uncommon / rare / epic / legendary)
//! - collection level royalty in basis points, updatable by the admin
//! - transfers, ownership lookups, rarity counters
//! - contract events for every state changing call

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Env, String,
    Symbol, Vec,
};

/// Hard cap on how many tokens can be minted in a single `batch_mint` call.
pub const MAX_BATCH: u32 = 25;
/// Royalties are expressed in basis points, capped at 25%.
pub const MAX_ROYALTY_BPS: u32 = 2_500;

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const BUMP_AMOUNT: u32 = DAY_IN_LEDGERS * 90;

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub max_supply: u32,
    pub name: String,
    pub royalty_bps: u32,
    pub symbol: String,
}

/// Metadata supplied by the caller for each token that gets minted.
#[contracttype]
#[derive(Clone)]
pub struct MintRequest {
    pub name: String,
    pub rarity: Symbol,
    pub uri: String,
}

/// Full, flattened view of a token. Returned by the read-only helpers so the
/// frontend can render a card without extra round trips.
#[contracttype]
#[derive(Clone)]
pub struct TokenView {
    pub id: u32,
    pub minted_at: u64,
    pub minter: Address,
    pub name: String,
    pub owner: Address,
    pub rarity: Symbol,
    pub uri: String,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Counter,
    Token(u32),
    Owned(Address),
    RarityCount(Symbol),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    SupplyExhausted = 4,
    TokenNotFound = 5,
    InvalidRoyalty = 6,
    EmptyBatch = 7,
    BatchTooLarge = 8,
    InvalidRarity = 9,
    InvalidMetadata = 10,
    NotOwner = 11,
}

#[contract]
pub struct NftMinter;

#[contractimpl]
impl NftMinter {
    /// One-time setup. Stores the collection config and seeds the token counter.
    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        royalty_bps: u32,
        max_supply: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if royalty_bps > MAX_ROYALTY_BPS {
            return Err(Error::InvalidRoyalty);
        }
        if max_supply == 0 {
            return Err(Error::InvalidMetadata);
        }

        admin.require_auth();

        let config = Config {
            admin: admin.clone(),
            max_supply,
            name,
            royalty_bps,
            symbol,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Counter, &0u32);
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("init"), admin), (royalty_bps, max_supply));
        Ok(())
    }

    /// Mint a single token to `to`. Returns the new token id.
    pub fn mint(env: Env, to: Address, req: MintRequest) -> Result<u32, Error> {
        to.require_auth();
        let config = Self::load_config(&env)?;
        let id = Self::mint_one(&env, &config, &to, &to, &req)?;

        env.events()
            .publish((symbol_short!("mint"), to), (id, req.rarity));
        Ok(id)
    }

    /// Mint up to `MAX_BATCH` tokens in a single transaction.
    /// Returns the ids of every token that was created, in order.
    pub fn batch_mint(env: Env, to: Address, reqs: Vec<MintRequest>) -> Result<Vec<u32>, Error> {
        to.require_auth();

        let count = reqs.len();
        if count == 0 {
            return Err(Error::EmptyBatch);
        }
        if count > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }

        let config = Self::load_config(&env)?;
        let mut ids: Vec<u32> = vec![&env];
        for req in reqs.iter() {
            let id = Self::mint_one(&env, &config, &to, &to, &req)?;
            ids.push_back(id);
        }

        let first = ids.first().unwrap_or(0);
        let last = ids.last().unwrap_or(0);
        env.events()
            .publish((symbol_short!("batch"), to), (count, first, last));
        Ok(ids)
    }

    /// Admin-only. Updates the collection royalty, in basis points.
    pub fn set_royalty(env: Env, caller: Address, royalty_bps: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut config = Self::load_config(&env)?;
        if caller != config.admin {
            return Err(Error::NotAuthorized);
        }
        if royalty_bps > MAX_ROYALTY_BPS {
            return Err(Error::InvalidRoyalty);
        }

        let previous = config.royalty_bps;
        config.royalty_bps = royalty_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("royalty"), caller), (previous, royalty_bps));
        Ok(())
    }

    /// Move a token to a new owner. Only the current owner may call this.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u32) -> Result<(), Error> {
        from.require_auth();

        let mut token = Self::load_token(&env, token_id)?;
        if token.owner != from {
            return Err(Error::NotOwner);
        }

        token.owner = to.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Token(token_id), &token);
        env.storage().persistent().extend_ttl(
            &DataKey::Token(token_id),
            BUMP_THRESHOLD,
            BUMP_AMOUNT,
        );

        Self::remove_owned(&env, &from, token_id);
        Self::push_owned(&env, &to, token_id);

        env.events()
            .publish((symbol_short!("transfer"), from, to), token_id);
        Ok(())
    }

    // ---------------------------------------------------------------- reads

    pub fn config(env: Env) -> Result<Config, Error> {
        Self::load_config(&env)
    }

    pub fn total_supply(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0u32)
    }

    pub fn token(env: Env, token_id: u32) -> Result<TokenView, Error> {
        Self::load_token(&env, token_id)
    }

    /// Paginated token listing, newest ids last. `start` is 1-indexed.
    pub fn list(env: Env, start: u32, limit: u32) -> Vec<TokenView> {
        let total = Self::total_supply(env.clone());
        let mut out: Vec<TokenView> = vec![&env];
        if total == 0 || limit == 0 || start > total {
            return out;
        }
        let from = if start == 0 { 1 } else { start };
        let mut id = from;
        while id <= total && out.len() < limit {
            if let Some(token) = env
                .storage()
                .persistent()
                .get::<DataKey, TokenView>(&DataKey::Token(id))
            {
                out.push_back(token);
            }
            id += 1;
        }
        out
    }

    pub fn tokens_of(env: Env, owner: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::Owned(owner))
            .unwrap_or_else(|| vec![&env])
    }

    pub fn balance_of(env: Env, owner: Address) -> u32 {
        Self::tokens_of(env, owner).len()
    }

    pub fn rarity_count(env: Env, rarity: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RarityCount(rarity))
            .unwrap_or(0u32)
    }

    /// Royalty owed on a secondary sale of `sale_price` stroops.
    pub fn royalty_amount(env: Env, sale_price: i128) -> Result<i128, Error> {
        let config = Self::load_config(&env)?;
        Ok(sale_price * i128::from(config.royalty_bps) / 10_000i128)
    }

    // ------------------------------------------------------------- internals

    fn load_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    fn load_token(env: &Env, token_id: u32) -> Result<TokenView, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::TokenNotFound)
    }

    fn mint_one(
        env: &Env,
        config: &Config,
        to: &Address,
        minter: &Address,
        req: &MintRequest,
    ) -> Result<u32, Error> {
        if !Self::is_valid_rarity(&req.rarity) {
            return Err(Error::InvalidRarity);
        }
        if req.name.len() == 0 || req.uri.len() == 0 {
            return Err(Error::InvalidMetadata);
        }

        let minted: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0u32);
        if minted >= config.max_supply {
            return Err(Error::SupplyExhausted);
        }

        let id = minted + 1;
        let token = TokenView {
            id,
            minted_at: env.ledger().timestamp(),
            minter: minter.clone(),
            name: req.name.clone(),
            owner: to.clone(),
            rarity: req.rarity.clone(),
            uri: req.uri.clone(),
        };

        env.storage().persistent().set(&DataKey::Token(id), &token);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Token(id), BUMP_THRESHOLD, BUMP_AMOUNT);
        env.storage().instance().set(&DataKey::Counter, &id);
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);

        Self::push_owned(env, to, id);
        Self::bump_rarity(env, &req.rarity);
        Ok(id)
    }

    fn is_valid_rarity(rarity: &Symbol) -> bool {
        rarity == &symbol_short!("common")
            || rarity == &symbol_short!("uncommon")
            || rarity == &symbol_short!("rare")
            || rarity == &symbol_short!("epic")
            || rarity == &symbol_short!("legendary")
    }

    fn push_owned(env: &Env, owner: &Address, token_id: u32) {
        let key = DataKey::Owned(owner.clone());
        let mut owned: Vec<u32> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| vec![env]);
        owned.push_back(token_id);
        env.storage().persistent().set(&key, &owned);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
    }

    fn remove_owned(env: &Env, owner: &Address, token_id: u32) {
        let key = DataKey::Owned(owner.clone());
        let owned: Vec<u32> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| vec![env]);
        let mut next: Vec<u32> = vec![env];
        for id in owned.iter() {
            if id != token_id {
                next.push_back(id);
            }
        }
        env.storage().persistent().set(&key, &next);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
    }

    fn bump_rarity(env: &Env, rarity: &Symbol) {
        let key = DataKey::RarityCount(rarity.clone());
        let current: u32 = env.storage().persistent().get(&key).unwrap_or(0u32);
        env.storage().persistent().set(&key, &(current + 1));
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
    }
}

mod test;
