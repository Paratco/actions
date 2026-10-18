/**
 * What s3-cache's restore (main) and save (post) steps share: key layout, path resolution and the
 * tar + zstd streams to and from the bucket.
 *
 * Mirrors actions/cache where it matters:
 * - archive members are relative to the workspace (with `../` for paths outside it), so a cache
 *   saved on one runner restores on another whose work directory is somewhere else;
 * - the object key includes a version hash of the `path` input, so two caches that share a key
 *   but cache different paths never restore each other;
 * - `restore-keys` are prefixes, and the newest object matching the first one that hits wins.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { fail, getInput, getMultilineInput } from "../lib/action";

export interface CacheEntry {
  /** The cache key the entry was saved under. */
  key: string;
  objectKey: string;
  size: number;
}

/** S3 multipart part size; also bounds how much of the archive is held in memory at once. */
const PART_SIZE = 16 * 1024 * 1024;
const SUFFIX = ".tar.zst";

export function workspace(): string {
  return resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
}

export function validateKey(key: string): void {
  if (key.length > 512) {
    fail(`Key ${key.slice(0, 40)}… is longer than 512 characters`);
  }

  if (key.includes(",")) {
    fail(`Key ${key} contains a comma, which is not allowed`);
  }
}

/** Where entries live: `<prefix>/<version>/`, version being a hash of the path input. */
export function entryPrefix(paths: string[]): string {
  const prefix = getInput("prefix").replace(/^\/+|\/+$/g, "");

  if (prefix === "") {
    fail("prefix is empty");
  }

  const version = createHash("sha256").update([...paths, "tar", "zstd"].join("|")).digest("hex").slice(0, 16);

  return `${prefix}/${version}/`;
}

export function pathInput(): string[] {
  return getMultilineInput("path", { required: true });
}

/** Exact key first, then each restore key as a prefix, newest object first. */
export async function findEntry(
  s3: Bun.S3Client,
  base: string,
  key: string,
  restoreKeys: string[]
): Promise<CacheEntry | undefined> {
  const exact = `${base}${key}${SUFFIX}`;

  if (await s3.exists(exact)) {
    return { key, objectKey: exact, size: (await s3.stat(exact)).size };
  }

  for (const restoreKey of restoreKeys) {
    let best: { key: string; size: number; time: number } | undefined;
    let continuationToken: string | undefined;

    do {
      const page = await s3.list({ prefix: `${base}${restoreKey}`, continuationToken });

      for (const object of page.contents ?? []) {
        const time = Date.parse(object.lastModified ?? "") || 0;

        if (object.key.endsWith(SUFFIX) && (best === undefined || time > best.time)) {
          best = { key: object.key, size: object.size ?? 0, time };
        }
      }

      continuationToken = page.isTruncated === true ? page.nextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    if (best !== undefined) {
      return { key: best.key.slice(base.length, -SUFFIX.length), objectKey: best.key, size: best.size };
    }
  }

  return undefined;
}

export function objectKeyFor(base: string, key: string): string {
  return `${base}${key}${SUFFIX}`;
}

/**
 * Resolve the `path` input to archive members relative to the workspace: `~` expands to the home
 * directory, globs match files, and a `!` line excludes glob matches.
 */
export function resolveMembers(paths: string[]): string[] {
  const root = workspace();
  const include = new Set<string>();
  const exclude: Bun.Glob[] = [];

  for (const raw of paths) {
    let line = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;

    if (line.startsWith("!")) {
      exclude.push(new Bun.Glob(line.slice(1).trim().replaceAll("\\", "/")));
      continue;
    }

    line = line.replaceAll("\\", "/");

    if (!/[*?[\]{}]/.test(line)) {
      const full = resolve(root, line);

      if (existsSync(full)) {
        include.add(full);
      }

      continue;
    }

    const cwd = isAbsolute(line) ? parse(line).root : root;
    const glob = new Bun.Glob(isAbsolute(line) ? line.slice(cwd.length) : line);

    for (const file of glob.scanSync({ cwd, onlyFiles: true, dot: true })) {
      include.add(resolve(cwd, file));
    }
  }

  return [...include]
    .map((full) => relative(root, full).split(sep).join("/") || ".")
    .filter((member) => !exclude.some((glob) => glob.match(member)));
}

function tarBinary(): string {
  // Same reasoning as the shim: GNU tar from Git for Windows reads "C:" as a remote host.
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

  return process.platform === "win32" && existsSync(system) ? system : "tar";
}

/** tar the members, compress with zstd and stream the result into the bucket. Returns its size. */
export async function saveArchive(s3: Bun.S3Client, objectKey: string, members: string[]): Promise<number> {
  const manifest = join(tmpdir(), `s3-cache-${process.pid}-${Date.now()}.txt`);

  writeFileSync(manifest, `${members.join("\n")}\n`);

  try {
    // -P keeps the `../` of members outside the workspace, exactly as actions/cache does.
    const tar = Bun.spawn([tarBinary(), "-cf", "-", "-P", "-C", workspace(), "-T", manifest], {
      stdout: "pipe",
      stderr: "inherit"
    });
    const compressed = Readable.from(tar.stdout).pipe(
      createZstdCompress()
    );
    const writer = s3.file(objectKey).writer({ partSize: PART_SIZE, queueSize: 4 });
    let size = 0;

    for await (const chunk of compressed) {
      size += (chunk as Buffer).length;
      await writer.write(chunk as Buffer);
    }

    // Check tar before completing the upload: a multipart upload that is never completed leaves
    // no object behind, so a broken archive is never published under the key.
    const code = await tar.exited;

    if (code !== 0) {
      throw new Error(`tar exited with code ${code}`);
    }

    await writer.end();

    return size;
  } finally {
    rmSync(manifest, { force: true });
  }
}

/** Stream an entry out of the bucket, through zstd and into tar in the workspace. */
export async function restoreArchive(s3: Bun.S3Client, objectKey: string): Promise<void> {
  const tar = Bun.spawn([tarBinary(), "-xf", "-", "-P", "-C", workspace()], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit"
  });
  const decompressed = Readable.from(
    s3.file(objectKey).stream()
  ).pipe(createZstdDecompress());

  for await (const chunk of decompressed) {
    tar.stdin.write(chunk as Buffer);
    await tar.stdin.flush();
  }

  await tar.stdin.end();

  const code = await tar.exited;

  if (code !== 0) {
    throw new Error(`tar exited with code ${code}`);
  }
}
