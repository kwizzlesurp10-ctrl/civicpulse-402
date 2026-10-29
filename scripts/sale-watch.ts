import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPublicClient,
  http,
  fallback,
  parseAbiItem,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO_WALLET: Address =
  (process.env.NEXT_PUBLIC_PAY_TO_ADDRESS as Address) ||
  '0xAB745e5F576667037696e78ba7dA28E193E4423D';

const LEDGER_PATH = path.join(process.cwd(), 'docs/LIVE_LEDGER.md');
const CURSOR_PATH = path.join(process.cwd(), 'docs/.sale-watch-cursor.json');

const CHUNK_SIZE = 2_000n;
const DEFAULT_LOOKBACK_BLOCKS = 7_200n;

const client = createPublicClient({
  chain: base,
  transport: fallback([
    http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
    http('https://base.llamarpc.com'),
    http('https://1rpc.io/base'),
  ]),
});

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

interface CursorState {
  lastScannedBlock: string;
  updatedAt: string;
  payTo: Address;
}

const INITIAL_LEDGER_HEADER = `# LIVE SETTLEMENT LEDGER (CivicPulse 402 — Base Mainnet)

Publicly verifiable, append-only record of autonomous x402 USDC settlements on Base Mainnet (\`eip155:8453\`).
- **Token Contract**: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` (Native Base USDC)
- **Verified Payee**: \`0xAB745e5F576667037696e78ba7dA28E193E4423D\`

| Timestamp (UTC) | Endpoint | Query | Payer | Amount | BaseScan Tx | Block |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
`;

async function ensureLedgerFile(): Promise<string> {
  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  try {
    return await fs.readFile(LEDGER_PATH, 'utf-8');
  } catch {
    await fs.writeFile(LEDGER_PATH, INITIAL_LEDGER_HEADER, 'utf-8');
    return INITIAL_LEDGER_HEADER;
  }
}

async function loadCursor(latestBlock: bigint): Promise<bigint> {
  try {
    const raw = await fs.readFile(CURSOR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CursorState;
    const saved = BigInt(parsed.lastScannedBlock);
    if (saved > 0n && saved <= latestBlock) {
      return saved + 1n;
    }
  } catch {
    // Cursor file doesn't exist yet
  }
  return latestBlock > DEFAULT_LOOKBACK_BLOCKS
    ? latestBlock - DEFAULT_LOOKBACK_BLOCKS
    : 1n;
}

async function saveCursor(blockNumber: bigint): Promise<void> {
  const state: CursorState = {
    lastScannedBlock: blockNumber.toString(),
    updatedAt: new Date().toISOString(),
    payTo: PAY_TO_WALLET,
  };
  await fs.mkdir(path.dirname(CURSOR_PATH), { recursive: true });
  await fs.writeFile(CURSOR_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

async function runSaleWatch() {
  console.log(`[sale-watch] Polling Base Mainnet (8453) USDC transfers -> ${PAY_TO_WALLET}`);

  const latestBlock = await client.getBlockNumber();
  let fromBlock = await loadCursor(latestBlock);

  if (fromBlock > latestBlock) {
    console.log(`[sale-watch] Already up to date at block ${latestBlock.toString()}.`);
    return;
  }

  const maxCatchup = 50_000n;
  if (latestBlock - fromBlock > maxCatchup) {
    fromBlock = latestBlock - maxCatchup;
  }

  console.log(
    `[sale-watch] Scanning block range ${fromBlock.toString()} -> ${latestBlock.toString()}`
  );

  let ledgerContent = await ensureLedgerFile();
  let newSettlementsCount = 0;
  const blockTimestampCache = new Map<bigint, string>();

  let cursor = fromBlock;
  while (cursor <= latestBlock) {
    const toBlock = cursor + CHUNK_SIZE - 1n > latestBlock ? latestBlock : cursor + CHUNK_SIZE - 1n;

    const logs = await client.getLogs({
      address: BASE_USDC,
      event: TRANSFER_EVENT,
      args: {
        to: PAY_TO_WALLET,
      },
      fromBlock: cursor,
      toBlock,
    });

    for (const log of logs) {
      const txHash = log.transactionHash as Hex;
      const blockNum = log.blockNumber;
      const from = log.args.from as Address;
      const value = log.args.value ?? 0n;

      if (!txHash || !blockNum || !from) continue;

      if (ledgerContent.toLowerCase().includes(txHash.toLowerCase())) {
        continue;
      }

      let isoTime = blockTimestampCache.get(blockNum);
      if (!isoTime) {
        try {
          const blk = await client.getBlock({ blockNumber: blockNum });
          isoTime = new Date(Number(blk.timestamp) * 1000).toISOString();
        } catch {
          isoTime = new Date().toISOString();
        }
        blockTimestampCache.set(blockNum, isoTime);
      }

      const amountUsdc = Number(formatUnits(value, 6)).toFixed(2);
      const shortPayer = `${from.slice(0, 6)}...${from.slice(-4)}`;
      const shortTx = `${txHash.slice(0, 10)}...${txHash.slice(-6)}`;
      const baseScanUrl = `https://basescan.org/tx/${txHash}`;

      const row = `| ${isoTime} | \`/api/v1/compliance\` | \`on-chain-sale-watch\` | [\`${shortPayer}\`](https://basescan.org/address/${from}) | **${amountUsdc} USDC** | [\`${shortTx}\`](${baseScanUrl}) | \`${blockNum.toString()}\` |\n`;

      await fs.appendFile(LEDGER_PATH, row, 'utf-8');
      ledgerContent += row;
      newSettlementsCount++;

      console.log(
        `[sale-watch] + Recorded settlement: ${amountUsdc} USDC from ${from} (tx: ${txHash})`
      );
    }

    cursor = toBlock + 1n;
  }

  await saveCursor(latestBlock);
  console.log(
    `[sale-watch] Complete. New settlements logged: ${newSettlementsCount}. Cursor saved at block ${latestBlock.toString()}.`
  );
}

runSaleWatch().catch((err) => {
  console.error('[sale-watch] Fatal error:', err);
  process.exit(1);
});
