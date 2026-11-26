import { keccak256, encodePacked, concat, zeroHash, type Address, type Hex } from "viem";

export interface AirdropEntry {
  account: Address;
  amount: bigint;
}

// Double-hash (account, amount) so leaves cannot collide with 64-byte internal nodes.
export function hashLeaf(entry: AirdropEntry): Hex {
  const inner = keccak256(encodePacked(["address", "uint256"], [entry.account, entry.amount]));
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export class MerkleTree {
  layers: Hex[][];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      this.layers = [[zeroHash]];
      return;
    }

    const leaves = entries.map((entry) => hashLeaf(entry));
    this.layers = [leaves];

    let currentLayer = leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Hex[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          // Odd-layer convention: promote the unmatched trailing node directly to the next layer.
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  get root(): Hex {
    return this.layers[this.layers.length - 1][0];
  }

  // The sibling hashes from the leaf at `index` up to the root.
  getProof(index: number): Hex[] {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error(`Leaf index ${index} out of bounds`);
    }

    const proof: Hex[] = [];
    let idx = index;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }

      idx = Math.floor(idx / 2);
    }

    return proof;
  }
}