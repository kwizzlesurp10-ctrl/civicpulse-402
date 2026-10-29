import { NextRequest, NextResponse } from 'next/server';
import {
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
} from '@/app/api/v1/compliance/route';

const CANONICAL_X402_BACKEND =
  process.env.X402_MCP_UPSTREAM_URL || 'https://x402-mcp.onrender.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x402-authorization, x-payment-signature, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, X-Verified-Payer, X-Settlement-Tx',
};

const MCP_TOOLS = [
  {
    name: 'query_minneapolis_compliance',
    description:
      'Fetches real-time City of Minneapolis housing code violations, active repair orders, and building permits for a street address. Costs 0.01 USDC (10000 units) on Base Mainnet (eip155:8453) via x402 EIP-3009.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Street address in Minneapolis, MN (e.g., "1700 Penn Ave N")',
        },
        authorization: {
          type: 'string',
          description:
            'Base64-encoded EIP-3009 TransferWithAuthorization Bearer token (payTo: 0xAB745e5F576667037696e78ba7dA28E193E4423D, value: 10000, chainId: 8453).',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_ramsey_parcel_audit',
    description:
      'Queries Ramsey County Open GIS for parcel attributes, registered owner, property use class, and tax assessment valuation by PIN or street address. Costs 0.01 USDC (10000 units) on Base Mainnet (eip155:8453) via x402 EIP-3009.',
    inputSchema: {
      type: 'object',
      properties: {
        parcel_id: {
          type: 'string',
          description: 'Ramsey County PIN (e.g., "04-29-23-41-0012") or street address.',
        },
        authorization: {
          type: 'string',
          description:
            'Base64-encoded EIP-3009 TransferWithAuthorization Bearer token (payTo: 0xAB745e5F576667037696e78ba7dA28E193E4423D, value: 10000, chainId: 8453).',
        },
      },
      required: ['parcel_id'],
      additionalProperties: false,
    },
  },
];

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  return NextResponse.json(
    {
      name: 'io.github.kwizzlesurp10-ctrl/x402-mcp',
      alias: 'civicpulse-402',
      version: '1.2.0',
      transport: 'streamable-http',
      protocolVersion: '2025-03-26',
      canonicalBackend: CANONICAL_X402_BACKEND,
      x402: {
        network: 'eip155:8453',
        chainId: 8453,
        token: 'USDC',
        tokenContract: BASE_USDC_ADDRESS,
        payTo: EXPECTED_PAYEE,
        priceUnits: '10000',
      },
      toolsCount: MCP_TOOLS.length,
      status: 'ONLINE',
    },
    { status: 200, headers: CORS_HEADERS }
  );
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { id = null, method, params } = body;

  if (method === 'initialize') {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'x402-mcp-civicpulse-gateway',
            version: '1.2.0',
          },
        },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  }

  if (method === 'notifications/initialized') {
    return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  }

  if (method === 'ping') {
    return NextResponse.json({ jsonrpc: '2.0', id, result: {} }, { headers: CORS_HEADERS });
  }

  if (method === 'tools/list') {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    const headerAuth =
      toolArgs.authorization ||
      request.headers.get('authorization') ||
      request.headers.get('x402-authorization') ||
      request.headers.get('x-payment-signature') ||
      '';

    let queryString = '';
    if (toolName === 'query_minneapolis_compliance') {
      queryString = `address=${encodeURIComponent(String(toolArgs.address || ''))}&jurisdiction=minneapolis`;
    } else if (toolName === 'query_ramsey_parcel_audit') {
      queryString = `parcel_id=${encodeURIComponent(String(toolArgs.parcel_id || ''))}&jurisdiction=ramsey`;
    } else {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const requestHeaders: Record<string, string> = { Accept: 'application/json' };
    if (headerAuth) {
      requestHeaders['Authorization'] = headerAuth;
    }

    const originUrl = new URL(request.url).origin;
    const localEndpoint = `${originUrl}/api/v1/compliance?${queryString}`;

    const apiRes = await fetch(localEndpoint, { headers: requestHeaders });
    const wwwAuth = apiRes.headers.get('www-authenticate') || '';
    const responsePayload = await apiRes.json().catch(() => ({}));

    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          isError: apiRes.status >= 400 && apiRes.status !== 402,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  httpStatus: apiRes.status,
                  ...(wwwAuth ? { wwwAuthenticate: wwwAuth } : {}),
                  ...responsePayload,
                },
                null,
                2
              ),
            },
          ],
        },
      },
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          ...(wwwAuth ? { 'WWW-Authenticate': wwwAuth } : {}),
        },
      }
    );
  }

  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    },
    { status: 404, headers: CORS_HEADERS }
  );
}
