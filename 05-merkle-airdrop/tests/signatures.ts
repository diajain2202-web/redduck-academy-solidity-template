import { keccak256, encodePacked, type WalletClient, type Address } from "viem";

export interface ClaimSignatureParts {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export async function signAirdropClaim(
  signerWallet: WalletClient,
  airdropAddress: Address,
  claimant: Address,
  amount: bigint,
): Promise<ClaimSignatureParts> {
  if (!signerWallet.account) {
    throw new Error("Signer wallet has no attached account");
  }

  const messageHash = keccak256(
    encodePacked(["address", "address", "uint256"], [airdropAddress, claimant, amount]),
  );

  const signature = await signerWallet.signMessage({
    account: signerWallet.account,
    message: { raw: messageHash },
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  let v = parseInt(signature.slice(130, 132), 16);
  if (v < 27) {
    v += 27;
  }

  return { v, r, s };
}