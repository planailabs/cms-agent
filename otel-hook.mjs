/**
 * OpenTelemetry's ESM instrumentation hook, registered the way node still
 * supports.
 *
 * `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` does the
 * same job and prints a deprecation warning on every boot saying so
 * ("may be removed in the future; instead use register()"). This is that
 * register() call, in a file, because the alternative node suggests is a
 * `data:text/javascript,…` URL with quotes and semicolons in it — passed
 * through NODE_OPTIONS, a systemd unit and a docker entrypoint.
 *
 * It has to be a file next to node_modules for a second reason: the bare
 * specifier below resolves against THIS module, not the working directory.
 * The service runs from VAR_DIR (module.nix) or /data (the image), where
 * @opentelemetry is nowhere in reach — so the launcher only needs an absolute
 * path to this shim, and the resolution problem stops being the launcher's.
 *
 * Loaded via `--import`, before `@opentelemetry/auto-instrumentations-node/
 * register`: the hook must be in place before the SDK patches anything.
 */
import { register } from 'node:module';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
  data: {
    /**
     * openai@4 is not compatible with the hook, and fails at import time.
     *
     * Its shim registry keeps state in `export let` bindings and reads them
     * back through `import * as shims`. import-in-the-middle's namespace
     * proxy does not carry live bindings, so the read still says "no shims
     * registered" after the write set them — and the second registration
     * throws `you must import 'openai/shims/node' before importing anything
     * else from openai`, taking the whole server down at boot.
     *
     * Excluding it costs nothing: there is no openai instrumentation to lose,
     * and the API calls it makes are still traced by the http/undici ones.
     * The regex matches the package directory rather than the specifier —
     * pnpm's real path ends in `node_modules/openai/…`, and the module that
     * actually breaks is reached by a RELATIVE import from inside it, which
     * a bare `'openai'` entry would never match.
     *
     * Removable once this repo is on openai v5+, which deleted _shims.
     */
    exclude: [/[/\\]node_modules[/\\]openai[/\\]/],
  },
});
