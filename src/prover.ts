import { groth16 } from "snarkjs";
import { poseidon } from "../shared/poseidon.js";
import { findLeafIndex, merklePath } from "../shared/tree.js";
import type { Credential, ProofPayload, Roster } from "../shared/types.js";

const WASM_URL = "zk/qualification.wasm";
const ZKEY_URL = "zk/qualification_final.zkey";

// Generates the Groth16 proof entirely in the browser. Only the proof and the
// four public signals (root, threshold, eventId, nullifier) ever leave the
// page; secret, score and Merkle path stay local.
export async function generateProof(
  credential: Credential,
  roster: Roster,
  eventId: number,
  threshold: number,
): Promise<ProofPayload> {
  const hash = await poseidon();
  const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
  const leaves = roster.leaves.map(BigInt);
  const leafIndex = findLeafIndex(leaves, leaf);
  if (leafIndex < 0) {
    throw new Error("凭证已撤销或不在当前名单中，禁止出证");
  }
  const path = merklePath(leafIndex, leaves, hash);
  const input = {
    secret: BigInt(credential.secret).toString(),
    score: credential.score,
    pathElements: path.pathElements.map(String),
    pathIndices: path.pathIndices,
    root: BigInt(roster.root).toString(),
    threshold,
    eventId,
  };
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    WASM_URL,
    ZKEY_URL,
  );
  return { eventId, proof, publicSignals };
}

export async function fetchRoster(): Promise<Roster> {
  const response = await fetch("/api/roster", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Roster;
}

export async function revoke(
  indices: number[],
  expectedVersion: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch("/api/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ indices, expectedVersion }),
  });
  return { status: response.status, body: await response.json() };
}

export async function redeem(payload: ProofPayload): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch("/api/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}
