import { type Address } from 'viem';
import { type SignPaymentParams } from '@/hooks/useEip3009Payment';

export interface X402Challenge {
  realm?: string;
  token?: string;
  contract?: Address;
  chain?: number;
  payTo?: Address;
  amountUnits?: bigint;
}

export function parse402Header(headerValue: string): X402Challenge {
  const challenge: X402Challenge = {};
  const stripped = headerValue.replace(/^x402\s+/i, '');
  const regex = /(\w+)=["']?([^"',]+)["']?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stripped)) !== null) {
    const [, key, val] = match;
    switch (key.toLowerCase()) {
      case 'realm':
        challenge.realm = val;
        break;
      case 'token':
        challenge.token = val;
        break;
      case 'contract':
        challenge.contract = val as Address;
        break;
      case 'chain':
        challenge.chain = parseInt(val, 10);
        break;
      case 'payto':
        challenge.payTo = val as Address;
        break;
      case 'amount':
        challenge.amountUnits = BigInt(val);
        break;
    }
  }
  return challenge;
}

export interface FetchWith402Options extends RequestInit {
  signer: (params?: SignPaymentParams) => Promise<{ authorizationHeader: string }>;
  maxRetries?: number;
  maxAllowedUnits?: bigint;
}

export async function fetchWith402(
  input: RequestInfo | URL,
  options: FetchWith402Options
): Promise<Response> {
  const { signer, maxRetries = 1, maxAllowedUnits = 100_000n, ...fetchInit } = options;

  let attempts = 0;
  const currentHeaders = new Headers(fetchInit.headers || {});

  while (attempts <= maxRetries) {
    const response = await fetch(input, {
      ...fetchInit,
      headers: currentHeaders,
    });

    if (response.status !== 402) {
      return response;
    }

    attempts++;
    if (attempts > maxRetries) {
      return response;
    }

    const authHeader = response.headers.get('www-authenticate');
    let targetRecipient: Address | undefined;
    let targetAmount: bigint = 10_000n;

    if (authHeader && authHeader.toLowerCase().includes('x402')) {
      const parsed = parse402Header(authHeader);
      targetRecipient = parsed.payTo;
      if (parsed.amountUnits) {
        targetAmount = parsed.amountUnits;
      }
    } else {
      try {
        const cloned = response.clone();
        const body = await cloned.json();
        targetRecipient = body.recipient || body.pay_to;
        if (body.amount_due_units) {
          targetAmount = BigInt(body.amount_due_units);
        }
      } catch {
        // Default fallback
      }
    }

    if (targetAmount > maxAllowedUnits) {
      throw new Error(
        `402 Micropayment challenge exceeds allowed threshold: ${targetAmount.toString()} units requested`
      );
    }

    const { authorizationHeader } = await signer({
      recipient: targetRecipient,
      valueUnits: targetAmount,
    });

    currentHeaders.set('Authorization', authorizationHeader);
  }

  throw new Error('x402 handshake exceeded maximum retry attempts.');
}
