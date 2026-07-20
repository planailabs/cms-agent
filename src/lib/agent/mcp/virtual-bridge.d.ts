/** The esbuild-bundled bridgeEntry source, embedded by the vite plugin in
 * astro.config.mjs. Absent in vitest — custom.ts catches and bundles live. */
declare module 'virtual:mcp-bridge' {
  const source: string;
  export default source;
}
