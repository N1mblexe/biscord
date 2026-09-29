import { describe, expect, it } from 'vitest';
import { adminRoutes } from './admin';

/**
 * Bundle split sanity (docs/plans/phase-8.md, "Bundle size"): LiveKit and the admin pages must only
 * be reachable through dynamic `import()`, so they stay out of the initial chunk.
 */

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Static imports and re-exports of a module (`import type` is erased; dynamic `import()` isn't matched). */
function staticImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?'([^']+)';/gm;
  for (const match of source.matchAll(re)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  return specs;
}

function resolve(from: string, spec: string): string | null {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const base = parts.join('/');
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => p in sources) ?? null;
}

/** Every module statically reachable from `entry`, with the bare packages each one imports. */
function staticGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (graph.has(file)) continue;
    const packages: string[] = [];
    graph.set(file, packages);
    for (const spec of staticImports(sources[file] ?? '')) {
      if (!spec.startsWith('.')) {
        packages.push(spec);
        continue;
      }
      if (spec.endsWith('.css')) continue;
      const target = resolve(file, spec);
      if (target === null) throw new Error(`${file}: can't resolve ${spec}`);
      queue.push(target);
    }
  }
  return graph;
}

const isLiveKit = (pkg: string) => pkg === 'livekit-client' || pkg.startsWith('@livekit/');

describe('initial chunk', () => {
  const initial = staticGraph('/src/main.tsx');

  it('walks the real app (sanity)', () => {
    expect(initial.has('/src/router.tsx')).toBe(true);
    expect(initial.has('/src/voice/VoiceProvider.tsx')).toBe(true);
    expect(initial.has('/src/components/VoiceChannels.tsx')).toBe(true);
  });

  it('never imports LiveKit statically', () => {
    const offenders = [...initial].filter(([, pkgs]) => pkgs.some(isLiveKit)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('leaves the voice engine, the video stage and the admin pages to lazy chunks', () => {
    for (const lazy of [
      '/src/voice/engine.tsx',
      '/src/voice/VideoStage.tsx',
      '/src/pages/AdminUsersPage.tsx',
      '/src/pages/AdminInvitesPage.tsx',
      '/src/pages/AdminChannelsPage.tsx',
    ]) {
      expect(lazy in sources, lazy).toBe(true);
      expect(initial.has(lazy), lazy).toBe(false);
    }
  });

  it('the voice engine chunk is where LiveKit lives', () => {
    const engine = staticGraph('/src/voice/engine.tsx');
    expect([...engine.values()].flat().some(isLiveKit)).toBe(true);
    expect(engine.has('/src/voice/VideoStage.tsx')).toBe(true);
  });
});

describe('admin routes', () => {
  const byPath = new Map(adminRoutes.map((r) => [r.index === true ? '(index)' : (r.path ?? ''), r]));

  it('has the admin pages plus the old reset-code path', () => {
    expect([...byPath.keys()].sort()).toEqual(['(index)', 'channels', 'invites', 'users', 'users/reset']);
  });

  it.each([['invites'], ['users'], ['channels']])('%s loads its page component lazily', async (path) => {
    const route = byPath.get(path);
    expect(route?.Component).toBeUndefined();
    const lazy = route?.lazy;
    if (typeof lazy !== 'object' || typeof lazy.Component !== 'function') {
      throw new Error(`${path}: expected an object-form lazy with a Component loader`);
    }
    expect(typeof (await lazy.Component())).toBe('function');
  });

  it('/admin/users/reset redirects to the users page', async () => {
    const loader = byPath.get('users/reset')?.loader;
    if (typeof loader !== 'function') throw new Error('users/reset: expected a loader');
    const res: unknown = await loader({
      request: new Request('http://localhost/admin/users/reset'),
      params: {},
      context: undefined,
      unstable_pattern: '/admin/users/reset',
    } as unknown as Parameters<typeof loader>[0]);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).headers.get('Location')).toBe('/admin/users');
  });
});
