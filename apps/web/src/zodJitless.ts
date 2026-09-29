/**
 * Must be the first import of `main.tsx`: it has to run before any zod schema is built.
 *
 * zod 4 probes `new Function('')` once, to decide whether it may compile fast object parsers. Under the
 * production CSP (`script-src 'self'`, no `'unsafe-eval'`) the probe throws, which zod catches, but the
 * browser still reports a `securitypolicyviolation`. With `jitless` set, zod skips the probe entirely.
 *
 * This is `z.config({ jitless: true })` without importing zod (it isn't a dependency of the web app, only
 * of `@hearth/shared`): zod keeps its global config on `globalThis.__zod_globalConfig` and adopts an
 * existing object there when it loads. Each object schema reads the flag when it is built, hence "first".
 */

declare global {
  // `var` is how a global property is declared; zod reads and writes exactly this name.
  var __zod_globalConfig: { jitless?: boolean } | undefined;
}

globalThis.__zod_globalConfig ??= {};
globalThis.__zod_globalConfig.jitless = true;

export {};
