---
name: civicpulse-402
description: Query real-time City of Minneapolis housing code violations, building permits, and Ramsey County parcel GIS audits over HTTP x402 ($0.01 USDC on Base) or Streamable HTTP MCP.
metadata:
  author: kwizzlesurp10-ctrl
  version: "1.2.0"
  repository: https://github.com/kwizzlesurp10-ctrl/x402-mcp
---

# CivicPulse-402 Municipal Compliance & Parcel GIS Skill

Autonomous Minnesota municipal compliance, housing code violation, building permit, and Ramsey County parcel GIS gateway powered by Base Mainnet (`eip155:8453`) USDC x402 micropayments (`$0.01` per query).

## 1. Install & Discover

### Install via `skills.sh` or `clawhub.ai`
```bash
# Install skill into agent environment via skills.sh
npx skills add kwizzlesurp10-ctrl/x402-mcp

# Or publish/consume via ClawHub
clawhub skill install civicpulse-402
```

### Discover Endpoints with AgentCash (Free Preflight)
```bash
npx agentcash discover https://civicpulse-402.vercel.app --include-guidance
npx agentcash discover https://x402-mcp.onrender.com --include-guidance
```

### Machine Discovery Surfaces
- OpenAPI 3.1 Spec: `https://civicpulse-402.vercel.app/openapi.json`
- x402 Legacy Catalog: `https://civicpulse-402.vercel.app/.well-known/x402`
- API Catalog (RFC 9727): `https://civicpulse-402.vercel.app/.well-known/api-catalog`
- MCP Server Card (SEP-1649): `https://civicpulse-402.vercel.app/.well-known/mcp/server-card.json`
- MCP Manifest: `https://civicpulse-402.vercel.app/.well-known/mcp.json`
- A2A Agent Card: `https://civicpulse-402.vercel.app/.well-known/agent-card.json`
- ERC-8004 Manifest: `https://civicpulse-402.vercel.app/.well-known/erc8004.json`
- LLM Index: `https://civicpulse-402.vercel.app/llms.txt`

## 2. HTTP x402 API (`/api/v1/compliance`)

- **Methods**: `GET` and `POST`
- **Price**: `$0.01 USDC` (`10000` atomic units, 6 decimals) on Base Mainnet (`eip155:8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Accepted Payment Headers**: `PAYMENT-SIGNATURE`, `Authorization`, `x-payment-signature`, `x402-authorization`
- **402 Challenge Behavior**: Missing payment headers return `HTTP 402 Payment Required` with base64 x402 v2 `PAYMENT-REQUIRED` (including `extensions.bazaar`) and `WWW-Authenticate` before parameter validation.

### Dry-Run Probe (Inspect Live `402` Terms)
```bash
curl -sS -D - -X POST https://civicpulse-402.vercel.app/api/v1/compliance \
  -H "Content-Type: application/json" \
  -d '{"address":"1700 Penn Ave N","jurisdiction":"minneapolis"}'
```

### Paid Request (`POST` / `GET`)
```bash
curl -sS -X POST https://civicpulse-402.vercel.app/api/v1/compliance \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: $PAYMENT_SIGNATURE" \
  -d '{"address":"1700 Penn Ave N","jurisdiction":"minneapolis"}'
```

## 3. Streamable HTTP MCP Tools (`POST /mcp`)

Endpoint: `https://civicpulse-402.vercel.app/mcp` (and canonical backend `https://x402-mcp.onrender.com/mcp`)

### List Available Tools (Free)
```bash
curl -sS -X POST https://civicpulse-402.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Tool 1: `query_minneapolis_compliance`
Fetches City of Minneapolis housing code violations, active repair orders, and building permits from ArcGIS Open Data (`$0.01 USDC`).
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "query_minneapolis_compliance",
    "arguments": {
      "address": "1700 Penn Ave N",
      "authorization": "Bearer <base64-eip3009-payload>"
    }
  }
}
```

### Tool 2: `query_ramsey_parcel_audit`
Queries Ramsey County Open GIS for parcel PIN, site address, registered owner, property use class, and assessed value (`$0.01 USDC`).
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "query_ramsey_parcel_audit",
    "arguments": {
      "parcel_id": "04-29-23-41-0012",
      "authorization": "Bearer <base64-eip3009-payload>"
    }
  }
}
```

## 4. Spend-Safety Rules

- Always inspect the live `402` `PAYMENT-REQUIRED` header (`accepts[0].payTo`, `accepts[0].amount == "10000"`, `accepts[0].network == "eip155:8453"`) or run `npx agentcash discover` before signing any EIP-3009 transfer authorization.
- Confirm the `to` address in your signed EIP-3009 payload matches the live `402` challenge `payTo` address and set a short `validBefore` window.
- Never issue bulk loops over property addresses without an explicit per-run USDC spend cap.
