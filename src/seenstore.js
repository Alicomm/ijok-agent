// Persistent seen-set of proof references, used to detect PROOF_REUSED.
//
// The platform may re-present a proof reference that was already accepted in
// a previous task; a valid proof does not gain re-entry. Every proof_tx we
// process is recorded here (file-backed so restarts do not lose the set).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.seen = new Set();
    if (filePath && existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        for (const ref of data.proofRefs || []) this.seen.add(ref);
      } catch {
        // Corrupt store: start empty rather than crash; reuse detection is
        // best-effort across a corrupt file but strict within a run.
        this.seen = new Set();
      }
    }
  }

  has(ref) {
    return this.seen.has(ref);
  }

  /** Record a proof reference. Returns true if it was already present. */
  record(ref) {
    const already = this.seen.has(ref);
    if (!already) {
      this.seen.add(ref);
      this.flush();
    }
    return already;
  }

  flush() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ proofRefs: [...this.seen] }, null, 2)
    );
  }
}
