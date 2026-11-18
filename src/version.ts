// Single source of truth for module identity: everything (handshake, handoff,
// recipeSource) reads from manifest.json via this module. No hardcoded copies.
import manifest from "../manifest.json" with { type: "json" };

export const MODULE_ID: string = manifest.id;
export const MODULE_VERSION: string = manifest.version;
