'use client';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loader: Promise<void> | null = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
    const script = existing ?? document.createElement('script');
    const loaded = () => window.turnstile ? resolve() : reject(new Error('TURNSTILE_NOT_READY'));
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', () => reject(new Error('TURNSTILE_LOAD_FAILED')), { once: true });
    if (!existing) {
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch(error => { loader = null; throw error; });
  return loader;
}

export function TurnstileChallenge({ siteKey, mode, resetKey, onToken }: { siteKey: string | null; mode: 'TEST_ONLY' | 'TURNSTILE'; resetKey: number; onToken: (token: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (mode !== 'TURNSTILE' || !siteKey || !container.current) return;
    let active = true;
    let widgetId: string | null = null;
    setError(''); onToken(null);
    void loadTurnstile().then(() => {
      if (!active || !container.current || !window.turnstile) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: siteKey,
        action: 'register',
        theme: 'light',
        size: 'flexible',
        callback: (token: string) => { if (active) onToken(token); },
        'expired-callback': () => { if (active) onToken(null); },
        'timeout-callback': () => { if (active) onToken(null); },
        'error-callback': () => { if (active) { onToken(null); setError('確認を読み込めませんでした。再読み込みしてください。'); } }
      });
    }).catch(() => { if (active) setError('確認を読み込めませんでした。再読み込みしてください。'); });
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [mode, onToken, resetKey, siteKey]);

  if (mode === 'TEST_ONLY') return <label className="captcha-test"><input key={resetKey} type="checkbox" onChange={event => onToken(event.target.checked ? 'test-registration-captcha' : null)} /><span><strong>自動送信ではありません</strong><small>ローカル試験用です。外部通信は行いません。</small></span></label>;
  if (!siteKey) return <div className="notice error" role="alert">登録保護の設定が不足しています。運営へお問い合わせください。</div>;
  return <div className="captcha-challenge"><div ref={container} /><p className="muted">Cloudflareの確認を完了すると登録できます。</p>{error && <div className="notice error" role="alert">{error}</div>}</div>;
}
