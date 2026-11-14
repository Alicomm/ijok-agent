// Proof Gatekeeper decision engine.
//
// Implements the seven documented outcomes from the event's trap
// encyclopedia. Every task is a structured decision over the envelope's
// `input` object:
//
//   registered_vk       VK the payment condition was registered with
//   proof_vk            VK the presented proof actually used
//   minimum             required minimum public balance (decimal string)
//   public_balance      balance disclosed by the proof (decimal string)
//   expiry_block        block height at which the condition expires
//   current_block       current block height given by the task
//   recipient           recipient committed in the proof
//   condition_recipient recipient named on the payment condition
//   amount              requested payment amount (decimal string)
//   max_transfer        single-transfer cap on the condition (decimal string)
//   proof_tx            on-chain reference of the presented proof
//
// Checks run in the order of the official build checklist. The first failing
// check determines the reason_code. All comparisons are exact and
// deterministic; numeric fields are compared as BigInt.
//
// Outcomes:
//   VALID_CONDITION     -> APPROVE  (everything passes)
//   VK_SUBSTITUTION     -> REJECT   proof_vk != registered_vk
//   THRESHOLD_MISMATCH  -> REJECT   public_balance < minimum
//   RECIPIENT_MISMATCH  -> REJECT   recipient != condition_recipient
//   AMOUNT_OVERFLOW     -> REJECT   amount > max_transfer
//   PROOF_REUSED        -> REJECT   proof_tx already seen in a previous task
//   EXPIRED_CONDITION   -> REJECT   current_block > expiry_block
//
// Anything missing or unparseable fails closed with MALFORMED_TASK.

export const REASON = {
  VALID: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  PROOF_REUSED: "PROOF_REUSED",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  MALFORMED_TASK: "MALFORMED_TASK",
};

const REQUIRED_FIELDS = [
  "registered_vk",
  "proof_vk",
  "minimum",
  "public_balance",
  "expiry_block",
  "current_block",
  "recipient",
  "condition_recipient",
  "amount",
  "max_transfer",
  "proof_tx",
];

function toBigIntOrNull(value) {
  try {
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

function sameHex(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

/**
 * Decide a Proof Gatekeeper task.
 * @param {object} input  the envelope's `input` object
 * @param {{has:function(string):boolean, record:function(string):boolean}} seenStore
 * @returns {{decision:string, reason_code:string, proof_tx:*, provable:boolean}}
 *   `provable` is false for PROOF_REUSED (excluded from proof scoring) and
 *   for malformed tasks; true otherwise.
 */
export function decideGatekeeper(input, seenStore) {
  const proofTx = input && typeof input === "object" ? input.proof_tx : undefined;
  const reject = (reason_code, provable = true) => ({
    decision: "REJECT",
    reason_code,
    proof_tx: proofTx,
    provable,
  });

  if (!input || typeof input !== "object") return reject(REASON.MALFORMED_TASK, false);
  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return reject(REASON.MALFORMED_TASK, false);
    }
  }

  const minimum = toBigIntOrNull(input.minimum);
  const publicBalance = toBigIntOrNull(input.public_balance);
  const amount = toBigIntOrNull(input.amount);
  const maxTransfer = toBigIntOrNull(input.max_transfer);
  const expiryBlock = toBigIntOrNull(input.expiry_block);
  const currentBlock = toBigIntOrNull(input.current_block);
  if (
    minimum === null || publicBalance === null || amount === null ||
    maxTransfer === null || expiryBlock === null || currentBlock === null
  ) {
    return reject(REASON.MALFORMED_TASK, false);
  }

  // 01 · Verification key substitution — the proof must use the VK the
  // condition was registered with. Proof validity is not condition compliance.
  if (!sameHex(input.proof_vk, input.registered_vk)) {
    seenStore?.record(String(proofTx));
    return reject(REASON.VK_SUBSTITUTION);
  }

  // 02 · Threshold mismatch — disclosed balance must meet the minimum.
  if (publicBalance < minimum) {
    seenStore?.record(String(proofTx));
    return reject(REASON.THRESHOLD_MISMATCH);
  }

  // 03 · Recipient mismatch — the proof's recipient must be the condition's.
  if (!sameHex(input.recipient, input.condition_recipient)) {
    seenStore?.record(String(proofTx));
    return reject(REASON.RECIPIENT_MISMATCH);
  }

  // 04 · Amount overflow — a single transfer may not exceed the cap.
  if (amount > maxTransfer) {
    seenStore?.record(String(proofTx));
    return reject(REASON.AMOUNT_OVERFLOW);
  }

  // 05 · Proof reused — a reference already processed for an earlier task
  // does not gain re-entry. record() returns true when already present.
  const alreadySeen = seenStore ? seenStore.record(String(proofTx)) : false;
  if (alreadySeen) {
    return reject(REASON.PROOF_REUSED, false);
  }

  // 06 · Expired condition — expiry is evaluated at the task's block height.
  if (currentBlock > expiryBlock) {
    return reject(REASON.EXPIRED_CONDITION);
  }

  // Everything passed.
  return {
    decision: "APPROVE",
    reason_code: REASON.VALID,
    proof_tx: proofTx,
    provable: true,
  };
}
