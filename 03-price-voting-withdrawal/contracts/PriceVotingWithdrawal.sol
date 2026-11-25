// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * Required Call Order:
 * 1. Voting & Withdrawal Window (`block.timestamp < votingEnd`):
 *    - Voters approve this contract on `token` and call `vote(price, amount)`
 *      one or more times across any prices.
 *    - Voters may call `withdraw(price, amount)` at any time to reclaim part
 *      or all of their tokens locked on `price`. Withdrawals before `votingEnd`
 *      reduce that price's active vote weight; withdrawals at or after
 *      `votingEnd` return the voter's locked tokens without altering final weights.
 * 2. Settlement (`block.timestamp >= votingEnd`):
 *    - Anyone calls `finalize()` once to scan all proposed prices, determine
 *      the strict highest-weight winner (or keep `0` on a tie / zero votes),
 *      and emit `PriceFinalized`.
 * 3. Reading Result:
 *    - Call `finalized()` and `currentTokenPrice()` to read the settled price.
 *
 * Reflection:
 * 1. Chosen Implementation Strategy (Per-Price Voter Bookkeeping + Unique
 *    Candidate Array with Post-Voting Scan):
 *    - Instead of storing only a single aggregate `lockedOf[voter]`, this
 *      contract tracks `_lockedOf[voter][price]` (plus `_totalLockedOf[voter]`)
 *      so `withdraw(price, amount)` knows the exact price weight to decrement
 *      and prevents a voter from withdrawing tokens locked on Price A against
 *      Price B.
 *    - Rather than maintaining a running `leader` during voting, the contract
 *      records each unique proposed price once in `_proposedPrices` (guarded by
 *      `_isProposed[price]`) and scans `_proposedPrices` once inside `finalize()`
 *      after `votingEnd` to compute the true winner across final weights.
 *
 * 2. Why the Simpler Pattern from `02-price-voting` Breaks Here:
 *    - In `02-price-voting`, `_leaderPrice` and `_leaderWeight` were only updated
 *      upward (`if (newWeight > _leaderWeight)`). Once withdrawals are allowed,
 *      reducing the current leader's weight below a runner-up leaves `_leaderPrice`
 *      pointing to a stale loser—and conversely, withdrawing from a tied
 *      competitor can break a tie that incremental tracking cannot resolve
 *      without knowing the next-highest weight across an unbounded `uint256`
 *      price space.
 */
contract PriceVotingWithdrawal {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weightOf;
    mapping(address => mapping(uint256 => uint256)) private _lockedOf;
    mapping(address => uint256) private _totalLockedOf;

    uint256[] private _proposedPrices;
    mapping(uint256 => bool) private _isProposed;

    uint256 private _currentTokenPrice;
    bool private _finalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error InsufficientLockedBalance();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
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

        if (!_isProposed[price]) {
            _isProposed[price] = true;
            _proposedPrices.push(price);
        }

        _lockedOf[msg.sender][price] += amount;
        _totalLockedOf[msg.sender] += amount;
        _weightOf[price] += amount;

        emit Voted(msg.sender, price, amount);
    }

    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedOf[msg.sender][price];
        if (locked < amount) revert InsufficientLockedBalance();

        _lockedOf[msg.sender][price] = locked - amount;
        _totalLockedOf[msg.sender] -= amount;

        // Only withdrawals during the active voting period change vote weights.
        if (block.timestamp < _votingEnd) {
            _weightOf[price] -= amount;
        }

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < _votingEnd) revert VotingActive();
        if (_finalized) revert AlreadyFinalized();

        _finalized = true;

        uint256 bestPrice;
        uint256 bestWeight;
        bool tied;

        uint256 len = _proposedPrices.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 price = _proposedPrices[i];
            uint256 weight = _weightOf[price];

            if (weight > bestWeight) {
                bestPrice = price;
                bestWeight = weight;
                tied = false;
            } else if (weight == bestWeight && weight > 0) {
                tied = true;
            }
        }

        if (bestWeight > 0 && !tied) {
            _currentTokenPrice = bestPrice;
            emit PriceFinalized(bestPrice, bestWeight);
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

    function weightOf(uint256 price) external view returns (uint256) {
        return _weightOf[price];
    }

    function lockedOf(address voter, uint256 price) external view returns (uint256) {
        return _lockedOf[voter][price];
    }

    function totalLockedOf(address voter) external view returns (uint256) {
        return _totalLockedOf[voter];
    }

    function proposedPricesCount() external view returns (uint256) {
        return _proposedPrices.length;
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }
}