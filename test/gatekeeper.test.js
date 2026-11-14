import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGatekeeper, REASON } from "../src/gatekeeper.js";
import { SeenStore } from "../src/seenstore.js";

let counter = 0;
function validInput(overrides = {}) {
  counter += 1;
  return {
    registered_vk: "0x7d3af291",
    proof_vk: "0x7d3af291",
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe429f01",
    condition_recipient: "0xDe429f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: `0xtx${counter}`,
    ...overrides,
  };
}

const store = () => new SeenStore(null);

test("valid condition approves", () => {
  const d = decideGatekeeper(validInput(), store());
  assert.equal(d.decision, "APPROVE");
  assert.equal(d.reason_code, REASON.VALID);
  assert.equal(d.provable, true);
});

test("vk substitution rejects", () => {
  const d = decideGatekeeper(validInput({ proof_vk: "0xa4c1b8ff" }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.VK_SUBSTITUTION);
});

test("vk comparison is case-insensitive", () => {
  const d = decideGatekeeper(validInput({ proof_vk: "0X7D3AF291" }), store());
  assert.equal(d.decision, "APPROVE");
});

test("threshold mismatch rejects", () => {
  const d = decideGatekeeper(validInput({ public_balance: "999" }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.THRESHOLD_MISMATCH);
});

test("balance exactly at minimum approves", () => {
  const d = decideGatekeeper(validInput({ public_balance: "1000" }), store());
  assert.equal(d.decision, "APPROVE");
});

test("recipient mismatch rejects", () => {
  const d = decideGatekeeper(validInput({ recipient: "0xDeadbeef" }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.RECIPIENT_MISMATCH);
});

test("amount overflow rejects", () => {
  const d = decideGatekeeper(validInput({ amount: "1001" }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.AMOUNT_OVERFLOW);
});

test("amount exactly at cap approves", () => {
  const d = decideGatekeeper(validInput({ amount: "1000" }), store());
  assert.equal(d.decision, "APPROVE");
});

test("expired condition rejects", () => {
  const d = decideGatekeeper(validInput({ current_block: 19842202 }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.EXPIRED_CONDITION);
});

test("current block equal to expiry still approves", () => {
  const d = decideGatekeeper(validInput({ current_block: 19842201 }), store());
  assert.equal(d.decision, "APPROVE");
});

test("proof reuse rejects on second presentation and is not provable", () => {
  const s = store();
  const input = validInput();
  const first = decideGatekeeper(input, s);
  assert.equal(first.decision, "APPROVE");
  const second = decideGatekeeper({ ...input }, s);
  assert.equal(second.decision, "REJECT");
  assert.equal(second.reason_code, REASON.PROOF_REUSED);
  assert.equal(second.provable, false);
});

test("missing field fails closed as malformed", () => {
  const input = validInput();
  delete input.proof_vk;
  const d = decideGatekeeper(input, store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.MALFORMED_TASK);
  assert.equal(d.provable, false);
});

test("non-numeric amount fails closed as malformed", () => {
  const d = decideGatekeeper(validInput({ amount: "five hundred" }), store());
  assert.equal(d.decision, "REJECT");
  assert.equal(d.reason_code, REASON.MALFORMED_TASK);
});

test("bigint precision: huge balances compare correctly", () => {
  const d = decideGatekeeper(
    validInput({
      minimum: "99999999999999999999999999",
      public_balance: "100000000000000000000000000",
    }),
    store()
  );
  assert.equal(d.decision, "APPROVE");
});
