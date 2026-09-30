pragma circom 2.1.6;

include "poseidon.circom";
include "comparators.circom";
include "mux1.circom";
include "bitify.circom";

// Range check: 0 <= in <= 100
template RangeCheck100() {
    input signal in;
    component bits = Num2Bits(8);
    bits.in <== in;
    component lt = LessEqThan(8);
    lt.in[0] <== in;
    lt.in[1] <== 100;
    lt.out === 1;
}

// Binary Merkle inclusion proof. pathIndices[i] = 0 means leaf/node is the
// left child, 1 means it is the right child.
template MerkleProof(depth) {
    input signal leaf;
    input signal pathElements[depth];
    input signal pathIndices[depth];
    output signal root;

    component selectors[depth];
    component hashers[depth];
    signal levelHash[depth + 1];
    levelHash[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        selectors[i] = MultiMux1(2);
        selectors[i].c[0][0] <== levelHash[i];
        selectors[i].c[0][1] <== pathElements[i];
        selectors[i].c[1][0] <== pathElements[i];
        selectors[i].c[1][1] <== levelHash[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
        levelHash[i + 1] <== hashers[i].out;
    }
    root <== levelHash[depth];
}

// Zero-knowledge qualification proof.
// Private inputs: secret (non-zero), score, Merkle path.
// Public signals, in order: root, threshold, eventId, nullifier.
template Qualification(depth) {
    input signal secret;
    input signal score;
    input signal pathElements[depth];
    input signal pathIndices[depth];

    input signal root;
    input signal threshold;
    input signal eventId;

    output signal nullifier;

    // secret must be non-zero
    signal secretInv;
    secretInv <-- secret != 0 ? 1 / secret : 0;
    secret * secretInv === 1;

    // score and threshold must be integers in [0, 100]
    component scoreRange = RangeCheck100();
    scoreRange.in <== score;
    component thresholdRange = RangeCheck100();
    thresholdRange.in <== threshold;

    // path directions must be binary
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
    }

    // leaf = Poseidon(secret, score); Merkle membership
    signal leaf;
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== secret;
    leafHasher.inputs[1] <== score;
    leaf <== leafHasher.out;

    component tree = MerkleProof(depth);
    tree.leaf <== leaf;
    for (var j = 0; j < depth; j++) {
        tree.pathElements[j] <== pathElements[j];
        tree.pathIndices[j] <== pathIndices[j];
    }
    tree.root === root;

    // score >= threshold
    component qualifies = GreaterEqThan(8);
    qualifies.in[0] <== score;
    qualifies.in[1] <== threshold;
    qualifies.out === 1;

    // nullifier binds secret and eventId
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== eventId;
    nullifier <== nullifierHasher.out;
}

component main {public [root, threshold, eventId]} = Qualification(4);
