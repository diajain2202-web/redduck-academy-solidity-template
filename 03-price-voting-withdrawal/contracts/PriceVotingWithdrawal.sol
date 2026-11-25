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
 *      reduce that price's active vote weight and update the max-heap;
 *      withdrawals at or after `votingEnd` return locked tokens without
 *      altering final weights.
 * 2. Settlement (`block.timestamp >= votingEnd`):
 *    - Anyone calls `finalize()` once to record the winning price in O(1)
 *      time and emit `PriceFinalized`.
 * 3. Reading Result:
 *    - Call `finalized()` and `currentTokenPrice()` to read the settled price.
 *
 * Tie-Breaking Rule:
 * - If two or more prices share the highest positive weight when `finalize()`
 *   is called (a tie), or if no positive-weight votes remain, there is no
 *   unique winner: `currentTokenPrice()` remains `0` and `PriceFinalized(0, 0)`
 *   is emitted.
 *
 * Reflection:
 * 1. Chosen Implementation Strategy (Per-Price Voter Bookkeeping + On-Chain
 *    Binary Max-Heap):
 *    - Tracking `_lockedOf[voter][price]` lets `withdraw(price, amount)` know
 *      the exact price weight to decrement and prevents a voter from
 *      withdrawing tokens locked on one price against another price.
 *    - Maintaining a binary max-heap (`_heap` with 1-based `_heapIndex`) keeps
 *      the highest-weight price at `_heap[0]` in O(log N) per `vote` (`_siftUp`)
 *      and O(log N) per `withdraw` (`_siftDown`), avoiding any O(N) linear scan
 *      over voter-controlled prices in `finalize()`.
 *    - In a binary max-heap, the second-largest weight is guaranteed to be at
 *      `_heap[1]` or `_heap[2]`, allowing `finalize()` and `leader()` to verify
 *      whether `_heap[0]` is a strict winner or tied in strict O(1) time.
 *
 * 2. Why the Simpler Pattern from `02-price-voting` Breaks Here:
 *    - In `02-price-voting`, `_leaderPrice` and `_leaderWeight` only updated
 *      upward (`if (newWeight > _leaderWeight)`). With withdrawals, reducing
 *      the leader's weight below a runner-up leaves `_leaderPrice` pointing to
 *      a stale loser, and withdrawing from a tied competitor breaks a tie that
 *      monotonic tracking cannot resolve across an unbounded `uint256` space.
 */
contract PriceVotingWithdrawal {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weightOf;
    mapping(address => mapping(uint256 => uint256)) private _lockedOf;
    mapping(address => uint256) private _totalLockedOf;

    // Max-heap of proposed prices ordered by `_weightOf[price]`.
    // `_heapIndex[price]` stores the 1-based index into `_heap` (0 = absent).
    uint256[] private _heap;
    mapping(uint256 => uint256) private _heapIndex;

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

        _lockedOf[msg.sender][price] += amount;
        _totalLockedOf[msg.sender] += amount;
        _weightOf[price] += amount;

        uint256 idx = _heapIndex[price];
        if (idx == 0) {
            _heap.push(price);
            idx = _heap.length;
            _heapIndex[price] = idx;
        }
        _siftUp(idx - 1);

        emit Voted(msg.sender, price, amount);
    }

    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedOf[msg.sender][price];
        if (locked < amount) revert InsufficientLockedBalance();

        // Effects before external interaction (Checks-Effects-Interactions)
        _lockedOf[msg.sender][price] = locked - amount;
        _totalLockedOf[msg.sender] -= amount;

        if (block.timestamp < _votingEnd) {
            _weightOf[price] -= amount;
            uint256 idx = _heapIndex[price];
            if (idx > 0) {
                _siftDown(idx - 1);
            }
        }

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < _votingEnd) revert VotingActive();
        if (_finalized) revert AlreadyFinalized();

        _finalized = true;

        (uint256 bestPrice, uint256 bestWeight, bool tied) = _computeLeader();

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

    function leader() external view returns (uint256 price, uint256 weight) {
        (price, weight, ) = _computeLeader();
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }

    // ----- internal helpers -----

    function _computeLeader() internal view returns (uint256 bestPrice, uint256 bestWeight, bool tied) {
        uint256 len = _heap.length;
        if (len == 0) {
            return (0, 0, false);
        }

        bestPrice = _heap[0];
        bestWeight = _weightOf[bestPrice];

        if (bestWeight == 0) {
            return (0, 0, false);
        }

        if (len > 1) {
            uint256 runnerUpWeight = _weightOf[_heap[1]];
            if (len > 2) {
                uint256 rightWeight = _weightOf[_heap[2]];
                if (rightWeight > runnerUpWeight) {
                    runnerUpWeight = rightWeight;
                }
            }
            if (runnerUpWeight == bestWeight) {
                return (0, bestWeight, true);
            }
        }

        return (bestPrice, bestWeight, false);
    }

    function _siftUp(uint256 pos) internal {
        uint256 price = _heap[pos];
        uint256 weight = _weightOf[price];

        while (pos > 0) {
            uint256 parentPos = (pos - 1) / 2;
            uint256 parentPrice = _heap[parentPos];
            if (weight <= _weightOf[parentPrice]) {
                break;
            }
            _heap[pos] = parentPrice;
            _heapIndex[parentPrice] = pos + 1;
            pos = parentPos;
        }

        _heap[pos] = price;
        _heapIndex[price] = pos + 1;
    }

    function _siftDown(uint256 pos) internal {
        uint256 len = _heap.length;
        uint256 price = _heap[pos];
        uint256 weight = _weightOf[price];

        while (true) {
            uint256 left = 2 * pos + 1;
            if (left >= len) break;

            uint256 largestChild = left;
            uint256 largestWeight = _weightOf[_heap[left]];

            uint256 right = left + 1;
            if (right < len) {
                uint256 rightWeight = _weightOf[_heap[right]];
                if (rightWeight > largestWeight) {
                    largestChild = right;
                    largestWeight = rightWeight;
                }
            }

            if (weight >= largestWeight) {
                break;
            }

            uint256 childPrice = _heap[largestChild];
            _heap[pos] = childPrice;
            _heapIndex[childPrice] = pos + 1;
            pos = largestChild;
        }

        _heap[pos] = price;
        _heapIndex[price] = pos + 1;
    }
}
