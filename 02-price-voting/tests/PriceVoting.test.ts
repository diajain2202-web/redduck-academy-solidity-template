import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [token.address, votingEnd]);

    // give voters some tokens and approve the voting contract
    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("vote", function () {
    it("records a single vote and sets the leading price and weight", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.deepEqual(await voting.read.leader(), [100n, parseEther("50")]);
    });

    it("emits Voted", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );
    });

    it("stacks weight when two voters vote for the same price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([100n, parseEther("60")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("100"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("40"));
      assert.equal(await voting.read.lockedOf([bob.account.address]), parseEther("60"));
      assert.deepEqual(await voting.read.leader(), [100n, parseEther("100")]);
    });

    it("selects the price with higher total weight when voters vote for different prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("80")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("80"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("50"));
      assert.deepEqual(await voting.read.leader(), [100n, parseEther("80")]);
    });

    it("grows lockedOf and updates each price weight when a single voter votes twice for different prices", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("30")], { account: alice.account });
      await voting.write.vote([250n, parseEther("45")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("75"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("30"));
      assert.equal(await voting.read.weightOf([250n]), parseEther("45"));
      assert.deepEqual(await voting.read.leader(), [250n, parseEther("45")]);
    });

    it("updates the leading price when a new vote pushes a different price above the current leader", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      assert.deepEqual(await voting.read.leader(), [100n, parseEther("50")]);

      await voting.write.vote([200n, parseEther("75")], { account: bob.account });
      assert.deepEqual(await voting.read.leader(), [200n, parseEther("75")]);
    });

    it("does NOT update the leading price on a tie", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      assert.deepEqual(await voting.read.leader(), [100n, parseEther("50")]);
    });

    it("reverts when called after votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/,
      );
    });

    it("reverts when called with amount == 0", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );
    });

    it("reverts when the voter has not approved enough tokens", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await token.write.approve([voting.address, parseEther("10")], { account: alice.account });

      await assert.rejects(
        voting.write.vote([100n, parseEther("20")], { account: alice.account }),
      );
    });
  });

  describe("finalize", function () {
    it("reverts when called before votingEnd", async function () {
      const { voting } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(voting.write.finalize(), /VotingActive/);
    });

    it("reverts when called twice", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });

    it("sets currentTokenPrice and finalized and emits PriceFinalized", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([150n, parseEther("60")], { account: alice.account });
      await voting.write.vote([200n, parseEther("40")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [150n, parseEther("60")],
      );

      assert.equal(await voting.read.currentTokenPrice(), 150n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("succeeds with no votes and keeps currentTokenPrice at 0", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("succeeds on a tie and keeps currentTokenPrice at 0", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });
  });

  describe("claim", function () {
    it("reverts when called before votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /VotingActive/,
      );
    });

    it("reverts when the caller has nothing locked", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /NothingToClaim/,
      );
    });

    it("returns the full locked amount and zeros out lockedOf", async function () {
      const { token, voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      const initialBalance = await token.read.balanceOf([alice.account.address]);

      await voting.write.vote([100n, parseEther("30")], { account: alice.account });
      await voting.write.vote([200n, parseEther("20")], { account: alice.account });

      assert.equal(
        await token.read.balanceOf([alice.account.address]),
        initialBalance - parseEther("50"),
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), parseEther("50")],
      );

      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), initialBalance);
    });

    it("prevents a voter from claiming twice", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.claim({ account: alice.account });

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /NothingToClaim/,
      );
    });
  });
});