import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataStore, ConflictError, ValidationError } from "../server/dataStore.js";
import { poseidon } from "../shared/poseidon.js";

const root = resolve(__dirname, "..");
const tempDir = resolve(root, "tmp-test-data");

async function store() {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const roster = JSON.parse(
    readFileSync(resolve(root, "test", "fixtures", "data", "roster.json"), "utf8"),
  );
  writeFileSync(resolve(tempDir, "roster.json"), JSON.stringify(roster));
  return new DataStore(await poseidon(), tempDir);
}

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function freshStore() {
  return store();
}

describe("versioned roster store", () => {
  it("revokes a valid batch atomically and advances one version", async () => {
    const data = await freshStore();
    const before = await data.getRoster();
    const after = await data.revoke(before.version, [1, 3]);
    expect(after.version).toBe(1);
    expect(after.leaves[1]).toBe("0");
    expect(after.leaves[3]).toBe("0");
    expect(after.leaves[0]).not.toBe("0");
    expect(after.revokedIndices).toEqual([1, 3]);
    expect(after.root).not.toBe(before.root);
  });

  it("rejects the whole batch on conflict or invalid indices", async () => {
    const data = await freshStore();
    await expect(data.revoke(0, [])).rejects.toBeInstanceOf(ValidationError);
    await expect(data.revoke(0, [16])).rejects.toBeInstanceOf(ValidationError);
    await expect(data.revoke(0, [0, 0])).rejects.toBeInstanceOf(ValidationError);
    await expect(data.revoke(99, [0])).rejects.toBeInstanceOf(ConflictError);
    const unchanged = await data.getRoster();
    expect(unchanged.version).toBe(0);
    expect(unchanged.revokedIndices).toEqual([]);
  });

  it("rejects revoking an already zero leaf", async () => {
    const data = await freshStore();
    await data.revoke(0, [2]);
    await expect(data.revoke(1, [2, 4])).rejects.toBeInstanceOf(ConflictError);
    const roster = await data.getRoster();
    expect(roster.version).toBe(1);
    expect(roster.leaves[4]).not.toBe("0");
  });

  it("canonicalizes nullifiers so leading zeroes cannot create a second record", async () => {
    const data = await freshStore();
    const roster = await data.getRoster();
    const first = await data.redeem(1001, roster.root, "123", () => Promise.resolve(true));
    const second = await data.redeem(1001, roster.root, "0123", () => Promise.resolve(true));
    expect(first.redeemed).toBe(true);
    expect(second.redeemed).toBe(false);
  });
});
