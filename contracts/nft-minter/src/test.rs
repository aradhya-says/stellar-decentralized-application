#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, vec, Env, String};

fn setup(env: &Env) -> (NftMinterClient<'_>, Address) {
    let contract_id = env.register(NftMinter, ());
    let client = NftMinterClient::new(env, &contract_id);
    let admin = Address::generate(env);

    client.initialize(
        &admin,
        &String::from_str(env, "Forge Genesis"),
        &String::from_str(env, "FORGE"),
        &500u32,
        &1000u32,
    );

    (client, admin)
}

fn req(env: &Env, name: &str, rarity: Symbol) -> MintRequest {
    MintRequest {
        name: String::from_str(env, name),
        rarity,
        uri: String::from_str(env, "ipfs://bafy/1.json"),
    }
}

#[test]
fn initialize_sets_config() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    let config = client.config();
    assert_eq!(config.admin, admin);
    assert_eq!(config.royalty_bps, 500);
    assert_eq!(config.max_supply, 1000);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn mint_assigns_sequential_ids() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);

    let first = client.mint(&user, &req(&env, "Ingot #1", symbol_short!("common")));
    let second = client.mint(&user, &req(&env, "Ingot #2", symbol_short!("rare")));

    assert_eq!(first, 1);
    assert_eq!(second, 2);
    assert_eq!(client.total_supply(), 2);
    assert_eq!(client.balance_of(&user), 2);
    assert_eq!(client.rarity_count(&symbol_short!("rare")), 1);
    assert_eq!(client.token(&1).owner, user);
}

#[test]
fn batch_mint_creates_every_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);

    let reqs = vec![
        &env,
        req(&env, "Batch A", symbol_short!("epic")),
        req(&env, "Batch B", symbol_short!("epic")),
        req(&env, "Batch C", symbol_short!("legendary")),
    ];
    let ids = client.batch_mint(&user, &reqs);

    assert_eq!(ids.len(), 3);
    assert_eq!(ids.first().unwrap(), 1);
    assert_eq!(ids.last().unwrap(), 3);
    assert_eq!(client.rarity_count(&symbol_short!("epic")), 2);
    assert_eq!(client.list(&1, &10).len(), 3);
}

#[test]
fn royalty_is_updatable_and_computed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    assert_eq!(client.royalty_amount(&10_000_000i128), 500_000i128);
    client.set_royalty(&admin, &1000u32);
    assert_eq!(client.config().royalty_bps, 1000);
    assert_eq!(client.royalty_amount(&10_000_000i128), 1_000_000i128);
}

#[test]
fn transfer_moves_ownership() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let id = client.mint(&alice, &req(&env, "Relic", symbol_short!("uncommon")));
    client.transfer(&alice, &bob, &id);

    assert_eq!(client.token(&id).owner, bob);
    assert_eq!(client.balance_of(&alice), 0);
    assert_eq!(client.balance_of(&bob), 1);
}

#[test]
fn rejects_unknown_rarity() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);

    let result = client.try_mint(&user, &req(&env, "Bad", symbol_short!("mythic")));
    assert_eq!(result, Err(Ok(Error::InvalidRarity)));
}

#[test]
fn rejects_oversized_batch() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);

    let mut reqs = vec![&env];
    for _ in 0..(MAX_BATCH + 1) {
        reqs.push_back(req(&env, "Overflow", symbol_short!("common")));
    }

    assert_eq!(
        client.try_batch_mint(&user, &reqs),
        Err(Ok(Error::BatchTooLarge))
    );
}

#[test]
fn non_admin_cannot_change_royalty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_set_royalty(&stranger, &100u32),
        Err(Ok(Error::NotAuthorized))
    );
}
