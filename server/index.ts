import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { loadPolicy } from "./policy.js";
import {
  canonicalFieldElement,
  RedemptionStore,
  RosterStore,
} from "./store.js";
import { poseidon } from "../shared/poseidon.js";
import { TREE_DEPTH } from "../shared/types.js";
import type {
  ProofPayload,
  RevokeRequest,
  VerifyResult,
} from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const vkey = JSON.parse(
  readFileSync(resolve(here, "..", "zk", "verification_key.json"), "utf8"),
) as unknown;

const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(here, "..", "data");
const policy = loadPolicy();
const hash = await poseidon();
const rosterStore = new RosterStore(hash, dataDir);
await rosterStore.ready();
const store = new RedemptionStore(dataDir);
let operationChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationChain.then(operation, operation);
  operationChain = result.then(() => undefined, () => undefined);
  return result;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/policy", (_req, res) => {
  const roster = rosterStore.current();
  res.json({
    merkleRoot: roster.root,
    treeDepth: policy.treeDepth,
    rosterVersion: roster.version,
    events: policy.events,
  });
});

app.get("/api/roster", (_req, res) => {
  res.json({ ...rosterStore.current(), treeDepth: TREE_DEPTH });
});

app.post("/api/revoke", async (req, res) => {
  const body = req.body as Partial<RevokeRequest>;
  if (
    !body ||
    !Number.isInteger(body.expectedVersion) ||
    !Array.isArray(body.indices)
  ) {
    res.status(400).json({ reason: "expectedVersion and indices are required" });
    return;
  }
  try {
    const indices = body.indices.slice();
    const expectedVersion = body.expectedVersion as number;
    const roster = await runSerialized(() =>
      rosterStore.revoke(indices, expectedVersion, dataDir),
    );
    res.json({
      version: roster.version,
      root: roster.root,
      leaves: roster.leaves,
      revokedIndices: [...new Set(body.indices)],
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    const reason = (error as Error).message;
    console.log("revoke rejected:", reason);
    res.status(status).json({ reason });
  }
});

app.post("/api/redeem", async (req, res) => {
  const body = req.body as Partial<ProofPayload>;
  const fail = (status: number, reason: string): void => {
    console.log("redeem rejected:", reason);
    res.status(status).json({
      verified: false,
      redeemed: false,
      reason,
    } satisfies VerifyResult);
  };

  const event = policy.events.find((e) => e.eventId === body?.eventId);
  if (!event) {
    fail(400, "unknown event");
    return;
  }
  if (!body || typeof body.proof !== "object" || !Array.isArray(body.publicSignals)) {
    fail(400, "malformed payload");
    return;
  }

  const [rawNullifier, rawRoot, rawThreshold, rawEventId] = body.publicSignals as string[];
  let nullifier: string;
  let root: string;
  let threshold: string;
  let eventId: string;
  try {
    nullifier = canonicalFieldElement(rawNullifier);
    root = canonicalFieldElement(rawRoot);
    threshold = canonicalFieldElement(rawThreshold);
    eventId = canonicalFieldElement(rawEventId);
  } catch {
    fail(400, "invalid public signals");
    return;
  }

  try {
    await runSerialized(async () => {
      const currentRoster = rosterStore.current();
      if (BigInt(root) !== BigInt(currentRoster.root)) {
        throw Object.assign(new Error("merkle root mismatch"), { status: 403 });
      }
      if (BigInt(threshold) !== BigInt(event.threshold)) {
        throw Object.assign(new Error("threshold mismatch"), { status: 403 });
      }
      if (BigInt(eventId) !== BigInt(event.eventId)) {
        throw Object.assign(new Error("event id mismatch"), { status: 403 });
      }

      const valid = await snarkjs.groth16.verify(
        vkey,
        [nullifier, root, threshold, eventId],
        body.proof as never,
      );
      if (!valid) {
        throw Object.assign(new Error("invalid proof"), { status: 403 });
      }

      const redeemed = await store.claim(event.eventId, nullifier);
      if (!redeemed) {
        throw Object.assign(new Error("already redeemed for this event"), {
          status: 409,
          duplicate: true,
        });
      }
    });
  } catch (error) {
    const reason = (error as Error).message;
    if ((error as { duplicate?: boolean }).duplicate) {
      res.status(409).json({
        verified: true,
        redeemed: false,
        eventId: event.eventId,
        nullifier,
        reason,
      } satisfies VerifyResult);
    } else {
      fail((error as { status?: number }).status ?? 400, reason);
    }
    return;
  }

  console.log("redeem accepted:", { eventId: event.eventId, nullifier });
  res.json({
    verified: true,
    redeemed: true,
    eventId: event.eventId,
    nullifier,
  } satisfies VerifyResult);
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(`verification server listening on http://127.0.0.1:${port}`);
  console.log("trusted root:", rosterStore.current().root);
  console.log("roster version:", rosterStore.current().version);
});
