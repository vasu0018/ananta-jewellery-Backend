// Reports and dashboards bucket data by Indian business days.
process.env.TZ = process.env.TZ || "Asia/Kolkata";

import { env } from "./config/env";
import { createApp } from "./app";
import { prisma } from "./lib/prisma";
import { ensureSequences, cancelStaleUnpaidOrders } from "./lib/orders";
import { syncActiveShipments } from "./lib/shipping";
import { sendAbandonedCartReminders } from "./lib/abandoned";

/** Run a background job on an interval, never overlapping and never crashing the process. */
function every(name: string, ms: number, job: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await job();
      if (typeof result === "number" && result > 0) console.log(`[jobs] ${name}: ${result}`);
    } catch (e) {
      console.warn(`[jobs] ${name} failed:`, e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, ms);
}

async function main() {
  await prisma.$connect();
  await ensureSequences();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`✦ Ananta Jewellery API ready on ${env.API_PUBLIC_URL} (port ${env.PORT}, ${env.NODE_ENV})`);
  });

  const timers =
    process.env.DISABLE_JOBS === "1"
      ? []
      : [
          every("auto-cancel unpaid orders", 5 * 60_000, cancelStaleUnpaidOrders),
          every("sync shipments", 30 * 60_000, syncActiveShipments),
          every("abandoned cart reminders", 30 * 60_000, sendAbandonedCartReminders),
        ];

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    timers.forEach(clearInterval);
    server.close(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("Failed to start server", e);
  process.exit(1);
});
