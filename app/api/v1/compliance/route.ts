import { NextRequest, NextResponse } from 'next/server';
import { verifyTypedData, isAddress, type Hex, type Address } from 'viem';
import {
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
  USDC_EIP3009_ABI,
  publicClient,
  settleEIP3009OnChain,
} from '@/lib/relayer';
import { appendSettlementToLedger } from '@/lib/ledger';
import { isRetiredPayee } from '@/lib/x402PayTo';

export { BASE_USDC_ADDRESS, EXPECTED_PAYEE };

const REQUIRED_AMOUNT_USDC_UNITS = 10_000n;

const usdcDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: BASE_USDC_ADDRESS,
} as const;

const eip3009Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const MPLS_OPEN_DATA_BASE = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services';
const MPLS_VIOLATIONS_LAYER = `${MPLS_OPEN_DATA_BASE}/Code_Violations/FeatureServer/0/query`;
const MPLS_PERMITS_LAYER = `${MPLS_OPEN_DATA_BASE}/Building_Permits/FeatureServer/0/query`;
const RAMSEY_OPEN_DATA_BASE = 'https://services2.arcgis.com/b2CW5vms5U2jB7J9/arcgis/rest/services';
const RAMSEY_PARCELS_LAYER = `${RAMSEY_OPEN_DATA_BASE}/Attributed_Parcel_Points/FeatureServer/0/query`;

export interface EIP3009Payload {
  from: Address;
  to: Address;
  value: string;
  validAfter: number | string;
  validBefore: number | string;
  nonce: Hex;
  signature: Hex;
  type?: 'TransferWithAuthorization' | 'ReceiveWithAuthorization';
  primaryType?: 'TransferWithAuthorization' | 'ReceiveWithAuthorization';
}

function parseAuthorizationToken(rawHeader: string): EIP3009Payload {
  const trimmed = rawHeader.trim();
  let parsed: any;

  if (trimmed.startsWith('Bearer ') || trimmed.startsWith('x402 ')) {
    const token = trimmed.split(/\s+/)[1];
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
  } else if (trimmed.startsWith('{')) {
    parsed = JSON.parse(trimmed);
  } else if (!trimmed.includes(' ')) {
    parsed = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf-8'));
  } else {
    throw new Error('Unsupported authorization header scheme.');
  }

  // Unwrap x402 v2 PaymentPayload envelope when supplied via PAYMENT-SIGNATURE
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.payload?.authorization &&
    parsed.payload?.signature
  ) {
    return {
      ...parsed.payload.authorization,
      signature: parsed.payload.signature,
    } as EIP3009Payload;
  }

  return parsed as EIP3009Payload;
}

export async function verifyEIP3009Authorization(
  rawHeader: string,
  skipOnChainNonceCheck = false
): Promise<{
  valid: boolean;
  signer?: Address;
  parsedPayload?: EIP3009Payload;
  error?: string;
}> {
  try {
    const payload = parseAuthorizationToken(rawHeader);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, error: 'Malformed EIP-3009 payload structure.' };
    }

    const { from, to, value, validAfter, validBefore, nonce, signature } = payload;
    const primaryType = payload.type || payload.primaryType || 'TransferWithAuthorization';

    if (!isAddress(from) || !isAddress(to) || !signature || !nonce) {
      return { valid: false, error: 'Malformed EIP-3009 payload structure.' };
    }

    if (isRetiredPayee(to)) {
      return {
        valid: false,
        error: `Retired payee address rejected: ${to}`,
      };
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

    if (Number.isNaN(validAfterNum) || Number.isNaN(validBeforeNum)) {
      return { valid: false, error: 'Invalid timestamp format in authorization.' };
    }
    if (validAfterNum >= validBeforeNum) {
      return {
        valid: false,
        error: 'Invalid authorization window: validAfter must be strictly less than validBefore.',
      };
    }
    if (now <= validAfterNum) {
      return { valid: false, error: 'Authorization signature is not yet active.' };
    }
    if (now >= validBeforeNum) {
      return { valid: false, error: 'Authorization signature has expired.' };
    }

    if (!skipOnChainNonceCheck) {
      const isNonceUsed = await publicClient.readContract({
        address: BASE_USDC_ADDRESS,
        abi: USDC_EIP3009_ABI,
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
      types: { [primaryType]: eip3009Types[primaryType] },
      primaryType,
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

    return { valid: true, signer: from, parsedPayload: payload };
  } catch (err: any) {
    return { valid: false, error: `Signature verification exception: ${err?.message}` };
  }
}

function sanitizeArcGisWhere(param: string): string {
  return param.replace(/'/g, "''").trim().toUpperCase();
}

async function fetchMinneapolisData(address: string) {
  const sanitized = sanitizeArcGisWhere(address);
  const whereClause = `UPPER(address) LIKE '%${sanitized}%'`;

  const violationsUrl = `${MPLS_VIOLATIONS_LAYER}?where=${encodeURIComponent(
    whereClause
  )}&outFields=case_number,address,violation_type,status,entered_date&resultRecordCount=10&f=json`;

  const permitsUrl = `${MPLS_PERMITS_LAYER}?where=${encodeURIComponent(
    whereClause
  )}&outFields=permit_number,issue_date,permit_type,description,status&resultRecordCount=10&f=json`;

  const [violationsRes, permitsRes] = await Promise.allSettled([
    fetch(violationsUrl, { next: { revalidate: 60 } }),
    fetch(permitsUrl, { next: { revalidate: 60 } }),
  ]);

  let violations: any[] = [];
  let permits: any[] = [];

  if (violationsRes.status === 'fulfilled' && violationsRes.value.ok) {
    const data = await violationsRes.value.json().catch(() => ({}));
    if (Array.isArray(data.features)) {
      violations = data.features.map((f: any) => ({
        caseNumber: f.attributes?.case_number || 'N/A',
        address: f.attributes?.address || address,
        violationType: f.attributes?.violation_type || 'General Housing Code',
        status: f.attributes?.status || 'Active',
      }));
    }
  }

  if (permitsRes.status === 'fulfilled' && permitsRes.value.ok) {
    const data = await permitsRes.value.json().catch(() => ({}));
    if (Array.isArray(data.features)) {
      permits = data.features.map((f: any) => ({
        permitNumber: f.attributes?.permit_number || 'N/A',
        permitType: f.attributes?.permit_type || 'Alteration/Repair',
        workDescription: f.attributes?.description || 'Structural/Permit record',
      }));
    }
  }

  return { violations, permits };
}

async function fetchRamseyData(parcelOrAddress: string) {
  const sanitized = sanitizeArcGisWhere(parcelOrAddress);
  const isPin = /^\d{2}-\d{2}-\d{2}-\d{2}-\d{4}$/.test(sanitized) || /^\d+$/.test(sanitized);
  const whereClause = isPin ? `PIN = '${sanitized}'` : `UPPER(SITE_ADDR) LIKE '%${sanitized}%'`;

  const parcelUrl = `${RAMSEY_PARCELS_LAYER}?where=${encodeURIComponent(
    whereClause
  )}&outFields=PIN,SITE_ADDR,OWNER_NAME,PROPERTY_USE,ASSESSED_VALUE&resultRecordCount=5&f=json`;

  try {
    const res = await fetch(parcelUrl, { next: { revalidate: 60 } });
    if (!res.ok) return { parcels: [] };
    const data = await res.json();
    if (Array.isArray(data.features)) {
      return {
        parcels: data.features.map((f: any) => ({
          pin: f.attributes?.PIN || 'N/A',
          siteAddress: f.attributes?.SITE_ADDR || parcelOrAddress,
          owner: f.attributes?.OWNER_NAME || 'Redacted/Public Entity',
          propertyUse: f.attributes?.PROPERTY_USE || 'Residential / Commercial',
          assessedValue: f.attributes?.ASSESSED_VALUE || null,
        })),
      };
    }
    return { parcels: [] };
  } catch {
    return { parcels: [] };
  }
}

interface ComplianceInput {
  address: string | null;
  parcelId: string | null;
  jurisdiction: string;
}

function buildPaymentRequiredPayload(method: 'GET' | 'POST', resourceUrl = 'https://civicpulse.kwizzlesurp.com/api/v1/compliance') {
  const inputParamsSchema = {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: "Minneapolis street address (e.g., '1700 Penn Ave N')",
      },
      parcel_id: {
        type: 'string',
        description: "Ramsey County PIN or site address (e.g., '04-29-23-41-0012')",
      },
      jurisdiction: {
        type: 'string',
        enum: ['minneapolis', 'ramsey'],
        description: 'Target municipal jurisdiction',
      },
    },
    additionalProperties: false,
  };

  return {
    x402Version: 2,
    error: 'Payment Required',
    resource: {
      url: resourceUrl,
      description:
        'Real-time Minneapolis housing code violations, permits, and Ramsey County parcel GIS audits',
      mimeType: 'application/json',
      serviceName: 'CivicPulse-402',
      tags: ['compliance', 'gis', 'minneapolis', 'ramsey', 'real-estate'],
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: REQUIRED_AMOUNT_USDC_UNITS.toString(),
        asset: BASE_USDC_ADDRESS,
        payTo: EXPECTED_PAYEE,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
        },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input:
            method === 'POST'
              ? {
                  type: 'http',
                  method: 'POST',
                  bodyType: 'json',
                  body: {
                    address: '1700 Penn Ave N',
                    jurisdiction: 'minneapolis',
                  },
                }
              : {
                  type: 'http',
                  method: 'GET',
                  queryParams: {
                    address: '1700 Penn Ave N',
                    jurisdiction: 'minneapolis',
                  },
                },
          output: {
            type: 'json',
            example: {
              status: 'OK',
              settled: false,
              network: 'Base Mainnet (eip155:8453)',
              data: {
                violations: [],
                permits: [],
              },
            },
          },
        },
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            input: {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'http' },
                method: { type: 'string', enum: ['GET', 'POST'] },
                ...(method === 'POST'
                  ? {
                      bodyType: { type: 'string', const: 'json' },
                      body: inputParamsSchema,
                    }
                  : {
                      queryParams: inputParamsSchema,
                    }),
              },
              required: ['type', 'method'],
              additionalProperties: true,
            },
            output: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                example: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    network: { type: 'string' },
                    data: { type: 'object' },
                  },
                  required: ['status', 'data'],
                },
              },
              required: ['type'],
            },
          },
          required: ['input'],
        },
      },
    },
  };
}

function buildPaymentRequiredResponse(method: 'GET' | 'POST', resourceUrl?: string) {
  const v2Payload = buildPaymentRequiredPayload(method, resourceUrl);
  const encodedPaymentRequired = Buffer.from(JSON.stringify(v2Payload), 'utf-8').toString('base64');

  return NextResponse.json(
    {
      protocol: 'x402-mcp/v1.2',
      ...v2Payload,
      amount_due: '0.01 USDC (10000 units)',
      amount_due_units: REQUIRED_AMOUNT_USDC_UNITS.toString(),
      chain_id: 8453,
      token_contract: BASE_USDC_ADDRESS,
      pay_to: EXPECTED_PAYEE,
      eip3009: {
        domain: usdcDomain,
        types: { TransferWithAuthorization: eip3009Types.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
      },
    },
    {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodedPaymentRequired,
        'WWW-Authenticate': `x402 realm="CivicPulse-Base", token="USDC", contract="${BASE_USDC_ADDRESS}", chain="8453", payTo="${EXPECTED_PAYEE}", amount="10000"`,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function handleComplianceRequest(
  request: NextRequest,
  method: 'GET' | 'POST',
  input: ComplianceInput
) {
  const authHeader =
    request.headers.get('payment-signature') ||
    request.headers.get('authorization') ||
    request.headers.get('x-payment-signature') ||
    request.headers.get('x402-authorization');

  // Always issue HTTP 402 challenge BEFORE input validation so automated discovery probes succeed
  if (!authHeader) {
    return buildPaymentRequiredResponse(method, new URL('/api/v1/compliance', request.url).toString());
  }

  const verification = await verifyEIP3009Authorization(authHeader);

  if (!verification.valid || !verification.parsedPayload) {
    return NextResponse.json(
      { error: 'Payment Signature Invalid', details: verification.error },
      { status: 403 }
    );
  }

  const { address, parcelId, jurisdiction } = input;
  if (!address && !parcelId) {
    return NextResponse.json(
      { error: 'Missing query parameters: supply `address` or `parcel_id`.' },
      { status: 400 }
    );
  }

  const p = verification.parsedPayload;

  let settlementTxHash: Hex | null = null;
  let settlementBlock: string = 'PENDING_RELAY';
  let ledgerStatus = { loggedLocal: false, loggedGithub: false };

  if (process.env.RELAYER_PRIVATE_KEY) {
    try {
      const receipt = await settleEIP3009OnChain({
        from: p.from,
        to: p.to,
        value: BigInt(p.value),
        validAfter: BigInt(p.validAfter),
        validBefore: BigInt(p.validBefore),
        nonce: p.nonce,
        signature: p.signature,
        method:
          p.primaryType === 'ReceiveWithAuthorization'
            ? 'receiveWithAuthorization'
            : 'transferWithAuthorization',
      });

      settlementTxHash = receipt.txHash;
      settlementBlock = receipt.blockNumber.toString();

      const formattedUsdc = (Number(p.value) / 1_000_000).toFixed(2);
      ledgerStatus = await appendSettlementToLedger({
        timestamp: new Date().toISOString(),
        endpoint: '/api/v1/compliance',
        query: address || parcelId || '',
        payer: p.from,
        recipient: p.to,
        amountUsdc: formattedUsdc,
        txHash: receipt.txHash,
        blockNumber: settlementBlock,
      });
    } catch (relayErr: any) {
      return NextResponse.json(
        {
          error: 'On-Chain Settlement Revert',
          details: relayErr?.shortMessage || relayErr?.message,
        },
        { status: 402 }
      );
    }
  }

  try {
    const data =
      jurisdiction === 'ramsey' || parcelId
        ? await fetchRamseyData(parcelId || address || '')
        : await fetchMinneapolisData(address || '');

    return NextResponse.json(
      {
        status: 'OK',
        settled: Boolean(settlementTxHash),
        tx_hash: settlementTxHash,
        basescan_url: settlementTxHash ? `https://basescan.org/tx/${settlementTxHash}` : null,
        block_number: settlementBlock,
        ledger_recorded: ledgerStatus.loggedLocal || ledgerStatus.loggedGithub,
        signer: verification.signer,
        network: 'Base Mainnet (eip155:8453)',
        timestamp: new Date().toISOString(),
        data,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Verified-Payer': verification.signer || '',
          ...(settlementTxHash ? { 'X-Settlement-Tx': settlementTxHash } : {}),
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Gateway upstream query failed', message: err?.message },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return handleComplianceRequest(request, 'GET', {
    address: searchParams.get('address'),
    parcelId: searchParams.get('parcel_id'),
    jurisdiction: (searchParams.get('jurisdiction') || 'minneapolis').toLowerCase(),
  });
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const address =
    typeof body?.address === 'string' ? body.address : searchParams.get('address');
  const parcelId =
    typeof body?.parcel_id === 'string' ? body.parcel_id : searchParams.get('parcel_id');
  const jurisdictionRaw =
    typeof body?.jurisdiction === 'string'
      ? body.jurisdiction
      : searchParams.get('jurisdiction') || 'minneapolis';

  return handleComplianceRequest(request, 'POST', {
    address: address ?? null,
    parcelId: parcelId ?? null,
    jurisdiction: jurisdictionRaw.toLowerCase(),
  });
}
