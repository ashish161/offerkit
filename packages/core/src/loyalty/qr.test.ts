import { describe, expect, it } from "vitest";
import type { LoyaltyEarnFormula } from "@offerkit/db/schema";
import { computeEarnPoints, normalizePhone } from "./qr.ts";

describe("computeEarnPoints", () => {
  it("per_cents: floor(amountMinor / divisor)", () => {
    const formula: LoyaltyEarnFormula = { kind: "per_cents", divisor: 1000 };
    // ₹2,500 = 250,000 paise → 250 points at divisor 1000 (₹10/pt)
    expect(computeEarnPoints(formula, 250_000)).toBe(250);
    // ₹5,000 = 500,000 paise → 500 points
    expect(computeEarnPoints(formula, 500_000)).toBe(500);
  });

  it("per_cents: floors partial units", () => {
    const formula: LoyaltyEarnFormula = { kind: "per_cents", divisor: 1000 };
    expect(computeEarnPoints(formula, 250_999)).toBe(250);
    expect(computeEarnPoints(formula, 999)).toBe(0);
  });

  it("per_cents: default divisor of 100 = 1 pt per major unit", () => {
    const formula: LoyaltyEarnFormula = { kind: "per_cents" };
    expect(computeEarnPoints(formula, 250_000)).toBe(2500);
  });

  it("fixed: returns value regardless of amount", () => {
    const formula: LoyaltyEarnFormula = { kind: "fixed", value: 50 };
    expect(computeEarnPoints(formula, 1)).toBe(50);
    expect(computeEarnPoints(formula, 1_000_000)).toBe(50);
  });

  it("fixed: defaults to 0 when value missing", () => {
    expect(computeEarnPoints({ kind: "fixed" }, 100)).toBe(0);
  });

  it("custom: returns null (caller must supply points)", () => {
    expect(computeEarnPoints({ kind: "custom" }, 100_000)).toBeNull();
  });

  it("non-positive or invalid amount returns 0", () => {
    const formula: LoyaltyEarnFormula = { kind: "per_cents", divisor: 100 };
    expect(computeEarnPoints(formula, 0)).toBe(0);
    expect(computeEarnPoints(formula, -500)).toBe(0);
    expect(computeEarnPoints(formula, Number.NaN)).toBe(0);
  });

  it("invalid divisor returns 0", () => {
    expect(computeEarnPoints({ kind: "per_cents", divisor: 0 }, 1000)).toBe(0);
    expect(computeEarnPoints({ kind: "per_cents", divisor: -1 }, 1000)).toBe(0);
  });
});

describe("normalizePhone", () => {
  it("returns the last 10 digits regardless of formatting", () => {
    expect(normalizePhone("9096444567")).toBe("9096444567");
    expect(normalizePhone("+91 90964 44567")).toBe("9096444567");
    expect(normalizePhone("090964 44567")).toBe("9096444567");
    expect(normalizePhone("(+91) 90964-44567")).toBe("9096444567");
  });

  it("returns null when there are too few digits to be a phone", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("K7XQ2M4A")).toBeNull();
  });
});
