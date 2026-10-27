const FLOCK_WRAPPER = `#!/bin/sh
for candidate in /usr/bin/flock /bin/flock; do
  if [ -x "\${candidate}" ] && "\${candidate}" -w 0 /tmp/.apple-flock-probe true >/dev/null 2>&1; then
    exec "\${candidate}" "$@"
  fi
done
skip=0
file=/tmp/.apple-flock-args.$$
: > "\${file}"
for arg in "$@"; do
  if [ "\${skip}" = 1 ]; then
    skip=0
    continue
  fi
  case "\${arg}" in
    -w|--timeout|--wait)
      skip=1
      ;;
    -w*)
      ;;
    --timeout=*|--wait=*)
      ;;
    *)
      printf '%s\\n' "\${arg}" >> "\${file}"
      ;;
  esac
done
set --
while IFS= read -r arg; do
  set -- "$@" "\${arg}"
done < "\${file}"
rm -f "\${file}"
if [ -x /bin/busybox ]; then
  exec /bin/busybox flock "$@"
fi
echo "flock: no compatible flock binary" >&2
exit 127
`;

export function runtimePrepScript(): string {
  return `mkdir -p /usr/local/bin /tmp/apple-dev-bin
cat > /usr/local/bin/flock << 'APPLE_DEV_FLOCK'
${FLOCK_WRAPPER}
APPLE_DEV_FLOCK
chmod +x /usr/local/bin/flock
if [ -f /etc/alpine-release ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
  apk add --no-cache libstdc++ || echo "container-devcontainers: could not install libstdc++" >&2
fi`;
}

export function serverInstallPreamble(): string {
  return `mkdir -p /tmp/apple-dev-bin
cat > /tmp/apple-dev-bin/flock << 'APPLE_DEV_FLOCK'
${FLOCK_WRAPPER}
APPLE_DEV_FLOCK
chmod +x /tmp/apple-dev-bin/flock
export PATH="/tmp/apple-dev-bin:\${PATH}"
if [ -f /etc/alpine-release ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
  apk add --no-cache libstdc++ || echo "container-devcontainers: could not install libstdc++" >&2
fi`;
}

export function patchServerInstallExec(args: string[]): string[] {
  const shells = new Set(['bash', 'sh']);
  for (let i = 0; i < args.length - 2; i++) {
    if (!shells.has(args[i]) || args[i + 1] !== '-c') {
      continue;
    }
    const script = args[i + 2];
    if (!script.includes('base64 -d') || !script.includes('| bash')) {
      continue;
    }
    const copy = args.slice();
    copy[i + 2] = `${serverInstallPreamble()}\n${script}`;
    return copy;
  }
  return args;
}
