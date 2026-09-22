# Refreshing the Taskboard plugins into a DSH profile

`scripts/refresh-taskboard-plugin.ts` replaces the two Taskboard plugin packages in a
profile with artifacts it has verified, and refuses to switch when the result would
not boot. It is the repeatable form of the repair that followed the 2026-09-21
accident.

```sh
tsx scripts/refresh-taskboard-plugin.ts --candidate D:/Plugins/dsh-taskboard-standalone
```

That command is a **dry-run**: it prints the whole plan and writes nothing. To perform
the switch, add `--apply`; the script then prints the same plan and waits for an
interactive `apply` confirmation before it touches the profile.

## Why `link:` to a package directory is forbidden

On 2026-09-21 the web profile's two Taskboard plugins were switched from
`link:<development tree>` to `link:<standalone package directory>`. The directory form
looked decoupled — it hands over built files rather than sources — but **`link:` never
installs the linked package's dependencies**. pnpm records a symlink and nothing else,
so `zod` and `@deepseek-ai/schemastery` were never materialized. The host then died
during plugin load, before any UI appeared, and DSH could not be opened at all.

`file:<artifact>.tgz` is the supported form: pnpm unpacks the tarball and installs the
dependencies its manifest declares. `scripts/refresh-taskboard-plugin.ts` installs only
`file:` specs and re-checks the installed runtime closure afterwards, so an install that
"succeeds" while a dependency is unreachable is caught before the next boot.

## What one refresh does

1. Builds fresh artifacts with `scripts/emit-taskboard-standalone.ts` (skipped when
   `--candidate <emitted tree>` supplies them).
2. Verifies every candidate tarball's sha256 against its `SHA256SUMS` ledger.
3. Archives the verified tarballs into a **new** `releases/<version>-<shortsha>/`
   directory under the artifact repository, with its own ledger and
   `provenance.json`. An existing release directory is never overwritten, so the
   previous known-good release stays installable.
4. Copies the profile's `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`,
   `cordis.yml`, and `pnpm-workspace.yaml` plus the artifact ledgers into
   `$DSH_HOME/backups/profiles-<profile>-<stamp>/`, with a `ROLLBACK.md` that states the
   restore steps.
5. Rewrites only the two Taskboard dependency specs to `file:<archived tgz>`. Every
   other dependency, bundle layer, and field is preserved; `dsh.profile.bundles` is
   never edited, because this deployment mounts the two packages through its own
   `cordis.patch.yml` and adding them to the bundle list would mount each twice.
6. Runs `pnpm install` in the profile directory. The package manager is resolved
   explicitly: an `npm_execpath` that names npm — or names anything other than pnpm —
   is ignored and pnpm is located on PATH instead, and a refresh **refuses before
   writing anything** when no pnpm exists. npm rejects the `link:` protocol this
   deployment's profile declares (`EUNSUPPORTEDPROTOCOL`), so degrading to npm would fail on
   the real profile while the log claimed pnpm.
7. Resolves each installed plugin's runtime dependency closure from the profile
   (`zod`, `@deepseek-ai/schemastery`, `clsx`, ...). A missing, unreadable, or
   wrong-version dependency **refuses the switch and restores the profile files from
   step 4**, then reinstalls. The run exits non-zero either way.

## Restart

The host reads plugins at boot, so a running instance keeps the old code until it is
restarted: `dsh --profile web`. The script prints that line when it finishes.

## Standard input is a question, never a default

- No `--apply`: dry-run. Nothing is written, no backup or archive directory is
  created, and `pnpm` is never invoked.
- `--apply`: the plan is printed first and the script waits for the literal word
  `apply`; any other answer aborts with nothing written.
- `--fault-skip-install` is a drill switch used to demonstrate the refusal and
  rollback path. It skips the install so the post-install state looks like the
  accident, and it never enables a switch.

## Restoring a rollback pack

```sh
tsx scripts/refresh-taskboard-plugin.ts --rollback "$DSH_HOME/backups/profiles-web-<stamp>"
```

The pack is self-describing: `ROLLBACK.md` lists the copy-back steps (restore the files,
`pnpm install`, restart) and `backup-manifest.json` records which files existed, their
sha256, and the ledgers of both the previous and the attempted artifact sets. The
`--rollback` command asks for the same `apply` confirmation before it writes.

## Verifying the script itself

```sh
pnpm exec vitest run scripts/refresh-taskboard-plugin.spec.ts
```

The spec covers the ledger (including the two-README.md collision that a basename key
would miss), a tampered artifact, the `link:`-shaped candidate refusal, the dry-run and
abort gates, the full apply, the missing-dependency refusal and rollback, the
archive-overwrite refusal, the build path, and a rollback pack whose file must be
deleted because it did not exist before the switch. It also pins the package-manager
resolution: an `npm_execpath` naming npm must yield pnpm (never npm), a contradictory
user agent cannot force npm, and a machine with no pnpm refuses before any write.
