import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findDevcontainerFiles } from './reopen';

const DOCKER_PATH = 'dev.containers.dockerPath';

const ACTIONS: { command: string; title: string; detail: string; run: (shimPath: string) => Promise<void> }[] = [
  {
    command: 'container-devcontainers.reopenInContainer',
    title: 'Reopen in Container',
    detail: 'Open this folder in a container through the Apple Container shim',
    run: (shimPath) => runDevContainers(shimPath, 'remote-containers.reopenInContainer'),
  },
  {
    command: 'container-devcontainers.rebuildAndReopen',
    title: 'Rebuild and Reopen',
    detail: 'Rebuild the image and reopen through the Apple Container shim',
    run: (shimPath) => runDevContainers(shimPath, 'remote-containers.rebuildAndReopenInContainer'),
  },
  {
    command: 'container-devcontainers.rebuildNoCacheAndReopen',
    title: 'Rebuild Without Cache and Reopen',
    detail: 'Rebuild without layer cache and reopen through the Apple Container shim',
    run: (shimPath) => runDevContainers(shimPath, 'remote-containers.rebuildNoCacheAndReopenInContainer'),
  },
  {
    command: 'container-devcontainers.rebuild',
    title: 'Rebuild Container',
    detail: 'Rebuild the container you are already in',
    run: (shimPath) => runDevContainers(shimPath, 'remote-containers.rebuildContainer'),
  },
  {
    command: 'container-devcontainers.rebuildNoCache',
    title: 'Rebuild Container Without Cache',
    detail: 'Rebuild the current container without layer cache',
    run: (shimPath) => runDevContainers(shimPath, 'remote-containers.rebuildContainerNoCache'),
  },
  {
    command: 'container-devcontainers.reopenLocally',
    title: 'Reopen Folder Locally',
    detail: 'Leave the container and open the folder on this Mac',
    run: async () => forward('remote-containers.reopenFolderLocally'),
  },
  {
    command: 'container-devcontainers.reinstallServer',
    title: 'Reinstall Server and Reload Window',
    detail: 'Replace the remote server inside the container',
    run: async () => forward('remote-containers.reinstallServerAndReload'),
  },
  {
    command: 'container-devcontainers.showLog',
    title: 'Show Log',
    detail: 'Open the Dev Containers log',
    run: async () => forward('remote-containers.showLog'),
  },
];

export function activate(context: vscode.ExtensionContext): void {
  const shimPath = path.join(context.extensionPath, 'bin', 'container-docker');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(item);

  const refresh = () => {
    const current = vscode.workspace.getConfiguration('dev.containers').get<string>('dockerPath');
    const usingShim = isShim(current, shimPath);
    item.text = usingShim ? '$(server) Apple Container' : '$(server) Docker';
    item.tooltip = usingShim
      ? 'Dev Containers are using Apple Container. Click for reopen, rebuild, and other actions.'
      : 'Dev Containers are using Docker. Click for actions, or switch to Apple Container.';
    item.command = 'container-devcontainers.showActions';
    item.show();
  };

  context.subscriptions.push(
    ...ACTIONS.map((action) => vscode.commands.registerCommand(action.command, () => action.run(shimPath))),
    vscode.commands.registerCommand('container-devcontainers.showActions', () => showActions(shimPath)),
    vscode.commands.registerCommand('container-devcontainers.useAppleContainer', async () => {
      if (!(await ensureAppleReady())) {
        return;
      }
      await vscode.workspace.getConfiguration('dev.containers').update('dockerPath', shimPath, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage('Dev Containers now use Apple Container. Run Apple Container: Reopen in Container.');
      refresh();
    }),
    vscode.commands.registerCommand('container-devcontainers.useDocker', async () => {
      await vscode.workspace.getConfiguration('dev.containers').update('dockerPath', 'docker', vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage('Dev Containers now use Docker.');
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(DOCKER_PATH)) {
        refresh();
      }
    }),
  );

  refresh();
}

export function deactivate(): void {
  return undefined;
}

interface ActionItem extends vscode.QuickPickItem {
  command: string;
}

async function showActions(shimPath: string): Promise<void> {
  const usingShim = isShim(vscode.workspace.getConfiguration('dev.containers').get<string>('dockerPath'), shimPath);
  const engine: ActionItem = usingShim
    ? { label: 'Use Docker Again', command: 'container-devcontainers.useDocker', detail: 'Point Dev Containers back at docker' }
    : { label: 'Use for Dev Containers', command: 'container-devcontainers.useAppleContainer', detail: 'Point Dev Containers at Apple Container' };
  const picked = await vscode.window.showQuickPick<ActionItem>(
    [
      ...ACTIONS.map((action) => ({ label: action.title, command: action.command, detail: action.detail })),
      engine,
    ],
    { title: usingShim ? 'Apple Container' : 'Docker', placeHolder: 'Reopen, rebuild, or switch the container engine' },
  );
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

async function runDevContainers(shimPath: string, command: string): Promise<void> {
  if (!(await ensureAppleReady())) {
    return;
  }
  if (!workspaceHasDevcontainer()) {
    await vscode.window.showErrorMessage('No devcontainer.json was found in this folder. Open a folder that contains one, then try again.');
    return;
  }
  await vscode.workspace.getConfiguration('dev.containers').update('dockerPath', shimPath, vscode.ConfigurationTarget.Global);
  await forward(command);
}

function workspaceHasDevcontainer(): boolean {
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  if (!folder) {
    return false;
  }
  return findDevcontainerFiles(folder.uri.fsPath).some((target) => fs.existsSync(target.config));
}

async function ensureAppleReady(): Promise<boolean> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    await vscode.window.showErrorMessage('Apple Container only runs on a Mac with Apple silicon.');
    return false;
  }
  if (!await commandExists('container')) {
    await vscode.window.showErrorMessage('The Apple Container CLI is not on PATH. Install it from https://github.com/apple/container and try again.');
    return false;
  }
  return true;
}

async function forward(command: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(message);
  }
}

function isShim(current: string | undefined, shimPath: string): boolean {
  if (!current) {
    return false;
  }
  return path.resolve(current) === path.resolve(shimPath);
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [command], (err) => resolve(!err));
  });
}
