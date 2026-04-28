import type { Conflict, Resolution } from "../types.js";
import type { ConflictResolver } from "./interface.js";

/**
 * Manual resolver. Returns no resolutions, marking conflicts as pending for
 * human decision. Use with `TenantPair.listConflicts` to surface them to the
 * user, then call a custom resolver or apply resolutions explicitly.
 */
export class ManualResolver implements ConflictResolver {
  public readonly name = "manual";

  resolve(_conflicts: Conflict[]): Resolution[] {
    return [];
  }
}
