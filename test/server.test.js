import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_GAMES_SECRET = "test-secret";
delete process.env.ALLOW_UNSIGNED_DEV;
process.env.PROVER_ENABLED = "0";

const { createAgentServer } = await import("../src/server.js");
const { SeenStore } = await import("../src/seenstore.js");
const { signBody } = await import("../src/hmac.js");

let server;
let base;

before(async () => {
  server = createAgentServer({ seenStore: new SeenStore(null), logger: { log() {}, warn() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function post(path, bodyObj, { sign = true } = {}) {
  const body = JSON.stringify(bodyObj);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-agent-games-signature"] = signBody(body, "test-secret");
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const task = (overrides = {}) => ({
  type: "agent-games.proof-gatekeeper.v1",
  task_id: "gk_test_1",
  mode: "practice",
  issued_at: "2026-11-14T00:00:00Z",
  deadline_at: "2026-11-14T00:01:00Z",
  input: {
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
    proof_tx: "0xtx-server-1",
  },
  ...overrides,
});

test("health endpoint returns preflight payload", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, protocolVersion: "v1" });
});

test("signed preflight envelope returns ok payload", async () => {
  const { status, json } = await post("/agent", { type: "agent-games.preflight.v1" });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, protocolVersion: "v1" });
});

test("unsigned task is rejected with 401", async () => {
  const { status } = await post("/agent", task(), { sign: false });
  assert.equal(status, 401);
});

test("tampered body is rejected with 401", async () => {
  const body = JSON.stringify(task());
  const res = await fetch(`${base}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": signBody(body, "test-secret"),
    },
    body: body.replace("1460", "9999"),
  });
  assert.equal(res.status, 401);
});

test("valid task returns documented decision shape", async () => {
  const { status, json, headers } = await post("/agent", task());
  assert.equal(status, 200);
  assert.equal(json.decision, "APPROVE");
  assert.equal(json.reason_code, "VALID_CONDITION");
  assert.equal(json.proof_tx, "0xtx-server-1");
  // response itself is signed over its raw body
  assert.ok(headers.get("x-agent-games-signature"));
});

test("trap task returns reject with reason code", async () => {
  const t = task({ task_id: "gk_test_2" });
  t.input = { ...t.input, proof_vk: "0xdifferent", proof_tx: "0xtx-server-2" };
  const { status, json } = await post("/agent", t);
  assert.equal(status, 200);
  assert.equal(json.decision, "REJECT");
  assert.equal(json.reason_code, "VK_SUBSTITUTION");
});

test("same task_id redelivery returns the cached response", async () => {
  const t = task({ task_id: "gk_test_3" });
  t.input = { ...t.input, proof_tx: "0xtx-server-3" };
  const first = await post("/agent", t);
  const second = await post("/agent", t);
  assert.equal(first.json.decision, "APPROVE");
  assert.deepEqual(second.json, first.json);
});
