#!/usr/bin/env bash
# Download the official circuit artifacts from the Agent Games site.
# Source of truth: https://agentgames.zkverify.io/api/circuit-info
set -euo pipefail
mkdir -p circuits
curl -fL -o circuits/gatekeeper.wasm        https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -fL -o circuits/gatekeeper_final.zkey  https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
curl -fL -o circuits/vfy-policy.wasm        https://agentgames.zkverify.io/circuits/vfy-policy.wasm
curl -fL -o circuits/vfy-policy_final.zkey  https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey
echo "Circuit artifacts downloaded to ./circuits"
