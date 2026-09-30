import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { RedemptionStore } from "../server/store.js";

const tempDir = resolve(__dirname, "..", "tmp-store-data");

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  process.env.DEMO_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DEMO_DATA_DIR;
});

describe("RedemptionStore", () => {
  it("allows concurrent duplicate claims only once per event+nullifier", async () => {
    const store = new RedemptionStore(tempDir);
    const results = await Promise.all([
      store.claim(1001, "101"),
      store.claim(1001, "101"),
      store.claim(1001, "101"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("keeps events independent and persists across instances", async () => {
    const first = new RedemptionStore(tempDir);
    expect(await first.claim(1001, "1")).toBe(true);
    expect(await first.claim(1002, "1")).toBe(true);
    const restarted = new RedemptionStore(tempDir);
    expect(await restarted.claim(1001, "1")).toBe(false);
    expect(await restarted.claim(1002, "1")).toBe(false);
    expect(await restarted.claim(1001, "2")).toBe(true);
  });

  it("canonicalizes decimal leading zeroes before checking uniqueness", async () => {
    const store = new RedemptionStore(tempDir);
    expect(await store.claim(1001, "00123")).toBe(true);
    expect(await store.claim(1001, "123")).toBe(false);
  });
});
import { resolve } from "node:path";
