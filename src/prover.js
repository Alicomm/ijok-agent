// Groth16 proof generation (snarkjs) + optional zkVerify submission (Kurier).
//
// The platform re-verifies the agent's decision proof against ITS registered
// verification key, so the proof must be produced with the official circuit
// artifacts (npm run fetch-circuits) — see /api/circuit-info on the Agent
// Games site for the current vkHash values:
//
//   gatekeeper vkHash: 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
//   vfyPolicy  vkHash: 0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047
//
// Proving is DISABLED by default (PROVER_ENABLED=1 to enable). The decision
// engine does not depend on it: with proving off, the agent still returns the
// documented decision shape, but provable tasks answered without a valid
// proof lose the reliability bonus and score -2 (see the event score model).
//
// The gatekeeper circuit's 13 input signals were confirmed empirically
// against the official gatekeeper.wasm (the platform does not publish the
// list): taskId, registeredVkHash, proofVkHash, minimum, publicBalance,
// expiryBlock, currentBlock, recipient, conditionRecipient, amount,
// maxTransfer, decision, salt. All 13 are public inputs (the verification
// key's IC has 14 points).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

// BN254 (bn128) scalar field modulus.
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function proverEnabled() {
  return process.env.PROVER_ENABLED === "1";
}

function circuitsDir() {
  return process.env.CIRCUITS_DIR || "./circuits";
}

/** Encode any integer-like value (decimal string, number, 0x-hex) as a
 *  field element decimal string, reduced mod p. */
export function toField(value) {
  let v;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number") v = BigInt(Math.trunc(value));
  else if (typeof value === "string" && value.trim() !== "") v = BigInt(value);
  else throw new Error(`cannot encode as field element: ${value}`);
  return (((v % FIELD_P) + FIELD_P) % FIELD_P).toString();
}

/** Encode the envelope task_id ("gk_24_9d1") as a field element. Numeric
 *  ids pass through; string ids are sha256-hashed into the field. This is a
 *  best-effort encoding — validate against a practice task before scored
 *  rounds (see README "Open items"). */
export function taskIdToField(taskId) {
  const s = String(taskId ?? "");
  if (/^\d+$/.test(s)) return toField(s);
  const hash = createHash("sha256").update(s, "utf8").digest("hex");
  return toField("0x" + hash);
}

/**
 * Map a task envelope + decision to gatekeeper circuit inputs.
 * Signal names are the circuit's own (confirmed against the wasm).
 * Encodings to validate in practice mode: taskId (string ids are hashed),
 * the vk hashes (reduced mod p), and salt (taken from input.salt when the
 * envelope carries one, else AGENT_GAMES_SALT, else 0).
 */
export function buildCircuitInput(task, decision) {
  const input = task.input || {};
  return {
    taskId: taskIdToField(task.task_id),
    registeredVkHash: toField(input.registered_vk),
    proofVkHash: toField(input.proof_vk),
    minimum: toField(input.minimum),
    publicBalance: toField(input.public_balance),
    expiryBlock: toField(input.expiry_block),
    currentBlock: toField(input.current_block),
    recipient: toField(input.recipient),
    conditionRecipient: toField(input.condition_recipient),
    amount: toField(input.amount),
    maxTransfer: toField(input.max_transfer),
    decision: decision.decision === "APPROVE" ? "1" : "0",
    salt: toField(input.salt ?? process.env.AGENT_GAMES_SALT ?? "0"),
  };
}

/**
 * Generate a Groth16 proof for a decision. Returns { proof, publicSignals }
 * or null when artifacts are missing. Throws only on unexpected errors —
 * callers should treat null/throw as "answer without proof".
 */
export async function generateProof(task, decision) {
  const dir = circuitsDir();
  const wasm = join(dir, "gatekeeper.wasm");
  const zkey = join(dir, "gatekeeper_final.zkey");
  if (!existsSync(wasm) || !existsSync(zkey)) return null;
  // snarkjs is imported lazily so the server runs without it when proving
  // is disabled.
  const snarkjs = await import("snarkjs");
  const circuitInput = buildCircuitInput(task, decision);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasm,
    zkey
  );
  return { proof, publicSignals };
}

/**
 * Submit a proof to zkVerify mainnet via Kurier and poll until Finalized.
 * Requires KURIER_API_KEY. Returns the proof reference string, or null when
 * not configured / not finalized within `budgetMs`.
 *
 * Submit format is the one published in the builder field guide:
 *   POST {KURIER_BASE_URL}/submit-proof/{KURIER_API_KEY}
 *   { proofType: "groth16", vkRegistered: true,
 *     proofOptions: { library: "snarkjs", curve: "bn128" },
 *     proofData: { proof, publicSignals, vk } }
 * The guide does not document the polling endpoint; job-status polling below
 * follows Kurier's public API shape and is best-effort — a polling failure
 * only means "not confirmed", never a wrong decision.
 */
export async function submitProofViaKurier(proof, publicSignals, { vkHash = GATEKEEPER_VK_HASH, budgetMs = 45_000 } = {}) {
  const apiKey = process.env.KURIER_API_KEY;
  if (!apiKey) return null;
  const base = (process.env.KURIER_BASE_URL || "https://api.kurier.xyz/api/v1").replace(/\/$/, "");
  const deadline = Date.now() + budgetMs;

  const submitRes = await fetch(`${base}/submit-proof/${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: vkHash },
    }),
  });
  if (!submitRes.ok) return null;
  const submitted = await submitRes.json();
  const jobId = submitted.jobId || submitted.id;
  if (!jobId) return null;

  while (Date.now() < deadline) {
    try {
      const statusRes = await fetch(`${base}/job-status/${apiKey}/${jobId}`);
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.status === "Finalized") {
          return status.txHash || status.proofReference || jobId;
        }
        if (status.status === "Failed" || status.status === "Error") return null;
      }
    } catch {
      // best-effort polling; keep trying until the budget runs out
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
