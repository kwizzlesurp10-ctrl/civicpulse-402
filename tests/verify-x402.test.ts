import assert from 'node:assert';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { parse402Header } from '../lib/x402Fetch';
import {
  verifyEIP3009Authorization,
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
} from '../app/api/v1/compliance/route';

async function runTests() {
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

  console.log('\nAll x402 verification & cryptographic tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
