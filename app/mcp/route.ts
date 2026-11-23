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
    'Content-Type, Authorization, payment-signature, x402-authorization, x-payment-signature, Mcp-Session-Id',
  'Access-Control-Expose-Headers':
    'WWW-Authenticate, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Verified-Payer, X-Settlement-Tx',
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
            `Base64-encoded EIP-3009 TransferWithAuthorization Bearer token (payTo: ${EXPECTED_PAYEE}, value: 10000, chainId: 8453).`,
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        httpStatus: { type: 'number', description: 'Upstream compliance HTTP status code (200 or 402).' },
        wwwAuthenticate: { type: 'string', description: 'RFC 7235 x402 challenge header when unpaid.' },
        paymentRequired: { type: 'string', description: 'Base64 x402 v2 PAYMENT-REQUIRED challenge when unpaid.' },
        violations: { type: 'array', description: 'Active and historical Minneapolis housing code violations.' },
        permits: { type: 'array', description: 'Associated Minneapolis building and repair permits.' },
        address: { type: 'string', description: 'Normalized Minneapolis street address queried.' },
      },
      required: ['httpStatus'],
    },
    annotations: {
      title: 'Minneapolis Housing Compliance Lookup ($0.01)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
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
            `Base64-encoded EIP-3009 TransferWithAuthorization Bearer token (payTo: ${EXPECTED_PAYEE}, value: 10000, chainId: 8453).`,
        },
      },
      required: ['parcel_id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        httpStatus: { type: 'number', description: 'Upstream GIS audit HTTP status code (200 or 402).' },
        wwwAuthenticate: { type: 'string', description: 'RFC 7235 x402 challenge header when unpaid.' },
        paymentRequired: { type: 'string', description: 'Base64 x402 v2 PAYMENT-REQUIRED challenge when unpaid.' },
        parcel: { type: 'object', description: 'Ramsey County parcel attributes, owner, and tax valuation.' },
        parcel_id: { type: 'string', description: 'Queried Ramsey County PIN or street address.' },
      },
      required: ['httpStatus'],
    },
    annotations: {
      title: 'Ramsey County Parcel GIS Audit ($0.01)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  if (accept.includes('text/event-stream')) {
    return NextResponse.json(
      {
        error: 'METHOD_NOT_ALLOWED',
        message: 'Use HTTP POST with JSON-RPC 2.0 on this stateless Streamable HTTP MCP endpoint.',
      },
      {
        status: 405,
        headers: {
          ...CORS_HEADERS,
          Allow: 'POST, OPTIONS',
          Vary: 'Accept',
        },
      }
    );
  }

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
      tools: MCP_TOOLS,
      status: 'ONLINE',
    },
    { status: 200, headers: { ...CORS_HEADERS, Vary: 'Accept' } }
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

    const paymentSignatureHeader = request.headers.get('payment-signature') || '';
    const headerAuth =
      toolArgs.authorization ||
      paymentSignatureHeader ||
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
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Unknown tool: ${String(toolName ?? '')}` }),
              },
            ],
          },
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const requestHeaders: Record<string, string> = { Accept: 'application/json' };
    if (headerAuth) {
      if (paymentSignatureHeader && !toolArgs.authorization) {
        requestHeaders['payment-signature'] = headerAuth;
      } else {
        requestHeaders['Authorization'] = headerAuth;
      }
    }

    const originUrl = new URL(request.url).origin;
    const localEndpoint = `${originUrl}/api/v1/compliance?${queryString}`;

    const apiRes = await fetch(localEndpoint, { headers: requestHeaders });
    const wwwAuth = apiRes.headers.get('www-authenticate') || '';
    const paymentRequired = apiRes.headers.get('payment-required') || '';
    const responsePayload = await apiRes.json().catch(() => ({}));

    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          isError: apiRes.status >= 400,
          ...(apiRes.status === 402
            ? { _meta: { 'x402/payment-required': responsePayload } }
            : {}),
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  httpStatus: apiRes.status,
                  ...(wwwAuth ? { wwwAuthenticate: wwwAuth } : {}),
                  ...(paymentRequired ? { paymentRequired } : {}),
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
          ...(apiRes.status === 402 && paymentRequired
            ? { 'PAYMENT-REQUIRED': paymentRequired }
            : {}),
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
