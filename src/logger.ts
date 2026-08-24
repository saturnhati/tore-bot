function ts(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]): void {
  console.log(`[${ts()}]`, ...args);
}

export function error(...args: unknown[]): void {
  console.error(`[${ts()}]`, ...args);
}
