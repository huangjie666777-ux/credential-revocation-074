export const TREE_DEPTH = 4;

export interface MerklePath {
  pathElements: string[];
  pathIndices: number[];
}

export interface Roster {
  version: number;
  leaves: string[];
  root: string;
}

export interface RosterResponse extends Roster {
  treeDepth: number;
}

export interface RevokeRequest {
  indices: number[];
  expectedVersion: number;
}

export interface RevokeResponse {
  version: number;
  root: string;
  leaves: string[];
  revokedIndices: number[];
}

export interface Credential {
  secret: string;
  score: number;
  leafIndex: number;
  pathElements: string[];
  pathIndices: number[];
}

export interface EventPolicy {
  eventId: number;
  name: string;
  threshold: number;
}

export interface ProofPayload {
  eventId: number;
  proof: unknown;
  publicSignals: string[];
}

export interface VerifyResult {
  verified: boolean;
  redeemed: boolean;
  eventId?: number;
  nullifier?: string;
  reason?: string;
}
