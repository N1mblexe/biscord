import { describe, expect, it } from 'vitest';

const mainSource = import.meta.glob<string>('./main.tsx', { query: '?raw', import: 'default', eager: true })[
  './main.tsx'
];

describe('zod runs jitless in the web app (CSP: no eval)', () => {
  it('main.tsx imports ./zodJitless before anything else', () => {
    // A side-effect import (`import 'x';`) or one with bindings (`import … from 'x';`).
    const re = /^import\s+(?:'([^']+)'|[\s\S]*?\sfrom\s+'([^']+)');/gm;
    const imports = [...(mainSource ?? '').matchAll(re)].map((m) => m[1] ?? m[2]);
    expect(imports[0]).toBe('./zodJitless');
  });

  it('with it loaded first, building and parsing the shared schemas never constructs a Function', async () => {
    const RealFunction = globalThis.Function;
    let constructed = 0;
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args: unknown[]) {
        constructed += 1;
        return Reflect.construct(target, args) as object;
      },
    });
    try {
      await import('./zodJitless');
      expect(globalThis.__zod_globalConfig?.jitless).toBe(true);
      const { LoginRequest } = await import('@hearth/shared');
      expect(LoginRequest.parse({ username: 'alice', password: 'secret' })).toEqual({
        username: 'alice',
        password: 'secret',
      });
      expect(LoginRequest.safeParse({ username: '' }).success).toBe(false);
    } finally {
      globalThis.Function = RealFunction;
    }
    expect(constructed).toBe(0);
  });
});
