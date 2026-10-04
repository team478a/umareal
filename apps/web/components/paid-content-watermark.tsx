'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

export type PaidContentViewer = {
  id: string;
  displayName: string;
};

function memberCode(id: string) {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return normalized.slice(-12).padStart(12, '0');
}

function jstMinute(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')} JST`;
}

export function paidContentWatermarkLabel(viewer: PaidContentViewer, observedAt?: Date) {
  const base = `UMAREAL MEMBER ${memberCode(viewer.id)}`;
  return observedAt ? `${base} / ${jstMinute(observedAt)}` : base;
}

export function PaidContentWatermark({ viewer, children }: { viewer: PaidContentViewer; children: ReactNode }) {
  const [observedAt, setObservedAt] = useState<Date>();
  useEffect(() => {
    const update = () => setObservedAt(new Date());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const label = useMemo(() => paidContentWatermarkLabel(viewer, observedAt), [viewer, observedAt]);

  return <div className="paid-content-protection">
    <p className="paid-content-protection-note">この画面には会員識別コードが表示されます。無断転載・共有はお控えください。</p>
    <div className="paid-content-protected-body">{children}</div>
    <div className="paid-content-watermark" aria-hidden="true">
      {Array.from({ length: 18 }, (_, index) => <span key={index}>{label}</span>)}
    </div>
  </div>;
}
