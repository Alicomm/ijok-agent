# IJOK Agent — Agent Games (zkVerify)

A competition agent for the **Proof Gatekeeper** track of the
[Agent Games](https://agentgames.zkverify.io) (zkVerify): the platform POSTs
signed, proof-backed payment requests to this endpoint; the agent verifies
every field, returns a deterministic APPROVE/REJECT decision with a reason
code, and — when proving is enabled — attaches a Groth16 proof of the
decision generated locally with snarkjs.

The platform re-verifies the proof against its own registered verification
key and scores the decision independently: a valid proof of a wrong decision
still loses. All decision rules are enforced in deterministic code — no
language model is involved in any decision.

## How it works

```
platform ──POST /agent (HMAC-signed task envelope)──▶ this service
this service ──{ decision, reason_code, proof, public_signals } (signed)──▶ platform
```

1. Verify `x-agent-games-signature` (HMAC over the **raw** body) *before*
   parsing JSON. Fail closed on any mismatch.
2. Answer the signed preflight (`agent-games.preflight.v1`) with
   `{ ok: true, protocolVersion: "v1" }`.
3. For a Proof Gatekeeper task, run the decision checks (below).
4. Optionally generate the Groth16 decision proof with the official
   gatekeeper circuit and submit it to zkVerify via Kurier, waiting for a
   Finalized result inside the remaining budget.
5. Sign the response body with the same HMAC header and return it — always
   within the platform's 60-second hard deadline.

## Decision rules (Proof Gatekeeper)

Checks run in the official build-checklist order; the first failure decides
the `reason_code`:

| reason_code | decision | condition |
|---|---|---|
| `VALID_CONDITION` | APPROVE | every check passes |
| `VK_SUBSTITUTION` | REJECT | `proof_vk` ≠ `registered_vk` |
| `THRESHOLD_MISMATCH` | REJECT | `public_balance` < `minimum` |
| `RECIPIENT_MISMATCH` | REJECT | `recipient` ≠ `condition_recipient` |
| `AMOUNT_OVERFLOW` | REJECT | `amount` > `max_transfer` |
| `PROOF_REUSED` | REJECT | `proof_tx` already processed for an earlier task (file-backed seen-set) |
| `EXPIRED_CONDITION` | REJECT | `current_block` > `expiry_block` |
| `MALFORMED_TASK` | REJECT | a required field is missing or unparseable (fail closed) |

Amounts are compared as `BigInt` (exact at any size). Addresses and VKs are
compared case-insensitively. Re-delivery of the same `task_id` returns the
cached original response instead of re-deciding.

Scoring (per the event page): correct decision **+12**, wrong approve
**−6**, wrong reject **−3**, timeout **−2**, missing/invalid proof on a
provable task **−2**, plus a reliability bonus (+0…+5) pro-rated by verified
proofs. `PROOF_REUSED` tasks have no proof to submit and are excluded from
proof scoring.

Rounds: 8 daily rounds, 13–21 Nov 2026, 16:00–02:00 IST (17:30–03:30 WIB),
8 tasks per agent per round.

## Setup

```bash
npm install
npm run fetch-circuits   # downloads gatekeeper + vfy-policy wasm/zkey into ./circuits
cp .env.example .env     # fill in AGENT_GAMES_HMAC_SECRET (see below)
npm start                # listens on PORT (default 8080), POST /agent
```

### Secrets (environment only — never commit)

| variable | where it comes from |
|---|---|
| `AGENT_GAMES_HMAC_SECRET` | Agent Games dashboard → My Agents → your agent → **Rotate Secret** (shown once) |
| `KURIER_API_KEY` | Kurier (zkVerify) — only needed when submitting proofs on-chain |
| `AGENT_GAMES_SALT` | fallback circuit salt (default `0`) |

## Local test

```bash
npm test   # 21 tests: decision engine (all 7 outcomes), HMAC, server flow
```

Manual replay with a sample envelope:

```bash
AGENT_GAMES_HMAC_SECRET=dev-secret npm start &
cat > /tmp/task.json <<'JSON'
{"type":"agent-games.proof-gatekeeper.v1","task_id":"gk_local_1","mode":"practice",
 "issued_at":"2026-11-14T00:00:00Z","deadline_at":"2026-11-14T00:01:00Z",
 "input":{"registered_vk":"0x7d3af291","proof_vk":"0x7d3af291","minimum":"1000",
 "public_balance":"1460","expiry_block":19842201,"current_block":19832000,
 "recipient":"0xDe429f01","condition_recipient":"0xDe429f01","amount":"500",
 "max_transfer":"1000","proof_tx":"0xlocaltest1"}}
JSON
SIG=$(AGENT_GAMES_HMAC_SECRET=dev-secret node scripts/sign.js @/tmp/task.json)
curl -s -X POST localhost:8080/agent -H 'content-type: application/json' \
  -H "x-agent-games-signature: $SIG" --data-binary @/tmp/task.json
# → {"decision":"APPROVE","reason_code":"VALID_CONDITION","proof_tx":"0xlocaltest1"}
```

## Enable proving

```bash
# .env
PROVER_ENABLED=1
KURIER_API_KEY=...        # optional; without it proofs are attached but not submitted
```

The gatekeeper circuit (Groth16 / BN254, Circom 2.x) has 13 input signals —
confirmed empirically against the official `gatekeeper.wasm`, since the
platform does not publish the list:

```
taskId, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision,
salt
```

All 13 are public inputs. Mappings live in `src/prover.js`
(`buildCircuitInput`) — the single place to change after practice tasks.

## Deploy

Any Node ≥ 20 host with a public HTTPS URL works (the registration form's
placeholder suggests Fly.io; Render/Railway/a VPS are equivalent):

1. Deploy this repo, set the env vars above in the host's dashboard.
2. Confirm `GET https://<your-host>/health` returns
   `{"ok":true,"protocolVersion":"v1"}`.
3. In the Agent Games dashboard, register the agent:
   - **Name:** `ijok` (public leaderboard identifier)
   - **Event tracks:** Proof Gatekeeper (this build; see below)
   - **Repository URL:** this repo's public GitHub URL
   - **Agent endpoint:** `https://<your-host>/agent`
4. **Rotate Secret** in the dashboard, copy the value into
   `AGENT_GAMES_HMAC_SECRET` on the host, restart.
5. Pass the signed preflight + at least one practice task from the
   dashboard before the first scored round.

## Open items to validate in practice mode

The public docs leave a few protocol details unspecified; each is isolated
in one place and flagged in the code:

- **Circuit input encodings** (`src/prover.js`): signal *names* are
  confirmed, but value encodings are best-effort — string `taskId`s are
  sha256-hashed into the field, VK hashes are reduced mod p, and `salt`
  comes from `input.salt` when present. Confirm against a practice task's
  expected public signals before scored rounds.
- **HMAC encoding**: the build guide names the header and the signed bytes
  (raw body) but not the algorithm/encoding. This build uses HMAC-SHA256,
  hex, timing-safe compare — the near-universal convention. The signed
  preflight in practice will confirm or refute it in one shot.
- **Kurier polling**: the guide documents the submit call
  (`POST /api/v1/submit-proof/{key}`) but not the status endpoint; polling
  here is best-effort and only gates an internal log line.
- **Steal the VFY** is *not* implemented in this build (it needs a strategy
  commitment registered from the dashboard before Swiss Round 1 plus the
  vfy-policy policy-proof flow). Only select tracks in the registration
  form that the deployed endpoint actually implements.

## Layout

```
src/
  index.js       entrypoint (.env loading, server start)
  server.js      HTTP routing, signature gate, task handling, budget
  hmac.js        HMAC-SHA256 sign/verify (raw body, timing-safe)
  gatekeeper.js  the decision engine (pure, deterministic)
  seenstore.js   file-backed proof-reference seen-set (PROOF_REUSED)
  prover.js      snarkjs proving + Kurier submission
scripts/
  fetch-circuits.sh   download official circuit artifacts
  sign.js             compute a request signature for local testing
test/
  gatekeeper.test.js  all seven outcomes + edge cases
  server.test.js      preflight, 401s, response shape, idempotent redelivery
```

## Security notes

- Secrets come from environment variables only; `.env` is git-ignored.
- The agent fails closed everywhere: bad signature → 401, malformed task →
  REJECT, proof failure → decision still returned (without proof) rather
  than a late or default-approve response.
- No wallet keys are used by this service. Kurier submission needs only an
  API key; the zkVerifyJS alternative would need a funded account and is
  not used here.
