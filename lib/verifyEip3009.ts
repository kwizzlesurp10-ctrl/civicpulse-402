import {
  createPublicClient,
  http,
  verifyTypedData,
  isAddress,
  type Hex,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

export const BASE_USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EXPECTED_PAYEE: Address =
  (process.env.NEXT_PUBLIC_PAY_TO_ADDRESS as Address) ||
  '0xAB745e5F576667037696e78ba7dA28E193E4423D';

export const REQUIRED_AMOUNT_USDC_UNITS = 10_000n;

export const usdcDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: BASE_USDC_ADDRESS,
} as const;

export const eip3009Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
});

const usdcAbi = [
  {
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    name: 'authorizationState',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface EIP3009Payload {
  from: Address;
  to: Address;
  value: string;
  validAfter: number | string;
  validBefore: number | string;
  nonce: Hex;
  signature: Hex;
}

export async function verifyEIP3009Authorization(
  rawHeader: string,
  skipOnChainNonceCheck = false
): Promise<{
  valid: boolean;
  signer?: Address;
  error?: string;
}> {
  try {
    let payload: EIP3009Payload;

    if (rawHeader.startsWith('Bearer ') || rawHeader.startsWith('x402 ')) {
      const token = rawHeader.split(' ')[1];
      payload = JSON.parse(Buffer.from(token, 'base64').toString('utf-8')) as EIP3009Payload;
    } else {
      payload = JSON.parse(rawHeader) as EIP3009Payload;
    }

    const { from, to, value, validAfter, validBefore, nonce, signature } = payload;

    if (!isAddress(from) || !isAddress(to) || !signature || !nonce) {
      return { valid: false, error: 'Malformed EIP-3009 payload structure.' };
    }

    if (to.toLowerCase() !== EXPECTED_PAYEE.toLowerCase()) {
      return {
        valid: false,
        error: `Invalid payee: expected ${EXPECTED_PAYEE}, received ${to}`,
      };
    }

    const amountUnits = BigInt(value);
    if (amountUnits < REQUIRED_AMOUNT_USDC_UNITS) {
      return {
        valid: false,
        error: `Insufficient payment: required ${REQUIRED_AMOUNT_USDC_UNITS.toString()} units, got ${value}`,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfterNum = Number(validAfter);
    const validBeforeNum = Number(validBefore);

    if (now < validAfterNum) {
      return { valid: false, error: 'Authorization signature is not yet active.' };
    }
    if (now >= validBeforeNum) {
      return { valid: false, error: 'Authorization signature has expired.' };
    }

    if (!skipOnChainNonceCheck) {
      const isNonceUsed = await baseClient.readContract({
        address: BASE_USDC_ADDRESS,
        abi: usdcAbi,
        functionName: 'authorizationState',
        args: [from, nonce],
      });

      if (isNonceUsed) {
        return { valid: false, error: 'Authorization nonce has already been consumed on-chain.' };
      }
    }

    const isValidSignature = await verifyTypedData({
      address: from,
      domain: usdcDomain,
      types: eip3009Types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from,
        to,
        value: amountUnits,
        validAfter: BigInt(validAfterNum),
        validBefore: BigInt(validBeforeNum),
        nonce,
      },
      signature,
    });

    if (!isValidSignature) {
      return { valid: false, error: 'Cryptographic signature verification failed.' };
    }

    return { valid: true, signer: from };
  } catch (err: any) {
    return { valid: false, error: `Signature verification exception: ${err?.message}` };
  }
}
