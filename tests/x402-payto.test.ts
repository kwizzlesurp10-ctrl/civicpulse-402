import assert from 'node:assert';
import { getAddress } from 'viem';
import {
  DEFAULT_X402_PAY_TO,
  RETIRED_X402_PAY_TO,
  EXPECTED_PAYEE,
  isRetiredPayee,
} from '../lib/x402PayTo';

function runTests(): void {
  assert.strictEqual(
    getAddress(DEFAULT_X402_PAY_TO),
    getAddress('0x0d25A44f74868eCE53B305C97139CF4B62963410'),
    'DEFAULT_X402_PAY_TO must be Keith Base Account'
  );
  assert.strictEqual(
    getAddress(EXPECTED_PAYEE),
    getAddress(DEFAULT_X402_PAY_TO),
    'EXPECTED_PAYEE must default to canonical payTo when env is unset'
  );
  assert(isRetiredPayee(RETIRED_X402_PAY_TO));
  assert(isRetiredPayee('0xab745e5f576667037696e78ba7da28e193e4423d'));
  assert(!isRetiredPayee(DEFAULT_X402_PAY_TO));
  console.log('[PASS] x402 payTo canonical address and retired-payee guard');
}

runTests();
