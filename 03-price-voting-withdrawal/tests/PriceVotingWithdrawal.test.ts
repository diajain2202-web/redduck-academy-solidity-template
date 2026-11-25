import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;
const ONE_HOUR = 60 * 60;

describe("PriceVotingWithdrawal", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVotingWithdrawal", [token.address, votingEnd]);

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("voting", function () {
    it("records votes across single and multiple prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("40")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("40")],
      );

      await voting.write.vote([100n, parseEther("60")], { account: bob.account });
      await voting.write.vote([200n, parseEther("25")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("100"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("25"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), parseEther("40"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 200n]), parseEther("25"));
      assert.equal(await voting.read.totalLockedOf([alice.account.address]), parseEther("65"));
    });

    it("reverts on zero amount or at/after votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/,
      );
    });
  });

  describe("withdrawal", function () {
    it("allows partial and full mid-voting withdrawals and updates weights", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      const startBal = await token.read.balanceOf([alice.account.address]);

      await voting.write.vote([100n, parseEther("80")], { account: alice.account });

      await viem.assertions.emitWithArgs(
        voting.write.withdraw([100n, parseEther("30")], { account: alice.account }),
        voting,
        "Withdrawn",
        [getAddress(alice.account.address), 100n, parseEther("30")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), parseEther("50"));
      assert.equal(await voting.read.totalLockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await token.read.balanceOf([alice.account.address]), startBal - parseEther("50"));

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.totalLockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), startBal);
    });

    it("reverts when withdrawing zero or more than locked for a specific price", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("40")], { account: alice.account });

      await assert.rejects(
        voting.write.withdraw([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );

      await assert.rejects(
        voting.write.withdraw([100n, parseEther("50")], { account: alice.account }),
        /InsufficientLockedBalance/,
      );
    });

    it("lets a voter withdraw mid-voting and re-vote for a different price", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("90")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await voting.write.withdraw([100n, parseEther("90")], { account: alice.account });
      await voting.write.vote([200n, parseEther("90")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.proposeWinner([200n]);

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 200n);
    });

    it("allows withdrawing locked tokens after votingEnd without altering final election weights", async function () {
      const { token, voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      const aliceStart = await token.read.balanceOf([alice.account.address]);

      await voting.write.vote([100n, parseEther("80")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await voting.write.withdraw([100n, parseEther("80")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), aliceStart);

      await voting.write.proposeWinner([100n]);
      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });
  });

  describe("claim-and-challenge settlement & finalize", function () {
    it("sets the correct winning price after a pure sequence of votes with no withdrawals", async function () {
      const { voting, votingEnd, alice, bob, carol } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("70")], { account: bob.account });
      await voting.write.vote([100n, parseEther("50")], { account: carol.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.proposeWinner([100n], { account: alice.account }),
        voting,
        "WinnerProposed",
        [getAddress(alice.account.address), 100n, parseEther("90")],
      );

      assert.deepEqual(await voting.read.leader(), [100n, parseEther("90")]);

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [100n, parseEther("90")],
      );

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });

    it("allows challenging an inferior candidate and settles on the true winner after many distinct prices", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      for (let i = 1n; i <= 15n; i++) {
        await voting.write.vote([1000n + i, parseEther(String(i))], { account: alice.account });
      }

      // Price 1007 gets 27 ETH total, then Bob withdraws 15 ETH -> drops to 12 ETH, leaving 1015 (15 ETH) as winner
      await voting.write.vote([1007n, parseEther("20")], { account: bob.account });
      await voting.write.withdraw([1007n, parseEther("15")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);

      // Someone initially proposes runner-up 1007 (12 ETH), then Bob challenges with true winner 1015 (15 ETH)
      await voting.write.proposeWinner([1007n], { account: alice.account });
      await voting.write.proposeWinner([1015n], { account: bob.account });

      // Proposing an inferior price reverts
      await assert.rejects(
        voting.write.proposeWinner([1001n], { account: alice.account }),
        /CandidateNotBetter/,
      );

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 1015n);
    });

    it("updates the winning price when a withdrawal drops the former leader below a runner-up", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.proposeWinner([200n]);

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 200n);
    });

    it("keeps currentTokenPrice at 0 when two distinct prices tie for top weight", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await voting.write.proposeWinner([100n], { account: alice.account });
      await voting.write.proposeWinner([200n], { account: bob.account });

      assert.deepEqual(await voting.read.leader(), [0n, 0n]);

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("enforces timing rules on proposeWinner and finalize", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(voting.write.proposeWinner([100n]), /VotingActive/);
      await assert.rejects(voting.write.finalize(), /ChallengePeriodActive/);

      await networkHelpers.time.increaseTo(votingEnd);
      await assert.rejects(voting.write.finalize(), /ChallengePeriodActive/);

      await networkHelpers.time.increaseTo(votingEnd + BigInt(ONE_HOUR));
      await assert.rejects(voting.write.proposeWinner([100n]), /ChallengePeriodEnded/);

      await voting.write.finalize();
      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });
  });
});