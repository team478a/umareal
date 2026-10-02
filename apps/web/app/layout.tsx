import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'ウマリアル', template: '%s｜ウマリアル' },
  applicationName: 'ウマリアル',
  description: '馬を知る。競馬がもっとリアルになる。',
  icons: {
    icon: [{ url: '/brand/umareal-icon.jpg', type: 'image/jpeg' }],
    apple: [{ url: '/brand/umareal-icon.jpg', type: 'image/jpeg' }]
  },
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    siteName: 'ウマリアル',
    title: 'ウマリアル',
    description: '馬を知る。競馬がもっとリアルになる。',
    images: [{ url: 'https://app.umareal.com/brand/umareal-logo.jpg', width: 1280, height: 640, alt: 'ウマリアル' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ウマリアル',
    description: '馬を知る。競馬がもっとリアルになる。',
    images: ['https://app.umareal.com/brand/umareal-logo.jpg']
  },
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false }
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
