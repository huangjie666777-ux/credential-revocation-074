import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMerkleTree } from "../shared/tree.js";
import { TREE_DEPTH, type Roster } from "../shared/types.js";
import type { PoseidonFn } from "../shared/poseidon-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = resolve(here, "..", "data");
const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

interface RedemptionRecord {
  eventId: number;
  nullifier: string;
  at: string;
}

export function canonicalFieldElement(value: string | number | bigint): string {
  const text = value.toString();
  if (!/^[0-9]+$/.test(text)) throw new Error("invalid field element");
  const parsed = BigInt(text);
  if (parsed >= BN254_FIELD_MODULUS) throw new Error("field element out of range");
  return parsed.toString();
}

export class RedemptionStore {
  private records: RedemptionRecord[];
  private chain: Promise<void> = Promise.resolve();
  private readonly dbPath: string;

  constructor(dataDir: string = defaultDataDir) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.dbPath = resolve(dataDir, "redemptions.json");
    this.records = this.load();
  }

  private load(): RedemptionRecord[] {
    try {
      return JSON.parse(readFileSync(this.dbPath, "utf8")) as RedemptionRecord[];
    } catch {
      return [];
    }
  }

  private persist(): void {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2) + "\n");
    renameSync(tmp, this.dbPath);
  }

  has(eventId: number, nullifier: string): boolean {
    const key = canonicalFieldElement(nullifier);
    return this.records.some(
      (r) => r.eventId === eventId && r.nullifier === key,
    );
  }

  // Serialized atomic claim: under concurrent duplicate submissions only one
  // call inserts; others see the record and return false. The record is
  // persisted before reporting success, so it survives restarts.
  claim(eventId: number, nullifier: string): Promise<boolean> {
    const key = canonicalFieldElement(nullifier);
    const run = this.chain.then(() => {
      if (this.has(eventId, key)) return false;
      this.records.push({ eventId, nullifier: key, at: new Date().toISOString() });
      this.persist();
      return true;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class RosterStore {
  private roster: Roster;
  private chain: Promise<Roster> = Promise.resolve(undefined as unknown as Roster);

  constructor(private readonly hash: PoseidonFn, dataDir: string = defaultDataDir) {
    const path = resolve(dataDir, "roster.json");
    const loaded = JSON.parse(readFileSync(path, "utf8")) as Roster;
    if (
      !Number.isInteger(loaded.version) ||
      loaded.version < 0 ||
      !Array.isArray(loaded.leaves) ||
      loaded.leaves.length !== 2 ** TREE_DEPTH
    ) {
      throw new Error("invalid persisted roster");
    }
    loaded.leaves.forEach((leaf) => canonicalFieldElement(leaf));
    canonicalFieldElement(loaded.root);
    this.roster = loaded;
    this.chain = buildMerkleTree(loaded.leaves.map(BigInt), hash).then((tree) => {
      if (tree.root.toString() !== loaded.root) throw new Error("persisted roster root mismatch");
      return this.current();
    });
  }

  current(): Roster {
    return {
      version: this.roster.version,
      root: this.roster.root,
      leaves: this.roster.leaves.slice(),
    };
  }

  ready(): Promise<Roster> {
    return this.chain;
  }

  revoke(indices: number[], expectedVersion: number, dataDir: string = defaultDataDir): Promise<Roster> {
    const run = this.chain.then(async () => {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw Object.assign(new Error("invalid expected version"), { status: 400 });
      }
      if (this.roster.version !== expectedVersion) {
        throw Object.assign(new Error("roster version conflict"), { status: 409 });
      }
      if (
        !Array.isArray(indices) ||
        indices.length === 0 ||
        indices.some((index) => !Number.isInteger(index) || index < 0 || index >= this.roster.leaves.length)
      ) {
        throw Object.assign(new Error("invalid leaf indices"), { status: 400 });
      }

      const unique = new Set(indices);
      if (unique.size !== indices.length || [...unique].some((index) => this.roster.leaves[index] === "0")) {
        throw Object.assign(new Error("indices include a revoked leaf"), { status: 400 });
      }

      const leaves = this.roster.leaves.slice();
      for (const index of unique) leaves[index] = "0";
      const tree = await buildMerkleTree(leaves.map(BigInt), this.hash);
      const next: Roster = {
        version: this.roster.version + 1,
        leaves,
        root: tree.root.toString(),
      };
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      const path = resolve(dataDir, "roster.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
      renameSync(tmp, path);
      this.roster = next;
      return this.current();
    });
    this.chain = run.catch(() => this.current());
    return run;
  }
}
