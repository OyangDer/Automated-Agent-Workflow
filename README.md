# DSH Taskboard plugins

The Taskboard plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as a standalone release: install them into **any** released `dsh` with
one command each. No DSH source tree, no workspace checkout, no pnpm workspace protocol.

| Package | Role |
| --- | --- |
| `@deepseek-ai/dsh-taskboard` | The durable five-column board domain, the agent-facing workflow tools, reviewer automation, and the browser Remote API. |
| `@deepseek-ai/dsh-client-ui-taskboard` | The **Taskboard** browser tab that renders the board. |

Both are required: the tab reads the Remote surface the host package mounts.

## Install

Ask your DSH to install the plugin, or run the command directly. Pick one spec
form; the tarball form is the one this repository ships today.

**Local tarball** (from a clone of this repository):

```sh
dsh plugin --profile web add ./releases/dsh-taskboard-0.1.5-alpha.1.tgz
dsh plugin --profile web add ./releases/dsh-client-ui-taskboard-0.1.5-alpha.1.tgz
```

**Git** (installs straight from this repository; the `#path:/` fragment selects
the package inside it):

```sh
dsh plugin --profile web add "git+https://github.com/OyangDer/Automated-Agent-Workflow.git#path:/packages/dsh-taskboard"
dsh plugin --profile web add "git+https://github.com/OyangDer/Automated-Agent-Workflow.git#path:/packages/dsh-client-ui-taskboard"
```

**npm name** (works once the packages are published to the registry; they are
not published at the time of this release):

```sh
dsh plugin --profile web add @deepseek-ai/dsh-taskboard
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-taskboard
```

Restart the profile afterwards (`dsh --profile web`). `dsh plugin` appends every
installed dependency whose manifest declares `dsh.bundle` to the profile's
`dsh.profile.bundles` layer list, so both packages join the stack; the
**Taskboard** tab then mounts next to the conversation view.

## Layout

```
packages/dsh-taskboard/                `@deepseek-ai/dsh-taskboard@0.1.5-alpha.1`
packages/dsh-client-ui-taskboard/   `@deepseek-ai/dsh-client-ui-taskboard@0.1.5-alpha.1`
releases/                         deterministic tarballs for GitHub Releases
SHA256SUMS                        integrity ledger for every file below
.gitattributes                    disables checkout text conversion, so a clone matches the tarball
```

Each `packages/` directory is a complete, installable package: the built
artifacts a registry would ship are committed here, so both `dsh plugin add`
specs work without a build step on the consumer's machine.

## Provenance

Every file here is generated from the DeepSeek Harness repository by
`scripts/emit-taskboard-standalone.ts`. Do not edit this tree by hand — regenerate
it from the monorepo commit you want to ship. The emitter builds both packages
with the repository's own tooling, rewrites each manifest to real semver, packs
the tarballs, and refuses to write a tree whose manifests still carry the pnpm
workspace protocol or that vendors `node_modules` or DSH sources.
