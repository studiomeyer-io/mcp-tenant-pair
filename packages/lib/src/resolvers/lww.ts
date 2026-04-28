import type { Conflict, Resolution } from "../types.js";
import type { ConflictResolver } from "./interface.js";

/**
 * Last-write-wins resolver. Picks the candidate with the highest `validFrom`
 * timestamp; ties broken by highest `version`. Deterministic and idempotent.
 */
export class LWWResolver implements ConflictResolver {
  public readonly name = "lww";

  resolve(conflicts: Conflict[]): Resolution[] {
    return conflicts.map((conflict) => {
      const winner = [...conflict.candidates].sort((a, b) => {
        if (a.validFrom > b.validFrom) return -1;
        if (a.validFrom < b.validFrom) return 1;
        return b.version - a.version;
      })[0];
      if (!winner) {
        throw new Error(`LWWResolver: empty candidate list for ${conflict.namespace}::${conflict.key}`);
      }
      return {
        pairId: conflict.pairId,
        namespace: conflict.namespace,
        key: conflict.key,
        winnerVersion: winner.version,
      };
    });
  }
}
