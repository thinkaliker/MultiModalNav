export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`mmn:${key}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`mmn:${key}`, JSON.stringify(value));
  } catch {
    // storage full or unavailable; settings just won't persist
  }
}
