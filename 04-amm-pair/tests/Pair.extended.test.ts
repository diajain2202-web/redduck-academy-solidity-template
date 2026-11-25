import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem } = await network.connect();

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

describe("Pair — full specification", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    for (const w of [alice, bob]) {
      await tokenA.write.transfer([w.account.address, parseEther("100000")]);
      await tokenB.write.transfer([w.account.address, parseEther("100000")]);
    }

    for (const w of [deployer, alice, bob]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, deployer, alice, bob };
  }

  describe("getAmountOut", function () {
    it("reverts on zero amountIn or zero reserves", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(
        pair.read.getAmountOut([0n, parseEther("100"), parseEther("100")]),
        /InsufficientAmount/,
      );
      await assert.rejects(
        pair.read.getAmountOut([parseEther("10"), 0n, parseEther("100")]),
        /InsufficientLiquidity/,
      );
      await assert.rejects(
        pair.read.getAmountOut([parseEther("10"), parseEther("100"), 0n]),
        /InsufficientLiquidity/,
      );
    });

    it("computes exact 0.3% fee output formula", async function () {
      const { pair } = await deployFixture();

      const out = await pair.read.getAmountOut([1000n, 10000n, 10000n]);
      // (1000 * 997 * 10000) / (10000 * 1000 + 1000 * 997) = 9970000000 / 10997000 = 906
      assert.equal(out, 906n);
    });
  });

  describe("addLiquidity", function () {
    it("permanently locks MINIMUM_LIQUIDITY on first deposit and mints sqrt(x*y) - 1000", async function () {
      const { pair, deployer } = await deployFixture();

      const amount = parseEther("100");
      const expectedLiquidity = amount - 1000n;

      await viem.assertions.emitWithArgs(
        pair.write.addLiquidity([amount, amount]),
        pair,
        "LiquidityAdded",
        [getAddress(deployer.account.address), amount, amount, expectedLiquidity],
      );

      assert.equal(await pair.read.balanceOf([DEAD_ADDRESS]), 1000n);
      assert.equal(await pair.read.balanceOf([deployer.account.address]), expectedLiquidity);
      assert.equal(await pair.read.totalSupply(), amount);
      assert.equal(await pair.read.reserve0(), amount);
      assert.equal(await pair.read.reserve1(), amount);
    });

    it("reverts if initial deposit is too small to exceed MINIMUM_LIQUIDITY", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(
        pair.write.addLiquidity([1000n, 1000n]),
        /InsufficientLiquidity/,
      );
    });

    it("reverts when either deposit amount is 0", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(pair.write.addLiquidity([0n, parseEther("10")]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([parseEther("10"), 0n]), /InsufficientAmount/);
    });

    it("mints proportional LP tokens on subsequent deposits and uses the smaller side when out of ratio", async function () {
      const { pair, alice, bob } = await deployFixture();

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);

      // Balanced deposit of 50 & 50 -> mints 50e18 LP
      await pair.write.addLiquidity([parseEther("50"), parseEther("50")], { account: alice.account });
      assert.equal(await pair.read.balanceOf([alice.account.address]), parseEther("50"));

      // Pool now has 150 / 150 reserves and 150e18 totalSupply.
      // Bob deposits 30 of token0 and 60 of token1 (out of ratio): min side is 30 -> 30e18 LP.
      await pair.write.addLiquidity([parseEther("30"), parseEther("60")], { account: bob.account });
      assert.equal(await pair.read.balanceOf([bob.account.address]), parseEther("30"));
      assert.equal(await pair.read.reserve0(), parseEther("180"));
      assert.equal(await pair.read.reserve1(), parseEther("210"));
    });
  });

  describe("removeLiquidity", function () {
    it("burns LP tokens, returns proportional reserves, and emits LiquidityRemoved", async function () {
      const { pair, tokenA, tokenB, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);
      await pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account });

      const aliceLP = await pair.read.balanceOf([alice.account.address]);
      assert.equal(aliceLP, parseEther("100"));

      const tokenABefore = await tokenA.read.balanceOf([alice.account.address]);
      const tokenBBefore = await tokenB.read.balanceOf([alice.account.address]);

      await viem.assertions.emitWithArgs(
        pair.write.removeLiquidity([aliceLP], { account: alice.account }),
        pair,
        "LiquidityRemoved",
        [getAddress(alice.account.address), parseEther("100"), parseEther("100"), aliceLP],
      );

      assert.equal(await pair.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await tokenA.read.balanceOf([alice.account.address]), tokenABefore + parseEther("100"));
      assert.equal(await tokenB.read.balanceOf([alice.account.address]), tokenBBefore + parseEther("100"));
      assert.equal(await pair.read.reserve0(), parseEther("100"));
      assert.equal(await pair.read.reserve1(), parseEther("100"));
    });

    it("lets LPs withdraw accumulated swap fees when burning LP tokens", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], { account: alice.account });

      // Bob swaps back and forth to generate fees
      await pair.write.swap([tokenA.address, parseEther("200"), 0n], { account: bob.account });
      await pair.write.swap([tokenB.address, parseEther("200"), 0n], { account: bob.account });

      const aliceLP = await pair.read.balanceOf([alice.account.address]);
      const aBefore = await tokenA.read.balanceOf([alice.account.address]);
      const bBefore = await tokenB.read.balanceOf([alice.account.address]);

      await pair.write.removeLiquidity([aliceLP], { account: alice.account });

      const aAfter = await tokenA.read.balanceOf([alice.account.address]);
      const bAfter = await tokenB.read.balanceOf([alice.account.address]);

      assert.ok((aAfter - aBefore) + (bAfter - bBefore) > parseEther("2000"));
    });

    it("reverts when removing zero liquidity", async function () {
      const { pair, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account });

      await assert.rejects(
        pair.write.removeLiquidity([0n], { account: alice.account }),
        /InsufficientAmount/,
      );
    });
  });

  describe("swap", function () {
    it("supports swapping in both directions and emits Swapped", async function () {
      const { pair, tokenA, tokenB, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const amountIn = parseEther("50");
      const expectedOut = await pair.read.getAmountOut([
        amountIn,
        parseEther("1000"),
        parseEther("1000"),
      ]);

      await viem.assertions.emitWithArgs(
        pair.write.swap([tokenB.address, amountIn, expectedOut], { account: alice.account }),
        pair,
        "Swapped",
        [getAddress(alice.account.address), getAddress(tokenB.address), amountIn, expectedOut],
      );

      assert.equal(await pair.read.reserve1(), parseEther("1000") + amountIn);
      assert.equal(await pair.read.reserve0(), parseEther("1000") - expectedOut);
      assert.ok(tokenA.address);
    });

    it("reverts on invalid token address", async function () {
      const { pair, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      await assert.rejects(
        pair.write.swap([alice.account.address, parseEther("10"), 0n], { account: alice.account }),
        /InvalidToken/,
      );
    });

    it("reverts when output is below minAmountOut (slippage protection)", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const amountIn = parseEther("100");
      const expectedOut = await pair.read.getAmountOut([
        amountIn,
        parseEther("1000"),
        parseEther("1000"),
      ]);

      await assert.rejects(
        pair.write.swap([tokenA.address, amountIn, expectedOut + 1n], { account: alice.account }),
        /InsufficientOutput/,
      );
    });

    it("reverts on zero amountIn", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      await assert.rejects(
        pair.write.swap([tokenA.address, 0n, 0n], { account: alice.account }),
        /InsufficientAmount/,
      );
    });
  });
});