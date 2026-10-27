import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  appleContainerAuthority,
  appleContainerUri,
  containerIdFromAppleAuthority,
  findDevcontainerFiles,
  localFolderFromInspect,
  parseUpResult,
  readImageReference,
  upArguments,
  workspaceFromDevContainerAuthority,
} from '../../reopen';

const root = path.resolve(__dirname, '../../..');

test('apple container authority round-trips the container id', () => {
  const authority = appleContainerAuthority('box', 'docker.io/library/alpine:latest');
  assert.equal(containerIdFromAppleAuthority(authority), 'box');
  assert.equal(appleContainerUri('box', 'docker.io/library/alpine:latest', '/workspace'), `vscode-remote://${authority}/workspace`);
  const decoded = JSON.parse(Buffer.from(authority.slice('apple-container+'.length), 'hex').toString()) as { settingType: string; image: string };
  assert.equal(decoded.settingType, 'appleContainer');
  assert.equal(decoded.image, 'docker.io/library/alpine:latest');
});

test('dev container authority keeps the host workspace path', () => {
  const payload = Buffer.from(JSON.stringify({
    settingType: 'config',
    workspacePath: '/work/hello',
    devcontainerPath: '/work/hello/.devcontainer/devcontainer.json',
  })).toString('hex');
  const target = workspaceFromDevContainerAuthority(`dev-container+${payload}`);
  assert.deepEqual(target, {
    folder: '/work/hello',
    config: '/work/hello/.devcontainer/devcontainer.json',
  });
});

test('rebuild arguments replace the container and can skip the cache', () => {
  const target = { folder: '/work/hello', config: '/work/hello/.devcontainer/devcontainer.json' };
  assert.deepEqual(upArguments('up', target, '/shim'), [
    'up', '--workspace-folder', '/work/hello', '--config', target.config, '--docker-path', '/shim',
  ]);
  assert.ok(upArguments('rebuild', target, '/shim').includes('--remove-existing-container'));
  assert.ok(upArguments('rebuild-no-cache', target, '/shim').includes('--build-no-cache'));
});

test('up result and inspect json produce the open target', () => {
  assert.deepEqual(parseUpResult('noise\n{"outcome":"success","containerId":"abc","remoteWorkspaceFolder":"/workspace"}\n'), {
    containerId: 'abc',
    remoteWorkspaceFolder: '/workspace',
  });
  assert.equal(readImageReference(JSON.stringify([{ configuration: { image: { reference: 'alpine:latest' } } }]), 'abc'), 'alpine:latest');
  assert.deepEqual(localFolderFromInspect(JSON.stringify([{
    configuration: { labels: { 'devcontainer.local_folder': '/work/hello', 'devcontainer.config_file': '/work/hello/.devcontainer/devcontainer.json' } },
  }])), { folder: '/work/hello', config: '/work/hello/.devcontainer/devcontainer.json' });
});

test('only configs in the workspace folder itself are found', () => {
  assert.deepEqual(findDevcontainerFiles(root), []);
  const hello = path.join(root, 'examples', 'hello');
  const configs = findDevcontainerFiles(hello);
  assert.equal(configs.length, 1);
  assert.ok(configs[0].config.endsWith('examples/hello/.devcontainer/devcontainer.json'));
});
