'use client';
import { useState } from 'react';
import { LockKeyhole, PlayCircle } from 'lucide-react';

type Manual = { id: string; title: string; description: string; duration: string; src: string };

const publicManuals: Manual[] = [
  { id: 'line-registration', title: 'LPからLINE無料登録', description: 'LPからLINE認証を始め、登録済みの場合にログインする流れです。', duration: '約45秒', src: '/manuals/user-01-line-registration.mp4' },
  { id: 'account-login', title: '無料会員登録・ログイン', description: 'LINEまたはメールで登録し、会員画面へ入る手順です。', duration: '約44秒', src: '/manuals/user-02-account-login.mp4' },
  { id: 'member-home', title: '会員ホーム・お知らせ', description: '会員ステータス、新着情報、未読のお知らせを確認します。', duration: '約41秒', src: '/manuals/user-03-member-home.mp4' },
  { id: 'race-papers', title: 'レース情報・紙面閲覧', description: '対象レースを探し、公開済みの通常レース紙面を確認します。', duration: '約46秒', src: '/manuals/user-04-race-papers.mp4' }
];

const adminManuals: Manual[] = [
  { id: 'dashboard', title: '今日の状況・使い方', description: '管理ダッシュボードと当日の確認順を説明します。', duration: '約42秒', src: '/api/v1/admin/manuals/dashboard/video' },
  { id: 'race-registration', title: '明日のレース登録', description: '翌日の対象レースと出走馬を登録する流れです。', duration: '約1分35秒', src: '/api/v1/admin/manuals/race-registration/video' },
  { id: 'race-paper', title: '通常紙面の作成・公開', description: '通常レース紙面の作成から公開前確認までを説明します。', duration: '約48秒', src: '/api/v1/admin/manuals/race-paper/video' },
  { id: 'win5-paper', title: 'WIN5紙面の作成・公開', description: '対象5レースの確認とWIN5紙面の作成手順です。', duration: '約36秒', src: '/api/v1/admin/manuals/win5-paper/video' },
  { id: 'assessment', title: '馬の評価・最終予想', description: 'パドック評価から最終予想の確認までを説明します。', duration: '約39秒', src: '/api/v1/admin/manuals/assessment/video' },
  { id: 'free-report', title: '無料速報の作成', description: '評価UP・DOWN馬と短評を使った無料速報の作成手順です。', duration: '約38秒', src: '/api/v1/admin/manuals/free-report/video' },
  { id: 'publication-schedule', title: '配信予約', description: '配信対象、経路、時刻、リンク先を確認します。', duration: '約39秒', src: '/api/v1/admin/manuals/publication-schedule/video' },
  { id: 'results', title: '結果登録・確定', description: '公式結果との照合から結果確定までを説明します。', duration: '約41秒', src: '/api/v1/admin/manuals/results/video' },
  { id: 'social-share', title: 'SNS投稿文の作成', description: '確定済み結果からSNS共有文を作成します。', duration: '約36秒', src: '/api/v1/admin/manuals/social-share/video' },
  { id: 'notifications', title: '通知履歴・再送', description: '配信履歴、失敗理由、重複防止の確認手順です。', duration: '約38秒', src: '/api/v1/admin/manuals/notifications/video' },
  { id: 'incidents', title: '障害確認', description: '停止・遅延・通知失敗の確認ポイントを説明します。', duration: '約35秒', src: '/api/v1/admin/manuals/incidents/video' }
];

function ManualLibrary({ items, admin = false }: { items: Manual[]; admin?: boolean }) {
  const [selectedId, setSelectedId] = useState(items[0].id);
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  return <>
    <div className="page-heading"><span className="eyebrow">{admin ? 'PRIVATE VIDEO GUIDE' : 'VIDEO GUIDE'}</span><h1>動画マニュアル</h1><p>{admin ? '管理画面の操作手順を、実際の画面と音声で確認できます。' : '無料会員登録からレース情報・紙面の確認までを動画で説明します。'}</p></div>
    {admin && <div className="notice manual-private-notice"><LockKeyhole size={18} /><span>このページと動画は管理者・レース担当だけが閲覧できます。動画URLを外部へ共有しないでください。</span></div>}
    <section className="panel manual-player" aria-labelledby="selected-manual-title">
      <div className="panel-heading"><div><span className="eyebrow">NOW PLAYING</span><h2 id="selected-manual-title">{selected.title}</h2></div><span className="count-tag">{selected.duration}</span></div>
      <div className="manual-video-wrap"><video key={selected.src} controls preload="metadata" playsInline controlsList={admin ? 'nodownload' : undefined}><source src={selected.src} type="video/mp4" />お使いのブラウザーは動画再生に対応していません。</video></div>
      <div className="panel-body"><p>{selected.description}</p></div>
    </section>
    <section className="panel manual-library" aria-labelledby="manual-list-title"><div className="panel-heading"><div><span className="eyebrow">CHAPTERS</span><h2 id="manual-list-title">動画を選ぶ</h2></div><span className="count-tag">{items.length}本</span></div><div className="manual-list">{items.map((item, index) => <button type="button" className={`manual-list-item ${item.id === selected.id ? 'active' : ''}`} aria-pressed={item.id === selected.id} key={item.id} onClick={() => setSelectedId(item.id)}><span className="manual-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span className="manual-duration"><PlayCircle size={17} />{item.duration}</span></button>)}</div></section>
  </>;
}

export function PublicVideoManual() { return <ManualLibrary items={publicManuals} />; }
export function AdminVideoManual() { return <ManualLibrary items={adminManuals} admin />; }
