<a id="readme-top"></a>

<div align="center">

[![macOS][macos-shield]][apple-container-url]
[![TypeScript][typescript-shield]][typescript-url]
[![Node][node-shield]][node-url]
[![License: MIT][license-shield]][license-url]

<h1>Apple Dev Containers (Unofficial)</h1>

<p>
An unofficial beta extension for running VS Code Dev Containers on Apple's <code>container</code> CLI.
</p>

<p>
Not affiliated with, endorsed by, or supported by Apple or Microsoft.
</p>

<p>
<a href="#getting-started"><strong>Get started »</strong></a>
<br />
<a href="#usage">Usage</a>
·
<a href="#roadmap">Roadmap</a>
·
<a href="https://github.com/apple/container">Apple Container</a>
</p>

</div>

## Table of Contents

- [About The Project](#about-the-project)
  - [Built With](#built-with)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Usage](#usage)
  - [Commands](#commands)
  - [Example](#example)
  - [Limits](#limits)
- [Tests](#tests)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)
- [Acknowledgments](#acknowledgments)

## About The Project

This project is unofficial. It is an independent extension, and it is not affiliated with, endorsed by, or supported by Apple or Microsoft. Apple Container, Dev Containers, and VS Code are named only to describe what this extension works with.

The Dev Containers extension shells out to whatever `dev.containers.dockerPath` points at. Apple's [`container`](https://github.com/apple/container) CLI is OCI-compatible, and it does not speak the Docker CLI. Pointing `dockerPath` at `container` itself does not work.

This project is a VS Code extension plus `bin/container-docker`, a translator for the Docker commands that extension actually runs: build, run, exec, inspect, ps, events, volumes, and the surrounding lifecycle commands. `buildx version` fails on purpose, so Dev Containers uses classic `docker build`, which maps onto `container build`. Feature installs then copy files into the build context.

`dev.containers.dockerPath` is an application setting. The engine you pick applies to every Dev Container until you switch back.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

[![TypeScript][typescript-shield]][typescript-url]
[![Node.js][node-shield]][node-url]
[![VS Code][vscode-shield]][vscode-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

Install the extension from this folder, then point Dev Containers at the shim.

### Prerequisites

- A Mac with Apple silicon
- [Apple Container](https://github.com/apple/container) on `PATH` (`container` 1.6.0 or newer)
- [Node.js](https://nodejs.org/) 22 or newer
- Cursor, with the Dev Containers extension

Confirm the CLI:

```sh
container --version
container system status
```

### Installation

1. Clone this repository and install it.
   ```sh
   npm install
   npm run compile
   ```
2. In Cursor, run **Developer: Install Extension from Location…** and choose this folder.
3. Reload the window.
4. Run **Apple Container: Use for Dev Containers**.

The status bar shows **Apple Container** while the shim is selected, and **Docker** after you switch back.

You can set the path yourself. Use the absolute path to `bin/container-docker`:

```json
"dev.containers.dockerPath": "/absolute/path/to/container-devcontainers/bin/container-docker"
```

**Apple Container: Use Docker Again** sets that value back to `docker`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

Open a folder that has a `devcontainer.json`. Click **Apple Container** in the status bar, or open the command palette, and run **Apple Container: Reopen in Container**.

That command points Dev Containers at the shim, then runs the normal Dev Containers reopen flow. Rebuild and related actions do the same. If the folder has no `devcontainer.json`, the extension stops with an error instead of showing a stuck progress toast.

The shim starts `container system` services when `container system status` is not already running.

### Commands

| Command | What it does |
| --- | --- |
| **Show Actions** | Opens the status-bar menu |
| **Use for Dev Containers** | Sets `dev.containers.dockerPath` to the shim |
| **Use Docker Again** | Sets `dev.containers.dockerPath` back to `docker` |
| **Reopen in Container** | Points Dev Containers at the shim and reopens the folder in a container |
| **Rebuild and Reopen** | Rebuilds the image, replaces the container, and reopens |
| **Rebuild Without Cache and Reopen** | Rebuilds without layer cache, then reopens |
| **Rebuild Container** | Same rebuild, for a window that is already inside the container |
| **Rebuild Container Without Cache** | Rebuilds the current container without layer cache |
| **Reopen Folder Locally** | Opens the folder on this Mac |
| **Reinstall Server and Reload Window** | Asks Dev Containers to replace the remote server |
| **Show Log** | Opens the Dev Containers log |

### Example

`examples/hello` is a small Alpine container.

```json
{
  "name": "Hello",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "workspaceFolder": "/workspace",
  "workspaceMount": "source=${localWorkspaceFolder},target=/workspace,type=bind",
  "postCreateCommand": "sh hello.sh"
}
```

Open `examples/hello` and run **Apple Container: Reopen in Container**. The post-create script writes `hello from the dev container` to the terminal output of that step.

Alpine images need `libstdc++` for the Cursor server. The example Dockerfile installs it. The shim also runs `apk add --no-cache libstdc++` when the library is missing, and it puts a `flock` wrapper on `PATH` because BusyBox `flock` rejects the `-w` timeout the server installer uses.

### Limits

- One engine at a time. `dockerPath` applies to every Dev Container.
- Docker Compose is not supported. `docker compose` fails with an explicit error.
- GPUs are not supported. `--privileged` maps to `--cap-add ALL`.
- `--security-opt`, `--hostname`, `--add-host`, and `--pull` on `docker run` are ignored.
- There is no Docker socket. The Containers side panel can keep reporting that Docker is unavailable.
- `container build` has no `--build-context` or `--cache-from`. Features use the in-context copy path.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Tests

```sh
npm test
npm run test:smoke
```

`npm test` compiles the project and runs the unit tests against a fake `container` binary. `npm run test:smoke` runs `@devcontainers/cli` against the Apple Container CLI installed on this Mac: an Alpine image container and a Dockerfile build. Smoke tests share one `container` service, so they run one at a time.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Docker CLI shim for the Dev Containers command set
- [x] Extension commands to switch `dockerPath`
- [x] Reopen and rebuild through the Dev Containers commands and the shim
- [x] Alpine `flock -w` and `libstdc++` workarounds for the Cursor server
- [ ] Docker Compose
- [ ] GPU passthrough
- [ ] A Containers side panel that does not expect a Docker socket

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

1. Fork the project.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add some amazing feature'`).
4. Push the branch (`git push origin feature/amazing-feature`).
5. Open a pull request.

Run `npm test` before opening the pull request. Run `npm run test:smoke` when a change touches build, run, or exec translation.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

Distributed under the MIT License. See the `LICENSE` file for the full text.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

This project does not have a public remote yet. Open an issue on the repository you cloned it from.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

- [Apple Container](https://github.com/apple/container)
- [Development Containers](https://containers.dev/) and [`@devcontainers/cli`](https://github.com/devcontainers/cli)
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template)
- [Shields.io](https://shields.io)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

[macos-shield]: https://img.shields.io/badge/macOS-Apple%20silicon-111111?style=for-the-badge&logo=apple&logoColor=white
[apple-container-url]: https://github.com/apple/container
[typescript-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[typescript-url]: https://www.typescriptlang.org/
[node-shield]: https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white
[node-url]: https://nodejs.org/
[vscode-shield]: https://img.shields.io/badge/VS%20Code-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white
[vscode-url]: https://code.visualstudio.com/
[license-shield]: https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge
[license-url]: LICENSE
