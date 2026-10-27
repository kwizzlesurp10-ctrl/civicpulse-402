#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
  usdcDomain,
  eip3009Types,
  REQUIRED_AMOUNT_USDC_UNITS,
} from '../lib/verifyEip3009';

const DEFAULT_API_BASE =
  process.env.CIVICPULSE_API_URL || 'https://civicpulse-402.vercel.app';

const server = new McpServer({
  name: 'civicpulse-402',
  version: '1.0.0',
});

// 1. Tool: Probe 402 challenge terms without payment
server.tool(
  'probe_compliance_challenge',
  'Probe the live CivicPulse HTTP 402 micropayment terms, challenge headers, and settlement contract without paying.',
  {
    address: z
      .string()
      .optional()
      .describe("Street address to probe (e.g., '1700 Penn Ave N')"),
    parcel_id: z
      .string()
      .optional()
      .describe("Ramsey County PIN/Parcel ID (e.g., '04-29-23-41-0012')"),
    jurisdiction: z
      .enum(['minneapolis', 'ramsey'])
      .default('minneapolis')
      .describe('Target municipality or county jurisdiction'),
  },
  async ({ address, parcel_id, jurisdiction }) => {
    const params = new URLSearchParams();
    if (address) params.set('address', address);
    if (parcel_id) params.set('parcel_id', parcel_id);
    if (jurisdiction) params.set('jurisdiction', jurisdiction);

    const url = `${DEFAULT_API_BASE}/api/v1/compliance?${params.toString()}`;

    try {
      const res = await fetch(url);
      const wwwAuthenticate = res.headers.get('www-authenticate');
      const body = await res.json().catch(() => ({}));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: res.status,
                statusText: res.statusText,
                wwwAuthenticateHeader: wwwAuthenticate,
                challenge: body,
                settlement: {
                  chain: 'Base Mainnet (8453)',
                  tokenContract: BASE_USDC_ADDRESS,
                  payTo: EXPECTED_PAYEE,
                  rateUsdc: '$0.01 (10,000 atomic units)',
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Failed to probe CivicPulse endpoint: ${err?.message}`,
          },
        ],
      };
    }
  }
);

// 2. Tool: Query compliance records with optional autonomous payment
server.tool(
  'check_compliance',
  'Query Minneapolis housing code violations and building permits, or Ramsey County parcel attributes. Automatically signs and pays 0.01 USDC on Base if EVM_PRIVATE_KEY is available.',
  {
    address: z
      .string()
      .optional()
      .describe("Street address (e.g. '1700 Penn Ave N')"),
    parcel_id: z
      .string()
      .optional()
      .describe("Parcel ID or PIN (e.g. '04-29-23-41-0012')"),
    jurisdiction: z
      .enum(['minneapolis', 'ramsey'])
      .default('minneapolis')
      .describe("Target jurisdiction ('minneapolis' or 'ramsey')"),
    private_key: z
      .string()
      .optional()
      .describe(
        'Optional hex private key for automated payment signing (defaults to EVM_PRIVATE_KEY env var)'
      ),
  },
  async ({ address, parcel_id, jurisdiction, private_key }) => {
    if (!address && !parcel_id) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: Must provide either `address` or `parcel_id`.',
          },
        ],
      };
    }

    const params = new URLSearchParams();
    if (address) params.set('address', address);
    if (parcel_id) params.set('parcel_id', parcel_id);
    if (jurisdiction) params.set('jurisdiction', jurisdiction);

    const url = `${DEFAULT_API_BASE}/api/v1/compliance?${params.toString()}`;
    const rawKey = private_key || process.env.EVM_PRIVATE_KEY;

    let headers: Record<string, string> = {};

    if (rawKey) {
      const formattedKey = (
        rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
      ) as Hex;
      const account = privateKeyToAccount(formattedKey);

      const now = Math.floor(Date.now() / 1000);
      const validAfter = now - 60;
      const validBefore = now + 3600;
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);
      const nonce = toHex(randomBytes);

      const signature = await account.signTypedData({
        domain: usdcDomain,
        types: eip3009Types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address,
          to: EXPECTED_PAYEE,
          value: REQUIRED_AMOUNT_USDC_UNITS,
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
          nonce,
        },
      });

      const payload = {
        from: account.address,
        to: EXPECTED_PAYEE,
        value: REQUIRED_AMOUNT_USDC_UNITS.toString(),
        validAfter,
        validBefore,
        nonce,
        signature,
      };

      const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      headers['Authorization'] = `Bearer ${base64}`;
    }

    try {
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => ({}));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: res.status,
                url,
                paid: res.status === 200,
                response: body,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Request to CivicPulse failed: ${err?.message}`,
          },
        ],
      };
    }
  }
);

// 3. Tool: Gateway Information & Discovery Manifest
server.tool(
  'get_gateway_info',
  'Retrieve CivicPulse 402 gateway discovery metadata, settlement wallet, and open data endpoints.',
  {},
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              gateway: 'CivicPulse 402',
              version: '1.0.0',
              publicUrl: DEFAULT_API_BASE,
              protocol: 'x402-mcp/v1.2',
              network: 'Base Mainnet (chainId 8453)',
              usdcContract: BASE_USDC_ADDRESS,
              payToAddress: EXPECTED_PAYEE,
              pricing: '$0.01 USDC (10,000 atomic units)',
              supportedJurisdictions: ['Minneapolis (Hennepin)', 'Ramsey County (St. Paul)'],
              discoveryUrls: {
                mcpConfig: `${DEFAULT_API_BASE}/mcp.json`,
                wellKnownX402: `${DEFAULT_API_BASE}/.well-known/x402.json`,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CivicPulse 402 MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error in CivicPulse 402 MCP server:', err);
  process.exit(1);
});
