import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as snarkjs from "snarkjs";
import { merklePath } from "../shared/tree.js";
import { poseidon } from "../shared/poseidon.js";
import type { Credential, ProofPayload } from "../shared/types.js";

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
  events: { eventId: number; name: string; threshold: number }[];
} {
  return JSON.parse(
    readFileSync(resolve(root, "data", "policy.json"), "utf8"),
  );
}

export function loadRoster() {
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
    roster: ReturnType<typeof loadRoster>;
  }> = {},
): Promise<ProofPayload> {
  const policy = loadPolicy();
  const roster = overrides.roster ?? loadRoster();
  const event = policy.events.find((e) => e.eventId === eventId)!;
  const credential = loadCredential(index);
  const { wasm, zkey } = paths();
  const hash = await poseidon();
  const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
  const leaves = roster.leaves.map(BigInt);
  const leafIndex = leaves.findIndex((candidate: bigint) => candidate === leaf);
  if (leafIndex < 0) throw new Error("credential revoked or absent from roster");
  const path = merklePath(leafIndex, leaves, hash);
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
