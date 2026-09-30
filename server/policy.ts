import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventPolicy } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface PolicyConfig {
  merkleRoot?: string;
  treeDepth: number;
  events: EventPolicy[];
}

export function loadPolicy(): PolicyConfig {
  const path = resolve(here, "..", "data", "policy.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as PolicyConfig;
  for (const event of config.events) {
    if (
      !Number.isInteger(event.eventId) ||
      !Number.isInteger(event.threshold) ||
      event.threshold < 0 ||
      event.threshold > 100
    ) {
      throw new Error(`invalid event policy: ${JSON.stringify(event)}`);
    }
  }
  return config;
}
