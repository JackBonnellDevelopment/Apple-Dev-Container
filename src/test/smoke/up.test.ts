import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// These tests share one Apple Container service, so npm run test:smoke forces --test-concurrency=1.
const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const shim = path.join(root, 'bin', 'container-docker');
const cli = require.resolve('@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js');

async function devcontainer(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function removeWorkspaceContainers(folder: string): Promise<void> {
  const { stdout } = await execFileAsync('container', ['list', '--all', '--format', 'json']);
  const listed = stdout.trim() ? JSON.parse(stdout) as Array<{ id: string; configuration?: { labels?: Record<string, string> } }> : [];
  for (const container of listed) {
    if (container.configuration?.labels?.['devcontainer.local_folder'] === folder) {
      await execFileAsync('container', ['delete', '--force', container.id]);
    }
  }
}

test('devcontainer up runs an image container through the shim', { timeout: 240000 }, async () => {
  const folder = path.join(root, 'test', 'fixtures', 'image-dev');
  await removeWorkspaceContainers(folder);
  try {
    const up = await devcontainer(['up', '--workspace-folder', folder, '--docker-path', shim]);
    assert.equal(up.code, 0, `devcontainer up failed\n${up.stdout}\n${up.stderr}`);
    assert.match(up.stdout, /"outcome":"success"/);
    const executed = await devcontainer([
      'exec', '--workspace-folder', folder, '--docker-path', shim,
      'cat', '/tmp/apple-dev-marker',
    ]);
    assert.equal(executed.code, 0, `devcontainer exec failed\n${executed.stdout}\n${executed.stderr}`);
    assert.match(executed.stdout, /image-ok/);
  } finally {
    await removeWorkspaceContainers(folder);
  }
});

test('devcontainer up builds a Dockerfile through the shim', { timeout: 240000 }, async () => {
  const folder = path.join(root, 'test', 'fixtures', 'build-dev');
  await removeWorkspaceContainers(folder);
  try {
    const up = await devcontainer(['up', '--workspace-folder', folder, '--docker-path', shim]);
    assert.equal(up.code, 0, `devcontainer up failed\n${up.stdout}\n${up.stderr}`);
    assert.match(up.stdout, /"outcome":"success"/);
    const executed = await devcontainer([
      'exec', '--workspace-folder', folder, '--docker-path', shim,
      'cat', '/opt/marker',
    ]);
    assert.equal(executed.code, 0, `devcontainer exec failed\n${executed.stdout}\n${executed.stderr}`);
    assert.match(executed.stdout, /build-ok/);
  } finally {
    await removeWorkspaceContainers(folder);
  }
});
