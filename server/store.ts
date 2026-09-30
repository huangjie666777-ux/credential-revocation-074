import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = resolve(here, "..", "data");

interface RedemptionRecord {
  eventId: number;
  nullifier: string;
  at: string;
}

function load(path: string): RedemptionRecord[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RedemptionRecord[];
  } catch {
    return [];
  }
}

export function canonicalDecimal(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error("expected a non-negative decimal integer");
  }
  return BigInt(value).toString();
}

export class RedemptionStore {
  private records: RedemptionRecord[];
  private chain: Promise<void> = Promise.resolve();
  private readonly dataDir: string;
  private readonly dbPath: string;

  constructor(dataDir = defaultDataDir) {
    this.dataDir = dataDir;
    this.dbPath = resolve(this.dataDir, "redemptions.json");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.records = load(this.dbPath).map((record) => ({
      ...record,
      nullifier: canonicalDecimal(record.nullifier),
    }));
  }

  private persist(): void {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2) + "\n");
    writeFileSync(this.dbPath, JSON.stringify(this.records, null, 2) + "\n");
  }

  has(eventId: number, nullifier: string): boolean {
    return this.records.some(
      (r) => r.eventId === eventId && r.nullifier === nullifier,
    );
  }

  // Serialized atomic claim: under concurrent duplicate submissions only one
  // call inserts; others see the record and return false. The record is
  // persisted before reporting success, so it survives restarts.
  claim(eventId: number, nullifier: string): Promise<boolean> {
    const canonicalNullifier = canonicalDecimal(nullifier);
    const run = this.chain.then(() => {
      if (this.has(eventId, canonicalNullifier)) return false;
      this.records.push({
        eventId,
        nullifier: canonicalNullifier,
        at: new Date().toISOString(),
      });
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
