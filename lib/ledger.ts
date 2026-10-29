import fs from 'node:fs/promises';
import path from 'node:path';
import { type Hex, type Address } from 'viem';

export interface LedgerEntry {
  timestamp: string;
  endpoint: string;
  query: string;
  payer: Address;
  recipient: Address;
  amountUsdc: string;
  txHash: Hex;
  blockNumber: string;
}

const LEDGER_REL_PATH = 'docs/LIVE_LEDGER.md';

const LEDGER_HEADER = `# LIVE SETTLEMENT LEDGER (CivicPulse 402 — Base Mainnet)

Publicly verifiable, append-only record of autonomous x402 USDC settlements on Base Mainnet (\`eip155:8453\`).
- **Token Contract**: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` (Native Base USDC)
- **Verified Payee**: \`0xAB745e5F576667037696e78ba7dA28E193E4423D\`

| Timestamp (UTC) | Endpoint | Query | Payer | Amount | BaseScan Tx | Block |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
`;

function formatLedgerRow(entry: LedgerEntry): string {
  const shortPayer = `${entry.payer.slice(0, 6)}...${entry.payer.slice(-4)}`;
  const shortTx = `${entry.txHash.slice(0, 10)}...${entry.txHash.slice(-6)}`;
  const baseScanUrl = `https://basescan.org/tx/${entry.txHash}`;
  const cleanQuery = entry.query.replace(/\|/g, '\\|');

  return `| ${entry.timestamp} | \`${entry.endpoint}\` | \`${cleanQuery}\` | [\`${shortPayer}\`](https://basescan.org/address/${entry.payer}) | **${entry.amountUsdc} USDC** | [\`${shortTx}\`](${baseScanUrl}) | \`${entry.blockNumber}\` |\n`;
}

export async function appendSettlementToLedger(entry: LedgerEntry): Promise<{
  loggedLocal: boolean;
  loggedGithub: boolean;
}> {
  const row = formatLedgerRow(entry);
  let loggedLocal = false;
  let loggedGithub = false;

  try {
    const fullPath = path.join(process.cwd(), LEDGER_REL_PATH);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    try {
      await fs.access(fullPath);
    } catch {
      await fs.writeFile(fullPath, LEDGER_HEADER, 'utf-8');
    }

    await fs.appendFile(fullPath, row, 'utf-8');
    loggedLocal = true;
  } catch {
    // Expected on read-only Vercel serverless filesystem
  }

  const ghToken = process.env.GITHUB_LEDGER_TOKEN;
  const ghRepo = process.env.GITHUB_LEDGER_REPO || 'kwizzlesurp10-ctrl/civicpulse-402';

  if (ghToken) {
    try {
      const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${LEDGER_REL_PATH}`;
      const getRes = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
        },
      });

      let existingContent = LEDGER_HEADER;
      let sha: string | undefined;

      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
        existingContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
      }

      const updatedContent = existingContent.endsWith('\n')
        ? `${existingContent}${row}`
        : `${existingContent}\n${row}`;

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `chore(ledger): record x402 settlement ${entry.txHash.slice(0, 10)} (${entry.amountUsdc} USDC)`,
          content: Buffer.from(updatedContent, 'utf-8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });

      loggedGithub = putRes.ok;
    } catch (err) {
      console.error('GitHub LIVE_LEDGER sync error:', err);
    }
  }

  return { loggedLocal, loggedGithub };
}
