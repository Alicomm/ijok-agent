// Entrypoint: `npm start`
//
// Loads .env (when present), builds the seen-store, and starts the agent
// endpoint on PORT (default 8080). Register the public URL as
// https://<your-host>/agent in the Agent Games dashboard.

import { existsSync, readFileSync } from "node:fs";
import { createAgentServer } from "./server.js";
import { SeenStore } from "./seenstore.js";

function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const port = Number(process.env.PORT || 8080);
const seenStore = new SeenStore(process.env.SEEN_STORE_PATH || "./data/seen.json");
const server = createAgentServer({ seenStore });

server.listen(port, () => {
  console.log(`ijok-agent listening on :${port} (POST /agent)`);
  if (!process.env.AGENT_GAMES_HMAC_SECRET && !process.env.AGENT_GAMES_SECRET) {
    console.warn(
      "WARNING: AGENT_GAMES_HMAC_SECRET is not set — task signatures cannot be verified. " +
        "Set it from Dashboard -> My Agents -> Rotate Secret before competing."
    );
  }
});
