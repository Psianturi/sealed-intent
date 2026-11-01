//! Public record of who may issue SeIn receipts, which agents exist and who owns them, and
//! Merkle roots of receipts. It holds hashes and statuses only, never amounts or recipients.
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active,
    Frozen,
    Retired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub agent_id: String,
    pub owner: AccountId,
    pub custody_account: AccountId,
    /// sha256 of the sealed policy, hex; a commitment that does not reveal it
    pub policy_hash: String,
    /// the key the agent signs its requests with
    pub agent_key: String,
    pub status: AgentStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct IssuerKey {
    pub public_key: String,
    pub added_at_ms: u64,
    pub retired_at_ms: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Anchor {
    pub index: u32,
    pub root: String,
    /// issue times of the receipts inside, set by the operator
    pub from_ms: u64,
    pub to_ms: u64,
    pub count: u32,
    /// when the chain saw this root; a receipt cannot be older than its period and newer than this
    pub anchored_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    operator: AccountId,
    issuers: IterableMap<String, IssuerKey>,
    agents: LookupMap<String, Agent>,
    by_owner: LookupMap<AccountId, Vec<String>>,
    agent_count: u64,
    anchors: Vector<Anchor>,
}

fn require_hex(value: &str, bytes: usize, name: &str) {
    require!(value.len() == bytes * 2 && value.bytes().all(|b| b.is_ascii_hexdigit()), format!("{name} must be {bytes} bytes of hex"));
}

#[near]
impl Registry {
    #[init]
    pub fn new(operator: AccountId) -> Self {
        Self {
            operator,
            issuers: IterableMap::new(b"i"),
            agents: LookupMap::new(b"a"),
            by_owner: LookupMap::new(b"o"),
            agent_count: 0,
            anchors: Vector::new(b"n"),
        }
    }

    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only the operator");
    }

    fn own_agent(&mut self, agent_id: &str) -> &mut Agent {
        let caller = env::predecessor_account_id();
        let agent = self.agents.get_mut(agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(agent.owner == caller, "only the owner of this agent");
        agent
    }

    /// The caller becomes the owner. The id comes from a counter, so nobody picks or reuses one.
    /// The caller pays for the storage; the rest of the deposit comes back.
    #[payable]
    pub fn register_agent(&mut self, custody_account: AccountId, policy_hash: String, agent_key: String) -> String {
        require_hex(&policy_hash, 32, "policy_hash");
        require_hex(&agent_key, 32, "agent_key");
        let before = env::storage_usage();
        let owner = env::predecessor_account_id();
        self.agent_count += 1;
        let agent_id = format!("agent-{}", self.agent_count);
        let now = env::block_timestamp_ms();
        self.agents.insert(
            agent_id.clone(),
            Agent { agent_id: agent_id.clone(), owner: owner.clone(), custody_account, policy_hash, agent_key, status: AgentStatus::Active, created_at_ms: now, updated_at_ms: now },
        );
        let mut mine = self.by_owner.get(&owner).cloned().unwrap_or_default();
        mine.push(agent_id.clone());
        self.by_owner.insert(owner.clone(), mine);
        self.agents.flush();
        self.by_owner.flush();
        let cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let paid = env::attached_deposit();
        require!(paid >= cost, format!("attach at least {cost} for storage"));
        let change = paid.saturating_sub(cost);
        if change > NearToken::from_yoctonear(0) {
            Promise::new(owner).transfer(change).detach();
        }
        agent_id
    }

    pub fn set_status(&mut self, agent_id: String, status: AgentStatus) {
        let now = env::block_timestamp_ms();
        let agent = self.own_agent(&agent_id);
        require!(agent.status != AgentStatus::Retired, "a retired agent stays retired");
        agent.status = status;
        agent.updated_at_ms = now;
    }

    pub fn set_policy_hash(&mut self, agent_id: String, policy_hash: String) {
        require_hex(&policy_hash, 32, "policy_hash");
        let now = env::block_timestamp_ms();
        let agent = self.own_agent(&agent_id);
        agent.policy_hash = policy_hash;
        agent.updated_at_ms = now;
    }

    pub fn add_issuer_key(&mut self, public_key: String) {
        self.only_operator();
        require_hex(&public_key, 32, "public_key");
        require!(self.issuers.get(&public_key).is_none(), "key already recorded");
        self.issuers.insert(public_key.clone(), IssuerKey { public_key, added_at_ms: env::block_timestamp_ms(), retired_at_ms: None });
    }

    pub fn retire_issuer_key(&mut self, public_key: String) {
        self.only_operator();
        let now = env::block_timestamp_ms();
        let key = self.issuers.get_mut(&public_key).unwrap_or_else(|| env::panic_str("unknown key"));
        require!(key.retired_at_ms.is_none(), "already retired");
        key.retired_at_ms = Some(now);
    }

    /// Roots only ever go forward: a period cannot start before the previous one ended.
    pub fn anchor(&mut self, root: String, from_ms: u64, to_ms: u64, count: u32) -> u32 {
        self.only_operator();
        require_hex(&root, 32, "root");
        require!(from_ms <= to_ms, "from after to");
        require!(count > 0, "empty anchor");
        let now = env::block_timestamp_ms();
        require!(to_ms <= now, "period ends in the future");
        if let Some(last) = self.anchors.get(self.anchors.len().saturating_sub(1)) {
            require!(from_ms >= last.to_ms, "period overlaps the previous anchor");
        }
        let index = self.anchors.len();
        self.anchors.push(Anchor { index, root, from_ms, to_ms, count, anchored_at_ms: now });
        index
    }

    pub fn operator(&self) -> &AccountId {
        &self.operator
    }

    pub fn issuer_key(&self, public_key: String) -> Option<&IssuerKey> {
        self.issuers.get(&public_key)
    }

    pub fn issuer_keys(&self) -> Vec<&IssuerKey> {
        self.issuers.values().collect()
    }

    pub fn get_agent(&self, agent_id: String) -> Option<&Agent> {
        self.agents.get(&agent_id)
    }

    pub fn agents_of(&self, owner: AccountId) -> Vec<String> {
        self.by_owner.get(&owner).cloned().unwrap_or_default()
    }

    pub fn agent_count(&self) -> u64 {
        self.agent_count
    }

    pub fn anchor_count(&self) -> u32 {
        self.anchors.len()
    }

    pub fn get_anchor(&self, index: u32) -> Option<&Anchor> {
        self.anchors.get(index)
    }

    pub fn anchors(&self, from_index: u32, limit: u32) -> Vec<&Anchor> {
        self.anchors.iter().skip(from_index as usize).take(limit.min(100) as usize).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const HEX_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEX_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn as_caller(who: &str, deposit: u128, ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ms * 1_000_000)
            .build());
    }
    const ENOUGH: u128 = 100_000_000_000_000_000_000_000;

    fn registry() -> Registry {
        as_caller("operator.testnet", 0, 1_000);
        Registry::new("operator.testnet".parse().unwrap())
    }

    fn with_agent() -> (Registry, String) {
        let mut r = registry();
        as_caller("alice.testnet", ENOUGH, 1_000);
        let id = r.register_agent("wallet.testnet".parse().unwrap(), HEX_A.into(), HEX_B.into());
        (r, id)
    }

    #[test]
    fn ids_come_from_a_counter() {
        let (mut r, id) = with_agent();
        assert_eq!(id, "agent-1");
        let second = r.register_agent("wallet.testnet".parse().unwrap(), HEX_A.into(), HEX_B.into());
        assert_eq!(second, "agent-2");
        assert_eq!(r.agents_of("alice.testnet".parse().unwrap()), vec!["agent-1", "agent-2"]);
        assert_eq!(r.get_agent("agent-1".into()).unwrap().status, AgentStatus::Active);
    }

    #[test]
    #[should_panic(expected = "for storage")]
    fn storage_must_be_paid() {
        let mut r = registry();
        as_caller("alice.testnet", 0, 1_000);
        r.register_agent("wallet.testnet".parse().unwrap(), HEX_A.into(), HEX_B.into());
    }

    #[test]
    #[should_panic(expected = "policy_hash must be 32 bytes")]
    fn a_policy_hash_is_a_hash() {
        let mut r = registry();
        as_caller("alice.testnet", ENOUGH, 1_000);
        r.register_agent("wallet.testnet".parse().unwrap(), "my limit is 50 dollars".into(), HEX_B.into());
    }

    #[test]
    fn the_owner_changes_status_and_policy() {
        let (mut r, id) = with_agent();
        as_caller("alice.testnet", 0, 2_000);
        r.set_status(id.clone(), AgentStatus::Frozen);
        r.set_policy_hash(id.clone(), HEX_B.into());
        let a = r.get_agent(id).unwrap();
        assert_eq!(a.status, AgentStatus::Frozen);
        assert_eq!(a.policy_hash, HEX_B);
        assert_eq!(a.updated_at_ms, 2_000);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn nobody_else_changes_status() {
        let (mut r, id) = with_agent();
        as_caller("mallory.testnet", 0, 2_000);
        r.set_status(id, AgentStatus::Active);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_operator_cannot_change_an_agent_either() {
        let (mut r, id) = with_agent();
        as_caller("operator.testnet", 0, 2_000);
        r.set_policy_hash(id, HEX_B.into());
    }

    #[test]
    #[should_panic(expected = "stays retired")]
    fn retired_is_final() {
        let (mut r, id) = with_agent();
        as_caller("alice.testnet", 0, 2_000);
        r.set_status(id.clone(), AgentStatus::Retired);
        r.set_status(id, AgentStatus::Active);
    }

    #[test]
    fn issuer_keys_keep_their_history() {
        let mut r = registry();
        as_caller("operator.testnet", 0, 1_000);
        r.add_issuer_key(HEX_A.into());
        as_caller("operator.testnet", 0, 5_000);
        r.retire_issuer_key(HEX_A.into());
        r.add_issuer_key(HEX_B.into());
        let a = r.issuer_key(HEX_A.into()).unwrap();
        assert_eq!((a.added_at_ms, a.retired_at_ms), (1_000, Some(5_000)));
        assert_eq!(r.issuer_keys().len(), 2);
    }

    #[test]
    #[should_panic(expected = "only the operator")]
    fn only_the_operator_adds_issuer_keys() {
        let mut r = registry();
        as_caller("mallory.testnet", 0, 1_000);
        r.add_issuer_key(HEX_A.into());
    }

    #[test]
    fn anchors_go_forward() {
        let mut r = registry();
        as_caller("operator.testnet", 0, 10_000);
        assert_eq!(r.anchor(HEX_A.into(), 1_000, 2_000, 3), 0);
        assert_eq!(r.anchor(HEX_B.into(), 2_000, 3_000, 1), 1);
        assert_eq!(r.anchor_count(), 2);
        assert_eq!(r.get_anchor(1).unwrap().anchored_at_ms, 10_000);
        assert_eq!(r.anchors(0, 10).len(), 2);
    }

    #[test]
    #[should_panic(expected = "overlaps")]
    fn a_receipt_cannot_be_backdated_into_a_closed_period() {
        let mut r = registry();
        as_caller("operator.testnet", 0, 10_000);
        r.anchor(HEX_A.into(), 1_000, 2_000, 3);
        r.anchor(HEX_B.into(), 1_500, 3_000, 1);
    }

    #[test]
    #[should_panic(expected = "in the future")]
    fn a_period_cannot_end_in_the_future() {
        let mut r = registry();
        as_caller("operator.testnet", 0, 10_000);
        r.anchor(HEX_A.into(), 1_000, 20_000, 3);
    }

    #[test]
    #[should_panic(expected = "only the operator")]
    fn only_the_operator_anchors() {
        let mut r = registry();
        as_caller("mallory.testnet", 0, 10_000);
        r.anchor(HEX_A.into(), 1_000, 2_000, 3);
    }
}
