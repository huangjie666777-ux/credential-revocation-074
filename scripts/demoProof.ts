import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { poseidon } from "../shared/poseidon.js";
import { merklePath } from "../shared/tree.js";
import type { Credential, ProofPayload, Roster } from "../shared/types.js";

// CLI: tsx scripts/demoProof.ts <credentialIndex> <eventId> [outFile]
// Produces a real Groth16 proof payload suitable for /api/redeem.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const indexArg = Number(process.argv[2]);
const eventId = Number(process.argv[3]);
const outFile = process.argv[4];
if (!Number.isInteger(indexArg) || !Number.isInteger(eventId)) {
  console.error("usage: tsx scripts/demoProof.ts <credentialIndex> <eventId> [outFile]");
  process.exit(2);
}

const policy = JSON.parse(readFileSync(resolve(root, "data", "policy.json"), "utf8")) as {
  events: { eventId: number; threshold: number }[];
};
const roster = JSON.parse(readFileSync(resolve(root, "data", "roster.json"), "utf8")) as Roster;
const event = policy.events.find((e) => e.eventId === eventId);
if (!event) throw new Error(`unknown event ${eventId}`);

const credential = JSON.parse(
  readFileSync(
    resolve(root, "credentials", `credential-${String(indexArg).padStart(2, "0")}.json`),
    "utf8",
  ),
) as Credential;
const hash = await poseidon();
const leaves = roster.leaves.map((leaf) => BigInt(leaf));
const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
const leafIndex = leaves.indexOf(leaf);
if (leafIndex < 0) throw new Error("credential is revoked or absent from current roster");
if (leaf === 0n) throw new Error("credential commitment must be non-zero");
const path = merklePath(leafIndex, leaves, hash, roster.treeDepth);

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  {
    secret: credential.secret,
    score: credential.score,
    pathElements: path.pathElements.map((value) => value.toString()),
    pathIndices: path.pathIndices,
    root: roster.root,
    threshold: event.threshold,
    eventId: event.eventId,
  },
  resolve(root, "zk", "qualification_js", "qualification.wasm"),
  resolve(root, "zk", "qualification_final.zkey"),
);

const payload: ProofPayload = { eventId, proof, publicSignals };
const json = JSON.stringify(payload);
if (outFile) {
  writeFileSync(outFile, json);
  console.log(`proof written to ${outFile}`);
  process.exit(0);
} else {
  process.stdout.write(json);
  process.exit(0);
}
