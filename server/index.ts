import express from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { loadPolicy } from "./policy.js";
import { ConflictError, DataStore, ValidationError } from "./dataStore.js";
import { canonicalDecimal } from "./store.js";
import { poseidon } from "../shared/poseidon.js";
import type { VerifyResult } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const vkey = JSON.parse(
  readFileSync(resolve(here, "..", "zk", "verification_key.json"), "utf8"),
) as unknown;

const policy = loadPolicy();
const dataDir = process.env.DEMO_DATA_DIR
  ? resolve(process.env.DEMO_DATA_DIR)
  : undefined;
const dataStore = new DataStore(await poseidon(), dataDir);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/policy", (_req, res, next) => {
  dataStore
    .getRoster()
    .then((roster) => {
      res.json({
        merkleRoot: roster.root,
        rosterVersion: roster.version,
        treeDepth: policy.treeDepth,
        events: policy.events,
      });
    })
    .catch(next);
});

app.get("/api/roster", (_req, res, next) => {
  dataStore.getRoster().then((roster) => res.json(roster)).catch(next);
});

app.post("/api/admin/revoke", (req, res, next) => {
  const body = req.body as { expectedVersion?: unknown; indices?: unknown };
  dataStore
    .revoke(body?.expectedVersion, body?.indices)
    .then((roster) => res.json({ revoked: true, roster }))
    .catch((error: Error) => {
      if (error instanceof ConflictError) {
        res.status(409).json({ revoked: false, reason: error.message });
      } else if (error instanceof ValidationError) {
        res.status(400).json({ revoked: false, reason: error.message });
      } else {
        next(error);
      }
    });
});

app.post("/api/redeem", async (req, res) => {
  const body = req.body as {
    eventId?: unknown;
    proof?: unknown;
    publicSignals?: unknown;
  };
  const fail = (status: number, reason: string, rosterVersion?: number): void => {
    console.log("redeem rejected:", reason);
    res.status(status).json({
      verified: false,
      redeemed: false,
      reason,
      ...(rosterVersion === undefined ? {} : { rosterVersion }),
    } satisfies VerifyResult);
  };

  if (!body || typeof body.proof !== "object" || !Array.isArray(body.publicSignals)) {
    fail(400, "malformed payload");
    return;
  }
  const event = policy.events.find((candidate) => candidate.eventId === body.eventId);
  if (!event) {
    fail(400, "unknown event");
    return;
  }

  const signals = body.publicSignals as unknown[];
  if (signals.length !== 4 || signals.some((signal) => typeof signal !== "string")) {
    fail(400, "malformed public signals");
    return;
  }
  let nullifier: string;
  let root: string;
  let threshold: string;
  let eventId: string;
  try {
    [nullifier, root, threshold, eventId] = (signals as string[]).map(canonicalDecimal);
  } catch {
    fail(400, "public signals must be non-negative decimal integers");
    return;
  }
  if (Number(threshold) !== event.threshold) {
    fail(403, "threshold mismatch");
    return;
  }
  if (BigInt(eventId) !== BigInt(event.eventId)) {
    fail(403, "event id mismatch");
    return;
  }

  try {
    const result = await dataStore.redeem(event.eventId, root, nullifier, () =>
      snarkjs.groth16.verify(
        vkey,
        [nullifier, root, threshold, eventId],
        body.proof as never,
      ),
    );
    if (!result.redeemed) {
      const duplicate = result.reason === "already redeemed for this event";
      res.status(duplicate ? 409 : 403).json({
        verified: duplicate,
        redeemed: false,
        eventId: event.eventId,
        nullifier,
        rosterVersion: result.rosterVersion,
        reason: result.reason,
      } satisfies VerifyResult);
      return;
    }
    console.log("redeem accepted:", { eventId: event.eventId, nullifier });
    res.json({
      verified: true,
      redeemed: true,
      eventId: event.eventId,
      nullifier,
      rosterVersion: result.rosterVersion,
    } satisfies VerifyResult);
  } catch (error) {
    fail(400, `proof verification error: ${(error as Error).message}`);
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(`verification server listening on http://127.0.0.1:${port}`);
  void dataStore.getRoster().then((roster) => {
    console.log("current roster:", { version: roster.version, root: roster.root });
  });
});
