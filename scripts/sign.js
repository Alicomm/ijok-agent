// Local testing helper: print the HMAC-SHA256 signature for a request body.
//
// Usage:
//   AGENT_GAMES_HMAC_SECRET=test-secret node scripts/sign.js '<json-body>'
//   AGENT_GAMES_HMAC_SECRET=test-secret node scripts/sign.js @body.json
//
// Then send the task with curl:
//   curl -X POST localhost:8080/agent \
//     -H 'content-type: application/json' \
//     -H "x-agent-games-signature: <printed-hex>" \
//     --data-binary @body.json

import { readFileSync } from "node:fs";
import { signBody } from "../src/hmac.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/sign.js '<json-body>' | @file.json");
  process.exit(1);
}
const body = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;
if (!process.env.AGENT_GAMES_HMAC_SECRET && !process.env.AGENT_GAMES_SECRET) {
  console.error("AGENT_GAMES_HMAC_SECRET is not set");
  process.exit(1);
}
console.log(signBody(body));
