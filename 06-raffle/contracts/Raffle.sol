// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

// Raffle — players deposit a volatile token; each deposit's USD value at entry
// time (from a Chainlink price feed) sets its win probability. After drawTime a
// Chainlink VRF draw picks a weighted winner, who claims the whole pot.
contract Raffle is VRFConsumerBaseV2Plus {
    struct Entry {
        address player;
        uint256 amount;
        uint256 cumulativeStart;
        uint256 cumulativeEnd;
    }

    IERC20 public immutable token; // deposit token
    AggregatorV3Interface public immutable priceFeed; // token/USD feed
    uint256 public immutable drawTime;

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32 public immutable callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public constant MAX_PRICE_AGE = 1 hours; // feed staleness bound

    Entry[] private _entries;
    uint256 public totalWeight;
    uint256 public totalPot;

    uint256 public requestId;
    uint256 public randomWord;
    bool public drawRequested;
    bool public fulfilled;
    bool public claimed;

    error ZeroAmount();
    error RaffleClosed();
    error RaffleOpen();
    error NoEntries();
    error DrawAlreadyRequested();
    error InvalidPrice();
    error StalePrice();
    error InvalidRequestId();
    error AlreadyFulfilled();
    error InvalidClaim();
    error TransferFailed();

    event Deposited(address indexed who, uint256 amount, uint256 weight);
    event DrawRequested(uint256 requestId);
    event WinnerPicked(address indexed winner);
    event Claimed(address indexed winner, uint256 amount);

    constructor(
        IERC20 _token,
        AggregatorV3Interface _priceFeed,
        uint256 _drawTime,
        address _coordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit
    ) VRFConsumerBaseV2Plus(_coordinator) {
        token = _token;
        priceFeed = _priceFeed;
        drawTime = _drawTime;
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
    }

    /// @notice Join the raffle by depositing tokens while it is open. The deposit's
    ///         weight is its USD value at the current feed price, fixed at entry.
    ///         Reject prices that are missing, non-positive, or stale.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= drawTime || drawRequested) revert RaffleClosed();

        (
            uint80 roundId,
            int256 price,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        if (price <= 0) revert InvalidPrice();
        if (
            updatedAt == 0 ||
            answeredInRound < roundId ||
            block.timestamp < updatedAt ||
            block.timestamp - updatedAt > MAX_PRICE_AGE
        ) {
            revert StalePrice();
        }

        uint256 weight = amount * uint256(price);
        uint256 start = totalWeight;
        uint256 end = start + weight;

        _entries.push(
            Entry({
                player: msg.sender,
                amount: amount,
                cumulativeStart: start,
                cumulativeEnd: end
            })
        );

        totalWeight = end;
        totalPot += amount;

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        emit Deposited(msg.sender, amount, weight);
    }

    /// @notice After drawTime, with at least one deposit, request a single random
    ///         word from VRF and track the returned request id. Only once.
    function drawWinner() external returns (uint256) {
        if (block.timestamp < drawTime) revert RaffleOpen();
        if (_entries.length == 0) revert NoEntries();
        if (drawRequested) revert DrawAlreadyRequested();

        drawRequested = true;

        uint256 reqId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        requestId = reqId;
        emit DrawRequested(reqId);

        return reqId;
    }

    /// @notice VRF callback. Confirm the request id matches and record the random
    ///         word — nothing more. No transfers, no loops, no settlement here.
    function fulfillRandomWords(uint256 _requestId, uint256[] calldata randomWords) internal override {
        if (_requestId != requestId) revert InvalidRequestId();
        if (fulfilled) revert AlreadyFulfilled();

        randomWord = randomWords[0];
        fulfilled = true;
    }

    /// @notice After the random word arrives, the winner claims the prize. The
    ///         caller supplies the index of the winning entry; verify it belongs
    ///         to msg.sender and is the winning entry, else revert InvalidClaim.
    function claim(uint256 entryIndex) external {
        if (!fulfilled || claimed || entryIndex >= _entries.length) {
            revert InvalidClaim();
        }

        Entry memory entry = _entries[entryIndex];
        if (entry.player != msg.sender) {
            revert InvalidClaim();
        }

        uint256 winningTicket = randomWord % totalWeight;
        if (winningTicket < entry.cumulativeStart || winningTicket >= entry.cumulativeEnd) {
            revert InvalidClaim();
        }

        claimed = true;
        uint256 prize = totalPot;

        emit WinnerPicked(msg.sender);
        emit Claimed(msg.sender, prize);

        bool ok = token.transfer(msg.sender, prize);
        if (!ok) revert TransferFailed();
    }

    // ----- read helpers -----

    function entriesCount() external view returns (uint256) {
        return _entries.length;
    }

    function getEntry(uint256 index)
        external
        view
        returns (
            address player,
            uint256 amount,
            uint256 cumulativeStart,
            uint256 cumulativeEnd
        )
    {
        Entry memory e = _entries[index];
        return (e.player, e.amount, e.cumulativeStart, e.cumulativeEnd);
    }
}