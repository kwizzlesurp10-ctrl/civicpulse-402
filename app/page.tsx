'use client';

import React, { useState, useTransition } from 'react';

interface Endpoint {
  id: string;
  name: string;
  category: string;
  priceUsdc: string;
  description: string;
  path: string;
  sampleQuery: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'mpls-housing-code',
    name: 'Minneapolis Housing Code & Violations',
    category: 'Twin Cities Metro',
    priceUsdc: '0.01',
    description: 'Inspect open tier-1 to tier-3 habitability violations and active city repair orders.',
    path: '/api/v1/compliance',
    sampleQuery: '?address=1700+Penn+Ave+N&jurisdiction=minneapolis',
  },
  {
    id: 'ramsey-permit-audit',
    name: 'Ramsey County Parcel & Permit Verification',
    category: 'Twin Cities Metro',
    priceUsdc: '0.01',
    description: 'Real-time pull of open Ramsey County parcel attributes and site records.',
    path: '/api/v1/compliance',
    sampleQuery: '?parcel_id=04-29-23-41-0012&jurisdiction=ramsey',
  },
];

export default function CivicPulseHome() {
  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint>(ENDPOINTS[0]);
  const [targetQuery, setTargetQuery] = useState(ENDPOINTS[0].sampleQuery);
  const [walletAddress, setWalletAddress] = useState<string>('0xAB745e5F576667037696e78ba7dA28E193E4423D');
  const [consoleOutput, setConsoleOutput] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<string>('IDLE');
  const [isPending, startTransition] = useTransition();

  const handleSelectEndpoint = (ep: Endpoint) => {
    setSelectedEndpoint(ep);
    setTargetQuery(ep.sampleQuery);
  };

  const probe402Challenge = async () => {
    startTransition(async () => {
      const res = await fetch(`${selectedEndpoint.path}${targetQuery}`);
      setHttpStatus(`${res.status} ${res.statusText}`);
      const wwwAuth = res.headers.get('www-authenticate');
      const body = await res.json().catch(() => ({}));
      setConsoleOutput(JSON.stringify({ wwwAuthenticateHeader: wwwAuth, responseBody: body }, null, 2));
    });
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 font-mono antialiased p-4 md:p-8">
      <header className="max-w-6xl mx-auto border-b border-neutral-800 pb-6 mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
            <span className="text-xs uppercase tracking-widest text-emerald-400 font-bold">Base Mainnet (8453) Live</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white mt-1">CivicPulse 402</h1>
          <p className="text-xs md:text-sm text-neutral-300 mt-1">
            Production x402 Micropayment Compliance Gateway (Autonomous City Intelligence)
          </p>
        </div>
        <div className="bg-neutral-900 border border-neutral-700 p-3 rounded text-right">
          <div className="text-[10px] text-neutral-300 uppercase tracking-wider font-medium">Settlement Wallet</div>
          <div className="text-xs text-neutral-100 font-semibold truncate max-w-xs">{walletAddress}</div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8">
        <section className="lg:col-span-5 space-y-4" aria-labelledby="endpoints-heading">
          <h2 id="endpoints-heading" className="text-xs font-semibold uppercase tracking-wider text-neutral-200 mb-2">
            Available Live Endpoints
          </h2>
          <div className="space-y-2">
            {ENDPOINTS.map((ep) => {
              const active = ep.id === selectedEndpoint.id;
              return (
                <button
                  key={ep.id}
                  onClick={() => handleSelectEndpoint(ep)}
                  aria-pressed={active}
                  className={`w-full text-left p-4 rounded border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    active
                      ? 'border-emerald-400 bg-neutral-900'
                      : 'border-neutral-700 bg-neutral-900/60 hover:border-neutral-500'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span className="text-xs font-bold text-white">{ep.name}</span>
                    <span className="text-[11px] font-bold text-emerald-300 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-700">
                      ${ep.priceUsdc} USDC
                    </span>
                  </div>
                  <p className="text-xs text-neutral-300 mt-2 leading-relaxed">{ep.description}</p>
                  <div className="mt-3 text-[10px] text-neutral-400 font-mono truncate">{ep.path}{ep.sampleQuery}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="lg:col-span-7 flex flex-col space-y-4" aria-labelledby="inspector-heading">
          <div className="bg-neutral-900 border border-neutral-700 rounded p-6 space-y-4">
            <h2 id="inspector-heading" className="text-xs font-semibold uppercase tracking-wider text-neutral-200">
              Live HTTP 402 Challenge Inspector
            </h2>
            <div className="flex items-center rounded border border-neutral-700 bg-black px-3 py-2 text-xs text-neutral-100 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400">
              <span className="text-neutral-300 font-bold mr-2" aria-hidden="true">GET</span>
              <span className="text-emerald-400 font-medium">{selectedEndpoint.path}</span>
              <label htmlFor="endpoint-query-input" className="sr-only">Target API Query</label>
              <input
                id="endpoint-query-input"
                type="text"
                value={targetQuery}
                onChange={(e) => setTargetQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-neutral-100 placeholder-neutral-400 w-full ml-1"
                placeholder="?query=parameters"
              />
            </div>
            <button
              onClick={probe402Challenge}
              disabled={isPending}
              className="w-full py-3 px-4 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold text-xs uppercase tracking-wider rounded transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
            >
              {isPending ? 'Inspecting Endpoint...' : 'Probe Live HTTP 402 Challenge'}
            </button>
          </div>

          <div className="bg-black border border-neutral-800 rounded p-4 flex-1 min-h-[300px] flex flex-col" aria-live="polite">
            <div className="flex justify-between items-center pb-2 border-b border-neutral-800 mb-3">
              <span className="text-[11px] text-neutral-300 uppercase tracking-widest font-medium">HTTP Stream / Settlement Response</span>
              <span className="text-[10px] text-emerald-400 font-mono font-bold">{httpStatus}</span>
            </div>
            {consoleOutput ? (
              <pre className="text-xs text-emerald-300 overflow-x-auto leading-relaxed flex-1">
                {consoleOutput}
              </pre>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-neutral-400 italic">
                Click Probe to inspect the live EIP-3009 402 challenge header and payload.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
