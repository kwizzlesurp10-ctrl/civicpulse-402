import { runSaleWatch } from '../lib/saleWatch';

async function main(): Promise<void> {
  console.log('[sale-watch] Polling Base Mainnet (8453) USDC transfers (adaptive eth_getLogs)');
  const result = await runSaleWatch();
  console.log(
    `[sale-watch] Complete. Scanned ${result.scannedBlocks.toString()} blocks in ${result.chunksCount} planned chunk(s). New settlements: ${result.newSettlementsRecorded}. Cursor: ${result.cursorUpdatedTo.toString()}.`
  );
}

main().catch((err) => {
  console.error('[sale-watch] Fatal error:', err);
  process.exit(1);
});
