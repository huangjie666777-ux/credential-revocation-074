import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMerkleTree } from "../shared/tree.js";
import { TREE_DEPTH, type Roster } from "../shared/types.js";
import { canonicalDecimal } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
export const defaultDataDir = resolve(here, "..", "data");

interface RedemptionRecord {
  eventId: number;
  nullifier: string;
  at: string;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function loadRedemptions(path: string): RedemptionRecord[] {
  try {
    const records = JSON.parse(readFileSync(path, "utf8")) as RedemptionRecord[];
    return records.map((record) => ({
      ...record,
      nullifier: canonicalDecimal(record.nullifier),
    }));
  } catch {
    return [];
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export class DataStore {
  private roster: Roster;
  private redemptions: RedemptionRecord[];
  private chain: Promise<void> = Promise.resolve();

  private readonly dataDir: string;
  private readonly rosterPath: string;
  private readonly redemptionsPath: string;

  constructor(private readonly hash: (inputs: bigint[]) => bigint, dataDir = defaultDataDir) {
    this.dataDir = dataDir;
    this.rosterPath = resolve(this.dataDir, "roster.json");
    this.redemptionsPath = resolve(this.dataDir, "redemptions.json");
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.rosterPath)) {
      throw new Error("data/roster.json is missing; run npm run credentials:generate");
    }
    this.roster = JSON.parse(readFileSync(this.rosterPath, "utf8")) as Roster;
    this.validateRoster(this.roster);
    this.redemptions = loadRedemptions(this.redemptionsPath);
  }

  private validateRoster(roster: Roster): void {
    if (
      !Number.isInteger(roster.version) ||
      roster.version < 0 ||
      roster.treeDepth !== TREE_DEPTH ||
      !Array.isArray(roster.leaves) ||
      roster.leaves.length !== 2 ** TREE_DEPTH ||
      typeof roster.root !== "string" ||
      !Array.isArray(roster.revokedIndices)
    ) {
      throw new Error("invalid persisted roster");
    }
    roster.leaves.forEach((leaf) => canonicalDecimal(leaf));
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  getRoster(): Promise<Roster> {
    return this.serialize(async () => structuredClone(this.roster));
  }

  revoke(expectedVersion: unknown, indices: unknown): Promise<Roster> {
    return this.serialize(async () => {
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError("expectedVersion must be an integer");
      }
      if (expectedVersion !== this.roster.version) {
        throw new ConflictError(
          `roster version conflict: expected ${this.roster.version}, got ${expectedVersion}`,
        );
      }
      if (!Array.isArray(indices) || indices.length === 0) {
        throw new ValidationError("indices must be a non-empty array");
      }
      const requested = [...indices] as unknown[];
      if (requested.some((index) => !Number.isInteger(index))) {
        throw new ValidationError("indices must contain integers only");
      }
      const numericIndices = requested as number[];
      if (numericIndices.some((index) => index < 0 || index >= this.roster.leaves.length)) {
        throw new ValidationError("leaf index out of range");
      }
      if (new Set(numericIndices).size !== numericIndices.length) {
        throw new ValidationError("duplicate leaf index in revocation request");
      }
      const alreadyRevoked = numericIndices.filter(
        (index) => BigInt(this.roster.leaves[index]) === 0n,
      );
      if (alreadyRevoked.length > 0) {
        throw new ConflictError(`leaves already revoked: ${alreadyRevoked.join(", ")}`);
      }

      const leaves = this.roster.leaves.slice();
      for (const index of numericIndices) leaves[index] = "0";
      const tree = await buildMerkleTree(
        leaves.map((leaf) => BigInt(leaf)),
        this.hash,
        this.roster.treeDepth,
      );
      const next: Roster = {
        version: this.roster.version + 1,
        treeDepth: this.roster.treeDepth,
        leaves,
        root: tree.root.toString(),
        revokedIndices: [
          ...this.roster.revokedIndices,
          ...numericIndices,
        ].sort((a, b) => a - b),
      };
      writeJson(this.rosterPath, next);
      this.roster = next;
      return structuredClone(next);
    });
  }

  async redeem(
    eventId: number,
    root: string,
    nullifier: string,
    verify: () => Promise<boolean>,
  ): Promise<{ redeemed: boolean; rosterVersion: number; reason?: string }> {
    return this.serialize(async () => {
      const canonicalRoot = canonicalDecimal(root);
      const canonicalNullifier = canonicalDecimal(nullifier);
      if (canonicalRoot !== this.roster.root) {
        return { redeemed: false, rosterVersion: this.roster.version, reason: "merkle root mismatch" };
      }
      const alreadyRedeemed = this.redemptions.some(
        (record) => record.eventId === eventId && record.nullifier === canonicalNullifier,
      );
      if (alreadyRedeemed) {
        return { redeemed: false, rosterVersion: this.roster.version, reason: "already redeemed for this event" };
      }

      const valid = await verify();
      if (!valid) return { redeemed: false, rosterVersion: this.roster.version, reason: "invalid proof" };

      this.redemptions.push({
        eventId,
        nullifier: canonicalNullifier,
        at: new Date().toISOString(),
      });
      writeJson(this.redemptionsPath, this.redemptions);
      return { redeemed: true, rosterVersion: this.roster.version };
    });
  }
}
