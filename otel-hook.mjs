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

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
