import { groth16 } from "snarkjs";
import { poseidon } from "../shared/poseidon.js";
import { merklePath } from "../shared/tree.js";
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
  const leaves = roster.leaves.map((leaf) => BigInt(leaf));
  const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
  const leafIndex = leaves.indexOf(leaf);
  if (leafIndex < 0 || leaf === 0n) {
    throw new Error("当前名单中找不到该凭证承诺，请先刷新名单或确认凭证文件");
  }
  const path = merklePath(leafIndex, leaves, hash, roster.treeDepth);
  const input = {
    secret: BigInt(credential.secret).toString(),
    score: credential.score,
    pathElements: path.pathElements.map((value) => value.toString()),
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

export async function revokeRoster(
  expectedVersion: number,
  indices: number[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch("/api/admin/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion, indices }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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
