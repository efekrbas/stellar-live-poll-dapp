#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, symbol_short, Env, String, Vec, Map, Address, log};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PollError {
    NotInitialized = 1,
    PollEnded = 2,
    AlreadyVoted = 3,
}

#[contracttype]
#[derive(Clone)]
pub struct Poll {
    pub question: String,
    pub options: Vec<String>,
    pub votes: Map<u32, u32>,
    pub voters: Vec<Address>,
    pub is_active: bool,
}

const POLL_KEY: &str = "POLL";

#[contract]
pub struct LivePollContract;

#[contractimpl]
impl LivePollContract {
    /// Initialize a new poll with a question and a list of options.
    pub fn init_poll(env: Env, question: String, options: Vec<String>) -> Poll {
        let mut votes = Map::new(&env);
        for i in 0..options.len() {
            votes.set(i as u32, 0u32);
        }

        let poll = Poll {
            question,
            options,
            votes,
            voters: Vec::new(&env),
            is_active: true,
        };

        env.storage().instance().set(&symbol_short!("POLL"), &poll);
        
        // Emit event for poll initialization
        env.events().publish((symbol_short!("poll"), symbol_short!("init")), poll.clone());
        
        log!(&env, "Poll initialized successfully");
        poll
    }

    /// Cast a vote for the given option index. Each address can only vote once.
    pub fn vote(env: Env, voter: Address, option_index: u32) -> Poll {
        voter.require_auth();

        let mut poll: Poll = env
            .storage()
            .instance()
            .get(&symbol_short!("POLL"))
            .unwrap_or_else(|| panic!("{}", PollError::NotInitialized as u32));

        if !poll.is_active {
            panic!("{}", PollError::PollEnded as u32);
        }

        // Check if voter has already voted
        for existing_voter in poll.voters.iter() {
            if existing_voter == voter {
                panic!("{}", PollError::AlreadyVoted as u32);
            }
        }

        // Increment vote count
        let current_votes = poll.votes.get(option_index).unwrap_or(0);
        poll.votes.set(option_index, current_votes + 1);

        // Record the voter
        poll.voters.push_back(voter);

        env.storage().instance().set(&symbol_short!("POLL"), &poll);

        // Emit event for vote
        env.events().publish((symbol_short!("poll"), symbol_short!("vote")), (voter, option_index));

        log!(&env, "Vote recorded successfully");
        poll
    }

    /// Retrieve the current poll data.
    pub fn get_poll(env: Env) -> Poll {
        env.storage()
            .instance()
            .get(&symbol_short!("POLL"))
            .unwrap_or_else(|| panic!("{}", PollError::NotInitialized as u32))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_init_poll() {
        let env = Env::default();
        let contract_id = env.register(LivePollContract, ());
        let client = LivePollContractClient::new(&env, &contract_id);

        let question = String::from_str(&env, "What is your favorite blockchain?");
        let options = Vec::from_array(
            &env,
            [
                String::from_str(&env, "Stellar"),
                String::from_str(&env, "Ethereum"),
                String::from_str(&env, "Solana"),
            ],
        );

        let poll = client.init_poll(&question, &options);
        assert_eq!(poll.question, question);
        assert_eq!(poll.options.len(), 3);
        assert_eq!(poll.votes.get(0).unwrap(), 0);
    }

    #[test]
    fn test_vote() {
        let env = Env::default();
        let contract_id = env.register(LivePollContract, ());
        let client = LivePollContractClient::new(&env, &contract_id);

        let question = String::from_str(&env, "Best network?");
        let options = Vec::from_array(
            &env,
            [
                String::from_str(&env, "Stellar"),
                String::from_str(&env, "Ethereum"),
            ],
        );
        client.init_poll(&question, &options);

        let voter = Address::generate(&env);
        env.mock_all_auths();

        let poll = client.vote(&voter, &0);
        assert_eq!(poll.votes.get(0).unwrap(), 1);
        assert_eq!(poll.voters.len(), 1);
    }

    #[test]
    #[should_panic]
    fn test_double_vote() {
        let env = Env::default();
        let contract_id = env.register(LivePollContract, ());
        let client = LivePollContractClient::new(&env, &contract_id);

        let question = String::from_str(&env, "Best?");
        let options = Vec::from_array(
            &env,
            [
                String::from_str(&env, "A"),
                String::from_str(&env, "B"),
            ],
        );
        client.init_poll(&question, &options);

        let voter = Address::generate(&env);
        env.mock_all_auths();

        client.vote(&voter, &0);
        client.vote(&voter, &1); // Should panic with AlreadyVoted
    }

    #[test]
    fn test_get_poll() {
        let env = Env::default();
        let contract_id = env.register(LivePollContract, ());
        let client = LivePollContractClient::new(&env, &contract_id);

        let question = String::from_str(&env, "Test?");
        let options = Vec::from_array(&env, [String::from_str(&env, "Yes")]);
        client.init_poll(&question, &options);

        let poll = client.get_poll();
        assert_eq!(poll.question, question);
    }
}
