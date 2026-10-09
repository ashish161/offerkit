import { z } from "zod";
import { paginationInput } from "./pagination.ts";

export const auditActor = z.enum(["user", "api_key", "system"]);

export const auditLogOutput = z.object({
  id: z.string().uuid(),
  actor: auditActor,
  actorId: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const auditLogListInput = paginationInput.extend({
  actor: auditActor.optional(),
  entity: z.string().optional(),
  action: z.string().optional(),
  entityId: z.string().optional(),
});
