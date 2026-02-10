#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, log, symbol_short, Address, Env, Map, String, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PollError {
    PollNotFound = 1,
    PollEnded = 2,
    AlreadyVoted = 3,
    InvalidOption = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Poll {
    pub question: String,
    pub options: Vec<String>,
    pub deadline: u64,
    pub votes: Map<u32, u32>,
}

#[contracttype]
pub enum DataKey {
    Poll,
    Voter(Address),
}

#[contract]
pub struct LivePollContract;

#[contractimpl]
impl LivePollContract {
    /// Initialize the poll.
    /// This overwrites any existing poll.
    pub fn init_poll(env: Env, question: String, options: Vec<String>, deadline: u64) {
        let poll = Poll {
            question,
            options,
            deadline,
            votes: Map::new(&env),
        };
        env.storage().instance().set(&DataKey::Poll, &poll);
        env.storage().instance().extend_ttl(17280, 17280);
    }

    /// Cast a vote for an option.
    pub fn vote(env: Env, voter: Address, option_index: u32) -> Result<(), PollError> {
        voter.require_auth();

        // 1. Load Poll
        let mut poll: Poll = env
            .storage()
            .instance()
            .get(&DataKey::Poll)
            .ok_or(PollError::PollNotFound)?;

        // 2. Check Deadline
        if env.ledger().timestamp() > poll.deadline {
            return Err(PollError::PollEnded);
        }

        // 3. Check Double Voting
        if env.storage().persistent().has(&DataKey::Voter(voter.clone())) {
            return Err(PollError::AlreadyVoted);
        }

        // 4. Validate Option
        if option_index >= poll.options.len() {
            return Err(PollError::InvalidOption);
        }

        // 5. Register Vote
        let current_counts = poll.votes.get(option_index).unwrap_or(0);
        poll.votes.set(option_index, current_counts + 1);

        // 6. Save State
        env.storage().instance().set(&DataKey::Poll, &poll);
        env.storage().persistent().set(&DataKey::Voter(voter.clone()), &true);
        env.storage().persistent().extend_ttl(&DataKey::Voter(voter.clone()), 17280, 17280);

        // 7. Emit Event
        env.events().publish(
            (symbol_short!("vote"),),
            (option_index, voter),
        );

        Ok(())
    }

    /// Get the current poll state.
    pub fn get_poll(env: Env) -> Result<Poll, PollError> {
        env.storage().instance().get(&DataKey::Poll).ok_or(PollError::PollNotFound)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger}, vec};

    #[test]
    fn test_poll_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, LivePollContract);
        let client = LivePollContractClient::new(&env, &contract_id);

        let question = String::from_str(&env, "Favorite Color?");
        let options = vec![
            &env,
            String::from_str(&env, "Red"),
            String::from_str(&env, "Blue"),
        ];
        // Set ledger time
        env.ledger().set_timestamp(100);
        let deadline = 200;

        client.init_poll(&question, &options, &deadline);

        let poll = client.get_poll();
        assert_eq!(poll.question, question);
        assert_eq!(poll.options.len(), 2);

        // Vote 1
        let voter1 = Address::generate(&env);
        client.vote(&voter1, &0); // Vote Red

        let poll_after = client.get_poll();
        assert_eq!(poll_after.votes.get(0).unwrap(), 1);
        assert_eq!(poll_after.votes.get(1).unwrap_or(0), 0);

        // Vote 2
        let voter2 = Address::generate(&env);
        client.vote(&voter2, &1); // Vote Blue

        // Vote 1 again (should fail)
        let res = client.try_vote(&voter1, &0);
        assert_eq!(res, Err(Ok(PollError::AlreadyVoted)));

        // Vote late (should fail)
        env.ledger().set_timestamp(201);
        let voter3 = Address::generate(&env);
        let res_late = client.try_vote(&voter3, &0);
        assert_eq!(res_late, Err(Ok(PollError::PollEnded)));
    }
}
