import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: '競馬会員メディア', description: 'レース情報と専門家の評価を確認する会員向けメディア', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
