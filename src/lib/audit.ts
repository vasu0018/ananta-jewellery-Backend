import type { Request } from "express";
import { prisma } from "./prisma";
import { clientIp } from "./http";

/** Record an admin action in the activity log. Never throws. */
export async function logActivity(
  req: Request,
  action: string,
  entity: string,
  entityId?: string | null,
  summary?: string,
  meta?: Record<string, unknown>,
) {
  try {
    await prisma.activityLog.create({
      data: {
        adminId: req.admin?.sub,
        action,
        entity,
        entityId: entityId ?? undefined,
        summary,
        meta: meta as object | undefined,
        ip: clientIp(req),
      },
    });
  } catch (e) {
    console.warn("[audit] failed to log activity", e);
  }
}

/** Create an in-app notification (broadcast to all admins when adminId is omitted). */
export async function notifyAdmins(input: {
  type: string;
  title: string;
  body?: string;
  link?: string;
  adminId?: string;
}) {
  try {
    await prisma.notification.create({ data: input });
  } catch (e) {
    console.warn("[notify] failed", e);
  }
}
