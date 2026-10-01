// Deterministic-ish, collision-resistant ids without external deps.
let counter = 0;
export function newId(prefix = "id"): string {
  counter = (counter + 1) % 0xfffff;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function newToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes).toString("base64url");
}

/** Monotonic token factory for export jobs (old jobs can be detected). */
export function monotonic(seed: { n: number }): number {
  seed.n += 1;
  return seed.n;
}
