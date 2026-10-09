import { eq, inArray } from "drizzle-orm";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { getDb, closeDb } from "@offerkit/db/client";
import * as schema from "@offerkit/db/schema";

type Db = ReturnType<typeof getDb>;

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");
const yes = args.has("--yes");
const qrOnly = args.has("--qr-only");

if (!process.env["DATABASE_URL"]) {
  console.error(
    "DATABASE_URL is not set. Run via `pnpm --filter @offerkit/web reset-demo` (loads ../../.env).",
  );
  process.exit(1);
}

const dbUrl = new URL(process.env["DATABASE_URL"]);

/**
 * ⚠️  DEV-ONLY TEARDOWN — DO NOT RUN AGAINST LIVE DATA
 *
 * This script IRREVERSIBLY HARD-DELETES customers and campaigns from the
 * database it is pointed at. There is no undo, and customer deletes cascade to
 * loyalty members and the full points ledger. It exists so local demo/test
 * data can be reset — it is NOT a substitute for the product's soft deletes.
 *
 * When to use:
 *   - resetting a local dev database after QR loyalty POC experiments
 *   - clearing demo/test tenants you control (e.g. a CI scratch database)
 *
 * When NOT to use:
 *   - any database that carries real/live customer data (production, staging
 *     with production copies, monitoring/reporting consumers).
 *
 * Run it only through the dev wrapper and never point DATABASE_URL at a
 * non-local host. The script refuses to run unless the host is
 * localhost/127.0.0.1/::1 (or the Database is a unix socket) — override with
 * --force only when you are certain the target is throwaway test data.
 *
 * Every app-level delete is a soft delete (sets `deleted_at` only), so the
 * database FK cascades never fire through the API — that is why deleting a
 * customer leaves its loyalty member + points ledger behind. This script is the
 * exception: it hard-deletes the two roots of the cascade chains:
 *
 *   campaign → loyalty_program → tier/earning_rule/reward/member → transaction
 *   customer → loyalty_member → transaction   (order/redemption/voucher → SET NULL)
 *
 * History and admin/workspace/users are left untouched.
 *
 * Flags:
 *   --qr-only   only LOYALTY_PROGRAM campaigns and their member customers
 *   --dry-run   print what would be deleted, delete nothing
 *   --yes       skip the confirmation prompt
 *   --force     bypass the local-host guard (dangerous)
 */

/** Refuse to fat-finger a live database: only local hosts are allowed. */
function assertLocalDatabase(): void {
  if (force) return;
  const host = dbUrl.hostname;
  const local = host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local) {
    console.error(
      `reset-demo is dev-only and refuses to run against host "${host}".\n` +
        "Point DATABASE_URL at a local database (localhost/127.0.0.1/::1/unix socket),\n" +
        "or pass --force if you are absolutely certain the target holds no live data.",
    );
    process.exit(1);
  }
}
async function resolveScope(
  db: Db,
  qrOnly: boolean,
): Promise<{ qrCampaignIds: string[]; customerIds: string[] }> {
  const campaignRows = qrOnly
    ? await db
        .select({ id: schema.campaign.id })
        .from(schema.campaign)
        .where(eq(schema.campaign.type, "LOYALTY_PROGRAM"))
    : await db.select({ id: schema.campaign.id }).from(schema.campaign);
  const qrCampaignIds = campaignRows.map((r) => r.id);

  let customerRows = await db.select({ id: schema.customer.id }).from(schema.customer);

  if (qrOnly && qrCampaignIds.length > 0) {
    const programRows = await db
      .select({ id: schema.loyaltyProgram.id })
      .from(schema.loyaltyProgram)
      .where(inArray(schema.loyaltyProgram.campaignId, qrCampaignIds));
    const programIds = programRows.map((r) => r.id);
    const memberIds = programIds.length
      ? await db
          .select({ customerId: schema.loyaltyMember.customerId })
          .from(schema.loyaltyMember)
          .where(inArray(schema.loyaltyMember.programId, programIds))
      : [];
    const affected = new Set(
      memberIds.map((r) => r.customerId).filter((id) => id !== null),
    );
    customerRows = (
      await db.select({ id: schema.customer.id }).from(schema.customer)
    ).filter((c) => affected.has(c.id));
  }

  return { qrCampaignIds, customerIds: customerRows.map((r) => r.id) };
}

const main = async (): Promise<void> => {
  assertLocalDatabase();
  const db = getDb();
  const { qrCampaignIds, customerIds } = await resolveScope(db, qrOnly);

  console.info("reset-demo: permanent teardown of demo/test data (cascades members + ledger)");
  if (qrOnly) {
    console.info("  (--qr-only: only LOYALTY_PROGRAM campaigns and their member customers)");
  }
  console.info(`  customers:       ${customerIds.length}`);
  console.info(`  campaigns:       ${qrCampaignIds.length}`);
  console.info(`  members:         ${await db.$count(schema.loyaltyMember)}`);
  console.info(`  transactions:    ${await db.$count(schema.loyaltyTransaction)}`);

  if (dryRun) {
    console.info("\ndry run — nothing deleted.");
    await closeDb();
    return;
  }

  if (!yes) {
    const rl = createInterface({ input: processStdin, output: processStdout });
    const answer = await rl.question(
      `Delete ${customerIds.length} customer(s) and ${qrCampaignIds.length} campaign(s) permanently? [y/N] `,
    );
    rl.close();
    if (!/^y/i.test(answer.trim())) {
      console.info("aborted — nothing deleted.");
      await closeDb();
      return;
    }
  }

  if (qrCampaignIds.length > 0) {
    await db.delete(schema.campaign).where(inArray(schema.campaign.id, qrCampaignIds));
  }
  if (customerIds.length > 0) {
    await db.delete(schema.customer).where(inArray(schema.customer.id, customerIds));
  }

  console.info(
    `\ndone — deleted ${customerIds.length} customer(s) and ${qrCampaignIds.length} campaign(s).`,
  );
  await closeDb();
};

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});