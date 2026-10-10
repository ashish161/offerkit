"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Gift, Loader2, Plus, RefreshCw, UserPlus } from "lucide-react";
import { T } from "gt-next/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "earn" | "redeem";

interface ScanSuccess {
  ok: true;
  balance: number;
  delta: number;
  basePoints: number;
  memberId: string;
  alreadyCredited: boolean;
  cardCode?: string;
  enrolled?: boolean;
}

interface ScanFailure {
  ok: false;
  code: string;
  message: string;
}

type ScanResult = ScanSuccess | ScanFailure;

interface RewardOption {
  id: string;
  name: string;
  description: string | null;
  cost: number;
  payload: { kind: string; typeKey?: string } & Record<string, unknown>;
}

interface RedeemSuccess {
  ok: true;
  balance: number;
  cost: number;
  rewardId: string;
  payload: { kind: string; typeKey?: string } & Record<string, unknown>;
  cardCode?: string;
}

interface RedeemFailure {
  ok: false;
  code: string;
  message: string;
}

type RedeemResult = RedeemSuccess | RedeemFailure;

type FieldErrors = Partial<
  Record<"cardCode" | "phone" | "amount" | "billNumber" | "name" | "rewardId", string>
>;

type RewardsStatus = "idle" | "loading" | "ready" | "error";

const PHONE_DIGITS = (v: string) => v.replace(/\D/g, "");

const pinStorageKey = (brand: string) => `offerkit.brand.pin.${brand}`;

const readStoredPin = (brand: string): string => {
  if (!brand) return "";
  try {
    return sessionStorage.getItem(pinStorageKey(brand)) ?? "";
  } catch {
    return "";
  }
};

const BRAND_SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30";

const REWARD_TYPE_LABEL: Record<string, string> = {
  discount: "Discount",
  gift_card: "Gift card",
  custom: "Custom reward",
};

/** A short label for the reward payload's kind, for manual POS fulfillment. */
function describeRewardType(payload: { kind: string; typeKey?: string }): string {
  if (payload.kind === "custom" && payload.typeKey) return payload.typeKey;
  return REWARD_TYPE_LABEL[payload.kind] ?? payload.kind;
}

export default function ScanPage() {
  const [mode, setMode] = useState<Mode>("earn");
  const [cardCode, setCardCode] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [note, setNote] = useState("");
  const [rewardId, setRewardId] = useState("");
  const [rewards, setRewards] = useState<RewardOption[]>([]);
  const [rewardsStatus, setRewardsStatus] = useState<RewardsStatus>("idle");
  const [rewardsNonce, setRewardsNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [redeemResult, setRedeemResult] = useState<RedeemResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // Multi-tenant brand mode. Empty list (or a failed fetch) = legacy UI — no
  // brand controls and no brand headers, exactly as before multi-tenancy.
  const [brands, setBrands] = useState<string[]>([]);
  const [brand, setBrand] = useState("");
  const [pin, setPin] = useState("");
  const brandMode = brands.length > 0;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/brands");
        if (!res.ok) throw new Error("brands unavailable");
        const data = (await res.json()) as { brands?: unknown };
        if (!mounted) return;
        const list = Array.isArray(data.brands)
          ? data.brands.filter((b): b is string => typeof b === "string")
          : [];
        setBrands(list);
        const first = list[0] ?? "";
        if (first) {
          setBrand(first);
          setPin(readStoredPin(first));
        }
      } catch {
        if (mounted) setBrands([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Load the redeemable rewards for the selected brand (or the legacy default)
  // when the terminal is in Redeem mode. Refetches when the brand or PIN
  // changes; a manual Retry bumps `rewardsNonce`.
  useEffect(() => {
    if (mode !== "redeem") return;
    let mounted = true;
    const run = async () => {
      if (brandMode && !pin) {
        if (mounted) {
          setRewards([]);
          setRewardsStatus("idle");
        }
        return;
      }
      setRewardsStatus("loading");
      try {
        const headers: Record<string, string> = {};
        if (brandMode) {
          if (brand) headers["X-Brand"] = brand;
          headers["X-Brand-Pin"] = pin;
        }
        const res = await fetch("/api/rewards", { headers });
        const data = (await res.json()) as { ok?: boolean; rewards?: unknown };
        if (!mounted) return;
        if (!res.ok || data.ok === false || !Array.isArray(data.rewards)) {
          setRewards([]);
          setRewardsStatus("error");
          return;
        }
        const list = data.rewards.filter(
          (r): r is RewardOption =>
            typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string",
        );
        setRewards(list);
        setRewardsStatus("ready");
        setRewardId((prev) => (list.some((r) => r.id === prev) ? prev : (list[0]?.id ?? "")));
      } catch {
        if (mounted) {
          setRewards([]);
          setRewardsStatus("error");
        }
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [mode, brandMode, brand, pin, rewardsNonce]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setFieldErrors({});
    setResult(null);
    setRedeemResult(null);
  };

  const handleBrandChange = (value: string) => {
    setBrand(value);
    setPin(readStoredPin(value));
    setRewardId("");
  };

  const handlePinChange = (value: string) => {
    setPin(value);
    if (!brand) return;
    try {
      sessionStorage.setItem(pinStorageKey(brand), value);
    } catch {
      // sessionStorage can be unavailable (private mode) — PIN just won't persist.
    }
  };

  const clearFieldError = (field: keyof FieldErrors) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  const validateEarn = (): FieldErrors | null => {
    const errs: FieldErrors = {};
    if (!cardCode.trim() && !phone.trim()) {
      errs.cardCode = "Enter a card code or phone number";
    } else if (cardCode.trim() && !/^[A-Za-z0-9-]+$/.test(cardCode.trim())) {
      errs.cardCode = "Card code can only contain letters, numbers and dashes";
    }
    if (phone.trim() && PHONE_DIGITS(phone).length < 10) {
      errs.phone = "Enter a full 10-digit phone number";
    }
    if (!amount || Number(amount) <= 0) {
      errs.amount = "Enter a bill amount above 0";
    }
    if (!billNumber.trim()) {
      errs.billNumber = "Enter a bill number";
    }
    if (enroll && !name.trim()) {
      errs.name = "Enter the customer's name";
    }
    return Object.keys(errs).length ? errs : null;
  };

  const validateRedeem = (): FieldErrors | null => {
    const errs: FieldErrors = {};
    if (!cardCode.trim() && !phone.trim()) {
      errs.cardCode = "Enter a card code or phone number";
    } else if (cardCode.trim() && !/^[A-Za-z0-9-]+$/.test(cardCode.trim())) {
      errs.cardCode = "Card code can only contain letters, numbers and dashes";
    }
    if (phone.trim() && PHONE_DIGITS(phone).length < 10) {
      errs.phone = "Enter a full 10-digit phone number";
    }
    if (!rewardId) {
      errs.rewardId = "Pick a reward to redeem";
    }
    return Object.keys(errs).length ? errs : null;
  };

  // Map server validation/shortfall responses to the offending field so the
  // message shows right where the cashier needs to fix it.
  const mapServerError = (message: string): { field: FieldErrors; general: string | null } => {
    const lower = message.toLowerCase();
    if (lower.includes("card code")) return { field: { cardCode: message }, general: null };
    if (lower.includes("phone")) return { field: { phone: message }, general: null };
    if (lower.includes("bill number")) return { field: { billNumber: message }, general: null };
    if (lower.includes("bill amount")) return { field: { amount: message }, general: null };
    if (lower.includes("reward")) return { field: { rewardId: message }, general: null };
    if (lower.includes("name")) return { field: { name: message }, general: null };
    return { field: {}, general: message };
  };

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (brandMode) {
      if (brand) headers["X-Brand"] = brand;
      headers["X-Brand-Pin"] = pin;
    }
    return headers;
  };

  const submitEarn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errors = validateEarn();
    if (errors) {
      setFieldErrors(errors);
      setError(null);
      setResult(null);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          ...(cardCode.trim() ? { cardCode: cardCode.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(enroll && name.trim() ? { name: name.trim() } : {}),
          ...(enroll && email.trim() ? { email: email.trim() } : {}),
          amount: Number(amount),
          billNumber: billNumber.trim(),
        }),
      });
      const body = (await res.json()) as ScanResult;
      if (body.ok) {
        setError(null);
        setResult(body);
        setAmount("");
        setCardCode("");
        setPhone("");
        setName("");
        setEmail("");
        setBillNumber("");
        setEnroll(false);
      } else if (body.code === "member_not_found" && phone.trim() && !cardCode.trim()) {
        // Phone isn't registered — step 2: capture the new customer's details.
        setEnroll(true);
        setError(null);
        setFieldErrors({});
      } else if (
        body.code === "unknown_brand" ||
        body.code === "invalid_pin" ||
        body.code === "wrong_brand"
      ) {
        // Brand/PIN failures aren't tied to a form field — surface the server's
        // message at the top of the form.
        setFieldErrors({});
        setError(body.message || "Brand authentication failed");
      } else {
        const message = body.message || "Something went wrong";
        const { field, general } = mapServerError(message);
        setFieldErrors(field);
        setError(general);
      }
    } catch {
      setError("Request failed — check your connection");
    } finally {
      setBusy(false);
    }
  };

  const submitRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errors = validateRedeem();
    if (errors) {
      setFieldErrors(errors);
      setError(null);
      setRedeemResult(null);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setError(null);
    setRedeemResult(null);
    try {
      const res = await fetch("/api/redeem", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          ...(cardCode.trim() ? { cardCode: cardCode.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          rewardId,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const body = (await res.json()) as RedeemResult;
      if (body.ok) {
        setError(null);
        setRedeemResult(body);
        setCardCode("");
        setPhone("");
        setNote("");
      } else if (
        body.code === "unknown_brand" ||
        body.code === "invalid_pin" ||
        body.code === "wrong_brand"
      ) {
        setFieldErrors({});
        setError(body.message || "Brand authentication failed");
      } else if (body.code === "member_not_found") {
        setFieldErrors(
          phone.trim() && !cardCode.trim()
            ? { phone: "No member found for this phone at this brand" }
            : { cardCode: "No member found for this card at this brand" },
        );
        setError(null);
      } else {
        const message = body.message || "Something went wrong";
        const { field, general } = mapServerError(message);
        setFieldErrors(field);
        setError(general);
      }
    } catch {
      setError("Request failed — check your connection");
    } finally {
      setBusy(false);
    }
  };

  const submitting = busy;
  const selectedReward = rewards.find((r) => r.id === rewardId) ?? null;
  const redeemedReward =
    redeemResult?.ok === true ? (rewards.find((r) => r.id === redeemResult.rewardId) ?? null) : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={mode === "earn" ? "default" : "outline"}
              disabled={submitting}
              onClick={() => switchMode("earn")}
            >
              <Plus className="size-4" />
              <T>Add points</T>
            </Button>
            <Button
              type="button"
              variant={mode === "redeem" ? "default" : "outline"}
              disabled={submitting}
              onClick={() => switchMode("redeem")}
            >
              <Gift className="size-4" />
              <T>Redeem</T>
            </Button>
          </div>
          <CardTitle>{mode === "earn" ? <T>Add points</T> : <T>Redeem points</T>}</CardTitle>
          <CardDescription>
            {mode === "earn" ? (
              <T>Enter the card code or phone, bill amount and bill number</T>
            ) : (
              <T>Enter the card code or phone and pick a reward to redeem</T>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={mode === "earn" ? submitEarn : submitRedeem} className="space-y-4">
            {brandMode && (
              <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="space-y-2">
                  <Label htmlFor="brand">
                    <T>Brand</T>
                  </Label>
                  <select
                    id="brand"
                    name="brand"
                    value={brand}
                    disabled={submitting}
                    onChange={(e) => handleBrandChange(e.target.value)}
                    className={BRAND_SELECT_CLASS}
                  >
                    {brands.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="brandPin">
                    <T>PIN</T>
                  </Label>
                  <Input
                    id="brandPin"
                    name="brandPin"
                    type="password"
                    autoComplete="off"
                    placeholder="••••"
                    value={pin}
                    disabled={submitting}
                    onChange={(e) => handlePinChange(e.target.value)}
                  />
                </div>
              </div>
            )}

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
                aria-invalid={Boolean(fieldErrors.cardCode)}
                onChange={(e) => {
                  setCardCode(e.target.value.toUpperCase());
                  clearFieldError("cardCode");
                }}
              />
              {fieldErrors.cardCode && (
                <p className="text-xs text-destructive" data-slot="field-error">
                  {fieldErrors.cardCode}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">
                <T>Phone (optional)</T>
              </Label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="e.g. 9096444567"
                value={phone}
                aria-invalid={Boolean(fieldErrors.phone)}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearFieldError("phone");
                }}
              />
              <p className="text-xs text-muted-foreground">
                <T>Enter the card code or the customer&apos;s phone number.</T>
              </p>
              {fieldErrors.phone && (
                <p className="text-xs text-destructive" data-slot="field-error">
                  {fieldErrors.phone}
                </p>
              )}
            </div>

            {mode === "earn" ? (
              <>
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
                    aria-invalid={Boolean(fieldErrors.amount)}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      clearFieldError("amount");
                    }}
                  />
                  {fieldErrors.amount && (
                    <p className="text-xs text-destructive" data-slot="field-error">
                      {fieldErrors.amount}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="billNumber">
                    <T>Bill number</T>
                  </Label>
                  <Input
                    id="billNumber"
                    name="billNumber"
                    autoComplete="off"
                    placeholder="e.g. INV-1042"
                    value={billNumber}
                    aria-invalid={Boolean(fieldErrors.billNumber)}
                    onChange={(e) => {
                      setBillNumber(e.target.value);
                      clearFieldError("billNumber");
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    <T>A unique number for this bill — prevents crediting twice.</T>
                  </p>
                  {fieldErrors.billNumber && (
                    <p className="text-xs text-destructive" data-slot="field-error">
                      {fieldErrors.billNumber}
                    </p>
                  )}
                </div>

                {enroll && (
                  <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <UserPlus className="size-4" />
                      <T>New customer for this phone</T>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <T>
                        This phone number isn&apos;t registered yet. Enter the customer&apos;s
                        details to enroll them and add points.
                      </T>
                    </p>
                    <div className="space-y-2">
                      <Label htmlFor="name">
                        <T>Name</T>
                      </Label>
                      <Input
                        id="name"
                        name="name"
                        autoComplete="off"
                        placeholder="e.g. Rohan"
                        value={name}
                        aria-invalid={Boolean(fieldErrors.name)}
                        onChange={(e) => {
                          setName(e.target.value);
                          clearFieldError("name");
                        }}
                      />
                      {fieldErrors.name && (
                        <p className="text-xs text-destructive" data-slot="field-error">
                          {fieldErrors.name}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">
                        <T>Email (optional)</T>
                      </Label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="off"
                        placeholder="e.g. rohan@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="reward">
                    <T>Reward</T>
                  </Label>
                  {rewardsStatus === "loading" && (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      <T>Loading rewards…</T>
                    </p>
                  )}
                  {rewardsStatus === "idle" && brandMode && !pin && (
                    <p className="text-xs text-muted-foreground">
                      <T>Enter the brand PIN to load rewards.</T>
                    </p>
                  )}
                  {rewardsStatus === "error" && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 p-3 text-xs text-destructive">
                      <span>
                        <T>Couldn&apos;t load rewards — check the PIN.</T>
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={submitting}
                        onClick={() => setRewardsNonce((n) => n + 1)}
                      >
                        <RefreshCw className="size-3" />
                        <T>Retry</T>
                      </Button>
                    </div>
                  )}
                  {rewardsStatus === "ready" && rewards.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      <T>No rewards are configured for this brand yet.</T>
                    </p>
                  )}
                  {rewardsStatus === "ready" && rewards.length > 0 && (
                    <>
                      <select
                        id="reward"
                        name="reward"
                        value={rewardId}
                        disabled={submitting}
                        onChange={(e) => {
                          setRewardId(e.target.value);
                          clearFieldError("rewardId");
                        }}
                        className={BRAND_SELECT_CLASS}
                      >
                        {rewards.map((r) => (
                          <option key={r.id} value={r.id}>
                            {`${r.name} · ${String(r.cost)} pts`}
                          </option>
                        ))}
                      </select>
                      {selectedReward && (
                        <p className="text-xs text-muted-foreground">
                          {selectedReward.cost.toLocaleString()} <T>points</T>
                          {selectedReward.description ? ` — ${selectedReward.description}` : ""}
                        </p>
                      )}
                    </>
                  )}
                  {fieldErrors.rewardId && (
                    <p className="text-xs text-destructive" data-slot="field-error">
                      {fieldErrors.rewardId}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="note">
                    <T>Note (optional)</T>
                  </Label>
                  <Input
                    id="note"
                    name="note"
                    autoComplete="off"
                    placeholder="e.g. requested at counter"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || (mode === "redeem" && rewardsStatus !== "ready")}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : mode === "earn" ? (
                enroll ? (
                  <UserPlus className="size-4" />
                ) : (
                  <Plus className="size-4" />
                )
              ) : (
                <Gift className="size-4" />
              )}
              {mode === "earn" ? (
                <T>{enroll ? "Enroll & Add Points" : "Add Points"}</T>
              ) : (
                <T>Redeem reward</T>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50 text-destructive">
          <CardContent className="pt-6 text-sm">{error}</CardContent>
        </Card>
      )}

      <Link
        href="/reports"
        className="text-center text-sm text-muted-foreground hover:text-foreground"
      >
        <T>View brand report</T> →
      </Link>

      {mode === "earn" && result?.ok && (
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
            {result.cardCode && (
              <div className="text-sm text-muted-foreground">
                {result.enrolled ? <T>New member card code</T> : <T>Card code</T>}:{" "}
                <span className="font-mono font-medium text-foreground">{result.cardCode}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {mode === "redeem" && redeemResult?.ok && (
        <Card>
          <CardContent className="space-y-1 pt-6">
            <div className="flex items-center gap-2 font-medium text-green-600 dark:text-green-500">
              <Check className="size-4" />
              <T>Redeemed</T>
              {redeemedReward ? `: ${redeemedReward.name}` : ""}
            </div>
            <div className="text-sm text-muted-foreground">
              <T>Reward</T>: {describeRewardType(redeemResult.payload)}
            </div>
            <div className="text-sm text-muted-foreground">
              <T>Points spent</T>:{" "}
              <span className="font-medium tabular-nums text-foreground">
                {redeemResult.cost.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-muted-foreground">
              <T>New balance</T>:{" "}
              <span className="font-medium tabular-nums text-foreground">
                {redeemResult.balance.toLocaleString()}
              </span>
            </div>
            {redeemResult.cardCode && (
              <div className="text-sm text-muted-foreground">
                <T>Card code</T>:{" "}
                <span className="font-mono font-medium text-foreground">
                  {redeemResult.cardCode}
                </span>
              </div>
            )}
            <p className="pt-1 text-xs text-muted-foreground">
              <T>Apply this reward on the POS and hand it to the customer.</T>
            </p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
