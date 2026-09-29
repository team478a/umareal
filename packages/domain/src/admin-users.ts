import { z } from 'zod';

const adminUserDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminUserListItemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  emailVerifiedAt: adminUserDateTimeSchema.nullable(),
  registrationMethod: z.string().min(1),
  lineAccount: z.object({
    unlinkedAt: adminUserDateTimeSchema.nullable()
  }).strict().nullable(),
  displayName: z.string().min(1),
  role: z.enum(['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR', 'ADMIN']),
  createdAt: adminUserDateTimeSchema
}).strict();

export const adminUsersResponseSchema = z.object({
  items: z.array(adminUserListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50)
}).strict();

export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;
