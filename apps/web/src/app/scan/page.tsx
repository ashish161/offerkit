"use client";

import { useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { T } from "gt-next/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ScanSuccess {
  ok: true;
  balance: number;
  delta: number;
  basePoints: number;
  memberId: string;
  alreadyCredited: boolean;
}

interface ScanFailure {
  ok: false;
  code: string;
  message: string;
}

type ScanResult = ScanSuccess | ScanFailure;

export default function ScanPage() {
  const [cardCode, setCardCode] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardCode, amount: Number(amount) }),
      });
      const body = (await res.json()) as ScanResult;
      if (body.ok) {
        setResult(body);
        setAmount("");
      } else {
        setError(body.message);
      }
    } catch {
      setError("Request failed — check your connection");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <T>Add points</T>
          </CardTitle>
          <CardDescription>
            <T>Enter the customer&apos;s card code and bill amount</T>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cardCode">
                <T>Card code</T>
              </Label>
              <Input
                id="cardCode"
                name="cardCode"
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="e.g. K7XQ2M4A"
                className="font-mono uppercase"
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value.toUpperCase())}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">
                <T>Bill amount</T>
              </Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                placeholder="2500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              <T>Add Points</T>
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50 text-destructive">
          <CardContent className="pt-6 text-sm">{error}</CardContent>
        </Card>
      )}

      {result?.ok && (
        <Card>
          <CardContent className="space-y-1 pt-6">
            <div className="flex items-center gap-2 font-medium text-green-600 dark:text-green-500">
              <Check className="size-4" />
              {result.alreadyCredited ? (
                <T>Already credited</T>
              ) : (
                <>
                  +{result.delta} <T>points added</T>
                </>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              <T>New balance</T>:{" "}
              <span className="font-medium tabular-nums text-foreground">
                {result.balance.toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
