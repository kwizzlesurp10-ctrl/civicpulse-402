import { getAddress, type Address } from 'viem';

/** Keith's Coinbase Base Account — canonical USDC payee on Base mainnet (eip155:8453). */
export const DEFAULT_X402_PAY_TO: Address = '0x0d25A44f74868eCE53B305C97139CF4B62963410';

/** Retired operator wallet; payments here may be unrecoverable — never advertise or accept. */
export const RETIRED_X402_PAY_TO: Address = '0xAB745e5F576667037696e78ba7dA28E193E4423D';

/**
 * Resolve the x402 payee from environment, with checksummed default.
 * Precedence: `X402_PAY_TO`, then `EXPECTED_PAY_TO`, then `NEXT_PUBLIC_PAY_TO_ADDRESS`.
 */
export function resolveX402PayTo(): Address {
  const fromEnv =
    process.env.X402_PAY_TO ||
    process.env.EXPECTED_PAY_TO ||
    process.env.NEXT_PUBLIC_PAY_TO_ADDRESS;
  const raw = fromEnv?.trim() || DEFAULT_X402_PAY_TO;
  return getAddress(raw);
}

export const EXPECTED_PAYEE: Address = resolveX402PayTo();

export function isRetiredPayee(address: string): boolean {
  try {
    return getAddress(address) === getAddress(RETIRED_X402_PAY_TO);
  } catch {
    return false;
  }
}
