// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * Required Call Order (Claim-and-Challenge Settlement):
 * 1. Voting & Withdrawal Window (`block.timestamp < votingEnd`):
 *    - Voters approve this contract on `token` and call `vote(price, amount)`
 *      one or more times across any prices.
 *    - Voters may call `withdraw(price, amount)` at any time to reclaim part
 *      or all of their tokens locked on `price`. Withdrawals before `votingEnd`
 *      reduce `_weightOf[price]`; withdrawals at or after `votingEnd` return
 *      locked tokens without altering final weights.
 * 2. Claim-and-Challenge Window (`votingEnd <= block.timestamp < votingEnd + CHALLENGE_PERIOD`):
 *    - Anyone calls `proposeWinner(price)` to claim the highest-weight price
 *      computed off-chain.
 *    - If a higher-weight price exists (or a distinct price ties the current
 *      candidate's weight), anyone can challenge by calling `proposeWinner(otherPrice)`
 *      before `challengeEnd()` (`votingEnd + CHALLENGE_PERIOD`).
 * 3. Finalization (`block.timestamp >= votingEnd + CHALLENGE_PERIOD`):
 *    - Anyone calls `finalize()` once to lock in `currentTokenPrice()` in O(1)
 *      time and emit `PriceFinalized`.
 * 4. Reading Result:
 *    - Call `finalized()` and `currentTokenPrice()` to read the settled price.
 *
 * Tie-Breaking Rule:
 * - If two or more distinct prices share the highest positive weight when the
 *   challenge window closes (`_candidateTied == true`), or if no positive-weight
 *   candidate was proposed, there is no unique winner: `currentTokenPrice()`
 *   remains `0` and `PriceFinalized(0, 0)` is emitted.
 *
 * Reflection:
 * 1. Chosen Implementation Strategy (O(1) Mapping Bookkeeping + Optimistic
 *    Claim-and-Challenge Settlement):
 *    - Tracking `_lockedOf[voter][price]` lets `withdraw(price, amount)` decrement
 *      the exact price weight in O(1) and prevents withdrawing tokens locked on
 *      one price against another.
 *    - Using a post-voting `proposeWinner(price)` claim-and-challenge step followed
 *      by `finalize()` completely eliminates all loops over voter-controlled
 *      prices: every state-changing function (`vote`, `withdraw`, `proposeWinner`,
 *      `finalize`) executes in strict O(1) gas regardless of how many distinct
 *      prices voters propose.
 *
 * 2. Why the Simpler Pattern from `02-price-voting` Breaks Here:
 *    - In `02-price-voting`, `_leaderPrice` and `_leaderWeight` only updated
 *      monotonically upward during `vote()`. Once mid-voting withdrawals are
 *      permitted, reducing the leader's weight below a runner-up leaves
 *      `_leaderPrice` pointing to a stale loser, and withdrawing from a tied
 *      competitor resolves a tie that monotonic tracking cannot detect over an
 *      unbounded `uint256` price space.
 */
contract PriceVotingWithdrawal {
    uint256 public constant CHALLENGE_PERIOD = 1 hours;

    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weightOf;
    mapping(address => mapping(uint256 => uint256)) private _lockedOf;
    mapping(address => uint256) private _totalLockedOf;

    uint256 private _candidatePrice;
    uint256 private _candidateWeight;
    bool private _hasCandidate;
    bool private _candidateTied;

    uint256 private _currentTokenPrice;
    bool private _finalized;

    error VotingEnded();
    error VotingActive();
    error ChallengePeriodEnded();
    error ChallengePeriodActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error ZeroWeightPrice();
    error CandidateNotBetter();
    error InsufficientLockedBalance();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
    event WinnerProposed(address indexed proposer, uint256 indexed price, uint256 weight);
    event PriceFinalized(uint256 indexed price, uint256 weight);

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // ----- write -----

    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= _votingEnd) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        bool ok = _token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        _lockedOf[msg.sender][price] += amount;
        _totalLockedOf[msg.sender] += amount;
        _weightOf[price] += amount;

        emit Voted(msg.sender, price, amount);
    }

    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedOf[msg.sender][price];
        if (locked < amount) revert InsufficientLockedBalance();

        // Checks-Effects-Interactions: update all state before external token transfer
        _lockedOf[msg.sender][price] = locked - amount;
        _totalLockedOf[msg.sender] -= amount;

        if (block.timestamp < _votingEnd) {
            _weightOf[price] -= amount;
        }

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, price, amount);
    }

    function proposeWinner(uint256 price) external {
        if (block.timestamp < _votingEnd) revert VotingActive();
        if (block.timestamp >= _votingEnd + CHALLENGE_PERIOD) revert ChallengePeriodEnded();

        uint256 weight = _weightOf[price];
        if (weight == 0) revert ZeroWeightPrice();

        if (!_hasCandidate || weight > _candidateWeight) {
            _candidatePrice = price;
            _candidateWeight = weight;
            _hasCandidate = true;
            _candidateTied = false;
        } else if (weight == _candidateWeight && price != _candidatePrice && !_candidateTied) {
            _candidateTied = true;
        } else {
            revert CandidateNotBetter();
        }

        emit WinnerProposed(msg.sender, price, weight);
    }

    function finalize() external {
        if (block.timestamp < _votingEnd + CHALLENGE_PERIOD) revert ChallengePeriodActive();
        if (_finalized) revert AlreadyFinalized();

        _finalized = true;

        if (_hasCandidate && _candidateWeight > 0 && !_candidateTied) {
            _currentTokenPrice = _candidatePrice;
            emit PriceFinalized(_candidatePrice, _candidateWeight);
        } else {
            emit PriceFinalized(0, 0);
        }
    }

    // ----- read -----

    function token() external view returns (IERC20) {
        return _token;
    }

    function votingEnd() external view returns (uint256) {
        return _votingEnd;
    }

    function challengeEnd() external view returns (uint256) {
        return _votingEnd + CHALLENGE_PERIOD;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return _weightOf[price];
    }

    function lockedOf(address voter, uint256 price) external view returns (uint256) {
        return _lockedOf[voter][price];
    }

    function totalLockedOf(address voter) external view returns (uint256) {
        return _totalLockedOf[voter];
    }

    function leader() external view returns (uint256 price, uint256 weight) {
        if (!_hasCandidate || _candidateTied) {
            return (0, 0);
        }
        return (_candidatePrice, _candidateWeight);
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }
}