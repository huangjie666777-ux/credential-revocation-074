import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prove } from "./helpers";

const root = resolve(__dirname, "..");
const PORT = 3199;
const base = `http://127.0.0.1:${PORT}`;
const dataDir = resolve(root, "tmp-server-data");
let server: ChildProcess | undefined;

beforeAll(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(resolve(root, "data"), dataDir, { recursive: true });
}, 10000);

async function resetServer() {
  server?.kill();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const roster = readFileSync(resolve(root, "test", "fixtures", "data", "roster.json"));
  writeFileSync(resolve(dataDir, "roster.json"), roster);
  writeFileSync(resolve(dataDir, "redemptions.json"), "[]\n");
  server = spawn(
    process.execPath,
    ["--import", "tsx", resolve(root, "server", "index.ts")],
    {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), DEMO_DATA_DIR: dataDir, TEST_ROSTER_DIR: dataDir },
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not start");
}

beforeEach(async () => {
  await resetServer();
}, 30000);

afterEach(() => {
  server?.kill();
});

async function post(payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  return res.json();
}

async function revoke(expectedVersion: number, indices: number[]): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/admin/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion, indices }),
  });
  return { status: res.status, body: await res.json() };
}

describe("server policy enforcement", () => {
  it("redeems a valid proof once and rejects the duplicate", async () => {
    const payload = await prove(5, 1001); // score 60 >= 60
    const first = await post(payload);
    expect(first.status).toBe(200);
    expect(first.body.redeemed).toBe(true);
    const second = await post(payload);
    expect(second.status).toBe(409);
    expect(second.body.redeemed).toBe(false);
  });

  it("rejects an unknown event", async () => {
    const payload = await prove(12, 1001); // score 100
    payload.eventId = 9999;
    const res = await post(payload);
    expect(res.status).toBe(400);
  });

  it("rejects a client-chosen lower threshold", async () => {
    // credential idx 6 has score 58; circuit cannot prove against threshold 60,
    // so build a valid proof for event 1002 policy threshold 85 with a score
    // 100 credential then try to relay its signals claiming event 1001: the
    // eventId/public signal mismatch is enforced. Here we directly tamper the
    // publicSignals threshold which makes the Groth16 proof invalid.
    const payload = await prove(12, 1001);
    payload.publicSignals[2] = "30";
    const res = await post(payload);
    expect([400, 403]).toContain(res.status);
    expect(res.body.redeemed).toBe(false);
  });

  it("rejects a proof bound to a foreign root", async () => {
    // A well-formed proof can only be built for the configured root;
    // tampering the public root invalidates the proof cryptographically.
    const payload = await prove(12, 1002);
    payload.publicSignals[1] = "1";
    const res = await post(payload);
    expect([400, 403]).toContain(res.status);
  });

  it("only accepts the current root after revocation and preserves ordering", async () => {
    const before = await get("/api/roster");
    const revoked = await revoke(before.version, [3]);
    expect(revoked.status).toBe(200);
    expect(revoked.body.roster.version).toBe(before.version + 1);
    const stale = await prove(3, 1001);
    const staleResult = await post(stale);
    expect(staleResult.status).toBe(403);
    expect(staleResult.body.reason).toBe("merkle root mismatch");

    const conflict = await revoke(before.version, [4]);
    expect(conflict.status).toBe(409);
    const after = await get("/api/roster");
    expect(after.leaves[4]).not.toBe("0");
  });

  it("treats the two events independently", async () => {
    const forA = await prove(12, 1001);
    const forB = await prove(8, 1002);
    const a = await post(forA);
    const b = await post(forB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.nullifier).not.toBe(b.body.nullifier);
  });
});
