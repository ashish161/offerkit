"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plus, UserPlus } from "lucide-react";
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
  cardCode?: string;
  enrolled?: boolean;
}

interface ScanFailure {
  ok: false;
  code: string;
  message: string;
}

type ScanResult = ScanSuccess | ScanFailure;

type FieldErrors = Partial<Record<"cardCode" | "phone" | "amount" | "billNumber" | "name", string>>;

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

export default function ScanPage() {
  const [cardCode, setCardCode] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
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

  const handleBrandChange = (value: string) => {
    setBrand(value);
    setPin(readStoredPin(value));
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

  const validate = (): FieldErrors | null => {
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

  // Map server validation/shortfall responses to the offending field so the
  // message shows right where the cashier needs to fix it.
  const mapServerError = (message: string): { field: FieldErrors; general: string | null } => {
    const lower = message.toLowerCase();
    if (lower.includes("card code")) return { field: { cardCode: message }, general: null };
    if (lower.includes("phone")) return { field: { phone: message }, general: null };
    if (lower.includes("bill number")) return { field: { billNumber: message }, general: null };
    if (lower.includes("bill amount")) return { field: { amount: message }, general: null };
    if (lower.includes("name")) return { field: { name: message }, general: null };
    return { field: {}, general: message };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errors = validate();
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
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (brandMode) {
        if (brand) headers["X-Brand"] = brand;
        headers["X-Brand-Pin"] = pin;
      }
      const res = await fetch("/api/scan", {
        method: "POST",
        headers,
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

  const submitting = busy;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <T>Add points</T>
          </CardTitle>
          <CardDescription>
            <T>Enter the card code or phone, bill amount and bill number</T>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
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
                    This phone number isn&apos;t registered yet. Enter the customer&apos;s details to
                    enroll them and add points.
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

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : enroll ? (
                <UserPlus className="size-4" />
              ) : (
                <Plus className="size-4" />
              )}
              <T>{enroll ? "Enroll & Add Points" : "Add Points"}</T>
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
            {result.cardCode && (
              <div className="text-sm text-muted-foreground">
                {result.enrolled ? <T>New member card code</T> : <T>Card code</T>}:{" "}
                <span className="font-mono font-medium text-foreground">{result.cardCode}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
