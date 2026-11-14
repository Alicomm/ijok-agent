// HTTP server for the Agent Games agent endpoint.
//
// Protocol (builder field guide):
//  - Tasks arrive as JSON POSTs at the registered endpoint path (/agent).
//  - The HMAC signature is verified against the RAW body before parsing.
//  - Responses are deterministic JSON, signed with the signature header
//    over the raw response body, and must arrive within 60 seconds.
//  - Fail closed: bad signature, malformed envelope, or uncertainty all
//    produce a rejection / error, never an approval.
//
// Preflight: the platform performs a signed preflight before marking an
// agent active; the expected health payload is { ok: true,
// protocolVersion: "v1" }. GET / and GET /health return the same payload.

import { createServer } from "node:http";
import { SIGNATURE_HEADER, signBody, verifyRequest, getSecret } from "./hmac.js";
import { decideGatekeeper } from "./gatekeeper.js";
import { proverEnabled, generateProof, submitProofViaKurier } from "./prover.js";

const MAX_BODY_BYTES = 1_000_000;
// Proving + Kurier finalization share one budget so the total handler time
// always stays inside the platform's 60-second hard deadline.
const TASK_BUDGET_MS = 55_000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  const secret = getSecret();
  if (secret) headers[SIGNATURE_HEADER] = signBody(body, secret);
  res.writeHead(status, headers);
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isPreflight(body) {
  if (!body || typeof body !== "object") return false;
  const type = typeof body.type === "string" ? body.type.toLowerCase() : "";
  return (
    body.preflight === true ||
    type.includes("preflight") ||
    type.includes("health") ||
    type.includes("ping")
  );
}

export function createAgentServer({ seenStore, logger = console } = {}) {
  // Idempotent redelivery: if the platform re-sends the same task_id,
  // answer with the original response instead of re-deciding (a second
  // decision would see its own proof_tx in the seen-set).
  const responseCache = new Map();

  async function handleTask(req, res) {
    const started = Date.now();
    let raw;
    try {
      raw = await readRawBody(req);
    } catch {
      return sendJson(res, 413, { error: "request body too large" });
    }

    if (!verifyRequest(raw, req.headers[SIGNATURE_HEADER])) {
      logger.warn("rejected request: invalid signature");
      return sendJson(res, 401, { error: "invalid signature" });
    }

    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }

    if (isPreflight(body)) {
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" });
    }

    if (body.type !== "agent-games.proof-gatekeeper.v1") {
      logger.warn(`unsupported task type: ${body.type}`);
      return sendJson(res, 400, { error: "unsupported task type" });
    }

    const taskId = body.task_id || "";
    if (taskId && responseCache.has(taskId)) {
      return sendJson(res, 200, responseCache.get(taskId));
    }

    const decision = decideGatekeeper(body.input, seenStore);
    const response = {
      decision: decision.decision,
      reason_code: decision.reason_code,
      proof_tx: decision.proof_tx,
    };

    // Attach a Groth16 decision proof when proving is enabled and the task
    // is provable (PROOF_REUSED tasks are excluded from proof scoring).
    // Proving and the Kurier submission share the remaining task budget;
    // the documented response shape is { decision, reason_code, proof,
    // public_signals } plus the echoed proof_tx audit pointer.
    if (decision.provable && proverEnabled()) {
      try {
        const remaining = () => Math.max(0, TASK_BUDGET_MS - (Date.now() - started));
        const proved = await Promise.race([
          generateProof(body, decision),
          new Promise((resolve) => setTimeout(() => resolve(null), remaining())),
        ]);
        if (proved) {
          response.proof = proved.proof;
          response.public_signals = proved.publicSignals;
          if (process.env.KURIER_API_KEY && remaining() > 3_000) {
            const reference = await submitProofViaKurier(proved.proof, proved.publicSignals, {
              budgetMs: remaining(),
            });
            logger.log(
              JSON.stringify({ task_id: taskId, kurier_reference: reference })
            );
          }
        }
      } catch (err) {
        // A proof failure must not lose the decision: answer without proof.
        logger.error(`proof generation failed for ${taskId}: ${err.message}`);
      }
    }

    if (taskId) {
      if (responseCache.size > 10_000) responseCache.clear();
      responseCache.set(taskId, response);
    }
    logger.log(
      JSON.stringify({
        task_id: taskId,
        mode: body.mode || null,
        decision: response.decision,
        reason_code: response.reason_code,
        proved: Boolean(response.proof),
        ms: Date.now() - started,
      })
    );
    return sendJson(res, 200, response);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" });
    }
    if (req.method === "POST" && url.pathname === "/agent") {
      handleTask(req, res).catch((err) => {
        console.error("handler error:", err);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    return sendJson(res, 404, { error: "not found" });
  });

  return server;
}
