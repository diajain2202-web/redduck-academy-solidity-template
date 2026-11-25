import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem } = await network.connect();

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

describe("Pair (pull-based AMM)", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    await tokenA.write.transfer([alice.account.address, parseEther("100000")]);
    await tokenB.write.transfer([alice.account.address, parseEther("100000")]);
    await tokenA.write.transfer([bob.account.address, parseEther("100000")]);
    await tokenB.write.transfer([bob.account.address, parseEther("100000")]);

    for (const w of [deployer, alice, bob]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, deployer, alice, bob };
  }

  it("a swap charges the 0.3% fee, moves the price, and does not let k decrease", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const r0Before = (await pair.read.reserve0()) as bigint;
    const r1Before = (await pair.read.reserve1()) as bigint;
    const kBefore = r0Before * r1Before;

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([amountIn, r0Before, r1Before])) as bigint;

    await pair.write.swap([tokenA.address, amountIn, 0n], { account: alice.account });

    const r0After = (await pair.read.reserve0()) as bigint;
    const r1After = (await pair.read.reserve1()) as bigint;

    assert.equal(r0After, r0Before + amountIn);
    assert.equal(r1After, r1Before - expectedOut);
    assert.ok(
      expectedOut > parseEther("90") && expectedOut < parseEther("91"),
      `got ${expectedOut}`,
    );
    assert.ok(r0After * r1After > kBefore, "k must not decrease across a swap");
  });

  describe("getAmountOut", function () {
    it("reverts on zero input or empty reserves", async function () {
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

    it("computes the exact 0.3% fee constant-product output", async function () {
      const { pair } = await deployFixture();

      const out = await pair.read.getAmountOut([1000n, 10000n, 10000n]);
      assert.equal(out, 906n);
    });
  });

  describe("addLiquidity & first-depositor lock", function () {
    it("permanently locks MINIMUM_LIQUIDITY on the first deposit and mints sqrt(x*y) - 1000", async function () {
      const { pair, tokenA, tokenB, deployer } = await deployFixture();

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
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));
    });

    it("mints proportional LP on balanced and imbalanced subsequent deposits", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await deployFixture();

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);

      // Balanced deposit by Alice
      await pair.write.addLiquidity([parseEther("50"), parseEther("50")], { account: alice.account });
      assert.equal(await pair.read.balanceOf([alice.account.address]), parseEther("50"));

      // Imbalanced deposit by Bob (30 of A, 60 of B -> smaller ratio is 30 -> 30e18 LP)
      await pair.write.addLiquidity([parseEther("30"), parseEther("60")], { account: bob.account });
      assert.equal(await pair.read.balanceOf([bob.account.address]), parseEther("30"));
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));
    });

    it("reverts on zero amounts or zero resulting liquidity", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(pair.write.addLiquidity([0n, parseEther("10")]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([parseEther("10"), 0n]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([1000n, 1000n]), /InsufficientLiquidity/);
    });
  });

  describe("removeLiquidity", function () {
    it("burns LP tokens, returns pro-rata reserves, and syncs balances", async function () {
      const { pair, tokenA, tokenB, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);
      await pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account });

      const aliceLP = await pair.read.balanceOf([alice.account.address]);
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
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));
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

  describe("swap directions, slippage, and validation", function () {
    it("swaps in the reverse tokenB-to-tokenA direction and syncs reserves", async function () {
      const { pair, tokenA, tokenB, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const r0Before = await pair.read.reserve0();
      const r1Before = await pair.read.reserve1();
      const amountIn = parseEther("50");
      const expectedOut = await pair.read.getAmountOut([amountIn, r1Before, r0Before]);

      await viem.assertions.emitWithArgs(
        pair.write.swap([tokenB.address, amountIn, expectedOut], { account: alice.account }),
        pair,
        "Swapped",
        [getAddress(alice.account.address), getAddress(tokenB.address), amountIn, expectedOut],
      );

      assert.equal(await pair.read.reserve0(), r0Before - expectedOut);
      assert.equal(await pair.read.reserve1(), r1Before + amountIn);
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));
    });

    it("reverts on invalid tokenIn and slippage violation", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      await assert.rejects(
        pair.write.swap([alice.account.address, parseEther("10"), 0n], { account: alice.account }),
        /InvalidToken/,
      );

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
  });
});