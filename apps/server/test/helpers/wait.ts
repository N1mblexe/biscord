/** Polls `predicate` every 10 ms until it is truthy, or rejects after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 2_000, message = 'condition' }: { timeoutMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
