import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as snarkjs from "snarkjs";
import { merklePath } from "../shared/tree.js";
import { poseidon } from "../shared/poseidon.js";
import type { Credential, ProofPayload, Roster } from "../shared/types.js";

const root = resolve(__dirname, "..");

export function paths() {
  return {
    root,
    wasm: resolve(root, "zk", "qualification_js", "qualification.wasm"),
    zkey: resolve(root, "zk", "qualification_final.zkey"),
    vkey: resolve(root, "zk", "verification_key.json"),
  };
}

export function loadPolicy(): {
  merkleRoot: string;
  events: { eventId: number; name: string; threshold: number }[];
} {
  return JSON.parse(
    readFileSync(resolve(root, "data", "policy.json"), "utf8"),
  );
}

export function loadRoster(): Roster {
  const dataDir = process.env.TEST_ROSTER_DIR;
  if (dataDir) {
    return JSON.parse(
      readFileSync(resolve(dataDir, "roster.json"), "utf8"),
    );
  }
  return JSON.parse(
    readFileSync(resolve(root, "data", "roster.json"), "utf8"),
  );
}

export function loadCredential(index: number): Credential {
  return JSON.parse(
    readFileSync(
      resolve(root, "credentials", `credential-${String(index).padStart(2, "0")}.json`),
      "utf8",
    ),
  );
}

export async function prove(
  index: number,
  eventId: number,
  overrides: Partial<{
    secret: string;
    score: number;
    root: string;
    threshold: number;
    tamperedEvent: number;
  }> = {},
): Promise<ProofPayload> {
  const policy = loadPolicy();
  const event = policy.events.find((e) => e.eventId === eventId)!;
  const credential = loadCredential(index);
  const roster = loadRoster();
  const hash = await poseidon();
  const leaves = roster.leaves.map((leaf) => BigInt(leaf));
  const leaf = hash([
    BigInt(overrides.secret ?? credential.secret),
    BigInt(overrides.score ?? credential.score),
  ]);
  const leafIndex = leaves.findIndex((candidate) => candidate === leaf);
  const path = leafIndex >= 0
    ? merklePath(leafIndex, leaves, hash, roster.treeDepth)
    : { pathElements: credential.pathElements.map(BigInt), pathIndices: credential.pathIndices };
  const { wasm, zkey } = paths();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      secret: overrides.secret ?? credential.secret,
      score: overrides.score ?? credential.score,
      pathElements: path.pathElements.map(String),
      pathIndices: path.pathIndices,
      root: overrides.root ?? roster.root,
      threshold: overrides.threshold ?? event.threshold,
      eventId: overrides.tamperedEvent ?? event.eventId,
    },
    wasm,
    zkey,
  );
  return { eventId, proof, publicSignals };
}

export async function verifyProof(payload: ProofPayload): Promise<boolean> {
  const { vkey } = paths();
  return snarkjs.groth16.verify(
    JSON.parse(readFileSync(vkey, "utf8")),
    payload.publicSignals,
    payload.proof as never,
  );
}
