import { TREE_DEPTH } from "./types.js";

const ZERO = 0n;

export interface BuiltTree {
  leaves: bigint[];
  root: bigint;
}

export async function buildMerkleTree(
  leaves: bigint[],
  hash: (inputs: bigint[]) => bigint,
): Promise<BuiltTree> {
  const level = leaves.slice();
  let nodes = level;
  for (let d = 0; d < TREE_DEPTH; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i] ?? ZERO;
      const right = nodes[i + 1] ?? ZERO;
      next.push(hash([left, right]));
    }
    nodes = next;
  }
  return { leaves: level, root: nodes[0] };
}

export function merklePath(
  leafIndex: number,
  allLeaves: bigint[],
  hash: (inputs: bigint[]) => bigint,
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let nodes = allLeaves.slice();
  let index = leafIndex;
  for (let d = 0; d < TREE_DEPTH; d++) {
    const siblingIndex = index ^ 1;
    pathElements.push(nodes[siblingIndex] ?? ZERO);
    pathIndices.push(index & 1);
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i] ?? ZERO;
      const right = nodes[i + 1] ?? ZERO;
      next.push(hash([left, right]));
    }
    nodes = next;
    index = index >> 1;
  }
  return { pathElements, pathIndices };
}

export function findLeafIndex(leaves: bigint[], leaf: bigint): number {
  return leaves.findIndex((candidate) => candidate === leaf);
}
