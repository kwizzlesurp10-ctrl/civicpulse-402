import { NextRequest, NextResponse } from 'next/server';
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jurisdiction = (searchParams.get('jurisdiction') || 'minneapolis').toLowerCase();
  const address = searchParams.get('address');
  const parcelId = searchParams.get('parcel_id');

  if (!address && !parcelId) {
    return NextResponse.json(
      { error: 'Missing query parameters: supply `address` or `parcel_id`.' },
      { status: 400 }
    );
  }

  const authHeader =
    request.headers.get('authorization') ||
    request.headers.get('x-payment-signature') ||
    request.headers.get('x402-authorization');

  if (!authHeader) {
    return NextResponse.json(
      {
        protocol: 'x402-mcp/v1.2',
        error: 'Payment Required',
        amount_due: '0.01 USDC (10000 units)',
        amount_due_units: '10000',
        chain_id: 8453,
        token_contract: BASE_USDC_ADDRESS,
        pay_to: EXPECTED_PAYEE,
        eip3009: {
          domain: usdcDomain,
          types: eip3009Types,
          primaryType: 'TransferWithAuthorization',
        },
      },
      {
        status: 402,
        headers: {
          'WWW-Authenticate': `x402 realm="CivicPulse-Base", token="USDC", contract="${BASE_USDC_ADDRESS}", chain="8453", payTo="${EXPECTED_PAYEE}", amount="10000"`,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const verification = await verifyEIP3009Authorization(authHeader);

  if (!verification.valid) {
    return NextResponse.json(
      { error: 'Payment Signature Invalid', details: verification.error },
      { status: 403 }
    );
  }

  try {
    const data =
      jurisdiction === 'ramsey' || parcelId
        ? await fetchRamseyData(parcelId || address || '')
        : await fetchMinneapolisData(address || '');

    return NextResponse.json(
      {
        status: 'OK',
        settled: true,
        settlement_mode: 'EIP-3009-transferWithAuthorization',
        signer: verification.signer,
        network: 'Base Mainnet (8453)',
        timestamp: new Date().toISOString(),
        data,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
          'X-Verified-Payer': verification.signer || '',
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
