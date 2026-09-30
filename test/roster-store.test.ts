import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poseidon } from "../shared/poseidon.js";
import { RosterStore } from "../server/store.js";

const tempDirs: string[] = [];

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "zk-roster-"));
  tempDirs.push(dir);
  const roster = JSON.parse(
    readFileSync(new URL("../data/roster.json", import.meta.url), "utf8"),
  );
  writeFileSync(join(dir, "roster.json"), JSON.stringify(roster));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RosterStore revocation", () => {
  it("revokes a batch atomically, increments version, keeps slots, and persists", async () => {
    const dir = makeDataDir();
    const hash = await poseidon();
    const store = new RosterStore(hash, dir);
    const before = store.current();
    const next = await store.revoke([2, 14], 0, dir);

    expect(next.version).toBe(1);
    expect(next.leaves).toHaveLength(16);
    expect(next.leaves[2]).toBe("0");
    expect(next.leaves[14]).toBe("0");
    expect(next.leaves[0]).toBe(before.leaves[0]);
    expect(next.root).not.toBe(before.root);

    const restarted = new RosterStore(hash, dir);
    await restarted.ready();
    expect(restarted.current()).toEqual(next);
  });

  it("rejects the whole batch on conflict, invalid indices, duplicates, or repeats", async () => {
    const dir = makeDataDir();
    const hash = await poseidon();
    const store = new RosterStore(hash, dir);
    await store.revoke([3], 0, dir);

    await expect(store.revoke([4], 0, dir)).rejects.toMatchObject({ status: 409 });
    await expect(store.revoke([16], 1, dir)).rejects.toMatchObject({ status: 400 });
    await expect(store.revoke([4, 4], 1, dir)).rejects.toMatchObject({ status: 400 });
    await expect(store.revoke([3], 1, dir)).rejects.toMatchObject({ status: 400 });
    expect(store.current().version).toBe(1);
    expect(store.current().leaves[4]).not.toBe("0");
  });
});
