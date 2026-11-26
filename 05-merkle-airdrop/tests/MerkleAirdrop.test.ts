import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress, zeroHash } from "viem";
import { MerkleTree, type AirdropEntry } from "./merkle.ts";
import { signAirdropClaim } from "./signatures.ts";

const { viem } = await network.connect();

describe("MerkleAirdrop", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, signer, dave, eve] = await viem.getWalletClients();

    const entries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("100") },
      { account: getAddress(bob.account.address), amount: parseEther("200") },
      { account: getAddress(carol.account.address), amount: parseEther("300") },
      { account: getAddress(eve.account.address), amount: parseEther("50") },
    ];
    const tree = new MerkleTree(entries);

    const token = await viem.deployContract("Token", [
      "Redduck Token",
      "RDDK",
      parseEther("100000000000000"),
    ]);
    const airdrop = await viem.deployContract("MerkleAirdrop", [
      token.address,
      tree.root,
      signer.account.address,
    ]);

    await token.write.transfer([airdrop.address, parseEther("100000000000000")], {
      account: deployer.account,
    });

    return { entries, tree, token, airdrop, deployer, alice, bob, carol, signer, dave, eve };
  }

  describe("Merkle proof claim path", function () {
    it("lets an eligible account claim its allocation with a Merkle proof and emits Claimed", async function () {
      const { entries, tree, token, airdrop, alice } = await deployFixture();

      const proof = tree.getProof(0);
      const { account, amount } = entries[0];

      await viem.assertions.emitWithArgs(
        airdrop.write.claim([amount, proof], { account: alice.account }),
        airdrop,
        "Claimed",
        [account, amount],
      );

      assert.equal((await token.read.balanceOf([account])) as bigint, amount);
      assert.equal((await airdrop.read.hasClaimed([account])) as boolean, true);
    });

    it("supports odd-sized Merkle trees", async function () {
      const [deployer, alice, bob, carol, signer] = await viem.getWalletClients();

      const entries: AirdropEntry[] = [
        { account: getAddress(alice.account.address), amount: parseEther("10") },
        { account: getAddress(bob.account.address), amount: parseEther("20") },
        { account: getAddress(carol.account.address), amount: parseEther("30") },
      ];
      const tree = new MerkleTree(entries);

      const token = await viem.deployContract("Token", ["Redduck Token", "RDDK", parseEther("1000")]);
      const airdrop = await viem.deployContract("MerkleAirdrop", [
        token.address,
        tree.root,
        signer.account.address,
      ]);
      await token.write.transfer([airdrop.address, parseEther("1000")], {
        account: deployer.account,
      });

      const carolProof = tree.getProof(2);
      await airdrop.write.claim([entries[2].amount, carolProof], { account: carol.account });
      assert.equal(await token.read.balanceOf([carol.account.address]), parseEther("30"));
    });

    it("reverts with InvalidProof on wrong amount, wrong caller, or tampered proof", async function () {
      const { entries, tree, airdrop, alice, dave } = await deployFixture();

      const aliceProof = tree.getProof(0);
      const aliceAmount = entries[0].amount;

      await assert.rejects(
        airdrop.write.claim([aliceAmount + 1n, aliceProof], { account: alice.account }),
        /InvalidProof/,
      );

      await assert.rejects(
        airdrop.write.claim([aliceAmount, aliceProof], { account: dave.account }),
        /InvalidProof/,
      );

      const badProof = [...aliceProof];
      badProof[0] = zeroHash;
      await assert.rejects(
        airdrop.write.claim([aliceAmount, badProof], { account: alice.account }),
        /InvalidProof/,
      );
    });
  });

  describe("Signature claim path", function () {
    it("lets an authorized account claim with an admin signature and emits Claimed", async function () {
      const { token, airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(signer, airdrop.address, daveAddr, amount);

      await viem.assertions.emitWithArgs(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        airdrop,
        "Claimed",
        [daveAddr, amount],
      );

      assert.equal((await token.read.balanceOf([daveAddr])) as bigint, amount);
      assert.equal((await airdrop.read.hasClaimed([daveAddr])) as boolean, true);
    });

    it("reverts with InvalidSignature when signed by an untrusted wallet", async function () {
      const { airdrop, alice, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(alice, airdrop.address, daveAddr, amount);

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature when amount or recipient does not match the signature", async function () {
      const { airdrop, signer, dave, eve } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(signer, airdrop.address, daveAddr, amount);

      await assert.rejects(
        airdrop.write.claimWithSignature([amount + 1n, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: eve.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature when replaying a signature across a different deployment", async function () {
      const { tree, airdrop, deployer, signer, dave } = await deployFixture();

      const secondToken = await viem.deployContract("Token", [
        "Redduck Token",
        "RDDK",
        parseEther("1000"),
      ]);
      const secondAirdrop = await viem.deployContract("MerkleAirdrop", [
        secondToken.address,
        tree.root,
        signer.account.address,
      ]);
      await secondToken.write.transfer([secondAirdrop.address, parseEther("1000")], {
        account: deployer.account,
      });

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(signer, airdrop.address, daveAddr, amount);

      await assert.rejects(
        secondAirdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature on malformed signature parameters", async function () {
      const { airdrop, dave } = await deployFixture();

      await assert.rejects(
        airdrop.write.claimWithSignature([parseEther("50"), 0, zeroHash, zeroHash], {
          account: dave.account,
        }),
        /InvalidSignature/,
      );
    });
  });

  describe("Shared hasClaimed replay protection", function () {
    it("prevents double-claiming on the same path", async function () {
      const { entries, tree, airdrop, alice, signer, dave } = await deployFixture();

      const proof = tree.getProof(0);
      await airdrop.write.claim([entries[0].amount, proof], { account: alice.account });
      await assert.rejects(
        airdrop.write.claim([entries[0].amount, proof], { account: alice.account }),
        /AlreadyClaimed/,
      );

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      const { v, r, s } = await signAirdropClaim(signer, airdrop.address, daveAddr, amount);
      await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });
      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /AlreadyClaimed/,
      );
    });

    it("prevents claiming via signature after claiming via Merkle proof, and vice versa", async function () {
      const { entries, tree, airdrop, alice, bob, signer } = await deployFixture();

      const aliceAddr = entries[0].account;
      const aliceProof = tree.getProof(0);
      await airdrop.write.claim([entries[0].amount, aliceProof], { account: alice.account });

      const aliceSig = await signAirdropClaim(
        signer,
        airdrop.address,
        aliceAddr,
        entries[0].amount,
      );
      await assert.rejects(
        airdrop.write.claimWithSignature(
          [entries[0].amount, aliceSig.v, aliceSig.r, aliceSig.s],
          { account: alice.account },
        ),
        /AlreadyClaimed/,
      );

      const bobAddr = entries[1].account;
      const bobProof = tree.getProof(1);
      const bobSig = await signAirdropClaim(signer, airdrop.address, bobAddr, entries[1].amount);

      await airdrop.write.claimWithSignature(
        [entries[1].amount, bobSig.v, bobSig.r, bobSig.s],
        { account: bob.account },
      );
      await assert.rejects(
        airdrop.write.claim([entries[1].amount, bobProof], { account: bob.account }),
        /AlreadyClaimed/,
      );
    });
  });
});