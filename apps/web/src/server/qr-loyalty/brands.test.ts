import { describe, expect, it } from "vitest";
import { brandFromHeader, parseBrands } from "./brands";

const PID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("brands", () => {
  it("parseBrands: empty/undefined -> {}", () => {
    expect(parseBrands("")).toEqual({});
    expect(parseBrands(undefined)).toEqual({});
  });

  it("parseBrands: invalid JSON -> {}", () => {
    expect(parseBrands("{oops")).toEqual({});
    expect(parseBrands("null")).toEqual({});
    expect(parseBrands("[]")).toEqual({});
  });

  it("parseBrands: validates uuid and non-empty pin", () => {
    expect(parseBrands(JSON.stringify({ b: { programId: "not-uuid", pin: "123" } }))).toEqual({});
    expect(parseBrands(JSON.stringify({ b: { programId: PID, pin: "" } }))).toEqual({});
    expect(parseBrands(JSON.stringify({ b: { programId: PID, pin: "123" } }))).toEqual({ b: { programId: PID, pin: "123" } });
  });

  it("parseBrands: trims keys", () => {
    expect(parseBrands(JSON.stringify({ " brandA ": { programId: PID, pin: "p" } }))).toEqual({ brandA: { programId: PID, pin: "p" } });
  });

  it("brandFromHeader: reads x-brand, trims, null on blank", () => {
    expect(brandFromHeader(new Request("http://x", { headers: { "x-brand": "A" } }))).toBe("A");
    expect(brandFromHeader(new Request("http://x", { headers: { "X-Brand": "  B  " } }))).toBe("B");
    expect(brandFromHeader(new Request("http://x"))).toBeNull();
    expect(brandFromHeader(new Request("http://x", { headers: { "x-brand": "   " } }))).toBeNull();
  });
});
