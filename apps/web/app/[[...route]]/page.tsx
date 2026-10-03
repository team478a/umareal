import { notFound } from 'next/navigation';
import { MediaApp } from '../../components/media-app';
const routes = ['', 'login', 'register', 'register/line', 'verify-email', 'forgot-password', 'reset-password', 'account', 'benefit', 'support', 'notifications', 'security', 'manual', 'expert', 'expert/win5', 'expert/papers', 'papers', 'admin/papers', 'results', 'plans', 'win5', 'races', 'admin', 'admin/manual', 'admin/users', 'admin/audit', 'admin/staff', 'admin/support', 'admin/races', 'admin/win5', 'admin/free-reports', 'admin/benefits', 'admin/publication-schedules', 'admin/acquisition', 'admin/onboarding-funnel', 'admin/registration-followups', 'admin/referrals', 'admin/line-rich-menu', 'admin/results', 'admin/social-shares', 'admin/billing', 'admin/settings', 'admin/notifications', 'admin/incidents', 'admin/backups', 'admin/account-closures', 'admin/readiness', 'admin/continuity', 'terms', 'privacy'];
export default async function Page({ params }: { params: Promise<{ route?: string[] }> }) {
  const { route } = await params;
  if (!routes.includes((route ?? []).join('/')) && !(route?.length === 2 && ['races', 'win5', 'papers'].includes(route[0]) && /^[0-9a-f-]{36}$/i.test(route[1]))) notFound();
  return <MediaApp />;
}
