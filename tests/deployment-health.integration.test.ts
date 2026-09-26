import { afterAll, describe, expect, it } from 'vitest';
import { base, db } from './helpers';

afterAll(async () => {
  await db.serviceHeartbeat.deleteMany({ where: { service: 'worker' } });
  await db.$disconnect();
});

describe('deployment health', () => {
  it('reports the API release and a recent worker heartbeat without infrastructure secrets', async () => {
    const releaseCommit = '1234567890abcdef1234567890abcdef12345678';
    const now = new Date();
    await db.serviceHeartbeat.upsert({
      where: { service: 'worker' },
      create: { service: 'worker', releaseCommit, heartbeatAt: now, startedAt: now },
      update: { releaseCommit, heartbeatAt: now, startedAt: now }
    });

    const response = await fetch(`${base}/api/v1/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.deployment.api.service).toBe('api');
    expect(body.deployment.api.commit === null || /^[0-9a-f]{12}$/.test(String(body.deployment.api.commit))).toBe(true);
    expect(body.deployment.worker).toEqual(expect.objectContaining({
      service: 'worker',
      commit: releaseCommit.slice(0, 12),
      status: 'OK',
      heartbeatAt: expect.any(String)
    }));
    expect(['CONSISTENT', 'MISMATCH', 'UNKNOWN']).toContain(body.deployment.consistency);
    expect(JSON.stringify(body)).not.toMatch(/DATABASE_URL|postgresql:|render\.com|serviceId|password|token/i);
  });
});
