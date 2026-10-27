'use client';

import { useState, useCallback } from 'react';
import { useAccount, useSignTypedData, useSwitchChain } from 'wagmi';
import { base } from 'viem/chains';
import { toHex, type Address, type Hex } from 'viem';

export const BASE_USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const DEFAULT_RECIPIENT: Address = '0xAB745e5F576667037696e78ba7dA28E193E4423D';

export const usdcDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: base.id,
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

export interface EIP3009Payload {
  from: Address;
  to: Address;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: Hex;
  signature: Hex;
}

export interface UseEip3009Options {
  recipient?: Address;
  validityWindowSeconds?: number;
}

export interface SignPaymentParams {
  valueUnits?: bigint | string;
  recipient?: Address;
}

export function useEip3009Payment(options?: UseEip3009Options) {
  const { address, chainId, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateNonce = useCallback((): Hex => {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return toHex(randomBytes);
  }, []);

  const signPayment = useCallback(
    async (
      params?: SignPaymentParams
    ): Promise<{
      payload: EIP3009Payload;
      authorizationHeader: string;
    }> => {
      setError(null);
      setIsLoading(true);

      try {
        if (!isConnected || !address) {
          throw new Error('Wallet is not connected.');
        }

        if (chainId !== base.id && switchChainAsync) {
          await switchChainAsync({ chainId: base.id });
        }

        const to = (params?.recipient || options?.recipient || DEFAULT_RECIPIENT) as Address;
        const value = BigInt(params?.valueUnits ?? 10_000n);

        const now = Math.floor(Date.now() / 1000);
        const validAfter = now - 60;
        const validBefore = now + (options?.validityWindowSeconds ?? 3600);
        const nonce = generateNonce();

        const signature = await signTypedDataAsync({
          domain: usdcDomain,
          types: eip3009Types,
          primaryType: 'TransferWithAuthorization',
          message: {
            from: address,
            to,
            value,
            validAfter: BigInt(validAfter),
            validBefore: BigInt(validBefore),
            nonce,
          },
        });

        const payload: EIP3009Payload = {
          from: address,
          to,
          value: value.toString(),
          validAfter,
          validBefore,
          nonce,
          signature,
        };

        const jsonString = JSON.stringify(payload);
        const base64Token =
          typeof window !== 'undefined'
            ? window.btoa(jsonString)
            : Buffer.from(jsonString).toString('base64');

        const authorizationHeader = `Bearer ${base64Token}`;
        setIsLoading(false);
        return { payload, authorizationHeader };
      } catch (err: any) {
        const message = err?.shortMessage || err?.message || 'Failed to sign authorization.';
        setError(message);
        setIsLoading(false);
        throw new Error(message);
      }
    },
    [address, chainId, isConnected, options, generateNonce, signTypedDataAsync, switchChainAsync]
  );

  return { signPayment, isLoading, error, isConnected, accountAddress: address };
}
