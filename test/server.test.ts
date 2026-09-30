import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { poseidon } from "../shared/poseidon.js";
import { buildMerkleTree } from "../shared/tree.js";
import { loadCredential, prove } from "./helpers";

const root = resolve(__dirname, "..");
const PORT = 3199;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dataDir: string;

beforeAll(async () => {
  dataDir = resolve(root, "tmp-test-data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(resolve(root, "data", "policy.json"), resolve(dataDir, "policy.json"));
  copyFileSync(resolve(root, "data", "roster.json"), resolve(dataDir, "roster.json"));
  server = spawn(
    process.execPath,
    ["--import", "tsx", resolve(root, "server", "index.ts")],
    {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}, 60000);

afterAll(() => {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function revoke(indices: number[], expectedVersion: number) {
  const res = await fetch(`${base}/api/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ indices, expectedVersion }),
  });
  return { status: res.status, body: await res.json() };
}

describe("server policy and revocation enforcement", () => {
  it("redeems a valid proof once and rejects the duplicate", async () => {
    const payload = await prove(5, 1001);
    const first = await post(payload);
    expect(first.status).toBe(200);
    expect(first.body.redeemed).toBe(true);
    const second = await post(payload);
    expect(second.status).toBe(409);
    expect(second.body.redeemed).toBe(false);
  });

  it("rejects an unknown event", async () => {
    const payload = await prove(12, 1001);
    payload.eventId = 9999;
    const res = await post(payload);
    expect(res.status).toBe(400);
  });

  it("rejects a client-tampered threshold and foreign root", async () => {
    const payload = await prove(12, 1001);
    payload.publicSignals[2] = "30";
    const thresholdResult = await post(payload);
    expect(thresholdResult.body.redeemed).toBe(false);

    const foreignRoot = await prove(12, 1002);
    foreignRoot.publicSignals[1] = "1";
    const rootResult = await post(foreignRoot);
    expect([400, 403]).toContain(rootResult.status);
  });

  it("treats the two events independently", async () => {
    const forA = await prove(0, 1001);
    const forB = await prove(0, 1002);
    const a = await post(forA);
    const b = await post(forB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.nullifier).not.toBe(b.body.nullifier);
  });

  it("revokes a leaf and then accepts only current-root non-revoked proofs", async () => {
    const before = (await get("/api/roster")).body;
    const stale = await prove(1, 1002, { roster: before });

    const revocation = await revoke([1], before.version);
    expect(revocation.status).toBe(200);
    expect(revocation.body.version).toBe(before.version + 1);

    const staleResult = await post(stale);
    expect(staleResult.status).toBe(403);
    expect(staleResult.body.reason).toBe("merkle root mismatch");

    const current = (await get("/api/roster")).body;
    const hash = await poseidon();
    const credential = loadCredential(1);
    const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
    expect(current.leaves.findIndex((value: string) => BigInt(value) === leaf)).toBe(-1);
    expect((await buildMerkleTree(current.leaves.map(BigInt), hash)).root.toString()).toBe(current.root);

    const fresh = await prove(8, 1001, { roster: current });
    const accepted = await post(fresh);
    expect(accepted.status).toBe(200);
  });

  it("rejects version conflicts and illegal batches without changing the roster", async () => {
    const before = (await get("/api/roster")).body;
    const conflict = await revoke([9], before.version + 1);
    const illegal = await revoke([99], before.version);
    expect(conflict.status).toBe(409);
    expect(illegal.status).toBe(400);
    const after = (await get("/api/roster")).body;
    expect(after.version).toBe(before.version);
    expect(after.root).toBe(before.root);
  });
});
