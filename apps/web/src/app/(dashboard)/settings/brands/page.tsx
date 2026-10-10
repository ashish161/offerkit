"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { T, useGT } from "gt-next/client";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, RotateCcw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ovx } from "@/lib/sdk";

interface BrandRow {
  id: string;
  name: string;
  programId: string;
  active: boolean;
  campaignName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BrandsResponse {
  ok: boolean;
  brands?: BrandRow[];
  legacyEnvConfigured?: boolean;
  code?: string;
  message?: string;
}

async function readBody(res: Response): Promise<BrandsResponse> {
  return (await res.json().catch(() => ({ ok: false }))) as BrandsResponse;
}

export default function BrandsSettingsPage() {
  const gt = useGT();
  const queryClient = useQueryClient();
  const queryKey = ["adminBrands"];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async (): Promise<BrandsResponse> => readBody(await fetch("/api/admin/brands")),
  });

  const { data: programs } = useQuery({
    queryKey: ["loyaltyPrograms", "all"],
    queryFn: () => ovx().loyalty.programs.list({ limit: 100 }),
  });
  const campaignIds = programs?.data.map((p) => p.campaignId) ?? [];
  const { data: campaigns } = useQuery({
    queryKey: ["campaigns", "brandOptions"],
    queryFn: () => ovx().campaigns.list({ limit: 100 }),
    enabled: campaignIds.length > 0,
  });
  const campaignName = (campaignId: string) =>
    campaigns?.data.find((c) => c.id === campaignId)?.name ?? campaignId.slice(0, 8);

  const programItems =
    programs?.data.map((p) => ({
      label: campaignName(p.campaignId),
      value: p.id,
    })) ?? [];

  const [name, setName] = useState("");
  const [programId, setProgramId] = useState("");
  const [pin, setPin] = useState("");
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPin, setResetPin] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editProgramId, setEditProgramId] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/brands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), programId, pin }),
      });
      const body = await readBody(res);
      if (!res.ok || !body.ok) throw new Error(body.message ?? gt("Create failed"));
      return body;
    },
    onSuccess: async () => {
      await invalidate();
      setName("");
      setProgramId("");
      setPin("");
      toast.success(gt("Brand created"));
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : gt("Create failed")),
  });

  const patch = useMutation({
    mutationFn: async (vars: { id: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/admin/brands/${vars.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars.body),
      });
      const body = await readBody(res);
      if (!res.ok || !body.ok) throw new Error(body.message ?? gt("Update failed"));
      return body;
    },
    onSuccess: async () => {
      await invalidate();
      setResetId(null);
      setResetPin("");
      setEditId(null);
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : gt("Update failed")),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/brands/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = await readBody(res);
        throw new Error(body.message ?? gt("Delete failed"));
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(gt("Brand deleted"));
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : gt("Delete failed")),
  });

  const brands = data?.brands ?? [];
  const createDisabled = !name.trim() || !programId || pin.trim().length < 4 || create.isPending;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          <T>Brands</T>
        </h1>
        <p className="text-sm text-muted-foreground">
          <T>
            Give each brand a loyalty program and a PIN. Brands use their name + PIN on the
            scan and report pages, and can only see their own program.
          </T>
        </p>
      </header>

      {data?.legacyEnvConfigured && (
        <Card className="border-amber-500/40">
          <CardContent className="pt-6 text-sm">
            <T>
              MULTI_TENANT_BRANDS is set in the environment. Database brands take precedence
              once any exist; remove the env var to avoid confusion.
            </T>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <T>New brand</T>
          </CardTitle>
          <CardDescription>
            <T>Assign an existing loyalty program and set the terminal PIN.</T>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (createDisabled) return;
              create.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="brandName">
                <T>Name</T>
              </Label>
              <Input
                id="brandName"
                autoComplete="off"
                placeholder="e.g. BrandA"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>
                <T>Loyalty program</T>
              </Label>
              <Select
                items={programItems}
                value={programId}
                onValueChange={(value) => setProgramId(value ?? "")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={gt("Select a program")} />
                </SelectTrigger>
                <SelectContent>
                  {programItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {programItems.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  <T>Create a loyalty program first.</T>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="brandPin">
                <T>PIN</T>
              </Label>
              <Input
                id="brandPin"
                autoComplete="off"
                placeholder="••••"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={createDisabled}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              <T>Create</T>
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <T>Configured brands</T>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading…</T>
            </p>
          ) : brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No brands yet.</T>
            </p>
          ) : (
            brands.map((brand) => (
              <div
                key={brand.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{brand.name}</span>
                    {brand.active ? (
                      <Badge variant="secondary">
                        <T>Active</T>
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        <T>Inactive</T>
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {brand.campaignName ?? brand.programId}
                  </div>
                </div>

                {resetId === brand.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      autoComplete="off"
                      placeholder={gt("New PIN")}
                      className="h-8 w-32"
                      value={resetPin}
                      onChange={(e) => setResetPin(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={resetPin.trim().length < 4 || patch.isPending}
                      onClick={() => patch.mutate({ id: brand.id, body: { pin: resetPin } })}
                    >
                      <T>Save</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setResetId(null);
                        setResetPin("");
                      }}
                    >
                      <T>Cancel</T>
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={gt("Edit")}
                      onClick={() => {
                        setEditId(brand.id);
                        setEditName(brand.name);
                        setEditProgramId(brand.programId);
                        setResetId(null);
                        setResetPin("");
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={gt("Reset PIN")}
                      onClick={() => {
                        setResetId(brand.id);
                        setResetPin("");
                      }}
                    >
                      <RotateCcw className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={brand.active ? gt("Deactivate") : gt("Activate")}
                      onClick={() =>
                        patch.mutate({ id: brand.id, body: { active: !brand.active } })
                      }
                    >
                      {brand.active ? (
                        <ShieldOff className="size-4" />
                      ) : (
                        <ShieldCheck className="size-4" />
                      )}
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={gt("Delete")}
                          className="text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      }
                      title={gt("Delete brand?")}
                      description={gt(
                        "The brand and its PIN stop working immediately. Existing members and history are not deleted.",
                      )}
                      confirmLabel={gt("Delete")}
                      destructive
                      pending={remove.isPending}
                      onConfirm={() => remove.mutate(brand.id)}
                    />
                  </div>
                )}

                {editId === brand.id && (
                  <div className="basis-full grid gap-3 border-t pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div className="space-y-2">
                      <Label htmlFor={`editName-${brand.id}`}>
                        <T>Name</T>
                      </Label>
                      <Input
                        id={`editName-${brand.id}`}
                        autoComplete="off"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>
                        <T>Loyalty program</T>
                      </Label>
                      <Select
                        items={programItems}
                        value={editProgramId}
                        onValueChange={(value) => setEditProgramId(value ?? "")}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={gt("Select a program")} />
                        </SelectTrigger>
                        <SelectContent>
                          {programItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={!editName.trim() || !editProgramId || patch.isPending}
                        onClick={() =>
                          patch.mutate({
                            id: brand.id,
                            body: { name: editName.trim(), programId: editProgramId },
                          })
                        }
                      >
                        <T>Save</T>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>
                        <T>Cancel</T>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
