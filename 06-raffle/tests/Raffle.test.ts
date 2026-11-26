import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const KEY_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLBACK_GAS = 500_000;

describe("Raffle", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const btc = await viem.deployContract("Token", ["Bitcoin", "BTC", parseEther("1000000")]);
    const feed = await viem.deployContract("PriceFeedMock", [8, 60_000n * 10n ** 8n]);

    const coord = await viem.deployContract("VRFCoordinatorMock", [10n ** 17n, 10n ** 9n, 10n ** 15n]);

    await coord.write.createSubscription();
    const [created] = await coord.getEvents.SubscriptionCreated({}, { fromBlock: 0n });
    const subId = created.args.subId as bigint;
    await coord.write.fundSubscription([subId, parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const drawTime = BigInt(now + 600);

    const raffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      drawTime,
      coord.address,
      subId,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await coord.write.addConsumer([subId, raffle.address]);

    for (const w of [alice, bob, carol]) {
      await btc.write.transfer([w.account.address, parseEther("100")]);
      await btc.write.approve([raffle.address, parseEther("100")], { account: w.account });
    }

    return { btc, feed, coord, raffle, subId, drawTime, deployer, alice, bob, carol };
  }

  it("runs the full raffle: deposit, draw, weighted winner, claim", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    // Entry 0: alice (weight 1 BTC). Entry 1: bob (weight 3 BTC).
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();

    const requestId = (await raffle.read.requestId()) as bigint;
    const totalWeight = (await raffle.read.totalWeight()) as bigint;

    // A random word at the top of the range lands in bob's entry (index 1).
    await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [totalWeight - 1n]]);

    const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
    await raffle.write.claim([1n], { account: bob.account });
    const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

    assert.equal(after - before, parseEther("4"));
  });

  describe("USD weighting at entry time", function () {
    it("locks each deposit's USD weight at entry time even if the token price changes later", async function () {
      const { btc, feed, coord, raffle, drawTime, alice, bob } = await deployFixture();

      // Alice deposits 1 BTC when BTC = $60,000 -> USD weight = 1e18 * 60000e8
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      const [, , aliceStart, aliceEnd] = await raffle.read.getEntry([0n]);
      const aliceWeight = aliceEnd - aliceStart;
      assert.equal(aliceWeight, parseEther("1") * 60_000n * 10n ** 8n);

      // Price drops to $20,000; Bob deposits 3 BTC -> USD weight = 3e18 * 20000e8 (equal to Alice's weight)
      await feed.write.updateAnswer([20_000n * 10n ** 8n]);
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , bobStart, bobEnd] = await raffle.read.getEntry([1n]);
      const bobWeight = bobEnd - bobStart;
      assert.equal(bobWeight, aliceWeight);
      assert.equal(await raffle.read.totalWeight(), aliceWeight * 2n);

      // Ticket right below aliceEnd picks Alice, who wins the full 4 BTC pot
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = await raffle.read.requestId();

      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [aliceEnd - 1n],
      ]);

      const aliceBefore = await btc.read.balanceOf([alice.account.address]);
      await viem.assertions.emitWithArgs(
        raffle.write.claim([0n], { account: alice.account }),
        raffle,
        "Claimed",
        [getAddress(alice.account.address), parseEther("4")],
      );
      const aliceAfter = await btc.read.balanceOf([alice.account.address]);
      assert.equal(aliceAfter - aliceBefore, parseEther("4"));
    });
  });

  describe("weighted-pick boundary edges", function () {
    it("picks entry 0 at randomWord = 0 and at the upper boundary (entry0End - 1)", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , , entry0End] = await raffle.read.getEntry([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = await raffle.read.requestId();

      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [entry0End - 1n],
      ]);

      // Bob cannot claim entry 0 or entry 1
      await assert.rejects(
        raffle.write.claim([0n], { account: bob.account }),
        /InvalidClaim/,
      );
      await assert.rejects(
        raffle.write.claim([1n], { account: bob.account }),
        /InvalidClaim/,
      );

      // Alice claims entry 0
      await raffle.write.claim([0n], { account: alice.account });
      assert.equal(await raffle.read.claimed(), true);
    });

    it("transitions cleanly to entry 1 at the exact boundary randomWord = entry0End", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , , entry0End] = await raffle.read.getEntry([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = await raffle.read.requestId();

      // Exact boundary ticket = entry0End belongs to entry 1 (Bob)
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [entry0End]]);

      await assert.rejects(
        raffle.write.claim([0n], { account: alice.account }),
        /InvalidClaim/,
      );
      await raffle.write.claim([1n], { account: bob.account });
      assert.equal(await raffle.read.claimed(), true);
    });

    it("wraps randomWord modulo totalWeight and enforces per-entry ownership", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      // Entry 0: Alice (1 BTC), Entry 1: Bob (2 BTC), Entry 2: Alice (1 BTC)
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("2")], { account: bob.account });
      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      const totalWeight = await raffle.read.totalWeight();
      const [, , entry2Start] = await raffle.read.getEntry([2n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = await raffle.read.requestId();

      // randomWord = totalWeight + entry2Start -> modulo totalWeight lands in entry 2
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [totalWeight + entry2Start],
      ]);

      // Alice cannot claim using her earlier entry 0; she must supply winning entry 2
      await assert.rejects(
        raffle.write.claim([0n], { account: alice.account }),
        /InvalidClaim/,
      );
      await raffle.write.claim([2n], { account: alice.account });
      assert.equal(await raffle.read.claimed(), true);
    });
  });

  describe("deposit failure modes", function () {
    it("reverts on zero deposit amount or after drawTime", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await assert.rejects(
        raffle.write.deposit([0n], { account: alice.account }),
        /ZeroAmount/,
      );

      await networkHelpers.time.increaseTo(drawTime);

      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /RaffleClosed/,
      );
    });

    it("reverts when the price feed returns zero, negative, or stale prices", async function () {
      const { feed, raffle, alice } = await deployFixture();

      // Zero price
      await feed.write.updateAnswer([0n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );

      // Negative price
      await feed.write.updateAnswer([-100n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );

      // Stale price (> MAX_PRICE_AGE = 1 hour)
      const now = await networkHelpers.time.latest();
      await feed.write.updateRoundData([10n, 60_000n * 10n ** 8n, BigInt(now - 3601), BigInt(now - 3601)]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /StalePrice/,
      );

      // Missing timestamp (updatedAt == 0)
      await feed.write.updateRoundData([11n, 60_000n * 10n ** 8n, 0n, 0n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /StalePrice/,
      );
    });
  });

  describe("drawWinner and claim failure modes", function () {
    it("reverts drawWinner before drawTime, with no entries, or when called twice", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      // Before drawTime
      await assert.rejects(raffle.write.drawWinner(), /RaffleOpen/);

      // At drawTime with zero entries
      await networkHelpers.time.increaseTo(drawTime);
      await assert.rejects(raffle.write.drawWinner(), /NoEntries/);
    });

    it("reverts drawWinner on a second call after a draw is already requested", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);

      await raffle.write.drawWinner();
      await assert.rejects(raffle.write.drawWinner(), /DrawAlreadyRequested/);
    });

    it("reverts claim before VRF fulfillment, on out-of-bounds index, or on double claim", async function () {
      const { coord, raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();

      // Before fulfillRandomWords
      await assert.rejects(
        raffle.write.claim([0n], { account: alice.account }),
        /InvalidClaim/,
      );

      const requestId = await raffle.read.requestId();
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [0n]]);

      // Out-of-bounds index
      await assert.rejects(
        raffle.write.claim([99n], { account: alice.account }),
        /InvalidClaim/,
      );

      // First valid claim succeeds
      await raffle.write.claim([0n], { account: alice.account });

      // Second claim reverts
      await assert.rejects(
        raffle.write.claim([0n], { account: alice.account }),
        /InvalidClaim/,
      );
    });
  });
});