"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, Loader2, Lock } from "lucide-react";
import { T } from "gt-next/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMinorCurrency } from "@/lib/money";

interface BrandReportSummary {
  customers: number;
  members: number;
  pointsEarned: number;
  pointsSpent: number;
  pointsOutstanding: number;
  bills: number;
  revenueMinor: number;
}

interface BrandReportDailyRow {
  day: string;
  earnEvents: number;
  pointsEarned: number;
  pointsSpent: number;
}

interface BrandReportScan {
  bill: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface BrandReport {
  programId: string;
  brand: string | null;
  currency: string | null;
  summary: BrandReportSummary;
  daily: BrandReportDailyRow[];
  recentScans: BrandReportScan[];
}

interface BrandCustomerRow {
  memberId: string;
  customerId: string;
  name: string | null;
  phone: string | null;
  balance: number;
  lifetimePoints: number;
  tierName: string | null;
  pointsEarned: number;
  pointsSpent: number;
  bills: number;
  revenueMinor: number;
  lastActivityAt: string;
}

interface BrandCustomerDetail {
  memberId: string;
  name: string | null;
  phone: string | null;
  cardCode: string | null;
  balance: number;
  lifetimePoints: number;
  tierName: string | null;
  nextTierName: string | null;
  nextTierThreshold: number | null;
  enrolledAt: string;
  pointsEarned: number;
  pointsSpent: number;
  bills: number;
  revenueMinor: number;
  ledger: {
    id: string;
    reason: string;
    delta: number;
    balanceAfter: number;
    note: string | null;
    createdAt: string;
    lifetimeAfter: number;
    tierName: string | null;
    previousTierName: string | null;
    tierChanged: boolean;
  }[];
  scans: BrandReportScan[];
}

type ReportResponse =
  | { ok: true; report: BrandReport }
  | { ok: false; code: string; message: string };

type CustomersResponse =
  | { ok: true; customers: BrandCustomerRow[] }
  | { ok: false; code: string; message: string };

type CustomerDetailResponse =
  | { ok: true; report: BrandCustomerDetail }
  | { ok: false; code: string; message: string };

const BRAND_NAME_KEY = "offerkit.brand.name";
const BRAND_PIN_KEY = "offerkit.brand.pin";

const readStored = (key: string): string => {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writeStored = (key: string, value: string): void => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage can be unavailable (private mode) — value just won't persist.
  }
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default function ReportsPage() {
  const [multiTenant, setMultiTenant] = useState(false);
  const [brand, setBrand] = useState("");
  const [pin, setPin] = useState("");
  const brandMode = multiTenant;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BrandReport | null>(null);

  const [customers, setCustomers] = useState<BrandCustomerRow[]>([]);
  const [custSearch, setCustSearch] = useState("");
  const [custBusy, setCustBusy] = useState(false);
  const [detail, setDetail] = useState<BrandCustomerDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (brandMode) {
      if (brand.trim()) headers["X-Brand"] = brand.trim();
      headers["X-Brand-Pin"] = pin;
    }
    return headers;
  };

  const authError = (body: { code: string; message: string }): string | null => {
    if (
      body.code === "unknown_brand" ||
      body.code === "invalid_pin" ||
      body.code === "wrong_brand"
    ) {
      return body.message || "Brand authentication failed";
    }
    return null;
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      let multi = false;
      try {
        const res = await fetch("/api/brands");
        if (res.ok) {
          const data = (await res.json()) as { multiTenant?: unknown };
          multi = data.multiTenant === true;
        }
      } catch {
        multi = false;
      }
      if (!mounted) return;
      setBrand(readStored(BRAND_NAME_KEY));
      setPin(readStored(BRAND_PIN_KEY));
      setMultiTenant(multi);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleBrandChange = (value: string) => {
    setBrand(value);
    writeStored(BRAND_NAME_KEY, value);
    setReport(null);
    setCustomers([]);
    setDetail(null);
    setSelectedMemberId(null);
    setCustSearch("");
  };

  const handlePinChange = (value: string) => {
    setPin(value);
    writeStored(BRAND_PIN_KEY, value);
  };

  const loadCustomers = async (search: string) => {
    setCustBusy(true);
    setDetail(null);
    setSelectedMemberId(null);
    try {
      const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const res = await fetch(`/api/reports/customers${query}`, { headers: authHeaders() });
      const body = (await res.json()) as CustomersResponse;
      if (body.ok) setCustomers(body.customers);
      else setCustomers([]);
    } catch {
      setCustomers([]);
    } finally {
      setCustBusy(false);
    }
  };

  const loadDetail = async (memberId: string) => {
    setSelectedMemberId(memberId);
    setDetailBusy(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/reports/customer?memberId=${encodeURIComponent(memberId)}`, {
        headers: authHeaders(),
      });
      const body = (await res.json()) as CustomerDetailResponse;
      if (body.ok) setDetail(body.report);
    } catch {
      // leave detail null; the row stays selected with no panel
    } finally {
      setDetailBusy(false);
    }
  };

  const load = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setCustomers([]);
    setDetail(null);
    setSelectedMemberId(null);
    try {
      const res = await fetch("/api/reports", { headers: authHeaders() });
      const body = (await res.json()) as ReportResponse;
      if (body.ok) {
        setReport(body.report);
        void loadCustomers("");
      } else {
        setError(authError(body) ?? body.message ?? "Something went wrong");
      }
    } catch {
      setError("Request failed — check your connection");
    } finally {
      setBusy(false);
    }
  };

  const currency = report?.currency ?? "INR";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BarChart3 className="size-5" />
          <T>Loyalty report</T>
        </h1>
        <Link href="/scan" className="text-sm text-muted-foreground hover:text-foreground">
          <T>Add points</T> →
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="size-4" />
            <T>Brand access</T>
          </CardTitle>
          <CardDescription>
            <T>Enter your brand PIN to view your read-only report</T>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={load} className="flex flex-wrap items-end gap-3">
            {brandMode && (
              <>
                <div className="min-w-40 flex-1 space-y-2">
                  <Label htmlFor="brand">
                    <T>Brand</T>
                  </Label>
                  <Input
                    id="brand"
                    name="brand"
                    autoComplete="off"
                    placeholder="e.g. BrandA"
                    value={brand}
                    disabled={busy}
                    onChange={(e) => handleBrandChange(e.target.value)}
                  />
                </div>
                <div className="w-32 space-y-2">
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
                    disabled={busy}
                    onChange={(e) => handlePinChange(e.target.value)}
                  />
                </div>
              </>
            )}
            <Button type="submit" disabled={busy || (brandMode && !pin)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
              <T>View report</T>
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50 text-destructive">
          <CardContent className="pt-6 text-sm">{error}</CardContent>
        </Card>
      )}

      {report && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="truncate">{report.brand ?? <T>Brand</T>}</span>
                <Badge variant="secondary">
                  <T>Read-only</T>
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <Kpi label="Customers" value={report.summary.customers.toLocaleString()} />
                <Kpi label="Members" value={report.summary.members.toLocaleString()} />
                <Kpi
                  label="Points earned"
                  value={report.summary.pointsEarned.toLocaleString()}
                />
                <Kpi label="Points spent" value={report.summary.pointsSpent.toLocaleString()} />
                <Kpi
                  label="Points outstanding"
                  value={report.summary.pointsOutstanding.toLocaleString()}
                />
                <Kpi label="Bills" value={report.summary.bills.toLocaleString()} />
                <Kpi
                  label="Revenue"
                  value={formatMinorCurrency(report.summary.revenueMinor, currency)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <T>Daily activity</T>{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  <T>(last 30 days)</T>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {report.daily.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <T>No activity yet</T>
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium"><T>Day</T></th>
                      <th className="py-2 text-right font-medium"><T>Earns</T></th>
                      <th className="py-2 text-right font-medium"><T>Earned</T></th>
                      <th className="py-2 text-right font-medium"><T>Spent</T></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.daily.map((r) => (
                      <tr key={r.day} className="border-b last:border-0">
                        <td className="py-2 tabular-nums">{r.day}</td>
                        <td className="py-2 text-right tabular-nums">{r.earnEvents}</td>
                        <td className="py-2 text-right tabular-nums">{r.pointsEarned}</td>
                        <td className="py-2 text-right tabular-nums">{r.pointsSpent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>
                  <T>Customers</T>{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({customers.length})
                  </span>
                </span>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadCustomers(custSearch);
                  }}
                  className="flex items-center gap-2"
                >
                  <Input
                    value={custSearch}
                    onChange={(e) => setCustSearch(e.target.value)}
                    placeholder="Name or phone"
                    className="h-8 w-40"
                    aria-label="Search customers"
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={custBusy}>
                    {custBusy && <Loader2 className="size-3.5 animate-spin" />}
                    <T>Search</T>
                  </Button>
                </form>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {custBusy ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <T>Loading customers…</T>
                </p>
              ) : customers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <T>No customers found</T>
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium"><T>Customer</T></th>
                      <th className="py-2 font-medium"><T>Tier</T></th>
                      <th className="py-2 text-right font-medium"><T>Balance</T></th>
                      <th className="py-2 text-right font-medium"><T>Lifetime</T></th>
                      <th className="py-2 text-right font-medium"><T>Bills</T></th>
                      <th className="py-2 text-right font-medium"><T>Revenue</T></th>
                      <th className="py-2 text-right font-medium"><T>Last seen</T></th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr
                        key={c.memberId}
                        onClick={() => void loadDetail(c.memberId)}
                        className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${
                          selectedMemberId === c.memberId ? "bg-muted/50" : ""
                        }`}
                      >
                        <td className="py-2">
                          <div>{c.name ?? "—"}</div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {c.phone ?? ""}
                          </div>
                        </td>
                        <td className="py-2">
                          {c.tierName ? (
                            <Badge variant="secondary">{c.tierName}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{c.balance}</td>
                        <td className="py-2 text-right tabular-nums">{c.lifetimePoints}</td>
                        <td className="py-2 text-right tabular-nums">{c.bills}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMinorCurrency(c.revenueMinor, currency)}
                        </td>
                        <td className="py-2 text-right text-xs text-muted-foreground">
                          {new Date(c.lastActivityAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {detailBusy && (
            <Card>
              <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <T>Loading customer…</T>
              </CardContent>
            </Card>
          )}

          {detail && !detailBusy && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="truncate">{detail.name ?? <T>Customer</T>}</span>
                  {detail.tierName && <Badge variant="secondary">{detail.tierName}</Badge>}
                </CardTitle>
                <CardDescription className="tabular-nums">
                  {detail.phone ?? "—"}
                  {detail.cardCode ? ` · ${detail.cardCode}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  <Kpi label="Balance" value={detail.balance.toLocaleString()} />
                  <Kpi label="Lifetime" value={detail.lifetimePoints.toLocaleString()} />
                  <Kpi label="Points earned" value={detail.pointsEarned.toLocaleString()} />
                  <Kpi label="Points spent" value={detail.pointsSpent.toLocaleString()} />
                  <Kpi label="Bills" value={detail.bills.toLocaleString()} />
                  <Kpi
                    label="Revenue"
                    value={formatMinorCurrency(detail.revenueMinor, currency)}
                  />
                  <Kpi
                    label="Enrolled"
                    value={new Date(detail.enrolledAt).toLocaleDateString()}
                  />
                </div>

                {detail.nextTierName && detail.nextTierThreshold !== null && (
                  <p className="text-xs text-muted-foreground">
                    <T>Next tier</T>: {detail.nextTierName} ·{" "}
                    {Math.max(detail.nextTierThreshold - detail.lifetimePoints, 0).toLocaleString()}{" "}
                    <T>points to go</T>
                  </p>
                )}

                <div>
                  <div className="mb-2 text-sm font-medium">
                    <T>Points ledger &amp; tier</T>
                  </div>
                  {detail.ledger.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <T>No transactions yet</T>
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 font-medium"><T>When</T></th>
                          <th className="py-2 font-medium"><T>Reason</T></th>
                          <th className="py-2 font-medium"><T>Note</T></th>
                          <th className="py-2 font-medium"><T>Tier</T></th>
                          <th className="py-2 text-right font-medium"><T>Δ</T></th>
                          <th className="py-2 text-right font-medium"><T>Balance</T></th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.ledger.map((l) => (
                          <tr key={l.id} className="border-b last:border-0">
                            <td className="py-2 text-xs text-muted-foreground">
                              {new Date(l.createdAt).toLocaleString()}
                            </td>
                            <td className="py-2 text-xs">{l.reason}</td>
                            <td className="py-2 text-xs text-muted-foreground">
                              {l.note ?? "—"}
                            </td>
                            <td className="py-2 text-xs">
                              {l.tierName ? (
                                l.tierChanged ? (
                                  <span className="font-medium">
                                    {l.previousTierName ?? "—"} → {l.tierName}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">{l.tierName}</span>
                                )
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td
                              className={`py-2 text-right tabular-nums ${
                                l.delta >= 0 ? "text-green-600" : "text-red-600"
                              }`}
                            >
                              {l.delta >= 0 ? `+${l.delta}` : l.delta}
                            </td>
                            <td className="py-2 text-right tabular-nums">{l.balanceAfter}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <div className="mb-2 text-sm font-medium">
                    <T>Scans</T>
                  </div>
                  {detail.scans.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <T>No scans yet</T>
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 font-medium"><T>Bill</T></th>
                          <th className="py-2 font-medium"><T>Status</T></th>
                          <th className="py-2 text-right font-medium"><T>Amount</T></th>
                          <th className="py-2 text-right font-medium"><T>When</T></th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.scans.map((s, i) => (
                          <tr key={`${s.bill ?? "scan"}-${i}`} className="border-b last:border-0">
                            <td className="py-2 font-mono text-xs">{s.bill ?? "—"}</td>
                            <td className="py-2 text-xs text-muted-foreground">{s.status}</td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMinorCurrency(s.amountMinor, s.currency)}
                            </td>
                            <td className="py-2 text-right text-xs text-muted-foreground">
                              {new Date(s.createdAt).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <T>Recent scans</T>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {report.recentScans.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <T>No scans yet</T>
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium"><T>Bill</T></th>
                      <th className="py-2 font-medium"><T>Status</T></th>
                      <th className="py-2 text-right font-medium"><T>Amount</T></th>
                      <th className="py-2 text-right font-medium"><T>When</T></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recentScans.map((s, i) => (
                      <tr key={`${s.bill ?? "scan"}-${i}`} className="border-b last:border-0">
                        <td className="py-2 font-mono text-xs">{s.bill ?? "—"}</td>
                        <td className="py-2 text-xs text-muted-foreground">{s.status}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMinorCurrency(s.amountMinor, s.currency)}
                        </td>
                        <td className="py-2 text-right text-xs text-muted-foreground">
                          {new Date(s.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <p className="pb-4 text-center text-xs text-muted-foreground">
        <T>Powered by OfferKit</T>
      </p>
    </main>
  );
}
