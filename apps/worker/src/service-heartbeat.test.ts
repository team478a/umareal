import { describe, expect, it, vi } from 'vitest';
import { recordWorkerHeartbeat } from './service-heartbeat';

describe('worker service heartbeat', () => {
  it('upserts the worker release without persisting other Render environment values', async () => {
    const upsert = vi.fn(async () => ({}));
    const startedAt = new Date('2026-09-26T00:00:00.000Z');
    const now = new Date('2026-09-26T00:00:15.000Z');
    const releaseCommit = 'abcdef0123456789abcdef0123456789abcdef01';

    const result = await recordWorkerHeartbeat({ serviceHeartbeat: { upsert } } as never, {
      startedAt,
      now,
      environment: { RENDER_GIT_COMMIT: releaseCommit, DATABASE_URL: 'must-not-be-recorded' }
    });

    expect(result).toEqual({ releaseCommit, heartbeatAt: now });
    expect(upsert).toHaveBeenCalledWith({
      where: { service: 'worker' },
      create: { service: 'worker', releaseCommit, heartbeatAt: now, startedAt },
      update: { releaseCommit, heartbeatAt: now, startedAt }
    });
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('must-not-be-recorded');
  });
});
