import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { parse402Header } from '../lib/x402Fetch';
import { getAddress } from 'viem';
import {
  GET,
  POST,
  verifyEIP3009Authorization,
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
} from '../app/api/v1/compliance/route';
import {
  DEFAULT_X402_PAY_TO,
  RETIRED_X402_PAY_TO,
} from '../lib/x402PayTo';

async function runTests() {
  console.log('0. Canonical advertised payTo...');
  assert.strictEqual(
    getAddress(EXPECTED_PAYEE),
    getAddress(DEFAULT_X402_PAY_TO),
    'Challenge payTo must be Keith Base Account'
  );
  assert.notStrictEqual(
    getAddress(EXPECTED_PAYEE),
    getAddress(RETIRED_X402_PAY_TO),
    'Retired payTo must not be advertised'
  );
  console.log(`   [PASS] EXPECTED_PAYEE=${EXPECTED_PAYEE}`);

  console.log('1. Testing RFC 7235 WWW-Authenticate x402 header parser...');
  const sampleHeader = `x402 realm="CivicPulse-Base", token="USDC", contract="${BASE_USDC_ADDRESS}", chain="8453", payTo="${EXPECTED_PAYEE}", amount="10000"`;
  const parsed = parse402Header(sampleHeader);

  assert.strictEqual(parsed.realm, 'CivicPulse-Base');
  assert.strictEqual(parsed.token, 'USDC');
  assert.strictEqual(parsed.chain, 8453);
  assert.strictEqual(parsed.payTo, EXPECTED_PAYEE);
  assert.strictEqual(parsed.amountUnits, 10000n);
  console.log('   [PASS] WWW-Authenticate header parsed accurately.');

  console.log('2. Testing EIP-3009 cryptographic signature generation & verification...');
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 3600;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const value = 10000n;

  const signature = await account.signTypedData({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: BASE_USDC_ADDRESS,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: EXPECTED_PAYEE,
      value,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const payload = {
    from: account.address,
    to: EXPECTED_PAYEE,
    value: value.toString(),
    validAfter,
    validBefore,
    nonce,
    signature,
  };

  const bearer = `Bearer ${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  const result = await verifyEIP3009Authorization(bearer, true);

  assert.strictEqual(result.valid, true, `Expected valid signature, got error: ${result.error}`);
  assert.strictEqual(result.signer?.toLowerCase(), account.address.toLowerCase());
  console.log(`   [PASS] Cryptographic EIP-3009 signature verified for signer ${result.signer}`);

  console.log('3. Testing Payee Mismatch Rejection (Security Warden Guard)...');
  const badPayload = { ...payload, to: '0x000000000000000000000000000000000000dEaD' };
  const badBearer = `Bearer ${Buffer.from(JSON.stringify(badPayload)).toString('base64')}`;
  const badResult = await verifyEIP3009Authorization(badBearer, true);

  assert.strictEqual(badResult.valid, false);
  console.log(`   [PASS] Payee mismatch blocked: ${badResult.error}`);

  const retiredPayload = { ...payload, to: RETIRED_X402_PAY_TO };
  const retiredBearer = `Bearer ${Buffer.from(JSON.stringify(retiredPayload)).toString('base64')}`;
  const retiredResult = await verifyEIP3009Authorization(retiredBearer, true);
  assert.strictEqual(retiredResult.valid, false);
  assert.match(retiredResult.error || '', /Retired payee/i);
  console.log(`   [PASS] Retired operator payTo blocked: ${retiredResult.error}`);

  console.log('4. Testing ReceiveWithAuthorization support...');
  const recvNonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const recvSignature = await account.signTypedData({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: BASE_USDC_ADDRESS,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: account.address,
      to: EXPECTED_PAYEE,
      value,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: recvNonce,
    },
  });

  const recvPayload = {
    from: account.address,
    to: EXPECTED_PAYEE,
    value: value.toString(),
    validAfter,
    validBefore,
    nonce: recvNonce,
    signature: recvSignature,
    primaryType: 'ReceiveWithAuthorization' as const,
  };
  const recvBearer = `Bearer ${Buffer.from(JSON.stringify(recvPayload)).toString('base64')}`;
  const recvResult = await verifyEIP3009Authorization(recvBearer, true);
  assert.strictEqual(recvResult.valid, true, `Expected valid ReceiveWithAuthorization, got: ${recvResult.error}`);
  console.log('   [PASS] ReceiveWithAuthorization signature verified successfully.');

  console.log('5. Testing FiatTokenV2 boundary check (validAfter >= now rejected)...');
  const futurePayload = {
    ...payload,
    validAfter: Math.floor(Date.now() / 1000) + 100,
  };
  const futureBearer = `Bearer ${Buffer.from(JSON.stringify(futurePayload)).toString('base64')}`;
  const futureResult = await verifyEIP3009Authorization(futureBearer, true);
  assert.strictEqual(futureResult.valid, false);
  assert.match(futureResult.error || '', /not yet active/i);
  console.log(`   [PASS] Future validAfter rejected: ${futureResult.error}`);

  console.log('6. Testing 402-before-400 probe behavior & v2 PAYMENT-REQUIRED Bazaar headers...');
  const getProbeRes = await GET(new NextRequest('https://civicpulse-402.vercel.app/api/v1/compliance'));
  assert.strictEqual(getProbeRes.status, 402, 'GET without params or payment must return 402 before 400');
  const getPrHeader = getProbeRes.headers.get('payment-required');
  assert(getPrHeader, 'GET 402 response must include PAYMENT-REQUIRED header');
  const getPrJson = JSON.parse(Buffer.from(getPrHeader, 'base64').toString('utf-8'));
  assert.strictEqual(getPrJson.x402Version, 2);
  assert.strictEqual(getPrJson.resource.serviceName, 'CivicPulse-402');
  assert.strictEqual(getPrJson.resource.tags.length, 5);
  assert.strictEqual(getPrJson.accepts[0].amount, '10000');
  assert.strictEqual(getPrJson.accepts[0].payTo, EXPECTED_PAYEE);
  assert.strictEqual(getPrJson.extensions.bazaar.info.input.method, 'GET');

  const postProbeRes = await POST(
    new NextRequest('https://civicpulse-402.vercel.app/api/v1/compliance', {
      method: 'POST',
      body: JSON.stringify({}),
    })
  );
  assert.strictEqual(postProbeRes.status, 402, 'POST without params or payment must return 402 before 400');
  const postPrHeader = postProbeRes.headers.get('payment-required');
  assert(postPrHeader, 'POST 402 response must include PAYMENT-REQUIRED header');
  const postPrJson = JSON.parse(Buffer.from(postPrHeader, 'base64').toString('utf-8'));
  assert.strictEqual(postPrJson.extensions.bazaar.info.input.method, 'POST');
  console.log('   [PASS] GET & POST return 402-before-400 with valid v2 PAYMENT-REQUIRED Bazaar headers.');

  console.log('7. Testing x402 v2 PAYMENT-SIGNATURE PaymentPayload unwrapping...');
  const v2Envelope = {
    x402Version: 2,
    accepted: getPrJson.accepts[0],
    payload: {
      authorization: {
        from: account.address,
        to: EXPECTED_PAYEE,
        value: value.toString(),
        validAfter,
        validBefore,
        nonce,
      },
      signature,
    },
  };
  const v2Header = Buffer.from(JSON.stringify(v2Envelope)).toString('base64');
  const v2Result = await verifyEIP3009Authorization(v2Header, true);
  assert.strictEqual(v2Result.valid, true, `Expected valid v2 PAYMENT-SIGNATURE, got: ${v2Result.error}`);
  console.log('   [PASS] x402 v2 PAYMENT-SIGNATURE payload verified successfully.');

  console.log('8. Testing discovery manifest JSON validity & server.json _meta compliance...');
  const jsonManifests = [
    'public/openapi.json',
    'public/.well-known/x402',
    'public/.well-known/api-catalog',
    'public/.well-known/mcp/server-card.json',
    'public/.well-known/mcp.json',
    'public/.well-known/agent-card.json',
    'public/.well-known/erc8004.json',
    'public/server.json',
    'server.json',
  ];
  for (const relPath of jsonManifests) {
    const raw = await fs.readFile(path.join(process.cwd(), relPath), 'utf-8');
    JSON.parse(raw);
  }
  const rootServer = JSON.parse(await fs.readFile(path.join(process.cwd(), 'server.json'), 'utf-8'));
  const pubServer = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public/server.json'), 'utf-8'));
  assert.strictEqual(rootServer.x402, undefined);
  assert.strictEqual(pubServer.x402, undefined);
  assert.strictEqual(
    rootServer._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.x402?.payTo,
    EXPECTED_PAYEE
  );
  assert.strictEqual(
    pubServer._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.x402?.payTo,
    EXPECTED_PAYEE
  );
  console.log('   [PASS] All discovery manifests parse cleanly and server.json _meta schema verified.');

  console.log('\nAll x402 verification & cryptographic tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
