import { notFound } from 'next/navigation';
import { MediaApp } from '../../components/media-app';
const routes = ['', 'login', 'register', 'register/line', 'verify-email', 'forgot-password', 'reset-password', 'account', 'notifications', 'security', 'expert', 'results', 'plans', 'races', 'admin', 'admin/users', 'admin/audit', 'admin/races', 'admin/free-reports', 'admin/publication-schedules', 'admin/acquisition', 'admin/onboarding-funnel', 'admin/results', 'admin/billing', 'admin/settings', 'admin/notifications', 'admin/incidents', 'admin/backups', 'admin/account-closures', 'admin/readiness', 'terms', 'privacy'];
export default async function Page({ params }: { params: Promise<{ route?: string[] }> }) {
  const { route } = await params;
  if (!routes.includes((route ?? []).join('/')) && !(route?.length === 2 && route[0] === 'races' && /^[0-9a-f-]{36}$/i.test(route[1]))) notFound();
  return <MediaApp />;
}
