import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

export const BASE_USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EXPECTED_PAYEE: Address =
  (process.env.NEXT_PUBLIC_PAY_TO_ADDRESS as Address) ||
  '0xAB745e5F576667037696e78ba7dA28E193E4423D';

const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

export const publicClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

export const USDC_EIP3009_ABI = [
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
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'transferWithAuthorization',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'receiveWithAuthorization',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export interface SettlementInput {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  method?: 'transferWithAuthorization' | 'receiveWithAuthorization';
}

export interface SettlementReceipt {
  txHash: Hex;
  blockNumber: bigint;
  payer: Address;
  recipient: Address;
  amountUnits: string;
  method: string;
}

export async function settleEIP3009OnChain(
  input: SettlementInput
): Promise<SettlementReceipt> {
  const relayerKey = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!relayerKey || !relayerKey.startsWith('0x')) {
    throw new Error('Missing RELAYER_PRIVATE_KEY environment variable.');
  }

  const relayerAccount = privateKeyToAccount(relayerKey);
  const walletClient = createWalletClient({
    account: relayerAccount,
    chain: base,
    transport: http(rpcUrl),
  });

  const payerBalance = await publicClient.readContract({
    address: BASE_USDC_ADDRESS,
    abi: USDC_EIP3009_ABI,
    functionName: 'balanceOf',
    args: [input.from],
  });

  if (payerBalance < input.value) {
    throw new Error(
      `Payer ${input.from} has insufficient Base USDC balance (${payerBalance.toString()} < ${input.value.toString()}).`
    );
  }

  const parsedSig = parseSignature(input.signature);
  const v = Number(parsedSig.v ?? (parsedSig.yParity === 0 ? 27 : 28));
  const r = parsedSig.r;
  const s = parsedSig.s;

  const canUseReceive =
    input.method === 'receiveWithAuthorization' &&
    relayerAccount.address.toLowerCase() === input.to.toLowerCase();

  const functionName = canUseReceive
    ? 'receiveWithAuthorization'
    : 'transferWithAuthorization';

  const { request } = await publicClient.simulateContract({
    account: relayerAccount,
    address: BASE_USDC_ADDRESS,
    abi: USDC_EIP3009_ABI,
    functionName,
    args: [
      input.from,
      input.to,
      input.value,
      input.validAfter,
      input.validBefore,
      input.nonce,
      v,
      r,
      s,
    ],
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== 'success') {
    throw new Error(`On-chain settlement transaction reverted: ${txHash}`);
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    payer: input.from,
    recipient: input.to,
    amountUnits: input.value.toString(),
    method: functionName,
  };
}
