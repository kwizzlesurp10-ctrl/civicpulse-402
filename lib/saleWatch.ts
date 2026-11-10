import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  fallback,
  http,
  parseAbiItem,
  type Address,
  type GetLogsReturnType,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { EXPECTED_PAYEE } from './x402PayTo';

export { EXPECTED_PAYEE } from './x402PayTo';

// Canonical Invariants
export const CANONICAL_CHAIN_ID = 8453;
export const CANONICAL_NETWORK = 'eip155:8453';

export const BASE_USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Planned scan segment size; adaptive getLogs may split further when RPC rejects the range. */
export const DEFAULT_CHUNK_SIZE = 2000n;
/** Hard ceiling for a single planned segment (adaptive fetch still shrinks on provider errors). */
export const DEFAULT_MAX_LOG_RANGE_BLOCKS = 50n;
export const DEFAULT_MAX_BLOCKS_PER_RUN = 30_000n;
export const DEFAULT_CONFIRMATION_LAG = 5n;
export const LOG_FETCH_MAX_ATTEMPTS = 5;
export const DEFAULT_CURSOR_PATH = 'docs/.sale-watch-cursor.json';
export const DEFAULT_LEDGER_PATH = 'docs/LIVE_LEDGER.md';

// ERC-20 & EIP-3009 ABI items
export const transferEventAbi = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
export const authorizationUsedEventAbi = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'
);
export const AUTHORIZATION_USED_TOPIC0: Hex =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';

export interface CursorState {
  version: string;
  chainId: number;
  contractAddress: string;
  payeeAddress: string;
  lastBlock: number;
  lastSyncedAt: string;
  totalSettlementsFound: number;
}

export type SettlementEventType = 'Transfer' | 'AuthorizationUsed' | 'TransferWithAuthorization';

export interface SettlementEvent {
  txHash: `0x${string}`;
  blockNumber: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
  amountUnits: bigint;
  amountUsdc: string;
  timestampUtc: string;
  eventType: SettlementEventType;
}

export interface SaleWatchConfig {
  rpcUrl?: string;
  usdcAddress?: Address;
  payToAddress?: Address;
  cursorPath?: string;
  ledgerPath?: string;
  chunkSize?: bigint;
  maxBlocksPerRun?: bigint;
  confirmations?: bigint;
  startBlock?: bigint;
  endBlock?: bigint;
  dryRun?: boolean;
  logger?: (msg: string) => void;
}

export interface SaleWatchResult {
  fromBlock: bigint;
  toBlock: bigint;
  scannedBlocks: bigint;
  chunksCount: number;
  eventsFound: number;
  newSettlementsRecorded: number;
  dryRun: boolean;
  cursorUpdatedTo: bigint;
}

export const LEDGER_HEADER = `# LIVE_LEDGER — CivicPulse-402 Base Mainnet Settlements

Canonical Payee: \`${EXPECTED_PAYEE}\`
USDC Contract: \`${BASE_USDC_ADDRESS}\`
Network: \`${CANONICAL_NETWORK}\` (Base Mainnet)

| Timestamp (UTC) | Block | Tx Hash | From | Amount (USDC) | Type | BaseScan |
|---|---|---|---|---|---|---|
`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the RPC refuses the requested eth_getLogs block span. */
export function isBlockRangeLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('eth_getlogs is limited') ||
    message.includes('block range') ||
    message.includes('range too large') ||
    message.includes('query returned more than') ||
    message.includes('max block range') ||
    message.includes('maximum block range') ||
    (message.includes('limited to') && message.includes('block'))
  );
}

/** True for rate limits and other errors worth retrying with backoff. */
export function isTransientRpcError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('504') ||
    message.includes('temporarily unavailable') ||
    message.includes('over rate limit')
  );
}

export interface GetLogsAdaptiveParams {
  address: Address;
  event: typeof transferEventAbi;
  args: { to: Address };
}

/**
 * Creates a Viem public client configured with resilient RPC transport fallbacks.
 */
export function createBaseClient(rpcUrl?: string) {
  const transports = [];
  const explicit = rpcUrl || process.env.BASE_RPC_URL;
  if (explicit) {
    transports.push(http(explicit, { retryCount: 3, timeout: 30_000 }));
  }
  if (!explicit || explicit !== 'https://mainnet.base.org') {
    transports.push(http('https://mainnet.base.org', { retryCount: 3, timeout: 30_000 }));
  }
  transports.push(
    http('https://base.llamarpc.com', { retryCount: 3, timeout: 30_000 }),
    http('https://base-rpc.publicnode.com', { retryCount: 3, timeout: 30_000 }),
    http('https://1rpc.io/base', { retryCount: 2, timeout: 30_000 })
  );

  return createPublicClient({
    chain: base,
    transport: fallback(transports, { rank: false }),
  });
}

type SaleWatchPublicClient = ReturnType<typeof createBaseClient>;

export type UsdcTransferLog = GetLogsReturnType<typeof transferEventAbi>[number];
export type UsdcTransferLogs = GetLogsReturnType<typeof transferEventAbi>;

async function getLogsWithRetry(
  client: SaleWatchPublicClient,
  params: {
    address: Address;
    event: typeof transferEventAbi;
    args: { to: Address };
    fromBlock: bigint;
    toBlock: bigint;
  },
  maxAttempts: number = LOG_FETCH_MAX_ATTEMPTS
): Promise<UsdcTransferLogs> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.getLogs(params);
    } catch (err) {
      lastError = err;
      if (isBlockRangeLimitError(err)) {
        throw err;
      }
      if (isTransientRpcError(err) && attempt < maxAttempts - 1) {
        const delayMs = Math.min(750 * 2 ** attempt, 8_000);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Fetches USDC Transfer logs for a block range, starting at the full span and
 * recursively halving when the provider rejects the range as too large.
 */
export async function fetchUsdcTransferLogsAdaptive(
  client: SaleWatchPublicClient,
  logFilter: GetLogsAdaptiveParams,
  fromBlock: bigint,
  toBlock: bigint
): Promise<UsdcTransferLogs> {
  if (fromBlock > toBlock) {
    return [];
  }

  try {
    return await getLogsWithRetry(client, {
      ...logFilter,
      fromBlock,
      toBlock,
    });
  } catch (err) {
    if (!isBlockRangeLimitError(err) || fromBlock === toBlock) {
      throw err;
    }
    const span = toBlock - fromBlock + 1n;
    const mid = fromBlock + span / 2n - 1n;
    const left = await fetchUsdcTransferLogsAdaptive(client, logFilter, fromBlock, mid);
    const right = await fetchUsdcTransferLogsAdaptive(client, logFilter, mid + 1n, toBlock);
    return [...left, ...right];
  }
}

/**
 * Calculates deterministic, gapless chunk ranges not exceeding maxChunkSize.
 */
export function calculateBlockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maxChunkSize: bigint = DEFAULT_CHUNK_SIZE
): Array<{ from: bigint; to: bigint }> {
  if (fromBlock > toBlock) {
    return [];
  }
  if (maxChunkSize <= 0n) {
    throw new Error(`maxChunkSize must be greater than 0, got ${maxChunkSize}`);
  }

  const ranges: Array<{ from: bigint; to: bigint }> = [];
  let current = fromBlock;

  while (current <= toBlock) {
    const chunkEnd = current + maxChunkSize - 1n < toBlock ? current + maxChunkSize - 1n : toBlock;
    ranges.push({ from: current, to: chunkEnd });
    current = chunkEnd + 1n;
  }

  return ranges;
}

/**
 * Parses all 66-character hex transaction hashes from the markdown ledger.
 */
export function parseExistingTxHashes(ledgerContent: string): Set<string> {
  const hashes = new Set<string>();
  if (!ledgerContent) return hashes;

  const regex = /0x[a-fA-F0-9]{64}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(ledgerContent)) !== null) {
    hashes.add(match[0].toLowerCase());
  }

  return hashes;
}

/**
 * Parses the maximum recorded block number from the ledger markdown table.
 */
export function parseMaxBlockFromLedger(ledgerContent: string): bigint | null {
  if (!ledgerContent) return null;

  const lines = ledgerContent.split('\n');
  let maxBlock: bigint | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('---') || trimmed.toLowerCase().includes('block')) {
      continue;
    }
    const cols = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      const blockStr = cols[1];
      if (/^\d+$/.test(blockStr)) {
        const b = BigInt(blockStr);
        if (maxBlock === null || b > maxBlock) {
          maxBlock = b;
        }
      }
    }
  }

  return maxBlock;
}

/**
 * Formats a SettlementEvent into a Markdown table row with BaseScan deep links.
 */
export function formatLedgerRow(event: SettlementEvent): string {
  const shortHash = `${event.txHash.slice(0, 10)}...${event.txHash.slice(-8)}`;
  const baseScanUrl = `https://basescan.org/tx/${event.txHash}`;
  return `| ${event.timestampUtc} | ${event.blockNumber.toString()} | [${shortHash}](${baseScanUrl}) | \`${event.from}\` | ${event.amountUsdc} | ${event.eventType} | [View](${baseScanUrl}) |`;
}

/**
 * Deduplicates events against previously recorded transaction hashes and within batch.
 */
export function deduplicateEvents(
  events: SettlementEvent[],
  existingHashes: Set<string>
): SettlementEvent[] {
  const seenInBatch = new Set<string>();
  const deduplicated: SettlementEvent[] = [];

  for (const event of events) {
    const lowerHash = event.txHash.toLowerCase();
    if (existingHashes.has(lowerHash)) {
      continue;
    }
    if (seenInBatch.has(lowerHash)) {
      continue;
    }
    seenInBatch.add(lowerHash);
    deduplicated.push(event);
  }

  return deduplicated;
}

/**
 * Loads the cursor state from disk, or constructs an initial state if missing.
 */
export async function loadCursor(cursorPath: string, fallbackBlock?: bigint): Promise<CursorState> {
  const resolvedPath = path.resolve(cursorPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = await fs.promises.readFile(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CursorState> & {
        lastScannedBlock?: string;
        payTo?: string;
      };
      if (typeof parsed.lastBlock === 'number' && parsed.lastBlock >= 0) {
        return parsed as CursorState;
      }
      if (typeof parsed.lastScannedBlock === 'string' && parsed.lastScannedBlock.length > 0) {
        const legacyBlock = Number(BigInt(parsed.lastScannedBlock));
        return {
          version: '1.0.0',
          chainId: CANONICAL_CHAIN_ID,
          contractAddress: BASE_USDC_ADDRESS,
          payeeAddress: EXPECTED_PAYEE,
          lastBlock: legacyBlock,
          lastSyncedAt:
            typeof (parsed as { updatedAt?: string }).updatedAt === 'string'
              ? (parsed as { updatedAt: string }).updatedAt
              : new Date().toISOString(),
          totalSettlementsFound: 0,
        };
      }
    } catch {
      // In case of corrupt JSON, fall through to fallback
    }
  }

  return {
    version: '1.0.0',
    chainId: CANONICAL_CHAIN_ID,
    contractAddress: BASE_USDC_ADDRESS,
    payeeAddress: EXPECTED_PAYEE,
    lastBlock: Number(fallbackBlock ?? 0n),
    lastSyncedAt: new Date().toISOString(),
    totalSettlementsFound: 0,
  };
}

/**
 * Persists the cursor state atomically to disk.
 */
export async function saveCursor(cursorPath: string, cursor: CursorState): Promise<void> {
  if (cursor.lastBlock < 0) {
    throw new Error(`Invalid cursor lastBlock: ${cursor.lastBlock}`);
  }
  const resolvedPath = path.resolve(cursorPath);
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, JSON.stringify(cursor, null, 2) + '\n', 'utf-8');
}

/**
 * Executes the sale-watch indexing pipeline against Base Mainnet RPC.
 */
export async function runSaleWatch(config?: SaleWatchConfig): Promise<SaleWatchResult> {
  const logger = config?.logger ?? console.log;
  const dryRun = Boolean(config?.dryRun);
  const usdcAddress = config?.usdcAddress ?? BASE_USDC_ADDRESS;
  const payToAddress = config?.payToAddress ?? EXPECTED_PAYEE;
  const cursorPath = config?.cursorPath ?? path.resolve(process.cwd(), DEFAULT_CURSOR_PATH);
  const ledgerPath = config?.ledgerPath ?? path.resolve(process.cwd(), DEFAULT_LEDGER_PATH);
  const maxChunkSize = config?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const confirmations = config?.confirmations ?? DEFAULT_CONFIRMATION_LAG;
  const maxBlocksPerRun =
    config?.maxBlocksPerRun ??
    (process.env.SALE_WATCH_MAX_BLOCKS_PER_RUN
      ? BigInt(process.env.SALE_WATCH_MAX_BLOCKS_PER_RUN)
      : DEFAULT_MAX_BLOCKS_PER_RUN);

  const client = createBaseClient(config?.rpcUrl);

  // 1. Read existing ledger and transaction hashes
  let ledgerContent = '';
  if (fs.existsSync(ledgerPath)) {
    ledgerContent = await fs.promises.readFile(ledgerPath, 'utf-8');
  }
  const existingHashes = parseExistingTxHashes(ledgerContent);

  // 2. Determine target ending block
  const latestBlockOnChain = await client.getBlockNumber();
  const safeTargetBlock =
    latestBlockOnChain > confirmations ? latestBlockOnChain - confirmations : latestBlockOnChain;
  let scanToBlock = config?.endBlock ?? safeTargetBlock;

  // 3. Determine starting block height
  let fromBlock: bigint;
  let cursor = await loadCursor(cursorPath);

  if (config?.startBlock !== undefined) {
    fromBlock = config.startBlock;
  } else if (fs.existsSync(cursorPath) && cursor.lastBlock > 0) {
    fromBlock = BigInt(cursor.lastBlock) + 1n;
  } else if (process.env.SALE_WATCH_START_BLOCK) {
    fromBlock = BigInt(process.env.SALE_WATCH_START_BLOCK);
  } else {
    const maxLedgerBlock = parseMaxBlockFromLedger(ledgerContent);
    if (maxLedgerBlock !== null) {
      fromBlock = maxLedgerBlock + 1n;
    } else {
      // Default to scanning recent 2,000 blocks window
      fromBlock = latestBlockOnChain > maxChunkSize ? latestBlockOnChain - maxChunkSize : 0n;
    }
  }

  logger(`[sale-watch] Canonical network: ${CANONICAL_NETWORK} (Base Mainnet)`);
  logger(`[sale-watch] USDC Contract: ${usdcAddress}`);
  logger(`[sale-watch] Payee: ${payToAddress}`);
  if (fromBlock > scanToBlock) {
    logger(`[sale-watch] Up-to-date: fromBlock (${fromBlock}) > toBlock (${scanToBlock}).`);
    return {
      fromBlock,
      toBlock: scanToBlock,
      scannedBlocks: 0n,
      chunksCount: 0,
      eventsFound: 0,
      newSettlementsRecorded: 0,
      dryRun,
      cursorUpdatedTo: BigInt(cursor.lastBlock),
    };
  }

  const blocksBehind = scanToBlock - fromBlock + 1n;
  if (maxBlocksPerRun > 0n && blocksBehind > maxBlocksPerRun) {
    scanToBlock = fromBlock + maxBlocksPerRun - 1n;
    logger(
      `[sale-watch] Capping this run to ${maxBlocksPerRun.toString()} blocks (${fromBlock.toString()} -> ${scanToBlock.toString()}); will resume on next run.`
    );
  }

  const toBlock = scanToBlock;
  logger(`[sale-watch] Scan range: blocks ${fromBlock} -> ${toBlock} (dryRun: ${dryRun})`);

  const logFilter: GetLogsAdaptiveParams = {
    address: usdcAddress,
    event: transferEventAbi,
    args: { to: payToAddress },
  };

  const chunks = calculateBlockRanges(fromBlock, toBlock, maxChunkSize);
  logger(`[sale-watch] Split into ${chunks.length} chunks (maxChunkSize: ${maxChunkSize})`);

  let totalEventsFound = 0;
  let totalNewRecorded = 0;
  const blockTimestampCache = new Map<bigint, string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger(`[sale-watch] Scanning chunk ${i + 1}/${chunks.length}: [${chunk.from}..${chunk.to}]`);

    // Ingest ERC-20 Transfer events to payee
    const logs = await fetchUsdcTransferLogsAdaptive(client, logFilter, chunk.from, chunk.to);

    const candidateEvents: SettlementEvent[] = [];

    for (const log of logs) {
      if (!log.args.from || !log.args.to || log.args.value === undefined) continue;
      if (log.args.value <= 0n) continue;
      if (log.args.to.toLowerCase() !== payToAddress.toLowerCase()) continue;
      if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) continue;

      const txHash = log.transactionHash;
      const blockNumber = log.blockNumber;

      // Resolve block timestamp
      let timestampUtc = blockTimestampCache.get(blockNumber);
      if (!timestampUtc) {
        try {
          const block = await client.getBlock({ blockNumber });
          timestampUtc = new Date(Number(block.timestamp) * 1000).toISOString();
        } catch {
          timestampUtc = new Date().toISOString();
        }
        blockTimestampCache.set(blockNumber, timestampUtc);
      }

      // Check whether this transaction also emitted EIP-3009 AuthorizationUsed
      let eventType: SettlementEventType = 'Transfer';
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        const hasAuthUsed = receipt.logs.some(
          (receiptLog) =>
            receiptLog.address.toLowerCase() === usdcAddress.toLowerCase() &&
            receiptLog.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC0.toLowerCase()
        );
        if (hasAuthUsed) {
          eventType = 'TransferWithAuthorization';
        }
      } catch {
        // If receipt fetch fails or is unsupported, retain default 'Transfer'
      }

      const amountUnits = log.args.value;
      const amountUsdc = (Number(amountUnits) / 1_000_000).toFixed(6);

      candidateEvents.push({
        txHash,
        blockNumber,
        from: log.args.from,
        to: log.args.to,
        amountUnits,
        amountUsdc,
        timestampUtc,
        eventType,
      });
    }

    totalEventsFound += candidateEvents.length;
    const newEvents = deduplicateEvents(candidateEvents, existingHashes);

    if (newEvents.length > 0) {
      logger(`[sale-watch] Found ${newEvents.length} new settlement(s) in chunk [${chunk.from}..${chunk.to}]`);
      totalNewRecorded += newEvents.length;

      if (!dryRun) {
        // Prepare rows and update ledger file
        let rowsToAppend = '';
        if (!fs.existsSync(ledgerPath) || ledgerContent.trim().length === 0) {
          rowsToAppend += LEDGER_HEADER;
          ledgerContent = LEDGER_HEADER;
        }

        for (const ev of newEvents) {
          existingHashes.add(ev.txHash.toLowerCase());
          const row = formatLedgerRow(ev);
          rowsToAppend += `${row}\n`;
          ledgerContent += `${row}\n`;
        }

        await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
        await fs.promises.appendFile(ledgerPath, rowsToAppend, 'utf-8');
      }
    }

    if (!dryRun) {
      // Advance cursor after each chunk completes
      cursor = {
        version: '1.0.0',
        chainId: CANONICAL_CHAIN_ID,
        contractAddress: usdcAddress,
        payeeAddress: payToAddress,
        lastBlock: Number(chunk.to),
        lastSyncedAt: new Date().toISOString(),
        totalSettlementsFound: cursor.totalSettlementsFound + newEvents.length,
      };
      await saveCursor(cursorPath, cursor);
    }
  }

  logger(
    `[sale-watch] Complete. Scanned ${toBlock - fromBlock + 1n} blocks. Found ${totalEventsFound} events (${totalNewRecorded} new). Cursor at ${toBlock}.`
  );

  return {
    fromBlock,
    toBlock,
    scannedBlocks: toBlock - fromBlock + 1n,
    chunksCount: chunks.length,
    eventsFound: totalEventsFound,
    newSettlementsRecorded: totalNewRecorded,
    dryRun,
    cursorUpdatedTo: toBlock,
  };
}
