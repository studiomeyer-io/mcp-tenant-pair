import type { Conflict, Resolution } from "../types.js";

export interface ConflictResolver {
  readonly name: string;
  resolve(conflicts: Conflict[]): Promise<Resolution[]> | Resolution[];
}
