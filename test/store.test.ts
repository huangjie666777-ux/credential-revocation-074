import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { RedemptionStore } from "../server/store.js";

const dbFile = new URL("../data/redemptions.json", import.meta.url);

afterEach(() => {
  try {
    rmSync(dbFile, { force: true });
  } catch {
    // ignore
  }
});

describe("RedemptionStore", () => {
  it("allows concurrent duplicate claims only once per event+nullifier", async () => {
    const store = new RedemptionStore();
    const results = await Promise.all([
      store.claim(1001, "1001"),
      store.claim(1001, "1001"),
      store.claim(1001, "1001"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("keeps events independent and persists across instances", async () => {
    const first = new RedemptionStore();
    expect(await first.claim(1001, "1")).toBe(true);
    expect(await first.claim(1002, "1")).toBe(true);
    const restarted = new RedemptionStore();
    expect(await restarted.claim(1001, "1")).toBe(false);
    expect(await restarted.claim(1002, "1")).toBe(false);
    expect(await restarted.claim(1001, "2")).toBe(true);
  });

  it("canonicalizes decimal leading zeroes before duplicate checks", async () => {
    const store = new RedemptionStore();
    expect(await store.claim(1001, "00042")).toBe(true);
    expect(await store.claim(1001, "42")).toBe(false);
  });
});
