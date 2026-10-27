import { ShimError, warn } from './errors';
import { patchServerInstallExec } from './flock';
import { applyDockerFormat } from './format';
import { ensureSystem, parseJsonOutput, runCapture, runInherit } from './spawn';
import {
  asArray,
  containerIdOf,
  containerUsesVolume,
  dockerStatus,
  labelsOf,
  matchLabelFilters,
  psRow,
  toAppleBind,
  toAppleMount,
  translateContainer,
  translateImage,
  translateVolume,
} from './translate';

const VERSION_TEXT = 'Docker version 27.5.1, build apple-container-shim\n';

const VERSION_INFO = {
  Client: { Version: '27.5.1', ApiVersion: '1.47', APIVersion: '1.47' },
  Server: { Version: '27.5.1', ApiVersion: '1.47', APIVersion: '1.47' },
  Version: '27.5.1',
  ApiVersion: '1.47',
  APIVersion: '1.47',
};

const INFO = {
  ServerVersion: '27.5.1',
  OperatingSystem: 'Apple Container',
  OSType: 'linux',
  Architecture: 'aarch64',
  Runtimes: {} as Record<string, unknown>,
  Driver: 'apple-container',
  NCPU: 1,
  MemTotal: 0,
};

interface Flag {
  key: string;
  inline?: string;
}

function flagAt(args: string[], index: number): Flag {
  const token = args[index];
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    if (eq >= 0) {
      return { key: token.slice(2, eq), inline: token.slice(eq + 1) };
    }
    return { key: token.slice(2) };
  }
  if (token.startsWith('-') && token.length === 2) {
    return { key: token.slice(1) };
  }
  return { key: token };
}

function takeValue(args: string[], index: number, inline: string | undefined, label: string): { value: string; next: number } {
  if (inline !== undefined) {
    return { value: inline, next: index + 1 };
  }
  if (index + 1 >= args.length) {
    throw new ShimError(`docker: flag ${label} needs a value`);
  }
  return { value: args[index + 1], next: index + 2 };
}

function drop(flag: string): void {
  warn(`ignoring unsupported docker flag --${flag}`);
}

export async function dispatch(argv: string[]): Promise<number> {
  const { version, args } = stripGlobals(argv);
  if (version && (args.length === 0 || args[0] !== 'version')) {
    process.stdout.write(VERSION_TEXT);
    return 0;
  }
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return 0;
  }
  const [command, ...rest] = args;
  switch (command) {
    case 'version':
      return commandVersion(rest);
    case 'buildx':
      process.stderr.write('buildx is unavailable. Dev Containers will use classic docker build, which this shim maps to `container build`.\n');
      return 1;
    case 'compose':
    case 'docker-compose':
      throw new ShimError('Docker Compose is not supported by the Apple Container shim.');
    case 'info':
      return commandInfo(rest);
    case 'build':
      return commandBuild(rest);
    case 'pull':
      return commandPull(rest);
    case 'tag':
      return commandTag(rest);
    case 'images':
      return commandImages(rest);
    case 'image':
      return commandImage(rest);
    case 'ps':
      return commandPs(rest);
    case 'inspect':
      return commandInspect(rest);
    case 'run':
      return commandRun(rest, 'run');
    case 'create':
      return commandRun(rest, 'create');
    case 'start':
      return commandStart(rest);
    case 'stop':
      return commandStop(rest);
    case 'rm':
    case 'remove':
      return commandRm(rest);
    case 'kill':
      return commandKill(rest);
    case 'exec':
      return commandExec(rest);
    case 'cp':
    case 'copy':
      return commandCp(rest);
    case 'logs':
      return commandLogs(rest);
    case 'events':
      return commandEvents(rest);
    case 'volume':
      return commandVolume(rest);
    case 'container':
      return commandContainer(rest);
    default:
      throw new ShimError(`docker: '${command}' is not supported by the Apple Container shim.`);
  }
}

function stripGlobals(argv: string[]): { version: boolean; args: string[] } {
  const args = [...argv];
  let version = false;
  const bools = new Set(['--debug', '--tls', '--tlsverify']);
  const valued = new Set(['--host', '-H', '--context', '--config', '--log-level']);
  while (args.length > 0) {
    const token = args[0];
    if (token === '--') {
      args.shift();
      break;
    }
    if (token === '-v' || token === '--version') {
      version = true;
      args.shift();
      continue;
    }
    if (bools.has(token)) {
      args.shift();
      continue;
    }
    if (token === '-l' || token === '--log-level') {
      args.splice(0, token === '-l' || !token.includes('=') ? 2 : 1);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    if (valued.has(name)) {
      args.splice(0, eq >= 0 ? 1 : 2);
      continue;
    }
    if (token.startsWith('-D')) {
      args.shift();
      continue;
    }
    break;
  }
  return { version, args };
}

function printHelp(): void {
  process.stdout.write(`Apple Container docker shim

Translates the Docker CLI calls made by Dev Containers into Apple's \`container\` CLI.

Supported commands: version, info, build, pull, images, tag, ps, inspect, run, create,
start, stop, rm, kill, exec, cp, logs, events, volume.

\`buildx\` is reported as unavailable so Dev Containers uses classic \`docker build\`.
Docker Compose is not supported.
`);
}

function commandVersion(args: string[]): number {
  let format: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = flagAt(args, i);
    if (flag.key === 'format' || flag.key === 'f') {
      const taken = takeValue(args, i, flag.inline, flag.key);
      format = taken.value;
      i = taken.next - 1;
      continue;
    }
  }
  if (format) {
    process.stdout.write(`${applyDockerFormat(format, VERSION_INFO)}\n`);
    return 0;
  }
  process.stdout.write(VERSION_TEXT);
  return 0;
}

function commandInfo(args: string[]): number {
  let format: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = flagAt(args, i);
    if (flag.key === 'f' || flag.key === 'format') {
      const taken = takeValue(args, i, flag.inline, flag.key);
      format = taken.value;
      i = taken.next - 1;
    }
  }
  if (format) {
    const rendered = applyDockerFormat(format, INFO);
    process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    return 0;
  }
  process.stdout.write('Server Version: 27.5.1\nOperating System: Apple Container\nOSType: linux\n');
  return 0;
}

const BUILD_VALUES = new Set(['file', 'f', 'tag', 't', 'build-arg', 'target', 'label', 'platform', 'progress', 'secret', 'ssh', 'arch', 'os', 'cpu', 'cpus', 'c', 'memory', 'm', 'iidfile', 'cache-from', 'build-context', 'output', 'o', 'security-opt', 'add-host', 'network', 'ulimit']);
const BUILD_BOOLS = new Set(['no-cache', 'pull', 'quiet', 'q', 'rm', 'force-rm', 'load', 'compress']);

async function commandBuild(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['build'];
  const positionals: string[] = [];
  let iidfile: string | undefined;
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    const key = flag.key === 'f' ? 'file' : flag.key === 't' ? 'tag' : flag.key === 'q' ? 'quiet' : flag.key === 'c' ? 'cpus' : flag.key === 'm' ? 'memory' : flag.key === 'o' ? 'output' : flag.key;
    if (key === 'security-opt' || key === 'cache-from' || key === 'output' || key === 'add-host' || key === 'network' || key === 'ulimit') {
      const taken = takeValue(args, i, flag.inline, key);
      drop(key);
      i = taken.next - 1;
      continue;
    }
    if (key === 'build-context') {
      throw new ShimError('docker build --build-context is not available. The shim hides buildx so Dev Containers copies features into the build context instead.');
    }
    if (key === 'iidfile') {
      const taken = takeValue(args, i, flag.inline, key);
      iidfile = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (key === 'load' || key === 'rm' || key === 'force-rm' || key === 'compress') {
      if (flag.inline === undefined && BUILD_BOOLS.has(key)) {
        drop(key);
      }
      continue;
    }
    if (BUILD_BOOLS.has(key) && flag.inline === undefined) {
      if (key === 'no-cache') {
        apple.push('--no-cache');
      } else if (key === 'pull') {
        apple.push('--pull');
      } else if (key === 'quiet') {
        apple.push('--quiet');
      }
      continue;
    }
    if (BUILD_VALUES.has(flag.key) || BUILD_VALUES.has(key)) {
      const taken = takeValue(args, i, flag.inline, key);
      i = taken.next - 1;
      if (key === 'file') {
        apple.push('-f', taken.value);
      } else if (key === 'tag') {
        tag = tag ?? taken.value;
        apple.push('-t', taken.value);
      } else if (key === 'build-arg') {
        apple.push('--build-arg', taken.value);
      } else if (key === 'target') {
        apple.push('--target', taken.value);
      } else if (key === 'label') {
        apple.push('--label', taken.value);
      } else if (key === 'platform') {
        apple.push('--platform', taken.value);
      } else if (key === 'progress') {
        const progress = taken.value === 'rawjson' ? 'plain' : taken.value;
        apple.push('--progress', progress);
      } else if (key === 'secret') {
        apple.push('--secret', taken.value);
      } else if (key === 'ssh') {
        apple.push('--ssh', taken.value);
      } else if (key === 'arch') {
        apple.push('--arch', taken.value);
      } else if (key === 'os') {
        apple.push('--os', taken.value);
      } else if (key === 'cpus' || key === 'cpu') {
        apple.push('--cpus', taken.value);
      } else if (key === 'memory') {
        apple.push('--memory', taken.value);
      }
      continue;
    }
    throw new ShimError(`docker build: unsupported flag ${token}`);
  }
  apple.push(positionals[0] ?? '.');
  if (positionals.length > 1) {
    throw new ShimError(`docker build: unexpected arguments ${positionals.slice(1).join(' ')}`);
  }
  const code = await runInherit(apple);
  if (code !== 0) {
    return code;
  }
  if (iidfile && tag) {
    await writeIid(iidfile, tag);
  } else if (iidfile) {
    warn('not writing --iidfile because the build had no -t tag');
  }
  return 0;
}

async function writeIid(file: string, tag: string): Promise<void> {
  const fs = await import('fs/promises');
  const result = await runCapture(['image', 'inspect', tag]);
  if (result.code !== 0) {
    warn(`built ${tag} but could not inspect it to write ${file}`);
    return;
  }
  const images = asArray(parseJsonOutput(result.stdout));
  const id = images[0] ? translateImage(images[0], tag).Id : '';
  if (!id) {
    warn(`built ${tag} but inspect did not include an image id`);
    return;
  }
  await fs.writeFile(file, `${id}\n`);
}

async function commandPull(args: string[]): Promise<number> {
  await ensureSystem();
  const names: string[] = [];
  const platform: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      names.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'q' || flag.key === 'quiet') {
      continue;
    }
    if (flag.key === 'platform') {
      const taken = takeValue(args, i, flag.inline, 'platform');
      platform.push('--platform', taken.value);
      i = taken.next - 1;
      continue;
    }
    drop(flag.key);
    if (flag.inline === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  if (names.length === 0) {
    throw new ShimError('docker pull: image name required');
  }
  let code = 0;
  for (const name of names) {
    code = await runInherit(['image', 'pull', ...platform, name]);
    if (code !== 0) {
      return code;
    }
  }
  return code;
}

async function commandTag(args: string[]): Promise<number> {
  await ensureSystem();
  const names = args.filter((arg) => !arg.startsWith('-'));
  if (names.length !== 2) {
    throw new ShimError('docker tag: expected SOURCE TARGET');
  }
  return runInherit(['image', 'tag', names[0], names[1]]);
}

async function commandImage(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'ls':
    case 'list':
      return commandImages(rest);
    case 'inspect':
      return commandInspect(['--type', 'image', ...rest]);
    case 'pull':
      return commandPull(rest);
    case 'tag':
      return commandTag(rest);
    case 'rm':
    case 'remove':
      return commandImageRemove(rest);
    default:
      throw new ShimError(`docker image: '${sub ?? ''}' is not supported.`);
  }
}

async function commandImageRemove(args: string[]): Promise<number> {
  await ensureSystem();
  const names = args.filter((arg) => !arg.startsWith('-'));
  if (names.length === 0) {
    throw new ShimError('docker image rm: image name required');
  }
  return runInherit(['image', 'delete', ...names]);
}

async function commandImages(args: string[]): Promise<number> {
  await ensureSystem();
  const result = await runCapture(['image', 'list', '--format', 'json']);
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    return result.code;
  }
  const images = asArray(parseJsonOutput(result.stdout)).map((image) => translateImage(image));
  let quiet = false;
  let format: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = flagAt(args, i);
    if (flag.key === 'q' || flag.key === 'quiet') {
      quiet = true;
      continue;
    }
    if (flag.key === 'format') {
      const taken = takeValue(args, i, flag.inline, flag.key);
      format = taken.value;
      i = taken.next - 1;
    }
  }
  if (quiet) {
    process.stdout.write(images.map((image) => image.Id).join('\n') + (images.length ? '\n' : ''));
    return 0;
  }
  if (format) {
    for (const image of images) {
      process.stdout.write(`${applyDockerFormat(format, { ...image, ID: image.Id, Repository: image.RepoTags[0] ?? '', Tag: '' })}\n`);
    }
    return 0;
  }
  for (const image of images) {
    process.stdout.write(`${image.RepoTags[0] ?? '<none>'}\t${image.Id}\n`);
  }
  return 0;
}

interface PsFilters {
  label: string[];
  name: string[];
  id: string[];
  status: string[];
  volume: string[];
}

async function commandPs(args: string[]): Promise<number> {
  let all = false;
  let quiet = false;
  let format: string | undefined;
  const filters: PsFilters = { label: [], name: [], id: [], status: [], volume: [] };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '-a' || token === '--all') {
      all = true;
      continue;
    }
    if (token === '-q' || token === '--quiet') {
      quiet = true;
      continue;
    }
    if (token === '--no-trunc' || token === '-s' || token === '--size') {
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'filter' || flag.key === 'f') {
      const taken = takeValue(args, i, flag.inline, 'filter');
      const eq = taken.value.indexOf('=');
      const name = eq === -1 ? taken.value : taken.value.slice(0, eq);
      const value = eq === -1 ? '' : taken.value.slice(eq + 1);
      if (name === 'label' || name === 'name' || name === 'id' || name === 'status' || name === 'volume') {
        filters[name].push(value);
      } else {
        drop(`filter ${name}`);
      }
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'format') {
      const taken = takeValue(args, i, flag.inline, 'format');
      format = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new ShimError(`docker ps: unsupported flag ${token}`);
    }
  }
  const containers = await fetchContainers();
  const rows = containers.filter((raw) => psMatches(raw, all, filters)).map((raw) => psRow(translateContainer(raw)));
  if (quiet) {
    process.stdout.write(rows.map((row) => row.ID).join('\n') + (rows.length ? '\n' : ''));
    return 0;
  }
  if (format === 'json') {
    for (const row of rows) {
      process.stdout.write(`${JSON.stringify({
        ID: row.ID,
        Names: row.Names,
        Image: row.Image,
        State: row.State,
        Status: row.Status,
        Labels: row.Labels,
        Command: row.Command,
        CreatedAt: row.CreatedAt,
        Mounts: row.Mounts,
        Ports: row.Ports,
      })}\n`);
    }
    return 0;
  }
  if (format) {
    for (const row of rows) {
      process.stdout.write(`${applyDockerFormat(format, row)}\n`);
    }
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(`${row.ID}\t${row.Image}\t${row.State}\t${row.Names}\n`);
  }
  return 0;
}

function psMatches(raw: Record<string, any>, all: boolean, filters: PsFilters): boolean {
  const state = String(raw.status?.state ?? 'unknown');
  const status = dockerStatus(state);
  if (!all && state !== 'running') {
    return false;
  }
  const id = containerIdOf(raw);
  if (filters.id.length && !filters.id.some((value) => id.startsWith(value))) {
    return false;
  }
  if (filters.name.length && !filters.name.some((value) => {
    try {
      return new RegExp(value).test(id);
    } catch {
      return id.includes(value);
    }
  })) {
    return false;
  }
  if (filters.status.length && !filters.status.includes(status) && !filters.status.includes(state)) {
    return false;
  }
  if (!matchLabelFilters(labelsOf(raw), filters.label)) {
    return false;
  }
  if (filters.volume.length && !filters.volume.every((volume) => containerUsesVolume(raw, volume))) {
    return false;
  }
  return true;
}

async function fetchContainers(): Promise<Record<string, any>[]> {
  await ensureSystem();
  const result = await runCapture(['list', '--all', '--format', 'json']);
  if (result.code !== 0) {
    throw new ShimError(result.stderr.trim() || `container list failed (${result.code})`, result.code || 1);
  }
  if (!result.stdout.trim()) {
    return [];
  }
  return asArray(parseJsonOutput(result.stdout));
}

async function commandInspect(args: string[]): Promise<number> {
  let type: string | undefined;
  let format: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      ids.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'type') {
      const taken = takeValue(args, i, flag.inline, 'type');
      type = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'format' || flag.key === 'f') {
      const taken = takeValue(args, i, flag.inline, 'format');
      format = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'size' || flag.key === 's') {
      continue;
    }
    throw new ShimError(`docker inspect: unsupported flag ${token}`);
  }
  if (ids.length === 0) {
    throw new ShimError('docker inspect: name required');
  }
  await ensureSystem();
  const kinds = type ? [type] : ['container', 'image', 'volume'];
  let lastError = '';
  for (const kind of kinds) {
    const found = await inspectKind(kind, ids);
    if (found.ok) {
      writeInspect(found.items, format);
      return 0;
    }
    lastError = found.error;
    if (type) {
      process.stderr.write(lastError.endsWith('\n') ? lastError : `${lastError}\n`);
      return found.code || 1;
    }
  }
  process.stderr.write(lastError.endsWith('\n') ? lastError : `${lastError}\n`);
  return 1;
}

async function inspectKind(kind: string, ids: string[]): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string; code: number }> {
  const command = kind === 'image' ? ['image', 'inspect', ...ids] : kind === 'volume' ? ['volume', 'inspect', ...ids] : ['inspect', ...ids];
  const result = await runCapture(command);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `inspect ${kind} failed`, code: result.code };
  }
  const rawItems = asArray(parseJsonOutput(result.stdout));
  const items = rawItems.map((raw, index) => {
    if (kind === 'image') {
      return translateImage(raw, ids[index]);
    }
    if (kind === 'volume') {
      return translateVolume(raw);
    }
    return translateContainer(raw);
  });
  return { ok: true, items };
}

function writeInspect(items: unknown[], format: string | undefined): void {
  if (!format) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  for (const item of items) {
    process.stdout.write(`${applyDockerFormat(format, item)}\n`);
  }
}

const RUN_VALUES = new Set(['env', 'e', 'env-file', 'gid', 'user', 'u', 'uid', 'workdir', 'w', 'cwd', 'ulimit', 'cpus', 'c', 'memory', 'm', 'cap-add', 'cap-drop', 'cidfile', 'dns', 'dns-domain', 'dns-option', 'dns-search', 'entrypoint', 'label', 'l', 'mount', 'name', 'network', 'os', 'publish', 'p', 'platform', 'shm-size', 'tmpfs', 'arch', 'volume', 'v', 'security-opt', 'hostname', 'h', 'add-host', 'pull', 'restart', 'log-driver', 'log-opt', 'health-cmd', 'health-interval', 'health-timeout', 'health-retries', 'health-start-period', 'group-add', 'ipc', 'pid', 'userns', 'cgroupns', 'device', 'sysctl', 'link', 'expose', 'gpus', 'gpu', 'annotation', 'memory-swap']);
const RUN_BOOLS = new Set(['interactive', 'i', 'tty', 't', 'detach', 'd', 'init', 'read-only', 'rm', 'remove', 'sig-proxy', 'privileged']);

async function commandRun(args: string[], verb: 'run' | 'create'): Promise<number> {
  await ensureSystem();
  const apple: string[] = [verb];
  const command: string[] = [];
  let seenImage = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (seenImage || token === '--' || (!token.startsWith('-') || token === '-')) {
      if (token === '--' && !seenImage) {
        command.push(...args.slice(i + 1));
        break;
      }
      seenImage = true;
      command.push(...args.slice(i));
      break;
    }
    if (token === '-a' || token.startsWith('--attach')) {
      drop('attach');
      if (token === '-a' || token === '--attach') {
        i += 1;
      }
      continue;
    }
    const clustered = expandCluster(token);
    if (clustered) {
      for (const short of clustered) {
        pushRunBool(apple, short);
      }
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'gpus' || flag.key === 'gpu') {
      throw new ShimError('GPUs are not supported by Apple Container.');
    }
    if (flag.key === 'privileged') {
      warn('mapping --privileged to --cap-add ALL');
      apple.push('--cap-add', 'ALL');
      continue;
    }
    if (flag.key === 'sig-proxy') {
      drop('sig-proxy');
      continue;
    }
    if (RUN_BOOLS.has(flag.key) && flag.inline === undefined) {
      pushRunBool(apple, flag.key, verb);
      continue;
    }
    if (!RUN_VALUES.has(flag.key) && !RUN_BOOLS.has(flag.key)) {
      throw new ShimError(`docker ${verb}: unsupported flag ${token}`);
    }
    const taken = takeValue(args, i, flag.inline, flag.key);
    i = taken.next - 1;
    pushRunValue(apple, flag.key, taken.value);
  }
  if (command.length === 0) {
    throw new ShimError(`docker ${verb}: image name required`);
  }
  apple.push(...command);
  return runInherit(apple);
}

function expandCluster(token: string): string[] | undefined {
  if (!token.startsWith('-') || token.startsWith('--') || token.length <= 2) {
    return undefined;
  }
  const chars = token.slice(1).split('');
  if (!chars.every((char) => char === 'i' || char === 't' || char === 'd')) {
    return undefined;
  }
  return chars;
}

function pushRunBool(apple: string[], key: string, verb: 'run' | 'create' = 'run'): void {
  switch (key) {
    case 'i':
    case 'interactive':
      apple.push('--interactive');
      break;
    case 't':
    case 'tty':
      apple.push('--tty');
      break;
    case 'd':
    case 'detach':
      if (verb === 'run') {
        apple.push('--detach');
      }
      break;
    case 'init':
      apple.push('--init');
      break;
    case 'read-only':
      apple.push('--read-only');
      break;
    case 'rm':
    case 'remove':
      apple.push('--rm');
      break;
    default:
      break;
  }
}

function pushRunValue(apple: string[], key: string, value: string): void {
  const dropped = new Set(['security-opt', 'hostname', 'h', 'add-host', 'pull', 'restart', 'log-driver', 'log-opt', 'health-cmd', 'health-interval', 'health-timeout', 'health-retries', 'health-start-period', 'group-add', 'ipc', 'pid', 'userns', 'cgroupns', 'device', 'sysctl', 'link', 'expose', 'annotation', 'memory-swap']);
  if (dropped.has(key)) {
    drop(key === 'h' ? 'hostname' : key);
    return;
  }
  switch (key) {
    case 'e':
    case 'env':
      apple.push('--env', value);
      break;
    case 'env-file':
      apple.push('--env-file', value);
      break;
    case 'gid':
      apple.push('--gid', value);
      break;
    case 'u':
    case 'user':
      apple.push('--user', value);
      break;
    case 'uid':
      apple.push('--uid', value);
      break;
    case 'w':
    case 'workdir':
    case 'cwd':
      apple.push('--workdir', value);
      break;
    case 'ulimit':
      apple.push('--ulimit', value);
      break;
    case 'c':
    case 'cpus':
      apple.push('--cpus', value);
      break;
    case 'm':
    case 'memory':
      apple.push('--memory', value);
      break;
    case 'cap-add':
      apple.push('--cap-add', value);
      break;
    case 'cap-drop':
      apple.push('--cap-drop', value);
      break;
    case 'cidfile':
      apple.push('--cidfile', value);
      break;
    case 'dns':
      apple.push('--dns', value);
      break;
    case 'dns-domain':
      apple.push('--dns-domain', value);
      break;
    case 'dns-option':
      apple.push('--dns-option', value);
      break;
    case 'dns-search':
      apple.push('--dns-search', value);
      break;
    case 'entrypoint':
      apple.push('--entrypoint', value);
      break;
    case 'l':
    case 'label':
      apple.push('--label', value);
      break;
    case 'mount': {
      const mount = toAppleMount(value);
      if (mount.kind === 'tmpfs') {
        apple.push('--tmpfs', mount.value);
      } else {
        apple.push('--mount', mount.value);
      }
      break;
    }
    case 'name':
      apple.push('--name', value);
      break;
    case 'network':
      apple.push('--network', value);
      break;
    case 'os':
      apple.push('--os', value);
      break;
    case 'p':
    case 'publish':
      apple.push('--publish', value);
      break;
    case 'platform':
      apple.push('--platform', value);
      break;
    case 'shm-size':
      apple.push('--shm-size', value);
      break;
    case 'tmpfs':
      apple.push('--tmpfs', value);
      break;
    case 'arch':
      apple.push('--arch', value);
      break;
    case 'volume':
    case 'v': {
      const mount = toAppleBind(value);
      apple.push('--mount', mount.value);
      break;
    }
    default:
      throw new ShimError(`docker run: unsupported flag --${key}`);
  }
}

async function commandExec(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['exec'];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      apple.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      apple.push(...args.slice(i));
      break;
    }
    const clustered = expandCluster(token);
    if (clustered) {
      for (const short of clustered) {
        if (short === 'i') {
          apple.push('--interactive');
        } else if (short === 't') {
          apple.push('--tty');
        } else if (short === 'd') {
          apple.push('--detach');
        }
      }
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'i' || flag.key === 'interactive') {
      apple.push('--interactive');
      continue;
    }
    if (flag.key === 't' || flag.key === 'tty') {
      apple.push('--tty');
      continue;
    }
    if (flag.key === 'd' || flag.key === 'detach') {
      apple.push('--detach');
      continue;
    }
    if (flag.key === 'privileged') {
      warn('ignoring docker exec --privileged');
      continue;
    }
    if (flag.key === 'u' || flag.key === 'user' || flag.key === 'e' || flag.key === 'env' || flag.key === 'w' || flag.key === 'workdir' || flag.key === 'env-file') {
      const taken = takeValue(args, i, flag.inline, flag.key);
      const mapped = flag.key === 'u' || flag.key === 'user' ? '--user' : flag.key === 'w' || flag.key === 'workdir' ? '--workdir' : flag.key === 'env-file' ? '--env-file' : '--env';
      apple.push(mapped, taken.value);
      i = taken.next - 1;
      continue;
    }
    throw new ShimError(`docker exec: unsupported flag ${token}`);
  }
  return runInherit(patchServerInstallExec(apple));
}

async function commandStart(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['start'];
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '-a' || token === '--attach') {
      apple.push('--attach');
      continue;
    }
    if (token === '-i' || token === '--interactive') {
      apple.push('--interactive');
      continue;
    }
    if (token.startsWith('-')) {
      throw new ShimError(`docker start: unsupported flag ${token}`);
    }
    ids.push(token);
  }
  if (ids.length === 0) {
    throw new ShimError('docker start: container id required');
  }
  let code = 0;
  for (const id of ids) {
    code = await runInherit([...apple, id]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}

async function commandStop(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['stop'];
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      ids.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 't' || flag.key === 'time') {
      const taken = takeValue(args, i, flag.inline, 'time');
      apple.push('--time', taken.value);
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 's' || flag.key === 'signal') {
      const taken = takeValue(args, i, flag.inline, 'signal');
      apple.push('--signal', taken.value);
      i = taken.next - 1;
      continue;
    }
    throw new ShimError(`docker stop: unsupported flag ${token}`);
  }
  if (ids.length === 0) {
    throw new ShimError('docker stop: container id required');
  }
  return runInherit([...apple, ...ids]);
}

async function commandRm(args: string[]): Promise<number> {
  await ensureSystem();
  let force = false;
  const ids: string[] = [];
  for (const token of args) {
    if (token === '-f' || token === '--force') {
      force = true;
      continue;
    }
    if (token === '-v' || token === '--volumes') {
      drop('volumes');
      continue;
    }
    if (token.startsWith('-')) {
      throw new ShimError(`docker rm: unsupported flag ${token}`);
    }
    ids.push(token);
  }
  if (ids.length === 0) {
    throw new ShimError('docker rm: container id required');
  }
  return runInherit(['delete', ...(force ? ['--force'] : []), ...ids]);
}

async function commandKill(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['kill'];
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      ids.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 's' || flag.key === 'signal') {
      const taken = takeValue(args, i, flag.inline, 'signal');
      apple.push('--signal', taken.value);
      i = taken.next - 1;
      continue;
    }
    throw new ShimError(`docker kill: unsupported flag ${token}`);
  }
  if (ids.length === 0) {
    throw new ShimError('docker kill: container id required');
  }
  return runInherit([...apple, ...ids]);
}

async function commandCp(args: string[]): Promise<number> {
  await ensureSystem();
  const paths: string[] = [];
  for (const token of args) {
    if (token === '-a' || token === '--archive' || token === '-L' || token === '--follow-link' || token === '-q' || token === '--quiet') {
      drop(token.replace(/^-+/, ''));
      continue;
    }
    if (token.startsWith('-')) {
      throw new ShimError(`docker cp: unsupported flag ${token}`);
    }
    paths.push(token);
  }
  if (paths.length !== 2) {
    throw new ShimError('docker cp: expected SRC DEST');
  }
  return runInherit(['copy', paths[0], paths[1]]);
}

async function commandLogs(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['logs'];
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      ids.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'f' || flag.key === 'follow') {
      apple.push('--follow');
      continue;
    }
    if (flag.key === 'n' || flag.key === 'tail') {
      const taken = takeValue(args, i, flag.inline, 'tail');
      apple.push('-n', taken.value);
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 't' || flag.key === 'timestamps' || flag.key === 'since' || flag.key === 'until') {
      drop(flag.key === 't' ? 'timestamps' : flag.key);
      if ((flag.key === 'since' || flag.key === 'until') && flag.inline === undefined) {
        i += 1;
      }
      continue;
    }
    throw new ShimError(`docker logs: unsupported flag ${token}`);
  }
  if (ids.length !== 1) {
    throw new ShimError('docker logs: container id required');
  }
  return runInherit([...apple, ids[0]]);
}

async function commandVolume(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'create':
      return volumeCreate(rest);
    case 'inspect':
      return commandInspect(['--type', 'volume', ...rest]);
    case 'ls':
    case 'list':
      return volumeList(rest);
    case 'rm':
    case 'remove':
      return volumeRemove(rest);
    default:
      throw new ShimError(`docker volume: '${sub ?? ''}' is not supported.`);
  }
}

async function volumeCreate(args: string[]): Promise<number> {
  await ensureSystem();
  const apple: string[] = ['volume', 'create'];
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) {
      names.push(token);
      continue;
    }
    const flag = flagAt(args, i);
    if (flag.key === 'label' || flag.key === 'opt' || flag.key === 'o') {
      const taken = takeValue(args, i, flag.inline, flag.key);
      apple.push(flag.key === 'label' ? '--label' : '--opt', taken.value);
      i = taken.next - 1;
      continue;
    }
    throw new ShimError(`docker volume create: unsupported flag ${token}`);
  }
  if (names.length !== 1) {
    throw new ShimError('docker volume create: volume name required');
  }
  return runInherit([...apple, names[0]]);
}

async function volumeList(args: string[]): Promise<number> {
  await ensureSystem();
  let format: string | undefined;
  const labelFilters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = flagAt(args, i);
    if (flag.key === 'format') {
      const taken = takeValue(args, i, flag.inline, 'format');
      format = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'filter' || flag.key === 'f') {
      const taken = takeValue(args, i, flag.inline, 'filter');
      if (taken.value.startsWith('label=')) {
        labelFilters.push(taken.value.slice('label='.length));
      } else {
        drop(`volume filter ${taken.value}`);
      }
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'q' || flag.key === 'quiet') {
      format = format ?? '{{.Name}}';
      continue;
    }
    if (args[i].startsWith('-')) {
      throw new ShimError(`docker volume ls: unsupported flag ${args[i]}`);
    }
  }
  const result = await runCapture(['volume', 'list', '--format', 'json']);
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    return result.code;
  }
  const volumes = asArray(result.stdout.trim() ? parseJsonOutput(result.stdout) : []).map((volume) => translateVolume(volume)).filter((volume) => matchLabelFilters(volume.Labels, labelFilters));
  for (const volume of volumes) {
    if (format) {
      process.stdout.write(`${applyDockerFormat(format, volume)}\n`);
    } else {
      process.stdout.write(`${volume.Driver}\t${volume.Name}\n`);
    }
  }
  return 0;
}

async function volumeRemove(args: string[]): Promise<number> {
  await ensureSystem();
  const names = args.filter((arg) => !arg.startsWith('-'));
  if (names.length === 0) {
    throw new ShimError('docker volume rm: volume name required');
  }
  return runInherit(['volume', 'delete', ...names]);
}

async function commandContainer(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'ls':
    case 'list':
    case 'ps':
      return commandPs(rest);
    case 'inspect':
      return commandInspect(['--type', 'container', ...rest]);
    case 'rm':
    case 'remove':
      return commandRm(rest);
    case 'start':
      return commandStart(rest);
    case 'stop':
      return commandStop(rest);
    case 'kill':
      return commandKill(rest);
    case 'logs':
      return commandLogs(rest);
    case 'exec':
      return commandExec(rest);
    case 'create':
      return commandRun(rest, 'create');
    default:
      throw new ShimError(`docker container: '${sub ?? ''}' is not supported.`);
  }
}

interface EventFilters {
  event: string[];
  container: string[];
  label: string[];
  type: string[];
}

export async function commandEvents(args: string[]): Promise<number> {
  await ensureSystem();
  let format = '{{json .}}';
  const filters: EventFilters = { event: [], container: [], label: [], type: [] };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const flag = flagAt(args, i);
    if (flag.key === 'format') {
      const taken = takeValue(args, i, flag.inline, 'format');
      format = taken.value;
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'filter' || flag.key === 'f') {
      const taken = takeValue(args, i, flag.inline, 'filter');
      const eq = taken.value.indexOf('=');
      const name = eq === -1 ? taken.value : taken.value.slice(0, eq);
      const value = eq === -1 ? '' : taken.value.slice(eq + 1);
      if (name === 'event' || name === 'container' || name === 'label' || name === 'type') {
        filters[name].push(value);
      }
      i = taken.next - 1;
      continue;
    }
    if (flag.key === 'since' || flag.key === 'until') {
      if (flag.inline === undefined) {
        i += 1;
      }
      continue;
    }
    if (token.startsWith('-')) {
      throw new ShimError(`docker events: unsupported flag ${token}`);
    }
  }

  const states = new Map<string, string>();
  const snapshot = async (baseline: boolean) => {
    const containers = await fetchContainers();
    const seen = new Set<string>();
    for (const raw of containers) {
      const id = containerIdOf(raw);
      const state = String(raw.status?.state ?? 'unknown');
      seen.add(id);
      const previous = states.get(id);
      states.set(id, state);
      if (baseline) {
        continue;
      }
      if (state === 'running' && previous !== 'running') {
        emitEvent(format, filters, 'start', raw);
      } else if (previous === 'running' && state !== 'running') {
        emitEvent(format, filters, 'die', raw);
      }
    }
    if (!baseline) {
      for (const id of [...states.keys()]) {
        if (!seen.has(id)) {
          emitEvent(format, filters, 'destroy', { id, configuration: { id, labels: {} } });
          states.delete(id);
        }
      }
    }
  };

  await snapshot(true);
  const timer = setInterval(() => {
    snapshot(false).catch((err) => {
      warn(err instanceof Error ? err.message : String(err));
    });
  }, 200);

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once('SIGTERM', () => {
      stop();
      process.exit(0);
    });
    process.once('SIGINT', () => {
      stop();
      process.exit(0);
    });
  });
  return 0;
}

function emitEvent(format: string, filters: EventFilters, action: string, raw: Record<string, any>): void {
  if (filters.event.length > 0 && !filters.event.includes(action)) {
    return;
  }
  if (filters.type.length > 0 && !filters.type.includes('container')) {
    return;
  }
  const id = containerIdOf(raw);
  if (filters.container.length > 0 && !filters.container.some((value) => id === value || id.startsWith(value))) {
    return;
  }
  const labels = labelsOf(raw);
  if (!matchLabelFilters(labels, filters.label)) {
    return;
  }
  const image = String(raw.configuration?.image?.reference ?? '');
  const event = {
    status: action,
    Status: action,
    Action: action,
    id,
    ID: id,
    Type: 'container',
    Actor: {
      ID: id,
      Attributes: { ...labels, name: id, image },
    },
    time: Math.floor(Date.now() / 1000),
  };
  const line = format.includes('json') && format.includes('.') && !format.includes('.status') && !format.includes('.Actor')
    ? JSON.stringify(event)
    : applyDockerFormat(format, event);
  process.stdout.write(`${line}\n`);
}
