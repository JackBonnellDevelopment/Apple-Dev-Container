export class ShimError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'ShimError';
  }
}

export function warn(message: string): void {
  process.stderr.write(`container-devcontainers: ${message}\n`);
}
