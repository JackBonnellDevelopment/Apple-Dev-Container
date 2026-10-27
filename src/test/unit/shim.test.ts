import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { patchServerInstallExec, serverInstallPreamble } from '../../shim/flock';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '../../..');
const shim = path.join(root, 'bin', 'container-docker');
const fake = path.join(root, 'test', 'fixtures', 'fake-container.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  log: string;
}

function recorded(logFile: string): string[][] {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function runShim(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-shim-'));
  const logFile = path.join(dir, 'argv.log');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shim, ...args], {
      env: {
        ...process.env,
        CONTAINER_BIN: fake,
        CONTAINER_FAKE_LOG: logFile,
        ...env,
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
      });
    });
  });
}

function containerFixture(options: {
  id: string;
  labels: Record<string, string>;
  state?: string;
  user?: unknown;
  mounts?: unknown[];
  ports?: unknown[];
}) {
  return {
    id: options.id,
    configuration: {
      id: options.id,
      creationDate: '2026-10-23T09:53:35Z',
      image: { reference: 'docker.io/library/alpine:latest' },
      initProcess: {
        arguments: ['60'],
        environment: ['PATH=/usr/bin'],
        executable: 'sleep',
        terminal: false,
        user: options.user ?? { id: { uid: 0, gid: 0 } },
        workingDirectory: '/workspace',
      },
      labels: options.labels,
      mounts: options.mounts ?? [{
        destination: '/workspace',
        options: [],
        source: '/tmp/probe',
        type: { virtiofs: {} },
      }],
      publishedPorts: options.ports ?? [{
        containerPort: 8080,
        hostAddress: '127.0.0.1',
        hostPort: 18080,
        proto: 'tcp',
      }],
      useInit: false,
      capAdd: [],
    },
    status: {
      state: options.state ?? 'running',
      startedDate: '2026-10-23T09:53:36Z',
      networks: [{ hostname: options.id, ipv4Address: '192.168.64.3/24', ipv4Gateway: '192.168.64.1' }],
    },
  };
}

const imageFixture = {
  id: 'be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a',
  configuration: {
    name: 'docker.io/library/alpine:latest',
    descriptor: { digest: 'sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a' },
  },
  variants: [{
    config: {
      architecture: 'arm64',
      os: 'linux',
      created: '2026-10-21T22:51:39Z',
      config: {
        Cmd: ['/bin/sh'],
        Env: ['PATH=/usr/bin'],
        WorkingDir: '/',
        Labels: { 'devcontainer.metadata': '[{"id":"alpine"}]' },
      },
    },
  }],
};

test('version output does not look like podman', async () => {
  const result = await runShim(['-v']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Docker version 27\.5\.1/);
  assert.doesNotMatch(result.stdout.toLowerCase(), /podman/);
});

test('buildx version fails so Dev Containers uses classic build', async () => {
  const result = await runShim(['buildx', 'version']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /buildx is unavailable/);
});

test('compose and gpus are rejected', async () => {
  const compose = await runShim(['compose', 'up']);
  assert.equal(compose.code, 1);
  assert.match(compose.stderr, /Compose is not supported/);

  const gpus = await runShim(['run', '--gpus', 'all', 'alpine']);
  assert.equal(gpus.code, 1);
  assert.match(gpus.stderr, /GPUs are not supported/);
});

test('ps -q filters labels and skips stopped containers unless -a is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-list-'));
  const listFile = path.join(dir, 'list.json');
  fs.writeFileSync(listFile, JSON.stringify([
    containerFixture({ id: 'probe', labels: { purpose: 'probe', 'devcontainer.local_folder': '/tmp/probe' } }),
    containerFixture({ id: 'other', labels: { purpose: 'other' } }),
    containerFixture({ id: 'stopped', labels: { purpose: 'probe' }, state: 'stopped' }),
  ]));
  const running = await runShim(['ps', '-q', '--filter', 'label=purpose=probe'], { CONTAINER_FAKE_LIST: listFile });
  assert.equal(running.code, 0);
  assert.equal(running.stdout, 'probe\n');

  const all = await runShim(['ps', '-q', '-a', '--filter', 'label=purpose=probe'], { CONTAINER_FAKE_LIST: listFile });
  assert.equal(all.stdout, 'probe\nstopped\n');
});

test('inspect translates container, image, and format output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-inspect-'));
  const inspectFile = path.join(dir, 'inspect.json');
  const imageFile = path.join(dir, 'image.json');
  fs.writeFileSync(inspectFile, JSON.stringify([containerFixture({
    id: 'probe',
    labels: { purpose: 'probe' },
    user: { raw: { userString: 'vscode' } },
  })]));
  fs.writeFileSync(imageFile, JSON.stringify([imageFixture]));

  const container = await runShim(['inspect', '--type', 'container', 'probe'], { CONTAINER_FAKE_INSPECT: inspectFile });
  assert.equal(container.code, 0);
  const parsed = JSON.parse(container.stdout);
  assert.equal(parsed[0].State.Running, true);
  assert.equal(parsed[0].Config.User, 'vscode');
  assert.equal(parsed[0].Config.Labels.purpose, 'probe');
  assert.equal(parsed[0].Mounts[0].Type, 'bind');
  assert.equal(parsed[0].Mounts[0].Source, '/tmp/probe');
  assert.equal(parsed[0].Mounts[0].Destination, '/workspace');
  assert.deepEqual(parsed[0].NetworkSettings.Ports['8080/tcp'], [{ HostIp: '127.0.0.1', HostPort: '18080' }]);

  const formatted = await runShim(['inspect', '--format', '{{json .Config}}', 'probe'], { CONTAINER_FAKE_INSPECT: inspectFile });
  const config = JSON.parse(formatted.stdout);
  assert.equal(config.WorkingDir, '/workspace');
  assert.equal(config.Labels.purpose, 'probe');

  const image = await runShim(['inspect', '--type', 'image', 'alpine:latest'], { CONTAINER_FAKE_IMAGE: imageFile });
  const imageJson = JSON.parse(image.stdout);
  assert.equal(imageJson[0].Id, 'sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a');
  assert.equal(imageJson[0].Os, 'linux');
  assert.equal(imageJson[0].Architecture, 'arm64');
  assert.deepEqual(imageJson[0].Config.Cmd, ['/bin/sh']);
  assert.equal(imageJson[0].Config.Labels['devcontainer.metadata'], '[{"id":"alpine"}]');
});

test('container ls --format json matches the Dev Containers parser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-ls-'));
  const listFile = path.join(dir, 'list.json');
  fs.writeFileSync(listFile, JSON.stringify([
    containerFixture({ id: 'probe', labels: { purpose: 'probe', keep: 'yes' } }),
  ]));
  const result = await runShim(['container', 'ls', '--all', '--format', 'json'], { CONTAINER_FAKE_LIST: listFile });
  assert.equal(result.code, 0);
  const row = JSON.parse(result.stdout);
  const labels: Record<string, string> = {};
  for (const pair of String(row.Labels).split(',')) {
    const [key, value] = pair.split('=');
    labels[key] = value;
  }
  assert.equal(row.ID, 'probe');
  assert.equal(row.Names, 'probe');
  assert.equal(row.State, 'running');
  assert.equal(labels.purpose, 'probe');
  assert.equal(labels.keep, 'yes');
});

test('build maps supported flags and drops flags Apple Container cannot take', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-build-'));
  const logFile = path.join(dir, 'argv.log');
  const result = await runShim([
    'build',
    '-f', 'Dockerfile',
    '-t', 'img:latest',
    '--build-arg', 'FOO=bar',
    '--target', 'dev',
    '--security-opt', 'label=disable',
    '--cache-from', 'img:cache',
    'contextDir',
  ], { CONTAINER_FAKE_LOG: logFile });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /security-opt/);
  assert.match(result.stderr, /cache-from/);
  const commands = recorded(logFile);
  const build = commands.find((args) => args[0] === 'build');
  assert.deepEqual(build, ['build', '-f', 'Dockerfile', '-t', 'img:latest', '--build-arg', 'FOO=bar', '--target', 'dev', 'contextDir']);
});

test('run drops docker-only flags and maps privileged and mounts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-run-'));
  const logFile = path.join(dir, 'argv.log');
  const result = await runShim([
    'run',
    '--sig-proxy=false',
    '-a', 'STDOUT',
    '-a', 'STDERR',
    '--privileged',
    '--mount', 'type=bind,source=/tmp,target=/workspace,consistency=cached',
    '--label', 'a=b',
    'alpine',
    'sleep',
    '1',
  ], { CONTAINER_FAKE_LOG: logFile });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /sig-proxy/);
  assert.match(result.stderr, /privileged/);
  const commands = recorded(logFile);
  const run = commands.find((args) => args[0] === 'run');
  assert.deepEqual(run, [
    'run',
    '--cap-add', 'ALL',
    '--mount', 'type=bind,source=/tmp,target=/workspace',
    '--label', 'a=b',
    'alpine',
    'sleep',
    '1',
  ]);
});

test('server install exec gets a BusyBox-compatible flock on PATH', async () => {
  const script = 'cat | (base64 -d 2>/dev/null || base64 -D || true) | bash';
  const patched = patchServerInstallExec(['exec', '--interactive', 'box', 'bash', '-c', script]);
  assert.equal(patched[3], 'bash');
  assert.match(patched[5], /\/tmp\/apple-dev-bin/);
  assert.match(patched[5], /base64 -d/);
  assert.match(patched[5], /libstdc\+\+/);
  assert.deepEqual(patchServerInstallExec(['exec', 'box', 'uname', '-m']), ['exec', 'box', 'uname', '-m']);

  const { stdout } = await promisify(execFile)('container', [
    'run', '--rm', '--entrypoint', '/bin/sh', 'alpine:latest', '-c',
    `${serverInstallPreamble()}
exec 200>/tmp/lock
flock -w 5 200
echo lock_ok
flock -u 200
echo unlock_ok`,
  ], { timeout: 60000 });
  assert.match(stdout, /lock_ok/);
  assert.match(stdout, /unlock_ok/);
});

test('events emits a start event when a container begins running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-dev-events-'));
  const listFile = path.join(dir, 'list.json');
  fs.writeFileSync(listFile, '[]');
  const child = spawn(process.execPath, [shim, 'events', '--format', '{{json .}}', '--filter', 'event=start'], {
    env: {
      ...process.env,
      CONTAINER_BIN: fake,
      CONTAINER_FAKE_LIST: listFile,
    },
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(listFile, JSON.stringify([
    containerFixture({ id: 'started', labels: { 'devcontainer.local_folder': '/work' } }),
  ]));
  const deadline = Date.now() + 2000;
  while (!stdout.includes('started') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  const event = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(event.status, 'start');
  assert.equal(event.id, 'started');
  assert.equal(event.Actor.Attributes['devcontainer.local_folder'], '/work');
});
