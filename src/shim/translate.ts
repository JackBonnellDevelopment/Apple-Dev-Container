export interface DockerMount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  Driver?: string;
  Mode: string;
  RW: boolean;
  Propagation: string;
}

export interface DockerContainer {
  Id: string;
  Name: string;
  Created: string;
  Path: string;
  Args: string[];
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    StartedAt: string;
    FinishedAt: string;
    ExitCode: number;
    Error: string;
  };
  Image: string;
  Config: {
    Hostname: string;
    User: string;
    Env: string[];
    Cmd: string[] | null;
    Image: string;
    Entrypoint: string[] | null;
    WorkingDir: string;
    Labels: Record<string, string>;
  };
  HostConfig: {
    Binds: string[];
    Privileged: boolean;
    Init: boolean;
  };
  Mounts: DockerMount[];
  NetworkSettings: {
    IPAddress: string;
    Gateway: string;
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

export interface DockerImage {
  Id: string;
  RepoTags: string[];
  Created: string;
  Os: string;
  Architecture: string;
  Variant?: string;
  Size: number;
  Config: {
    User: string;
    Env: string[];
    Cmd: string[] | null;
    Entrypoint: string[] | null;
    WorkingDir: string;
    Labels: Record<string, string>;
  };
}

export interface DockerVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Scope: string;
  Options: Record<string, string>;
}

type Json = Record<string, any>;

export function asArray(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value as Json[];
  }
  if (value && typeof value === 'object') {
    return [value as Json];
  }
  return [];
}

export function dockerStatus(state: string | undefined): string {
  switch (state) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'exited';
    case 'stopping':
      return 'removing';
    case 'unknown':
      return 'created';
    default:
      return state || 'created';
  }
}

export function labelsOf(raw: Json): Record<string, string> {
  const labels = raw.configuration?.labels ?? raw.labels ?? {};
  const out: Record<string, string> = {};
  if (!labels || typeof labels !== 'object') {
    return out;
  }
  for (const [key, value] of Object.entries(labels)) {
    out[key] = value == null ? '' : String(value);
  }
  return out;
}

export function containerIdOf(raw: Json): string {
  return String(raw.id ?? raw.configuration?.id ?? '');
}

function userString(user: unknown): string {
  if (!user) {
    return '';
  }
  if (typeof user === 'string') {
    return user;
  }
  if (typeof user !== 'object') {
    return '';
  }
  const record = user as Json;
  if (record.id && typeof record.id === 'object') {
    const id = record.id as Json;
    if (id.uid != null) {
      return `${id.uid}:${id.gid ?? 0}`;
    }
  }
  if (typeof record.raw === 'string') {
    return record.raw;
  }
  if (record.raw && typeof record.raw === 'object' && record.raw.userString != null) {
    return String(record.raw.userString);
  }
  if (record.userString != null) {
    return String(record.userString);
  }
  return '';
}

function mountKind(type: unknown): { kind: string; name?: string } {
  if (typeof type === 'string') {
    return { kind: type };
  }
  if (!type || typeof type !== 'object') {
    return { kind: 'bind' };
  }
  const record = type as Json;
  if ('volume' in record) {
    const volume = record.volume;
    const name = volume && typeof volume === 'object' ? String((volume as Json).name ?? '') : undefined;
    return { kind: 'volume', name: name || undefined };
  }
  if ('tmpfs' in record) {
    return { kind: 'tmpfs' };
  }
  if ('virtiofs' in record || 'block' in record) {
    return { kind: 'bind' };
  }
  const keys = Object.keys(record);
  return { kind: keys[0] || 'bind' };
}

export function translateMount(raw: Json): DockerMount {
  const kind = mountKind(raw.type);
  const options = Array.isArray(raw.options) ? raw.options.map(String) : [];
  const readOnly = options.includes('ro') || options.includes('readonly');
  const mount: DockerMount = {
    Type: kind.kind === 'volume' ? 'volume' : kind.kind === 'tmpfs' ? 'tmpfs' : 'bind',
    Source: String(raw.source ?? ''),
    Destination: String(raw.destination ?? raw.target ?? ''),
    Mode: readOnly ? 'ro' : '',
    RW: !readOnly,
    Propagation: 'rprivate',
  };
  if (mount.Type === 'volume') {
    mount.Name = kind.name || mount.Source;
    mount.Driver = 'local';
  }
  return mount;
}

function publishedPorts(raw: Json): DockerContainer['NetworkSettings']['Ports'] {
  const ports: DockerContainer['NetworkSettings']['Ports'] = {};
  const published = raw.configuration?.publishedPorts;
  if (!Array.isArray(published)) {
    return ports;
  }
  for (const port of published) {
    if (!port || typeof port !== 'object') {
      continue;
    }
    const item = port as Json;
    const containerPort = item.containerPort ?? item.container_port;
    if (containerPort == null) {
      continue;
    }
    const proto = String(item.proto ?? 'tcp');
    const key = `${containerPort}/${proto}`;
    const hostPort = item.hostPort ?? item.host_port;
    const hostIp = String(item.hostAddress ?? item.host_address ?? '0.0.0.0');
    ports[key] = ports[key] ?? [];
    ports[key]!.push({ HostIp: hostIp, HostPort: hostPort == null ? '' : String(hostPort) });
  }
  return ports;
}

export function translateContainer(raw: Json): DockerContainer {
  const id = containerIdOf(raw);
  const config = raw.configuration ?? {};
  const process = config.initProcess ?? {};
  const labels = labelsOf(raw);
  const mounts: DockerMount[] = Array.isArray(config.mounts) ? config.mounts.map((mount: Json) => translateMount(mount)) : [];
  const state = String(raw.status?.state ?? 'unknown');
  const status = dockerStatus(state);
  const image = String(config.image?.reference ?? config.image?.name ?? '');
  const executable = process.executable ? String(process.executable) : '';
  const args = Array.isArray(process.arguments) ? process.arguments.map(String) : [];
  const networks = Array.isArray(raw.status?.networks) ? raw.status.networks : [];
  const firstNet = networks[0] ?? {};
  const ip = String(firstNet.ipv4Address ?? '').split('/')[0];
  const gateway = String(firstNet.ipv4Gateway ?? '').split('/')[0];
  const hostname = String(firstNet.hostname ?? config.networks?.[0]?.options?.hostname ?? id);
  const capAdd = Array.isArray(config.capAdd) ? config.capAdd.map(String) : [];
  return {
    Id: id,
    Name: `/${id}`,
    Created: String(config.creationDate ?? ''),
    Path: executable,
    Args: args,
    State: {
      Status: status,
      Running: state === 'running',
      Paused: false,
      Restarting: false,
      Dead: false,
      StartedAt: String(raw.status?.startedDate ?? ''),
      FinishedAt: '',
      ExitCode: state === 'running' ? 0 : 0,
      Error: '',
    },
    Image: image,
    Config: {
      Hostname: hostname,
      User: userString(process.user),
      Env: Array.isArray(process.environment) ? process.environment.map(String) : [],
      Cmd: args.length ? args : null,
      Image: image,
      Entrypoint: executable ? [executable] : null,
      WorkingDir: String(process.workingDirectory ?? ''),
      Labels: labels,
    },
    HostConfig: {
      Binds: mounts
        .filter((mount) => mount.Type === 'bind' && mount.Source && mount.Destination)
        .map((mount) => `${mount.Source}:${mount.Destination}${mount.RW ? '' : ':ro'}`),
      Privileged: capAdd.includes('ALL'),
      Init: Boolean(config.useInit),
    },
    Mounts: mounts,
    NetworkSettings: {
      IPAddress: ip,
      Gateway: gateway,
      Ports: publishedPorts(raw),
    },
  };
}

export function imageIdOf(raw: Json): string {
  const digest = raw.configuration?.descriptor?.digest;
  if (typeof digest === 'string' && digest.startsWith('sha256:')) {
    return digest;
  }
  const id = String(raw.id ?? '');
  if (!id) {
    return '';
  }
  return id.startsWith('sha256:') ? id : `sha256:${id}`;
}

export function translateImage(raw: Json, requestedName?: string): DockerImage {
  const variant = Array.isArray(raw.variants) ? raw.variants[0] : undefined;
  const ociRoot = variant?.config ?? raw.config ?? {};
  const oci = ociRoot.config ?? ociRoot;
  const name = String(raw.configuration?.name ?? raw.configuration?.reference ?? requestedName ?? '');
  const labels = oci.Labels ?? oci.labels ?? {};
  return {
    Id: imageIdOf(raw),
    RepoTags: name ? [name] : [],
    Created: String(ociRoot.created ?? raw.configuration?.creationDate ?? ''),
    Os: String(ociRoot.os ?? variant?.platform?.os ?? 'linux'),
    Architecture: String(ociRoot.architecture ?? variant?.platform?.architecture ?? 'arm64'),
    Variant: ociRoot.variant ? String(ociRoot.variant) : undefined,
    Size: Number(variant?.size ?? raw.configuration?.descriptor?.size ?? 0),
    Config: {
      User: oci.User ? String(oci.User) : '',
      Env: Array.isArray(oci.Env) ? oci.Env.map(String) : [],
      Cmd: Array.isArray(oci.Cmd) ? oci.Cmd.map(String) : oci.Cmd ?? null,
      Entrypoint: Array.isArray(oci.Entrypoint) ? oci.Entrypoint.map(String) : oci.Entrypoint ?? null,
      WorkingDir: oci.WorkingDir ? String(oci.WorkingDir) : '',
      Labels: labels && typeof labels === 'object' ? Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, value == null ? '' : String(value)])) : {},
    },
  };
}

export function translateVolume(raw: Json): DockerVolume {
  const config = raw.configuration ?? raw;
  const labels = config.labels && typeof config.labels === 'object'
    ? Object.fromEntries(Object.entries(config.labels).map(([key, value]) => [key, value == null ? '' : String(value)]))
    : {};
  const options = config.options && typeof config.options === 'object'
    ? Object.fromEntries(Object.entries(config.options).map(([key, value]) => [key, value == null ? '' : String(value)]))
    : {};
  return {
    Name: String(config.name ?? raw.id ?? ''),
    Driver: String(config.driver ?? 'local'),
    Mountpoint: String(config.source ?? ''),
    Labels: labels,
    Scope: 'local',
    Options: options,
  };
}

export function labelString(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',');
}

export interface PsRow {
  ID: string;
  Id: string;
  Names: string;
  Name: string;
  Image: string;
  State: string;
  Status: string;
  Labels: string;
  LabelMap: Record<string, string>;
  Command: string;
  CreatedAt: string;
  Mounts: string;
  Ports: string;
}

export function psRow(container: DockerContainer): PsRow {
  const name = container.Name.startsWith('/') ? container.Name.slice(1) : container.Name;
  return {
    ID: container.Id,
    Id: container.Id,
    Names: name,
    Name: name,
    Image: container.Config.Image || container.Image,
    State: container.State.Status,
    Status: container.State.Running ? 'Up' : container.State.Status,
    Labels: labelString(container.Config.Labels),
    LabelMap: container.Config.Labels,
    Command: [container.Path, ...container.Args].filter(Boolean).join(' '),
    CreatedAt: container.Created,
    Mounts: container.Mounts.map((mount) => mount.Name || mount.Source).filter(Boolean).join(','),
    Ports: Object.entries(container.NetworkSettings.Ports)
      .map(([key, bindings]) => {
        const binding = bindings?.[0];
        return binding ? `${binding.HostIp}:${binding.HostPort}->${key}` : key;
      })
      .join(','),
  };
}

export function splitMount(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of splitCommas(spec)) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      out[part.trim()] = '';
      continue;
    }
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function splitCommas(spec: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of spec) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

export function toAppleMount(spec: string): { kind: 'mount' | 'tmpfs'; value: string } {
  const fields = splitMount(spec);
  const type = fields.type || 'bind';
  const source = fields.source ?? fields.src ?? '';
  const target = fields.target ?? fields.dst ?? fields.destination ?? '';
  const readOnly = 'readonly' in fields || fields.ro === 'true' || fields.ro === '1';
  if (type === 'tmpfs') {
    return { kind: 'tmpfs', value: target || source };
  }
  const appleType = type === 'volume' ? 'volume' : 'bind';
  let value = `type=${appleType},source=${source},target=${target}`;
  if (readOnly) {
    value += ',readonly';
  }
  return { kind: 'mount', value };
}

export function toAppleBind(spec: string): { kind: 'mount' | 'tmpfs'; value: string } {
  const parts = spec.split(':');
  const source = parts[0] ?? '';
  const target = parts[1] ?? '';
  const options = parts.slice(2);
  if (!target) {
    return { kind: 'mount', value: `type=bind,source=${source},target=${source}` };
  }
  const readOnly = options.includes('ro');
  const named = source.length > 0 && !source.startsWith('/') && !source.startsWith('.') && !source.startsWith('~');
  let value = `type=${named ? 'volume' : 'bind'},source=${source},target=${target}`;
  if (readOnly) {
    value += ',readonly';
  }
  return { kind: 'mount', value };
}

export function containerUsesVolume(raw: Json, name: string): boolean {
  const mounts = raw.configuration?.mounts;
  if (!Array.isArray(mounts)) {
    return false;
  }
  return mounts.some((mount) => {
    if (!mount || typeof mount !== 'object') {
      return false;
    }
    const item = mount as Json;
    if (String(item.source ?? '') === name) {
      return true;
    }
    const volume = item.type?.volume;
    if (volume && typeof volume === 'object' && String((volume as Json).name ?? '') === name) {
      return true;
    }
    return false;
  });
}

export function matchLabelFilters(labels: Record<string, string>, filters: string[]): boolean {
  for (const filter of filters) {
    const eq = filter.indexOf('=');
    if (eq === -1) {
      if (!(filter in labels)) {
        return false;
      }
      continue;
    }
    const key = filter.slice(0, eq);
    const value = filter.slice(eq + 1);
    if (labels[key] !== value) {
      return false;
    }
  }
  return true;
}
