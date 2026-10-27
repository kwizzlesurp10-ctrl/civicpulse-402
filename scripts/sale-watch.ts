#!/usr/bin/env node

import { runSaleWatch } from '../lib/saleWatch';

function printHelp(): void {
  console.log(`
Usage: sale-watch [options]

Options:
  --dry-run              Query Base RPC and log findings without modifying docs/
  --start-block <n>      Override starting block height
  --end-block <n>        Override ending block height
  --chunk-size <n>       Override maximum block chunk size (default: 2000)
  --cursor-path <path>   Override cursor JSON file path
  --ledger-path <path>   Override ledger Markdown file path
  --rpc-url <url>        Override primary Base RPC URL
  --help, -h             Display this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let dryRun = false;
  let startBlock: bigint | undefined;
  let endBlock: bigint | undefined;
  let chunkSize: bigint | undefined;
  let cursorPath: string | undefined;
  let ledgerPath: string | undefined;
  let rpcUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--start-block') {
      const val = args[++i];
      if (!val || isNaN(Number(val))) {
        console.error('Error: --start-block requires a numeric argument');
        process.exit(1);
      }
      startBlock = BigInt(val);
    } else if (arg === '--end-block') {
      const val = args[++i];
      if (!val || isNaN(Number(val))) {
        console.error('Error: --end-block requires a numeric argument');
        process.exit(1);
      }
      endBlock = BigInt(val);
    } else if (arg === '--chunk-size') {
      const val = args[++i];
      if (!val || isNaN(Number(val))) {
        console.error('Error: --chunk-size requires a numeric argument');
        process.exit(1);
      }
      chunkSize = BigInt(val);
    } else if (arg === '--cursor-path') {
      cursorPath = args[++i];
    } else if (arg === '--ledger-path') {
      ledgerPath = args[++i];
    } else if (arg === '--rpc-url') {
      rpcUrl = args[++i];
    }
  }

  // Also support environment variable overrides
  if (!startBlock && process.env.SALE_WATCH_START_BLOCK) {
    startBlock = BigInt(process.env.SALE_WATCH_START_BLOCK);
  }
  if (!rpcUrl && process.env.BASE_RPC_URL) {
    rpcUrl = process.env.BASE_RPC_URL;
  }

  try {
    const result = await runSaleWatch({
      dryRun,
      startBlock,
      endBlock,
      chunkSize,
      cursorPath,
      ledgerPath,
      rpcUrl,
    });

    console.log(
      `[sale-watch] Finished successfully. Blocks: ${result.fromBlock}..${result.toBlock} (${result.scannedBlocks} blocks). Settlements recorded: ${result.newSettlementsRecorded}.`
    );
    process.exit(0);
  } catch (err: any) {
    console.error(`[sale-watch] Fatal error during indexing:`, err?.message || err);
    process.exit(1);
  }
}

main();
