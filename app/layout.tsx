import './globals.css';
import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  title: 'CivicPulse 402 | Base USDC Municipal Compliance Gateway',
  description:
    'Autonomous Municipal Compliance & Real Estate API Gateway powered by x402 Micropayments',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
