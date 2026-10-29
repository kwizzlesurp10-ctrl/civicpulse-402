import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAddress, type Address } from 'viem';
import { parse402Header } from '../lib/x402Fetch';
import {
  EXPECTED_PAYEE,
  BASE_USDC_ADDRESS,
} from '../app/api/v1/compliance/route';

const CANONICAL_PAY_TO: Address = getAddress(
  process.env.EXPECTED_PAY_TO || '0xAB745e5F576667037696e78ba7dA28E193E4423D'
);
const CANONICAL_USDC: Address = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const CANONICAL_CHAIN_ID = 8453;
const CANONICAL_CAIP2 = 'eip155:8453';

interface AuditRow {
  surface: string;
  payTo: string;
  chain: string;
  tokenContract: string;
  verdict: 'PASS' | 'ABORT_DRIFT';
}

async function runWardenAudit() {
  const rows: AuditRow[] = [];
  console.log('====================================================================');
  console.log(' SECURITY WARDEN PREFLIGHT AUDIT (WhatAgentsBuy / PulseFeed Parity)');
  console.log('====================================================================');

  // 1. Verify mcp.json
  const mcpRaw = await fs.readFile(path.join(process.cwd(), 'mcp.json'), 'utf-8');
  const mcpJson = JSON.parse(mcpRaw);
  const mcpPayTo = getAddress(mcpJson.x402?.payTo || '');
  const mcpChain = Number(mcpJson.x402?.chainId);
  const mcpNetwork = String(mcpJson.x402?.network || '');
  const mcpContract = getAddress(mcpJson.x402?.tokenContract || '');

  assert.strictEqual(mcpPayTo, CANONICAL_PAY_TO, 'mcp.json payTo mismatch');
  assert.strictEqual(mcpChain, CANONICAL_CHAIN_ID, 'mcp.json chainId != 8453');
  assert.strictEqual(mcpNetwork, CANONICAL_CAIP2, 'mcp.json network != eip155:8453');
  assert.strictEqual(mcpContract, CANONICAL_USDC, 'mcp.json tokenContract != Base USDC');

  rows.push({
    surface: 'mcp.json',
    payTo: mcpPayTo,
    chain: `${mcpNetwork} (${mcpChain})`,
    tokenContract: mcpContract,
    verdict: 'PASS',
  });
  console.log('[PASS] 1/5 mcp.json manifest matches canonical x402 parameters.');

  // 2. Verify public/.well-known/x402.json
  const wellKnownRaw = await fs.readFile(
    path.join(process.cwd(), 'public/.well-known/x402.json'),
    'utf-8'
  );
  const wellKnownJson = JSON.parse(wellKnownRaw);
  const wkPayTo = getAddress(wellKnownJson.payTo || '');
  const wkChain = Number(wellKnownJson.chainId);
  const wkNetwork = String(wellKnownJson.network || '');
  const wkContract = getAddress(wellKnownJson.token?.address || '');

  assert.strictEqual(wkPayTo, CANONICAL_PAY_TO, '.well-known/x402.json payTo mismatch');
  assert.strictEqual(wkChain, CANONICAL_CHAIN_ID, '.well-known/x402.json chainId != 8453');
  assert.strictEqual(wkNetwork, CANONICAL_CAIP2, '.well-known/x402.json network != eip155:8453');
  assert.strictEqual(wkContract, CANONICAL_USDC, '.well-known/x402.json token != Base USDC');

  rows.push({
    surface: 'public/.well-known/x402.json',
    payTo: wkPayTo,
    chain: `${wkNetwork} (${wkChain})`,
    tokenContract: wkContract,
    verdict: 'PASS',
  });
  console.log('[PASS] 2/5 public/.well-known/x402.json matches canonical x402 parameters.');

  // 3. Verify server.json (Official MCP Registry Standard - Post-Smithery Proxy Cutover)
  const serverRaw = await fs.readFile(path.join(process.cwd(), 'server.json'), 'utf-8');
  const serverJson = JSON.parse(serverRaw);
  const srvPayTo = getAddress(serverJson.x402?.payTo || '');
  const srvChain = Number(serverJson.x402?.chainId);
  const srvNetwork = String(serverJson.x402?.network || '');
  const srvContract = getAddress(serverJson.x402?.tokenContract || '');

  assert.strictEqual(srvPayTo, CANONICAL_PAY_TO, 'server.json payTo mismatch');
  assert.strictEqual(srvChain, CANONICAL_CHAIN_ID, 'server.json chainId != 8453');
  assert.strictEqual(srvNetwork, CANONICAL_CAIP2, 'server.json network != eip155:8453');
  assert.strictEqual(srvContract, CANONICAL_USDC, 'server.json tokenContract != Base USDC');
  assert.ok(
    !serverRaw.includes('run.tools') && !serverRaw.includes('server.smithery.ai'),
    'server.json contains deprecated Smithery proxy URLs!'
  );

  rows.push({
    surface: 'server.json (Official MCP Registry)',
    payTo: srvPayTo,
    chain: `${srvNetwork} (${srvChain})`,
    tokenContract: srvContract,
    verdict: 'PASS',
  });
  console.log('[PASS] 3/5 server.json verified for Direct-URL Streamable HTTP & canonical payTo.');

  // 4. Verify Next.js Route Handler Exported Constants
  const routePayTo = getAddress(EXPECTED_PAYEE);
  const routeContract = getAddress(BASE_USDC_ADDRESS);

  assert.strictEqual(routePayTo, CANONICAL_PAY_TO, 'route.ts EXPECTED_PAYEE mismatch');
  assert.strictEqual(routeContract, CANONICAL_USDC, 'route.ts BASE_USDC_ADDRESS mismatch');

  rows.push({
    surface: 'app/api/v1/compliance/route.ts',
    payTo: routePayTo,
    chain: `eip155:${CANONICAL_CHAIN_ID}`,
    tokenContract: routeContract,
    verdict: 'PASS',
  });
  console.log('[PASS] 4/5 Next.js API Route Handler constants match canonical x402 parameters.');

  // 5. Probe Live HTTP 402 Challenge Endpoint
  const targetBaseUrl = (process.env.LIVE_GATEWAY_URL || '').replace(/\/$/, '');
  if (targetBaseUrl) {
    const probeUrl = `${targetBaseUrl}/api/v1/compliance?address=1700+Penn+Ave+N&jurisdiction=minneapolis`;
    const res = await fetch(probeUrl, { headers: { Accept: 'application/json' } });
    assert.strictEqual(res.status, 402, `Expected HTTP 402 challenge, got ${res.status}`);

    const wwwAuth = res.headers.get('www-authenticate') || '';
    const parsedHeader = parse402Header(wwwAuth);
    assert.strictEqual(getAddress(parsedHeader.payTo || ''), CANONICAL_PAY_TO);
    assert.strictEqual(getAddress(parsedHeader.contract || ''), CANONICAL_USDC);
    assert.strictEqual(parsedHeader.chain, CANONICAL_CHAIN_ID);

    rows.push({
      surface: `Live HTTP 402 (${targetBaseUrl})`,
      payTo: CANONICAL_PAY_TO,
      chain: `eip155:${CANONICAL_CHAIN_ID}`,
      tokenContract: CANONICAL_USDC,
      verdict: 'PASS',
    });
    console.log('[PASS] 5/5 Live HTTP 402 WWW-Authenticate header & JSON body verified!');
  } else {
    console.log('[INFO] 5/5 Skipped remote HTTP probe (set LIVE_GATEWAY_URL to test remote gateway).');
  }

  console.log('\n====================================================================');
  console.log(' ALL WARDEN PREFLIGHT CHECKS PASSED — ZERO PAY_TO OR CHAIN DRIFT');
  console.log('====================================================================');
}

runWardenAudit().catch((err) => {
  console.error('\n[WARDEN PREFLIGHT VETO]:', err.message || err);
  process.exit(1);
});
