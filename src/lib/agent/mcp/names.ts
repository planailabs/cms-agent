/**
 * The bridged tool-name rule, in one place.
 *
 * A bridged MCP tool is called `mcp_<server>_<tool>` with both parts
 * sanitized, and that string is the ONLY link from a tool back to the server
 * (and therefore the group) it came from. Two copies of the rule existed: one
 * in the bridge that mints the names inside the jail, one app-side that maps
 * them back. A drift between them does not fail loudly — it makes a tool
 * belong to no group, so lazy loading quietly stops working for it.
 *
 * Deliberately dependency-free: bridgeEntry.ts is bundled into a single file
 * that runs inside the bwrap jail, so anything this module imports would be
 * dragged in there with it.
 */

/** OpenAI tool names allow [A-Za-z0-9_-]; the length cap keeps the joined
 *  `mcp_<server>_<tool>` inside the 64-character limit. */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

/** The bridged name of one server's tool. */
export const bridgedToolName = (server: string, tool: string): string =>
  `mcp_${safeName(server)}_${safeName(tool)}`;

/** Prefix every tool of a server carries — the reverse lookup's only handle. */
export const bridgedToolPrefix = (server: string): string => `mcp_${safeName(server)}_`;
