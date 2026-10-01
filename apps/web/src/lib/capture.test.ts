import { describe, expect, it, vi } from 'vitest';
import { createCapture, onHidden, stopStream } from './capture';

/** A promise resolved (or rejected) from the outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createCapture', () => {
  it('keeps the started value until stop, then releases it once', async () => {
    const release = vi.fn();
    const capture = createCapture(() => Promise.resolve('mic'), release);
    await expect(capture.run()).resolves.toBe('mic');
    expect(capture.current()).toBe('mic');
    capture.stop();
    capture.stop();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('mic');
    expect(capture.current()).toBeNull();
  });

  it('releases a value that arrives after stop (the toggle went off while the prompt was open)', async () => {
    const release = vi.fn();
    const pending = deferred<string>();
    const capture = createCapture(() => pending.promise, release);
    const run = capture.run();
    capture.stop();
    pending.resolve('late');
    await expect(run).resolves.toBeNull();
    expect(release).toHaveBeenCalledWith('late');
    expect(capture.current()).toBeNull();
  });

  it('a new run replaces the running value and voids an older start', async () => {
    const release = vi.fn();
    const first = deferred<string>();
    let calls = 0;
    const capture = createCapture(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve('second');
    }, release);
    const older = capture.run();
    await expect(capture.run()).resolves.toBe('second');
    first.resolve('first');
    await expect(older).resolves.toBeNull();
    expect(release).toHaveBeenCalledWith('first');
    expect(capture.current()).toBe('second');
  });

  it('rejects when the start fails, unless it was stopped meanwhile', async () => {
    const failing = createCapture(() => Promise.reject(new Error('NotAllowedError')), vi.fn());
    await expect(failing.run()).rejects.toThrow('NotAllowedError');

    const pending = deferred<string>();
    const stopped = createCapture(() => pending.promise, vi.fn());
    const run = stopped.run();
    stopped.stop();
    pending.reject(new Error('NotAllowedError'));
    await expect(run).resolves.toBeNull();
  });
});

describe('onHidden', () => {
  it('fires only when the document becomes hidden, until unbound', () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
    };
    const onHide = vi.fn();
    const unbind = onHidden(doc as unknown as Document, onHide);
    const fire = () => {
      for (const cb of listeners) cb();
    };
    fire();
    expect(onHide).not.toHaveBeenCalled();
    doc.visibilityState = 'hidden';
    fire();
    expect(onHide).toHaveBeenCalledTimes(1);
    unbind();
    expect(listeners.size).toBe(0);
  });
});

describe('stopStream', () => {
  it('stops every track', () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    stopStream({ getTracks: () => tracks as unknown as MediaStreamTrack[] });
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
