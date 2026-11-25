import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

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

      await voting.write.finalize();
      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });
  });

  describe("leader resolution & finalize", function () {
    it("sets the correct winning price after a pure sequence of votes with no withdrawals", async function () {
      const { voting, votingEnd, alice, bob, carol } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("70")], { account: bob.account });
      await voting.write.vote([100n, parseEther("50")], { account: carol.account });

      assert.deepEqual(await voting.read.leader(), [100n, parseEther("90")]);

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [100n, parseEther("90")],
      );

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });

    it("finds the true winner across many distinct prices and multiple withdrawals", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      // Propose 15 distinct prices
      for (let i = 1n; i <= 15n; i++) {
        await voting.write.vote([i * 10n, parseEther(String(i))], { account: alice.account });
      }

      // Price 150 currently leads with 15 ETH; Bob backs price 70 with 20 ETH
      await voting.write.vote([70n, parseEther("20")], { account: bob.account });
      assert.deepEqual(await voting.read.leader(), [70n, parseEther("27")]);

      // Bob withdraws 15 ETH from price 70 (dropping it to 12 ETH), so price 150 (15 ETH) wins
      await voting.write.withdraw([70n, parseEther("15")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 150n);
    });

    it("updates the winning price when a withdrawal drops the former leader below a runner-up", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [200n, parseEther("60")],
      );

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
    });

    it("resolves a former tie when one side withdraws during voting", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await voting.write.withdraw([200n, parseEther("10")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });

    it("keeps currentTokenPrice at 0 when a withdrawal creates a tie or removes all votes", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("70")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await voting.write.withdraw([100n, parseEther("20")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("reverts if finalize is called before votingEnd or more than once", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(voting.write.finalize(), /VotingActive/);

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });
  });
});