import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { T } from "gt-next";
import { ArrowLeft, Star } from "lucide-react";
import { getCardDetails, listHistory } from "@offerkit/core/loyalty";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PageProps {
  params: Promise<{ code: string }>;
}

export const metadata: Metadata = {
  title: "Loyalty card · OfferKit",
  robots: { index: false },
};

export default async function LoyaltyCardPage({ params }: PageProps) {
  const { code } = await params;
  const details = await getCardDetails(db(), code);
  if (!details) notFound();

  const history = await listHistory(db(), details.memberId, 25);
  const progress =
    details.nextTierThreshold && details.nextTierThreshold > 0
      ? Math.min(100, Math.round((details.lifetimePoints / details.nextTierThreshold) * 100))
      : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 p-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        <T>OfferKit</T>
      </Link>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="truncate">
              {details.customerName ?? <T>Anonymous member</T>}
            </span>
            <Badge variant="secondary" className="font-mono">
              {details.cardCode}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-4xl font-bold tabular-nums">
              {details.balance.toLocaleString()}
            </div>
            <div className="text-sm text-muted-foreground">
              <T>Points balance</T>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Star className="size-4 text-muted-foreground" />
            {details.tierName ? (
              <span>
                <T>Tier</T>: <strong>{details.tierName}</strong>
              </span>
            ) : (
              <span>
                <T>No tier yet</T>
              </span>
            )}
            <span className="ml-auto text-muted-foreground">
              {details.lifetimePoints.toLocaleString()} <T>lifetime</T>
            </span>
          </div>

          {progress !== null && details.nextTierName && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  <T>Next</T>: {details.nextTierName}
                </span>
                <span>
                  {details.lifetimePoints.toLocaleString()} /{" "}
                  {details.nextTierThreshold?.toLocaleString()}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            <T>Recent activity</T>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No activity yet</T>
            </p>
          ) : (
            <ul className="divide-y">
              {history.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">
                      {tx.note ?? tx.reason}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {tx.createdAt.toLocaleString()}
                    </div>
                  </div>
                  <div
                    className={`shrink-0 tabular-nums font-medium ${
                      tx.delta >= 0 ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {tx.delta >= 0 ? "+" : ""}
                    {tx.delta.toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="pb-4 text-center text-xs text-muted-foreground">
        <T>Powered by OfferKit</T>
      </p>
    </main>
  );
}
