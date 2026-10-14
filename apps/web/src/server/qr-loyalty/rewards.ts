import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";

export interface RewardSummary {
  id: string;
  name: string;
  description: string | null;
  cost: number;
  payload: typeof schema.loyaltyReward.$inferSelect.payload;
}

/** Active rewards for one loyalty program, cheapest first. Read-only. */
export async function listProgramRewards(db: Db, programId: string): Promise<RewardSummary[]> {
  const rows = await db
    .select({
      id: schema.loyaltyReward.id,
      name: schema.loyaltyReward.name,
      description: schema.loyaltyReward.description,
      cost: schema.loyaltyReward.cost,
      payload: schema.loyaltyReward.payload,
    })
    .from(schema.loyaltyReward)
    .where(
      and(
        eq(schema.loyaltyReward.programId, programId),
        isNull(schema.loyaltyReward.deletedAt),
      ),
    )
    .orderBy(asc(schema.loyaltyReward.cost), asc(schema.loyaltyReward.name));
  return rows;
}

/**
 * Rewards available to the program a card code belongs to. null when the
 * card code is unknown. Used by the read-only card page to show what the
 * customer can afford; redemption itself happens at the merchant terminal.
 */
export async function listCardRewards(
  db: Db,
  cardCode: string,
): Promise<{ programId: string; rewards: RewardSummary[] } | null> {
  const normalized = cardCode.trim().toUpperCase();
  if (!normalized) return null;

  const [member] = await db
    .select({ programId: schema.loyaltyMember.programId })
    .from(schema.loyaltyMember)
    .where(eq(schema.loyaltyMember.cardCode, normalized))
    .limit(1);
  if (!member) return null;

  return { programId: member.programId, rewards: await listProgramRewards(db, member.programId) };
}
