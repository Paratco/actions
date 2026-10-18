# actions

GitHub Actions that keep artifacts and caches in **your own S3-compatible bucket** (AWS S3, MinIO, Cloudflare R2, Ceph, …) instead of GitHub's storage.

They take the same inputs as `actions/upload-artifact@v4`, `actions/download-artifact@v4` and `actions/cache`, plus the S3 connection inputs. They run on any runner OS (Linux, Windows, macOS), self-hosted or GitHub-hosted.

| Action | Mirrors |
|---|---|
| `Paratco/actions/s3-artifact/upload@v1` | `actions/upload-artifact` |
| `Paratco/actions/s3-artifact/download@v1` | `actions/download-artifact` |
| `Paratco/actions/s3-artifact/delete@v1` | deleting artifacts of the run |
| `Paratco/actions/s3-cache@v1` | `actions/cache` |

## Why

GitHub bills artifact storage in GB-hours against your plan's included storage, and its metering is beyond your control. Keeping hand-off files in a bucket you own makes that cost and its cleanup yours to decide.

## How they run

The actions are written in TypeScript for [Bun](https://bun.sh) (its S3 client, globbing and zstd streams) and bundled into `dist/`. GitHub only runs JavaScript actions on Node, so each action's entry point is a small Node shim that downloads a pinned Bun into the runner's tool cache, verifies its npm registry SHA-512, and runs the bundle with it. The first action on a runner pays for that download; later ones reuse it. Nothing is added to the job's `PATH`.

## S3 connection inputs

Every action takes these:

| Input | Required | Default | |
|---|---|---|---|
| `endpoint` | yes | | URL with scheme, e.g. `https://s3.example.com` or `http://minio:9000` |
| `bucket` | yes | | |
| `access-key-id` | yes | | |
| `secret-access-key` | yes | | |
| `region` | no | `us-east-1` | |
| `skip-tls-verify` | no | `false` | For self-signed certificates. Avoid on public networks. |

Use an access key that can only read and write this one bucket.

## s3-artifact

Artifacts are stored as `<prefix>/<name>/<path>`. The default `prefix` is `<owner>/<repo>/<run_id>`, so several repositories can share one bucket, and a re-run attempt of the same run sees what earlier attempts uploaded.

S3 has no per-object retention. Add a **lifecycle rule** to the bucket (for example: expire objects after 1 day) to replace upload-artifact's `retention-days`.


### Upload

```yaml
- uses: Paratco/actions/s3-artifact/upload@v1
  with:
    name: client-linux
    path: |
      out/make/**/*.zip
      out/make/**/*.deb
      !out/make/**/*-debug.zip
    if-no-files-found: error
    endpoint: ${{ vars.S3_ENDPOINT }}
    bucket: ${{ vars.S3_BUCKET }}
    access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

| Input | Default | |
|---|---|---|
| `name` | `artifact` | No slashes. |
| `path` | | Files, directories or globs, one per line; `!` excludes. Layout is kept relative to the files' common ancestor, as upload-artifact does. |
| `if-no-files-found` | `warn` | `warn`, `error` or `ignore` |
| `overwrite` | `false` | Replace an artifact of the same name instead of failing. |
| `prefix` | `<owner>/<repo>/<run_id>` | |

Outputs: `artifact-prefix`, `artifact-size` (bytes).

### Download

```yaml
- uses: Paratco/actions/s3-artifact/download@v1
  with:
    path: artifacts          # every artifact lands in artifacts/<name>/
    endpoint: ${{ vars.S3_ENDPOINT }}
    bucket: ${{ vars.S3_BUCKET }}
    access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

| Input | Default | |
|---|---|---|
| `name` | | One artifact, extracted directly into `path`. Fails if it does not exist. |
| `pattern` | | Glob over artifact names when `name` is empty. |
| `path` | workspace | |
| `merge-multiple` | `false` | Put all selected artifacts directly into `path`. |
| `prefix` | `<owner>/<repo>/<run_id>` | Must match the upload. |

Output: `download-path`.

### Delete

```yaml
- uses: Paratco/actions/s3-artifact/delete@v1
  with:
    pattern: client-*        # or name: …; both empty deletes every artifact of the run
    endpoint: ${{ vars.S3_ENDPOINT }}
    bucket: ${{ vars.S3_BUCKET }}
    access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

Inputs: `name`, `pattern`, `fail-on-error` (default `false`), `prefix`. Output: `deleted`.

## s3-cache

Restores at the start of the job and saves in a post step at the end of it, like `actions/cache`:

- Entries are `tar` archives compressed with zstd, streamed straight between `tar` and the bucket with no temporary archive on disk.
- Members are stored relative to the workspace (`../` for paths outside it), so a cache saved on one runner restores on another whose work directory is elsewhere.
- Entries live at `<prefix>/<version>/<key>.tar.zst`, where `version` is a hash of the `path` input, so caches with the same key but different paths never mix.
- `key` is tried first, then each `restore-keys` prefix in order; the newest matching entry wins.
- Nothing is saved after an exact hit on `key`, after a failed job, or when an entry for `key` already exists.
- An unreachable bucket never fails the job: it is a miss with a warning, or with `use-fallback` a restore from GitHub's cache service. The post step saves to whichever backend the restore used.

```yaml
- uses: Paratco/actions/s3-cache@v1
  with:
    path: node_modules
    key: deps-${{ runner.os }}-${{ hashFiles('bun.lock') }}
    restore-keys: |
      deps-${{ runner.os }}-
    endpoint: ${{ vars.S3_ENDPOINT }}
    bucket: ${{ vars.S3_CACHE_BUCKET }}
    access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
```

| Input | Default | |
|---|---|---|
| `path` | | Files, directories or globs, one per line. `~` is the home directory; `!` excludes glob matches. |
| `key` | | At most 512 characters, no commas. |
| `restore-keys` | | Key prefixes, one per line. |
| `lookup-only` | `false` | Check for a hit without downloading. |
| `restore-only` | `false` | Never save (like `actions/cache/restore`). |
| `use-fallback` | `true` | Use GitHub's cache service when the bucket is unreachable. |
| `retry-count` | `3` | Retries per S3 request. |
| `prefix` | `<owner>/<repo>` | Keeps repositories sharing a bucket apart. |

Outputs: `cache-hit`, `cache-primary-key`, `cache-matched-key`, `cache-size`.

Caches are never evicted by the action. Add a lifecycle rule to the bucket (for example: expire objects 30 days after creation).

## Development

```sh
bun install
bun run typecheck
bun run build      # writes dist/, which must be committed; CI fails if it is stale
```

## Versioning

Pin a major tag (`@v1`) or a full commit SHA. Breaking changes only ship in a new major version.
