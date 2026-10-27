import { spawn } from 'child_process';
import { ShimError } from './errors';

export function containerBin(): string {
  return process.env.CONTAINER_BIN || 'container';
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export function runInherit(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(containerBin(), args, { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new ShimError(`Apple Container CLI not found (${containerBin()}). Install it from https://github.com/apple/container`));
        return;
      }
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export function runCapture(args: string[]): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(containerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new ShimError(`Apple Container CLI not found (${containerBin()}). Install it from https://github.com/apple/container`));
        return;
      }
      reject(err);
    });
    child.on('exit', (code, signal) => {
      resolve({
        code: signal ? 1 : code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function parseJsonOutput(stdout: string): unknown {
  const start = stdout.search(/[\[{]/);
  if (start < 0) {
    throw new ShimError(`Apple Container did not return JSON.\n${stdout.trim()}`);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch (err) {
    throw new ShimError(`Could not parse Apple Container JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let systemReady: Promise<void> | undefined;

export function ensureSystem(): Promise<void> {
  if (!systemReady) {
    systemReady = ensureSystemOnce().catch((err) => {
      systemReady = undefined;
      throw err;
    });
  }
  return systemReady;
}

async function ensureSystemOnce(): Promise<void> {
  const status = await runCapture(['system', 'status']);
  if (status.code === 0 && /^\s*status\s+running\s*$/im.test(status.stdout)) {
    return;
  }
  const started = await runInherit(['system', 'start']);
  if (started !== 0) {
    throw new ShimError('Failed to start Apple Container services (`container system start`).', started);
  }
}
