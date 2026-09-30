import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { poseidon } from "../shared/poseidon.js";
import { buildMerkleTree, merklePath } from "../shared/tree.js";
import { EVENTS } from "../shared/events.js";
import { TREE_DEPTH, type Credential, type EventPolicy, type Roster } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const credDir = resolve(root, "credentials");
const dataDir = resolve(root, "data");

// Fixed demo scores for 16 students: includes clear pass/fail cases
// for both events (thresholds 60 and 85).
const SCORES = [95, 88, 85, 76, 72, 60, 58, 55, 90, 82, 70, 45, 100, 84, 63, 30];

function deterministicSecret(index: number, score: number): bigint {
  const digest = createHash("sha256")
    .update(`demo-credential-v1:${index}:${score}`)
    .digest();
  // keep it well below the BN254 field modulus and non-zero
  return (BigInt("0x" + digest.toString("hex").slice(0, 62)) % (1n << 240n)) + 1n;
}

const hash = await poseidon();
mkdirSync(credDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const secrets = SCORES.map((score, i) => deterministicSecret(i, score));
const leaves = secrets.map((secret, i) => hash([secret, BigInt(SCORES[i])]));
const tree = await buildMerkleTree(leaves, hash);

if (leaves.length !== 2 ** TREE_DEPTH) {
  throw new Error(`expected ${2 ** TREE_DEPTH} leaves`);
}

const roster: Roster = {
  version: 0,
  leaves: leaves.map((leaf) => leaf.toString()),
  root: tree.root.toString(),
};

const credentials: Array<Credential & { index: number }> = [];
for (let i = 0; i < leaves.length; i++) {
  const path = merklePath(i, leaves, hash);
  const credential: Credential = {
    secret: secrets[i].toString(),
    score: SCORES[i],
    leafIndex: i,
    pathElements: path.pathElements.map((v) => v.toString()),
    pathIndices: path.pathIndices,
  };
  credentials.push({ index: i, ...credential });
  writeFileSync(
    resolve(credDir, `credential-${String(i).padStart(2, "0")}.json`),
    JSON.stringify(credential, null, 2) + "\n",
  );
}

// Server-side trusted configuration: root + event policies only.
// It contains NO credential secrets or scores.
const policyConfig = {
  treeDepth: TREE_DEPTH,
  events: EVENTS satisfies EventPolicy[],
};
writeFileSync(resolve(dataDir, "policy.json"), JSON.stringify(policyConfig, null, 2) + "\n");
writeFileSync(resolve(dataDir, "roster.json"), JSON.stringify(roster, null, 2) + "\n");
writeFileSync(resolve(credDir, "roster.json"), JSON.stringify(roster, null, 2) + "\n");

// Demo manifest (not used by the verifier; only helps the presenter).
const manifest = credentials.map((c) => {
  const qualification = EVENTS.map((e) => ({
    eventId: e.eventId,
    name: e.name,
    threshold: e.threshold,
    qualifies: c.score >= e.threshold,
  }));
  return { index: c.index, file: `credential-${String(c.index).padStart(2, "0")}.json`, score: c.score, qualification };
});
writeFileSync(resolve(credDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`generated ${credentials.length} credentials in credentials/`);
console.log("trusted merkle root:", tree.root.toString());
console.log("public roster written to data/roster.json and credentials/roster.json");
console.log("server policy written to data/policy.json (no secrets)");
