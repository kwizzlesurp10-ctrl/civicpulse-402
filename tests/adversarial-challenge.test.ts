import assert from 'node:assert';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toHex, type Address, type Hex } from 'viem';
import {
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
  REQUIRED_AMOUNT_USDC_UNITS,
  usdcDomain,
  eip3009Types,
} from '../lib/verifyEip3009';

const BASE_URL = process.env.TEST_TARGET_URL || 'https://civicpulse-402.vercel.app';

interface TestResult {
  category: string;
  id: string;
  description: string;
  expectedStatus: number | number[];
  actualStatus: number;
  passed: boolean;
  notes: string;
}

const results: TestResult[] = [];

async function buildAuthorizationHeader(options: {
  account: ReturnType<typeof privateKeyToAccount>;
  to?: string;
  value?: string | number | bigint;
  validAfter?: number | string;
  validBefore?: number | string;
  nonce?: Hex;
  overrideDomain?: any;
  tamperSig?: 'r' | 's' | 'v' | 'random' | 'truncate' | false;
  claimFrom?: Address;
  rawPayloadModifier?: (payload: any) => any;
  headerPrefix?: 'Bearer ' | 'x402 ' | 'RawJSON' | 'Basic ' | '';
}): Promise<string> {
  const {
    account,
    to = EXPECTED_PAYEE,
    value = REQUIRED_AMOUNT_USDC_UNITS.toString(),
    validAfter,
    validBefore,
    nonce = toHex(crypto.getRandomValues(new Uint8Array(32))),
    overrideDomain,
    tamperSig = false,
    claimFrom,
    rawPayloadModifier,
    headerPrefix = 'Bearer ',
  } = options;

  const now = Math.floor(Date.now() / 1000);
  const actualValidAfter = validAfter !== undefined ? validAfter : now - 60;
  const actualValidBefore = validBefore !== undefined ? validBefore : now + 3600;

  // Sign message
  let signature: Hex;
  if (tamperSig === 'random') {
    signature = `0x${'deadbeef'.repeat(16)}1b` as Hex;
  } else if (tamperSig === 'truncate') {
    signature = `0x${'a'.repeat(64)}` as Hex;
  } else {
    // Attempt signing with typed data
    try {
      const msgValue = typeof value === 'bigint' ? value : BigInt(String(value));
      const msgValidAfter = typeof actualValidAfter === 'number' ? BigInt(actualValidAfter) : 0n;
      const msgValidBefore = typeof actualValidBefore === 'number' ? BigInt(actualValidBefore) : 0n;

      signature = await account.signTypedData({
        domain: overrideDomain || usdcDomain,
        types: eip3009Types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address,
          to: to as Address,
          value: msgValue,
          validAfter: msgValidAfter,
          validBefore: msgValidBefore,
          nonce,
        },
      });
    } catch {
      // Fallback dummy signature if parameter cannot be cast for typed data signing
      signature = `0x${'01'.repeat(64)}1b` as Hex;
    }

    if (tamperSig === 'r') {
      const char = signature[10];
      const flipped = char === 'a' ? 'b' : 'a';
      signature = (signature.slice(0, 10) + flipped + signature.slice(11)) as Hex;
    } else if (tamperSig === 's') {
      const char = signature[74];
      const flipped = char === 'c' ? 'd' : 'c';
      signature = (signature.slice(0, 74) + flipped + signature.slice(75)) as Hex;
    } else if (tamperSig === 'v') {
      signature = (signature.slice(0, -2) + '99') as Hex;
    }
  }

  let payloadObj: any = {
    from: claimFrom || account.address,
    to,
    value: String(value),
    validAfter: actualValidAfter,
    validBefore: actualValidBefore,
    nonce,
    signature,
  };

  if (rawPayloadModifier) {
    payloadObj = rawPayloadModifier(payloadObj);
  }

  if (headerPrefix === 'RawJSON') {
    return JSON.stringify(payloadObj);
  }

  const base64Payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
  return `${headerPrefix}${base64Payload}`;
}

async function runAdversarialTest(
  category: string,
  id: string,
  description: string,
  endpointPath: string,
  headers: Record<string, string>,
  expectedStatus: number | number[]
): Promise<TestResult> {
  const url = `${BASE_URL}${endpointPath}${endpointPath.includes('?') ? '&' : '?'}_t=${Date.now()}_${Math.random().toString(36).substring(7)}`;

  try {
    const res = await fetch(url, { headers });
    const actualStatus = res.status;
    const isExpected = Array.isArray(expectedStatus)
      ? expectedStatus.includes(actualStatus)
      : actualStatus === expectedStatus;

    let responseSummary = '';
    try {
      const text = await res.text();
      responseSummary = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    } catch {
      responseSummary = '(could not read body)';
    }

    const testResult: TestResult = {
      category,
      id,
      description,
      expectedStatus,
      actualStatus,
      passed: isExpected,
      notes: `Status ${actualStatus} - Response: ${responseSummary}`,
    };

    results.push(testResult);
    const passSymbol = isExpected ? '✅ PASS' : '❌ FAIL';
    console.log(`[${passSymbol}] [${category}] ${id}: ${description} -> Got ${actualStatus} (Expected ${JSON.stringify(expectedStatus)})`);
    return testResult;
  } catch (err: any) {
    const testResult: TestResult = {
      category,
      id,
      description,
      expectedStatus,
      actualStatus: 0,
      passed: false,
      notes: `Fetch exception: ${err.message}`,
    };
    results.push(testResult);
    console.log(`[❌ FAIL] [${category}] ${id}: ${description} -> Exception: ${err.message}`);
    return testResult;
  }
}

async function main() {
  console.log(`\n======================================================================`);
  console.log(`ADVERSARIAL STRESS TEST HARNESS — CIVICPULSE-402`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================================\n`);

  const primaryAccount = privateKeyToAccount(generatePrivateKey());
  const attackerAccount = privateKeyToAccount(generatePrivateKey());

  // -------------------------------------------------------------------------
  // CATEGORY 1: Payee Mismatch & Routing Hijacking
  // -------------------------------------------------------------------------
  console.log(`--- Category 1: Payee Mismatch & Routing Hijacking ---`);

  // 1.1 Payee directed to attacker address
  const h1_1 = await buildAuthorizationHeader({
    account: attackerAccount,
    to: attackerAccount.address,
  });
  await runAdversarialTest(
    'Payee Mismatch',
    'SEC-1.1',
    'Attacker directs funds to own address (attackerAccount)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h1_1 },
    403
  );

  // 1.2 Payee directed to zero address
  const h1_2 = await buildAuthorizationHeader({
    account: primaryAccount,
    to: '0x0000000000000000000000000000000000000000',
  });
  await runAdversarialTest(
    'Payee Mismatch',
    'SEC-1.2',
    'Payee directed to zero address 0x0000...0000',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h1_2 },
    403
  );

  // 1.3 Payee directed to dead burn address
  const h1_3 = await buildAuthorizationHeader({
    account: primaryAccount,
    to: '0x000000000000000000000000000000000000dEaD',
  });
  await runAdversarialTest(
    'Payee Mismatch',
    'SEC-1.3',
    'Payee directed to dead burn address 0x0000...dEaD',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h1_3 },
    403
  );

  // 1.4 Valid payee with lowercase address (case-insensitivity test)
  const h1_4 = await buildAuthorizationHeader({
    account: primaryAccount,
    to: EXPECTED_PAYEE.toLowerCase(),
  });
  await runAdversarialTest(
    'Payee Mismatch',
    'SEC-1.4',
    'Valid payee with lowercase address (case-insensitive equivalence)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h1_4 },
    200
  );

  // 1.5 Malformed payee address string
  const h1_5 = await buildAuthorizationHeader({
    account: primaryAccount,
    to: 'not_an_eth_address',
  });
  await runAdversarialTest(
    'Payee Mismatch',
    'SEC-1.5',
    'Malformed non-hex payee string in authorization payload',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h1_5 },
    403
  );

  // -------------------------------------------------------------------------
  // CATEGORY 2: Underpayment & Amount Boundary Attacks
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 2: Underpayment & Amount Boundary Attacks ---`);

  // 2.1 Zero payment
  const h2_1 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '0',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.1',
    'Zero value payment (0 units)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_1 },
    403
  );

  // 2.2 Micro-dust payment (1 unit = 0.000001 USDC)
  const h2_2 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '1',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.2',
    'Micro-dust payment (1 unit = 0.000001 USDC)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_2 },
    403
  );

  // 2.3 Off-by-one underpayment (9999 units, required is 10000)
  const h2_3 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '9999',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.3',
    'Off-by-one underpayment (9999 units, 1 unit below threshold)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_3 },
    403
  );

  // 2.4 Negative value payment
  const h2_4 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '-10000',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.4',
    'Negative value payment (-10000 units)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_4 },
    403
  );

  // 2.5 Floating-point value string
  const h2_5 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '10000.5',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.5',
    'Floating-point decimal value string ("10000.5")',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_5 },
    403
  );

  // 2.6 Non-numeric string value
  const h2_6 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: 'NaN',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.6',
    'Non-numeric value string ("NaN")',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_6 },
    403
  );

  // 2.7 Overpayment (20000 units = 0.02 USDC)
  const h2_7 = await buildAuthorizationHeader({
    account: primaryAccount,
    value: '20000',
  });
  await runAdversarialTest(
    'Underpayment',
    'SEC-2.7',
    'Overpayment (20000 units, exceeds minimum requirement)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h2_7 },
    200
  );

  // -------------------------------------------------------------------------
  // CATEGORY 3: Authorization Window Violations (EIP-3009 Time-Locks)
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 3: Authorization Window Violations ---`);

  const now = Math.floor(Date.now() / 1000);

  // 3.1 Expired authorization (validBefore 60s in the past)
  const h3_1 = await buildAuthorizationHeader({
    account: primaryAccount,
    validAfter: now - 3600,
    validBefore: now - 60,
  });
  await runAdversarialTest(
    'Authorization Window',
    'SEC-3.1',
    'Expired authorization window (validBefore was 60s ago)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h3_1 },
    403
  );

  // 3.2 Far past expiration (validBefore 1 year ago)
  const h3_2 = await buildAuthorizationHeader({
    account: primaryAccount,
    validAfter: now - 31536000 - 3600,
    validBefore: now - 31536000,
  });
  await runAdversarialTest(
    'Authorization Window',
    'SEC-3.2',
    'Stale authorization from 1 year in the past',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h3_2 },
    403
  );

  // 3.3 Future-dated authorization (validAfter 5 minutes in future)
  const h3_3 = await buildAuthorizationHeader({
    account: primaryAccount,
    validAfter: now + 300,
    validBefore: now + 3600,
  });
  await runAdversarialTest(
    'Authorization Window',
    'SEC-3.3',
    'Premature authorization (validAfter is 5 minutes in the future)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h3_3 },
    403
  );

  // 3.4 Inverted authorization window (validAfter > validBefore)
  const h3_4 = await buildAuthorizationHeader({
    account: primaryAccount,
    validAfter: now + 3600,
    validBefore: now + 60,
  });
  await runAdversarialTest(
    'Authorization Window',
    'SEC-3.4',
    'Inverted window (validAfter in future, validBefore sooner)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h3_4 },
    403
  );

  // 3.5 Malformed non-numeric timestamp strings
  const h3_5 = await buildAuthorizationHeader({
    account: primaryAccount,
    validAfter: 'immediate',
    validBefore: 'never',
  });
  await runAdversarialTest(
    'Authorization Window',
    'SEC-3.5',
    'Malformed non-numeric timestamp strings ("immediate", "never")',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h3_5 },
    403
  );

  // -------------------------------------------------------------------------
  // CATEGORY 4: Cryptographic Forgery & ECDSA Signature Tampering
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 4: Cryptographic Forgery & ECDSA Signature Tampering ---`);

  // 4.1 Tampered ECDSA r parameter
  const h4_1 = await buildAuthorizationHeader({
    account: primaryAccount,
    tamperSig: 'r',
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.1',
    'Tampered ECDSA r parameter (flipped bit)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_1 },
    403
  );

  // 4.2 Tampered ECDSA s parameter
  const h4_2 = await buildAuthorizationHeader({
    account: primaryAccount,
    tamperSig: 's',
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.2',
    'Tampered ECDSA s parameter (flipped bit)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_2 },
    403
  );

  // 4.3 Tampered ECDSA v parameter (invalid recovery ID)
  const h4_3 = await buildAuthorizationHeader({
    account: primaryAccount,
    tamperSig: 'v',
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.3',
    'Tampered ECDSA v parameter (invalid recovery ID 0x99)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_3 },
    403
  );

  // 4.4 Signer impersonation (signed by attacker, but payload claims from: primaryAccount)
  const h4_4 = await buildAuthorizationHeader({
    account: attackerAccount,
    claimFrom: primaryAccount.address,
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.4',
    'Signer impersonation (signed by Account A, claims from: Account B)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_4 },
    403
  );

  // 4.5 Cross-chain replay forgery (signed for Ethereum Mainnet 1 instead of Base 8453)
  const h4_5 = await buildAuthorizationHeader({
    account: primaryAccount,
    overrideDomain: {
      ...usdcDomain,
      chainId: 1,
    },
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.5',
    'Cross-chain replay forgery (domain chainId=1 instead of 8453)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_5 },
    403
  );

  // 4.6 Cross-contract replay forgery (signed for different contract)
  const h4_6 = await buildAuthorizationHeader({
    account: primaryAccount,
    overrideDomain: {
      ...usdcDomain,
      verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address, // Ethereum USDC
    },
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.6',
    'Cross-contract replay forgery (signed for different contract address)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_6 },
    403
  );

  // 4.7 Completely random 65-byte hex string
  const h4_7 = await buildAuthorizationHeader({
    account: primaryAccount,
    tamperSig: 'random',
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.7',
    'Random 65-byte hex string as signature',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_7 },
    403
  );

  // 4.8 Truncated signature (32 bytes)
  const h4_8 = await buildAuthorizationHeader({
    account: primaryAccount,
    tamperSig: 'truncate',
  });
  await runAdversarialTest(
    'Cryptographic Forgery',
    'SEC-4.8',
    'Truncated 32-byte signature',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: h4_8 },
    403
  );

  // -------------------------------------------------------------------------
  // CATEGORY 5: Corrupted / Malformed Payloads & Header Fuzzing
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 5: Corrupted Payloads & Header Fuzzing ---`);

  // 5.1 Corrupted Base64 token
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.1',
    'Corrupted Base64 characters in Bearer token',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: 'Bearer @@@not_valid_base64@@@===' },
    403
  );

  // 5.2 Base64 encoding of non-JSON plain text
  const plainTextB64 = Buffer.from('ATTACK_STRING_NOT_JSON').toString('base64');
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.2',
    'Base64 encoding of plain text (not JSON)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: `Bearer ${plainTextB64}` },
    403
  );

  // 5.3 Base64 encoding of truncated JSON
  const truncatedJsonB64 = Buffer.from('{"from": "0x123", "to":').toString('base64');
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.3',
    'Base64 encoding of truncated JSON syntax',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: `Bearer ${truncatedJsonB64}` },
    403
  );

  // 5.4 JSON array instead of object
  const arrayJsonB64 = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64');
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.4',
    'Base64 encoding of JSON array instead of authorization object',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: `Bearer ${arrayJsonB64}` },
    403
  );

  // 5.5 Missing required fields in JSON payload
  const missingFromHeader = await buildAuthorizationHeader({
    account: primaryAccount,
    rawPayloadModifier: (p) => {
      const { from, ...rest } = p;
      return rest;
    },
  });
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.5a',
    'JSON payload missing `from` property',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: missingFromHeader },
    403
  );

  const missingNonceHeader = await buildAuthorizationHeader({
    account: primaryAccount,
    rawPayloadModifier: (p) => {
      const { nonce, ...rest } = p;
      return rest;
    },
  });
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.5b',
    'JSON payload missing `nonce` property',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: missingNonceHeader },
    403
  );

  const missingSigHeader = await buildAuthorizationHeader({
    account: primaryAccount,
    rawPayloadModifier: (p) => {
      const { signature, ...rest } = p;
      return rest;
    },
  });
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.5c',
    'JSON payload missing `signature` property',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: missingSigHeader },
    403
  );

  // 5.6 Wrong data types in payload
  const typeConfusionHeader = await buildAuthorizationHeader({
    account: primaryAccount,
    rawPayloadModifier: (p) => ({
      ...p,
      from: 12345678,
      nonce: true,
      signature: ['0x123'],
    }),
  });
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.6',
    'Payload field type confusion (number from, boolean nonce, array sig)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: typeConfusionHeader },
    403
  );

  // 5.7 Empty Bearer token
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.7',
    'Empty Bearer token ("Bearer ")',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: 'Bearer ' },
    403
  );

  // 5.8 Unexpected auth scheme
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.8',
    'Unsupported auth scheme ("Basic dXNlcjpwYXNz")',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: 'Basic dXNlcjpwYXNz' },
    403
  );

  // 5.9 Alternative header: x-payment-signature
  const validAltSigHeader = await buildAuthorizationHeader({ account: primaryAccount });
  await runAdversarialTest(
    'Alternative Header',
    'SEC-5.9',
    'Valid authorization passed via `x-payment-signature` header',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { 'x-payment-signature': validAltSigHeader },
    200
  );

  // 5.10 Alternative header: x402-authorization
  const validX402AuthHeader = await buildAuthorizationHeader({ account: primaryAccount });
  await runAdversarialTest(
    'Alternative Header',
    'SEC-5.10',
    'Valid authorization passed via `x402-authorization` header',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { 'x402-authorization': validX402AuthHeader },
    200
  );

  // 5.11 Scheme: x402 prefix
  const validX402SchemeHeader = await buildAuthorizationHeader({
    account: primaryAccount,
    headerPrefix: 'x402 ',
  });
  await runAdversarialTest(
    'Alternative Header',
    'SEC-5.11',
    'Valid authorization passed with "x402 <base64>" prefix',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: validX402SchemeHeader },
    200
  );

  // 5.12 Oversized header fuzzing (>16KB header payload)
  const hugePayload = 'A'.repeat(16384);
  await runAdversarialTest(
    'Malformed Payload',
    'SEC-5.12',
    'Oversized header payload (16KB payload stress)',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    { Authorization: `Bearer ${hugePayload}` },
    [400, 403, 413, 431] // Clean error code, must NOT be 500
  );

  // -------------------------------------------------------------------------
  // CATEGORY 6: Input Sanitization, Injection & Query Fuzzing
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 6: Input Sanitization, Injection & Query Fuzzing ---`);

  // 6.1 No query parameters at all
  await runAdversarialTest(
    'Query Fuzzing',
    'INJ-6.1',
    'Zero query parameters provided',
    '/api/v1/compliance',
    {},
    400
  );

  // 6.2 Empty address parameter
  await runAdversarialTest(
    'Query Fuzzing',
    'INJ-6.2',
    'Empty address parameter (`?address=`)',
    '/api/v1/compliance?address=',
    {},
    400
  );

  // 6.3 Empty parcel_id parameter
  await runAdversarialTest(
    'Query Fuzzing',
    'INJ-6.3',
    'Empty parcel_id parameter (`?parcel_id=`)',
    '/api/v1/compliance?parcel_id=',
    {},
    400
  );

  // 6.4 Whitespace-only address with valid payment
  const validAuthHdr = await buildAuthorizationHeader({ account: primaryAccount });
  await runAdversarialTest(
    'Query Fuzzing',
    'INJ-6.4',
    'Whitespace-only address (`?address=%20%20%20`) with valid payment',
    '/api/v1/compliance?address=%20%20%20',
    { Authorization: validAuthHdr },
    200
  );

  // 6.5 SQL Injection in Minneapolis address: classic boolean injection
  await runAdversarialTest(
    'SQL Injection',
    'INJ-6.5a',
    "SQLi Minneapolis: ' OR '1'='1",
    "/api/v1/compliance?address=%27+OR+%271%27%3D%271&jurisdiction=minneapolis",
    { Authorization: validAuthHdr },
    200
  );

  // 6.5b SQL Injection in Minneapolis address: stacked query / drop table
  await runAdversarialTest(
    'SQL Injection',
    'INJ-6.5b',
    "SQLi Minneapolis: 1700 Penn'; DROP TABLE Code_Violations; --",
    "/api/v1/compliance?address=1700+Penn%27%3B+DROP+TABLE+Code_Violations%3B+--&jurisdiction=minneapolis",
    { Authorization: validAuthHdr },
    200
  );

  // 6.5c SQL Injection in Minneapolis address: UNION SELECT
  await runAdversarialTest(
    'SQL Injection',
    'INJ-6.5c',
    "SQLi Minneapolis: ' UNION SELECT null, null, null, null, null --",
    "/api/v1/compliance?address=%27+UNION+SELECT+null%2C+null%2C+null%2C+null%2C+null+--&jurisdiction=minneapolis",
    { Authorization: validAuthHdr },
    200
  );

  // 6.6a SQL Injection in Ramsey County parcel: PIN boolean injection
  await runAdversarialTest(
    'SQL Injection',
    'INJ-6.6a',
    "SQLi Ramsey County: 01-02-03-04-0001' OR '1'='1",
    "/api/v1/compliance?parcel_id=01-02-03-04-0001%27+OR+%271%27%3D%271&jurisdiction=ramsey",
    { Authorization: validAuthHdr },
    200
  );

  // 6.6b SQL Injection in Ramsey County parcel: numeric union
  await runAdversarialTest(
    'SQL Injection',
    'INJ-6.6b',
    "SQLi Ramsey County: 12345' UNION SELECT PIN, SITE_ADDR FROM Attributed_Parcel_Points --",
    "/api/v1/compliance?parcel_id=12345%27+UNION+SELECT+PIN%2C+SITE_ADDR+FROM+Attributed_Parcel_Points+--&jurisdiction=ramsey",
    { Authorization: validAuthHdr },
    200
  );

  // 6.7 NoSQL / Prototype pollution keys in query
  await runAdversarialTest(
    'Injection Fuzzing',
    'INJ-6.7',
    'NoSQL / Object prototype pollution query parameters',
    '/api/v1/compliance?address=1700+Penn&__proto__[admin]=true&constructor[prototype][polluted]=true',
    { Authorization: validAuthHdr },
    200
  );

  // 6.8 Path traversal attempt
  await runAdversarialTest(
    'Injection Fuzzing',
    'INJ-6.8a',
    'Directory traversal in address: ../../../../etc/passwd',
    '/api/v1/compliance?address=..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    { Authorization: validAuthHdr },
    200
  );

  // 6.8b Null byte injection
  await runAdversarialTest(
    'Injection Fuzzing',
    'INJ-6.8b',
    'Null byte injection: 1700 Penn Ave%00.html',
    '/api/v1/compliance?address=1700+Penn+Ave%00.html',
    { Authorization: validAuthHdr },
    200
  );

  // 6.8c Unicode, Emoji & Multilingual characters
  await runAdversarialTest(
    'Injection Fuzzing',
    'INJ-6.8c',
    'Unicode, Emoji & Multilingual characters (🏛️ 123 Minneapolis 🌟)',
    '/api/v1/compliance?address=%F0%9F%8F%9B%EF%B8%8F+123+Minneapolis+%F0%9F%8C%9F',
    { Authorization: validAuthHdr },
    200
  );

  // 6.8d XSS script tags in query
  await runAdversarialTest(
    'Injection Fuzzing',
    'INJ-6.8d',
    'XSS payload in address: <script>alert("xss")</script>',
    '/api/v1/compliance?address=%3Cscript%3Ealert(%22xss%22)%3C%2Fscript%3E',
    { Authorization: validAuthHdr },
    200
  );

  // 6.9 Extreme length query string parameter (3000 chars)
  const longAddress = 'A'.repeat(3000);
  await runAdversarialTest(
    'Stress Fuzzing',
    'INJ-6.9',
    'Extreme length query parameter (3,000 characters address)',
    `/api/v1/compliance?address=${longAddress}`,
    { Authorization: validAuthHdr },
    [200, 400, 414] // Clean response, definitely not 500
  );

  // -------------------------------------------------------------------------
  // CATEGORY 7: Positive Baseline & Settlement Verification
  // -------------------------------------------------------------------------
  console.log(`\n--- Category 7: Positive Baseline & Settlement Verification ---`);

  // 7.1 Legitimate Minneapolis query with valid signature
  const h7_1 = await buildAuthorizationHeader({ account: primaryAccount });
  await runAdversarialTest(
    'Positive Baseline',
    'BASE-7.1',
    'Legitimate Minneapolis query with valid EIP-3009 authorization',
    '/api/v1/compliance?address=1700+Penn+Ave+N&jurisdiction=minneapolis',
    { Authorization: h7_1 },
    200
  );

  // 7.2 Legitimate Ramsey County parcel query with valid signature
  const h7_2 = await buildAuthorizationHeader({ account: primaryAccount });
  await runAdversarialTest(
    'Positive Baseline',
    'BASE-7.2',
    'Legitimate Ramsey County parcel query with valid EIP-3009 authorization',
    '/api/v1/compliance?parcel_id=01-02-03-04-0001&jurisdiction=ramsey',
    { Authorization: h7_2 },
    200
  );

  // 7.3 Unauthenticated challenge check for baseline
  await runAdversarialTest(
    'Positive Baseline',
    'BASE-7.3',
    'Unauthenticated baseline request returns HTTP 402 Payment Required',
    '/api/v1/compliance?address=1700+Penn+Ave+N',
    {},
    402
  );

  // -------------------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------------------
  console.log(`\n======================================================================`);
  console.log(`TEST EXECUTION SUMMARY`);
  console.log(`======================================================================`);

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const serverErrors = results.filter((r) => r.actualStatus >= 500).length;

  console.log(`Total Adversarial Tests: ${total}`);
  console.log(`Passed:                 ${passed}`);
  console.log(`Failed:                 ${failed}`);
  console.log(`500 Server Crashes:     ${serverErrors}`);
  console.log(`Pass Rate:              ${((passed / total) * 100).toFixed(1)}%`);
  console.log(`======================================================================\n`);

  if (serverErrors > 0) {
    console.error(`CRITICAL WARNING: Detected ${serverErrors} HTTP 500+ server error responses!`);
    process.exit(1);
  }

  if (failed > 0) {
    console.error(`FAILURE: ${failed} tests failed!`);
    process.exit(1);
  }

  console.log(`ALL ADVERSARIAL STRESS TESTS PASSED WITH ZERO SERVER CRASHES!`);
}

main().catch((err) => {
  console.error('Fatal test harness execution error:', err);
  process.exit(1);
});
