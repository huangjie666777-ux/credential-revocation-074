import { describe, expect, it } from "vitest";
import { poseidon } from "../shared/poseidon.js";
import { loadCredential, loadRoster, prove, verifyProof } from "./helpers";

// Scores from scripts/generateCredentials.ts:
// idx 0 -> 95 (passes both), idx 5 -> 60 (passes 60 only),
// idx 6 -> 58 (fails both), idx 15 -> 30 (fails both),
// idx 12 -> 100, idx 2 -> 85 (exactly threshold of event 1002).
describe("qualification circuit (real Groth16)", () => {
  it("accepts a member above the threshold and verifies with bound signals", async () => {
    const payload = await prove(0, 1001);
    const roster = loadRoster();
    expect(payload.publicSignals).toHaveLength(4);
    expect(BigInt(payload.publicSignals[1])).toBe(BigInt(roster.root));
    expect(Number(payload.publicSignals[2])).toBe(60);
    expect(Number(payload.publicSignals[3])).toBe(1001);
    expect(await verifyProof(payload)).toBe(true);
  });

  it("passes a score exactly equal to the threshold (85)", async () => {
    const payload = await prove(2, 1002);
    expect(await verifyProof(payload)).toBe(true);
  });

  it("rejects witness generation when score is below threshold", async () => {
    await expect(prove(6, 1001)).rejects.toBeTruthy();
  });

  it("rejects a non-member secret (leaf not in tree)", async () => {
    await expect(
      prove(0, 1001, { secret: "12345678901234567890" }),
    ).rejects.toBeTruthy();
  });

  it("produces distinct nullifiers for different events and stable ones for same event", async () => {
    const hash = await poseidon();
    const credential = loadCredential(0);
    const a = await prove(0, 1001);
    const b = await prove(0, 1002);
    expect(a.publicSignals[0]).not.toBe(b.publicSignals[0]);
    expect(BigInt(a.publicSignals[0])).toBe(
      hash([BigInt(credential.secret), 1001n]),
    );
    const a2 = await prove(0, 1001);
    expect(a2.publicSignals[0]).toBe(a.publicSignals[0]);
  });

  it("cannot prove membership against a different root", async () => {
    await expect(prove(0, 1001, { root: "1" })).rejects.toBeTruthy();
  });

  it("out-of-range threshold cannot satisfy the circuit", async () => {
    await expect(prove(0, 1001, { threshold: 101 })).rejects.toBeTruthy();
  });

  it("rejects a negative threshold supplied as a wrapped field value", async () => {
    const negativeOne = (1n << 254n).toString();
    await expect(
      prove(0, 1001, { threshold: Number(negativeOne) }),
    ).rejects.toBeTruthy();
  });
});
