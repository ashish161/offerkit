"use client";

import Link from "next/link";
import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { T, useGT } from "gt-next/client";
import { Search } from "lucide-react";
import { DataTable } from "@/components/dashboard/data-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCursorPagination } from "@/hooks/use-cursor-pagination";
import { formatMinorCurrency } from "@/lib/money";
import { type ApiListItem, type OfferKitClient, ovx } from "@/lib/sdk";

type RedemptionRow = ApiListItem<OfferKitClient["redemptions"]["list"]>;

type Result = "" | "SUCCESS" | "FAILURE" | "ROLLBACK";

const RESULT_BADGE: Record<Exclude<Result, "">, "default" | "secondary" | "destructive" | "outline"> = {
  SUCCESS: "default",
  FAILURE: "destructive",
  ROLLBACK: "secondary",
};

export default function RedemptionsPage() {
  const gt = useGT();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Result>("");
  const pagination = useCursorPagination();
  const { cursor } = pagination;

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["redemptions", { search, result, cursor }],
    queryFn: () =>
      ovx().redemptions.list({
        search: search || undefined,
        result: result || undefined,
        cursor,
        limit: 20,
      }),
    refetchInterval: 5_000,
  });
  const columns: ColumnDef<RedemptionRow>[] = [
    {
      accessorKey: "voucherCode",
      header: () => <T>Code</T>,
      cell: ({ row }) => (
        <Link
          className="font-mono text-sm hover:underline"
          href={`/vouchers/${row.original.voucherCode}`}
        >
          {row.original.voucherCode}
        </Link>
      ),
    },
    {
      accessorKey: "customerName",
      header: () => <T>Customer</T>,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.customerName ?? row.original.customerEmail ?? "-"}
        </span>
      ),
    },
    {
      accessorKey: "result",
      header: () => <T>Result</T>,
      cell: ({ row }) => {
        const result = row.original.result as Exclude<Result, "">;
        return <Badge variant={RESULT_BADGE[result]}>{result}</Badge>;
      },
    },
    {
      accessorKey: "amount",
      header: () => <div className="text-right"><T>Amount</T></div>,
      cell: ({ row }) =>
        row.original.amount != null ? (
          <div className="text-right font-mono">
            {formatMinorCurrency(row.original.amount, row.original.currency ?? "INR")}
          </div>
        ) : (
          <div className="text-right text-muted-foreground">-</div>
        ),
    },
    {
      accessorKey: "failureReason",
      header: () => <T>Reason</T>,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.failureReason ?? "-"}
        </span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: () => <div className="text-right"><T>Created</T></div>,
      cell: ({ row }) => (
        <div className="text-right text-xs text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleString()}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          <T>Redemptions</T>
        </h1>
        <p className="text-sm text-muted-foreground">
          <T>Chronological ledger of every voucher redemption attempt, success or failure.</T>
        </p>
      </header>

      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={gt("Search by code, customer name or email")}
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              pagination.reset();
            }}
          />
        </div>
        <Select
          items={[
            { label: gt("All results"), value: "" },
            { label: gt("Success"), value: "SUCCESS" },
            { label: gt("Failure"), value: "FAILURE" },
            { label: gt("Rollback"), value: "ROLLBACK" },
          ]}
          value={result}
          onValueChange={(v) => {
            setResult(v as Result);
            pagination.reset();
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={gt("All results")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{gt("All results")}</SelectItem>
            <SelectItem value="SUCCESS">{gt("Success")}</SelectItem>
            <SelectItem value="FAILURE">{gt("Failure")}</SelectItem>
            <SelectItem value="ROLLBACK">{gt("Rollback")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.data ?? []}
        isLoading={isLoading}
        emptyMessage={<T>No redemptions yet.</T>}
        pagination={{
          type: "cursor",
          canPrevious: pagination.canPrevious,
          canNext: Boolean(data?.next),
          onPrevious: pagination.previous,
          onNext: () => {
            if (data?.next) pagination.next(data.next);
          },
          pending: isFetching,
        }}
      />
    </div>
  );
}