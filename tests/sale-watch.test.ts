import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  calculateBlockRanges,
  parseExistingTxHashes,
  parseMaxBlockFromLedger,
  formatLedgerRow,
  deduplicateEvents,
  loadCursor,
  saveCursor,
  runSaleWatch,
  CANONICAL_CHAIN_ID,
  BASE_USDC_ADDRESS,
  EXPECTED_PAYEE,
  type SettlementEvent,
  type CursorState,
} from '../lib/saleWatch';

async function runTestSuite() {
  console.log('================================================================');
  console.log('🧪 Running CivicPulse-402 sale-watch Automated Test Suite');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // Suite 1: Chunking Logic Boundaries & Invariant Tests
  // ---------------------------------------------------------------------------
  console.log('▶ Suite 1: Chunking Logic Boundaries & Invariants');

  // Test 1.1: fromBlock > toBlock returns empty array
  const emptyRanges = calculateBlockRanges(5000n, 4000n, 2000n);
  assert.strictEqual(emptyRanges.length, 0, 'Should return empty array when fromBlock > toBlock');
  console.log('  ✔ Passed: calculateBlockRanges handles inverted range (from > to)');

  // Test 1.2: fromBlock == toBlock returns exactly 1 single-block chunk
  const singleBlock = calculateBlockRanges(1000n, 1000n, 2000n);
  assert.strictEqual(singleBlock.length, 1);
  assert.strictEqual(singleBlock[0].from, 1000n);
  assert.strictEqual(singleBlock[0].to, 1000n);
  console.log('  ✔ Passed: calculateBlockRanges handles single-block range (from == to)');

  // Test 1.3: Exact chunk boundary (size == 2000)
  const exactChunk = calculateBlockRanges(1000n, 2999n, 2000n);
  assert.strictEqual(exactChunk.length, 1);
  assert.strictEqual(exactChunk[0].from, 1000n);
  assert.strictEqual(exactChunk[0].to, 2999n);
  assert.strictEqual(exactChunk[0].to - exactChunk[0].from + 1n, 2000n);
  console.log('  ✔ Passed: calculateBlockRanges handles exact chunk boundary (2000 blocks)');

  // Test 1.4: One block over chunk boundary (2001 blocks -> 2 chunks)
  const twoChunks = calculateBlockRanges(1000n, 3000n, 2000n);
  assert.strictEqual(twoChunks.length, 2);
  assert.strictEqual(twoChunks[0].from, 1000n);
  assert.strictEqual(twoChunks[0].to, 2999n);
  assert.strictEqual(twoChunks[1].from, 3000n);
  assert.strictEqual(twoChunks[1].to, 3000n);
  console.log('  ✔ Passed: calculateBlockRanges splits 2001 blocks into [2000, 1]');

  // Test 1.5: Multi-chunk large span with mathematical invariants
  const start = 100_000n;
  const end = 107_453n;
  const chunkSize = 2000n;
  const multiChunks = calculateBlockRanges(start, end, chunkSize);
  assert.strictEqual(multiChunks.length, 4);

  let totalCovered = 0n;
  for (let i = 0; i < multiChunks.length; i++) {
    const chunk = multiChunks[i];
    const span = chunk.to - chunk.from + 1n;
    assert(span <= chunkSize, `Chunk ${i} span ${span} exceeds chunkSize ${chunkSize}`);
    totalCovered += span;

    if (i > 0) {
      assert.strictEqual(
        chunk.from,
        multiChunks[i - 1].to + 1n,
        `Gap detected between chunk ${i - 1} and ${i}`
      );
    }
  }
  assert.strictEqual(multiChunks[0].from, start);
  assert.strictEqual(multiChunks[multiChunks.length - 1].to, end);
  assert.strictEqual(totalCovered, end - start + 1n);
  console.log('  ✔ Passed: Invariant checks satisfied for arbitrary block ranges (gapless, bounded, complete)');

  // Test 1.6: Invalid chunk size throws
  assert.throws(() => calculateBlockRanges(100n, 200n, 0n), /maxChunkSize must be greater than 0/);
  console.log('  ✔ Passed: calculateBlockRanges rejects non-positive chunk size');

  // ---------------------------------------------------------------------------
  // Suite 2: Deduplication and Row Formatting Tests
  // ---------------------------------------------------------------------------
  console.log('\n▶ Suite 2: Deduplication & Row Formatting');

  // Test 2.1: parseExistingTxHashes extracts normalized lowercase hashes
  const sampleLedger = `
# LIVE_LEDGER — CivicPulse-402 Base Mainnet Settlements
| Timestamp (UTC) | Block | Tx Hash | From | Amount (USDC) | Type | BaseScan |
|---|---|---|---|---|---|---|
| 2026-10-27T14:00:00Z | 53160000 | [0x1111111111111111111111111111111111111111111111111111111111111111](https://basescan.org/tx/0x1111111111111111111111111111111111111111111111111111111111111111) | \`0xaaa\` | 0.010000 | Transfer | [View](https://basescan.org/tx/0x1111111111111111111111111111111111111111111111111111111111111111) |
| 2026-10-27T14:15:00Z | 53160450 | [0x2222222222222222222222222222222222222222222222222222222222222222](https://basescan.org/tx/0x2222222222222222222222222222222222222222222222222222222222222222) | \`0xbbb\` | 0.050000 | TransferWithAuthorization | [View](https://basescan.org/tx/0x2222222222222222222222222222222222222222222222222222222222222222) |
`;
  const existingHashes = parseExistingTxHashes(sampleLedger);
  assert.strictEqual(existingHashes.size, 2);
  assert(existingHashes.has('0x1111111111111111111111111111111111111111111111111111111111111111'));
  assert(existingHashes.has('0x2222222222222222222222222222222222222222222222222222222222222222'));
  console.log('  ✔ Passed: parseExistingTxHashes extracts 66-character tx hashes from ledger table');

  // Test 2.2: parseMaxBlockFromLedger
  const maxBlock = parseMaxBlockFromLedger(sampleLedger);
  assert.strictEqual(maxBlock, 53160450n);
  assert.strictEqual(parseMaxBlockFromLedger(''), null);
  console.log('  ✔ Passed: parseMaxBlockFromLedger identifies maximum block height');

  // Test 2.3: formatLedgerRow formatting and regex re-ingestion
  const sampleEvent: SettlementEvent = {
    txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    blockNumber: 53161000n,
    from: '0x1234567890123456789012345678901234567890',
    to: EXPECTED_PAYEE,
    amountUnits: 10_000n,
    amountUsdc: '0.010000',
    timestampUtc: '2026-10-27T14:30:00.000Z',
    eventType: 'TransferWithAuthorization',
  };
  const row = formatLedgerRow(sampleEvent);
  assert(row.includes('https://basescan.org/tx/0x3333333333333333333333333333333333333333333333333333333333333333'));
  assert(row.includes('53161000'));
  assert(row.includes('0.010000'));
  assert(row.includes('TransferWithAuthorization'));
  assert(row.includes('2026-10-27T14:30:00.000Z'));

  const parsedFromRow = parseExistingTxHashes(row);
  assert(parsedFromRow.has('0x3333333333333333333333333333333333333333333333333333333333333333'));
  console.log('  ✔ Passed: formatLedgerRow generates compliant Markdown row verifiable by hash parser');

  // Test 2.4: deduplicateEvents eliminates pre-existing and duplicate in-batch events
  const batchEvents: SettlementEvent[] = [
    { ...sampleEvent, txHash: '0x1111111111111111111111111111111111111111111111111111111111111111' }, // Already in ledger
    { ...sampleEvent, txHash: '0x4444444444444444444444444444444444444444444444444444444444444444' }, // New
    { ...sampleEvent, txHash: '0x4444444444444444444444444444444444444444444444444444444444444444' }, // Duplicate in batch
  ];
  const deduplicated = deduplicateEvents(batchEvents, existingHashes);
  assert.strictEqual(deduplicated.length, 1);
  assert.strictEqual(deduplicated[0].txHash, '0x4444444444444444444444444444444444444444444444444444444444444444');
  console.log('  ✔ Passed: deduplicateEvents eliminates pre-recorded and in-batch duplicate transactions');

  // ---------------------------------------------------------------------------
  // Suite 3: Cursor Persistence File I/O & Validation Tests
  // ---------------------------------------------------------------------------
  console.log('\n▶ Suite 3: Cursor Persistence File I/O & Validation');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-test-'));
  const testCursorPath = path.join(tmpDir, 'test-cursor.json');

  // Test 3.1: loadCursor on missing file returns default state
  const defaultCursor = await loadCursor(testCursorPath, 53160000n);
  assert.strictEqual(defaultCursor.chainId, CANONICAL_CHAIN_ID);
  assert.strictEqual(defaultCursor.contractAddress, BASE_USDC_ADDRESS);
  assert.strictEqual(defaultCursor.payeeAddress, EXPECTED_PAYEE);
  assert.strictEqual(defaultCursor.lastBlock, 53160000);
  assert.strictEqual(defaultCursor.totalSettlementsFound, 0);
  console.log('  ✔ Passed: loadCursor provides deterministic default state on missing cursor file');

  // Test 3.2: saveCursor persists state and loadCursor retrieves it accurately
  const stateToSave: CursorState = {
    version: '1.0.0',
    chainId: CANONICAL_CHAIN_ID,
    contractAddress: BASE_USDC_ADDRESS,
    payeeAddress: EXPECTED_PAYEE,
    lastBlock: 53162000,
    lastSyncedAt: '2026-10-27T15:00:00.000Z',
    totalSettlementsFound: 42,
  };
  await saveCursor(testCursorPath, stateToSave);

  const reloaded = await loadCursor(testCursorPath);
  assert.deepStrictEqual(reloaded, stateToSave);
  console.log('  ✔ Passed: saveCursor and loadCursor achieve lossless round-trip persistence');

  // Test 3.3: saveCursor rejects invalid negative block
  await assert.rejects(
    async () => saveCursor(testCursorPath, { ...stateToSave, lastBlock: -1 }),
    /Invalid cursor lastBlock/
  );
  console.log('  ✔ Passed: saveCursor rejects invalid negative block height');

  // Clean up temporary test files
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ---------------------------------------------------------------------------
  // Suite 4: Live Base Mainnet Dry-Run Integration Test
  // ---------------------------------------------------------------------------
  console.log('\n▶ Suite 4: Live Base Mainnet Dry-Run Integration Test');

  const dryRunTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-live-'));
  const dummyLedgerPath = path.join(dryRunTmpDir, 'LIVE_LEDGER.md');
  const dummyCursorPath = path.join(dryRunTmpDir, '.cursor.json');

  // Perform live dry run against Base Mainnet RPC
  const dryRunResult = await runSaleWatch({
    dryRun: true,
    chunkSize: 100n,
    ledgerPath: dummyLedgerPath,
    cursorPath: dummyCursorPath,
  });

  assert.strictEqual(dryRunResult.dryRun, true);
  assert(dryRunResult.fromBlock > 0n, 'fromBlock must be greater than 0');
  assert(dryRunResult.toBlock >= dryRunResult.fromBlock, 'toBlock must be >= fromBlock');
  assert(dryRunResult.toBlock > 53_000_000n, 'toBlock must be at current Base block tip (>53M)');
  assert.strictEqual(dryRunResult.newSettlementsRecorded, 0, 'Dry-run must not report committed rows');

  // Verify dry-run invariant: no files created in dummy destination
  assert(!fs.existsSync(dummyLedgerPath), 'Dry-run must not create or write to ledger file');
  assert(!fs.existsSync(dummyCursorPath), 'Dry-run must not create or write to cursor file');

  fs.rmSync(dryRunTmpDir, { recursive: true, force: true });
  console.log('  ✔ Passed: Live Base Mainnet dry-run executed with exit status 0 and zero mutations');

  console.log('\n================================================================');
  console.log('✅ ALL SALE-WATCH TEST SUITES PASSED (100% SUCCESS)');
  console.log('================================================================');
}

runTestSuite().catch((err) => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
