import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type ReopenMode = 'up' | 'rebuild' | 'rebuild-no-cache';

export interface DevContainerTarget {
  folder: string;
  config: string;
}

export interface UpResult {
  containerId: string;
  remoteWorkspaceFolder: string;
}

export function appleContainerAuthority(id: string, image: string): string {
  const payload = Buffer.from(JSON.stringify({ settingType: 'appleContainer', id, image })).toString('hex');
  return `apple-container+${payload}`;
}

export function appleContainerUri(id: string, image: string, remotePath: string): string {
  const folder = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  return `vscode-remote://${appleContainerAuthority(id, image)}${folder}`;
}

export function workspaceFromDevContainerAuthority(authority: string): DevContainerTarget | undefined {
  const encoded = authority.split('@')[0].slice('dev-container+'.length);
  if (!encoded) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'hex').toString()) as { workspacePath?: string; devcontainerPath?: string };
    if (!parsed.workspacePath) {
      return undefined;
    }
    return {
      folder: parsed.workspacePath,
      config: parsed.devcontainerPath ?? path.join(parsed.workspacePath, '.devcontainer', 'devcontainer.json'),
    };
  } catch {
    return undefined;
  }
}

export function containerIdFromAppleAuthority(authority: string): string | undefined {
  const encoded = authority.split('@')[0].slice('apple-container+'.length);
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'hex').toString()) as { id?: string };
    return parsed.id;
  } catch {
    return undefined;
  }
}

export function findDevcontainerFiles(root: string): DevContainerTarget[] {
  const found: DevContainerTarget[] = [];
  const direct = path.join(root, '.devcontainer.json');
  if (fs.existsSync(direct)) {
    found.push({ folder: root, config: direct });
  }
  const nested = path.join(root, '.devcontainer', 'devcontainer.json');
  if (fs.existsSync(nested)) {
    found.push({ folder: root, config: nested });
  }
  const containerDir = path.join(root, '.devcontainer');
  if (fs.existsSync(containerDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(containerDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const config = path.join(containerDir, entry.name, 'devcontainer.json');
      if (fs.existsSync(config)) {
        found.push({ folder: root, config });
      }
    }
  }
  return found;
}

export function upArguments(mode: ReopenMode, target: DevContainerTarget, shimPath: string): string[] {
  const args = ['up', '--workspace-folder', target.folder, '--config', target.config, '--docker-path', shimPath];
  if (mode !== 'up') {
    args.push('--remove-existing-container');
  }
  if (mode === 'rebuild-no-cache') {
    args.push('--build-no-cache');
  }
  return args;
}

export function parseUpResult(stdout: string): UpResult {
  const lines = stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  const raw = lines[lines.length - 1];
  if (!raw) {
    throw new Error('Dev Containers did not return a container id.');
  }
  const parsed = JSON.parse(raw) as { outcome?: string; containerId?: string; remoteWorkspaceFolder?: string; message?: string };
  if (parsed.outcome && parsed.outcome !== 'success') {
    throw new Error(parsed.message || 'Dev Containers could not start the container.');
  }
  if (!parsed.containerId) {
    throw new Error('Dev Containers did not return a container id.');
  }
  return {
    containerId: parsed.containerId,
    remoteWorkspaceFolder: parsed.remoteWorkspaceFolder || '/workspace',
  };
}

export function localFolderFromInspect(inspectJson: string): DevContainerTarget | undefined {
  const parsed = JSON.parse(inspectJson) as { configuration?: { labels?: Record<string, string> } }[];
  const labels = parsed[0]?.configuration?.labels;
  const folder = labels?.['devcontainer.local_folder'];
  if (!folder) {
    return undefined;
  }
  return {
    folder,
    config: labels?.['devcontainer.config_file'] ?? path.join(folder, '.devcontainer', 'devcontainer.json'),
  };
}

export function readImageReference(inspectJson: string, containerId: string): string {
  const parsed = JSON.parse(inspectJson) as { configuration?: { image?: { reference?: string } } }[];
  const image = parsed[0]?.configuration?.image?.reference;
  if (!image) {
    throw new Error(`Container ${containerId} has no image reference.`);
  }
  return image;
}

export function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const failure = err as Error & { stderr?: string; stdout?: string };
        failure.message = `${failure.message}\n${stderr || failure.stderr || ''}`.trim();
        reject(failure);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}
