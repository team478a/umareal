import type { Request } from 'express';
import type { Identity } from '@keiba/domain';
import type { User } from '@keiba/db';
export type AuthContext = Identity & { user: User; sessionId?: string };
export type AppRequest = Request & { requestId: string; auth?: AuthContext; rawBody?: Buffer };
