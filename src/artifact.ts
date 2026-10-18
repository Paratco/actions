/**
 * s3-artifact/upload, s3-artifact/download and s3-artifact/delete.
 *
 * Artifacts are stored as `<prefix>/<name>/<relative path>` in any S3-compatible bucket, with the
 * same input names and file layout rules as actions/upload-artifact and download-artifact.
 *
 *   bun artifact.js upload | download | delete
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fail, getBooleanInput, getInput, mib, run, s3Client, setOutput, warning } from "./lib/action";

interface StoredObject {
  key: string;
  size: number;
}

// Created inside run() so a missing connection input is reported like any other failure.
let s3: Bun.S3Client;

function runPrefix(): string {
  const value = getInput("prefix").replace(/^\/+|\/+$/g, "");

  if (value === "") {
    fail("prefix is empty");
  }

  return `${value}/`;
}

function validateName(name: string): void {
  if (name === "" || name.includes("/") || name.includes("\\")) {
    fail(`Invalid artifact name "${name}": it must be non-empty and contain no slashes`);
  }
}

async function list(keyPrefix: string): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.list({ prefix: keyPrefix, continuationToken });

    for (const object of page.contents ?? []) {
      objects.push({ key: object.key, size: object.size ?? 0 });
    }

    continuationToken = page.isTruncated === true ? page.nextContinuationToken : undefined;
  } while (continuationToken !== undefined);

  return objects;
}

/** Artifact names under the run prefix, mapped to their objects. */
async function artifacts(prefix: string): Promise<Map<string, StoredObject[]>> {
  const byName = new Map<string, StoredObject[]>();

  for (const object of await list(prefix)) {
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf("/");

    if (slash <= 0) {
      continue;
    }

    const name = rest.slice(0, slash);
    const group = byName.get(name) ?? [];

    group.push(object);
    byName.set(name, group);
  }

  return byName;
}

/** Artifacts picked by the `name` or `pattern` input, as download-artifact does. */
function select(all: Map<string, StoredObject[]>, name: string, pattern: string): [string, StoredObject[]][] {
  if (name !== "") {
    const objects = all.get(name);

    return objects === undefined ? [] : [[name, objects]];
  }

  const glob = pattern === "" ? undefined : new Bun.Glob(pattern);

  return [...all].filter(([artifact]) => glob === undefined || glob.match(artifact));
}

/**
 * Resolve upload-artifact style `path` input: one entry per line, globs allowed, a directory means
 * everything under it, and a leading `!` excludes matches.
 */
function resolveFiles(spec: string): string[] {
  const include = new Set<string>();
  const exclude: Bun.Glob[] = [];

  for (const raw of spec.split(/\r?\n/)) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("!")) {
      exclude.push(new Bun.Glob(line.slice(1).trim()));
      continue;
    }

    const literal = !/[*?[\]{}]/.test(line);

    if (literal && existsSync(line) && statSync(line).isFile()) {
      include.add(resolve(line));
      continue;
    }

    // Bun.Glob matches relative to a cwd, so an absolute pattern scans from its filesystem root
    // (`/` or `C:\`). Globs always use forward slashes, Windows included.
    const pattern = (literal ? `${line.replace(/[\\/]+$/, "")}/**/*` : line).replaceAll("\\", "/");
    const cwd = isAbsolute(pattern) ? parse(pattern).root : process.cwd();
    const glob = new Bun.Glob(isAbsolute(pattern) ? pattern.slice(cwd.length) : pattern);

    for (const file of glob.scanSync({ cwd, onlyFiles: true, dot: true })) {
      include.add(resolve(cwd, file));
    }
  }

  return [...include].filter((file) => {
    const rel = relative(process.cwd(), file).split(sep).join("/");

    return !exclude.some((glob) => glob.match(rel) || glob.match(file));
  });
}

/** upload-artifact keeps the layout relative to the least common ancestor of all matched files. */
function commonRoot(files: string[]): string {
  const split = files.map((file) => dirname(file).split(sep));
  const first = split[0] ?? [];
  let length = first.length;

  for (const parts of split) {
    let i = 0;

    while (i < length && parts[i] === first[i]) {
      i++;
    }

    length = i;
  }

  // A lone "" (POSIX root) or "C:" (Windows drive) must stay a root, not become a relative path.
  return length <= 1 ? parse(files[0] ?? sep).root : first.slice(0, length).join(sep);
}

async function upload(): Promise<void> {
  const prefix = runPrefix();
  const name = getInput("name") || "artifact";
  const spec = getInput("path", { required: true });
  const ifNoFilesFound = getInput("if-no-files-found") || "warn";

  validateName(name);

  const files = resolveFiles(spec);

  if (files.length === 0) {
    const message = `No files were found with the provided path: ${spec}`;

    if (ifNoFilesFound === "error") {
      fail(message);
    }

    if (ifNoFilesFound === "ignore") {
      console.log(message);
    } else {
      warning(message);
    }

    return;
  }

  const namePrefix = `${prefix}${name}/`;
  const existing = await list(namePrefix);

  if (existing.length > 0) {
    if (!getBooleanInput("overwrite")) {
      fail(`An artifact named "${name}" already exists under ${prefix} — set overwrite: true to replace it`);
    }

    for (const { key } of existing) {
      await s3.delete(key);
    }
  }

  const root = commonRoot(files);
  let total = 0;

  for (const file of files) {
    const key = namePrefix + relative(root, file).split(sep).join("/");
    const size = await s3.write(key, Bun.file(file));

    total += size;
    console.log(`⬆️ ${key} (${mib(size)})`);
  }

  console.log(`✅ Uploaded ${files.length} file(s), ${mib(total)}, as "${name}"`);
  setOutput("artifact-prefix", namePrefix);
  setOutput("artifact-size", total);
}

async function download(): Promise<void> {
  const prefix = runPrefix();
  const name = getInput("name");
  const target = resolve(getInput("path") || ".");
  const selected = select(await artifacts(prefix), name, getInput("pattern"));

  if (name !== "" && selected.length === 0) {
    fail(`Artifact not found: "${name}" under ${prefix}`);
  }

  // Same layout rules as download-artifact: a single named artifact (or merge-multiple) lands
  // directly in `path`, otherwise each artifact gets its own `path/<name>/` directory.
  const flat = name !== "" || getBooleanInput("merge-multiple");

  for (const [artifact, objects] of selected) {
    for (const { key, size } of objects) {
      const rel = key.slice(`${prefix}${artifact}/`.length);
      const dest = flat ? join(target, rel) : join(target, artifact, rel);

      await Bun.write(dest, s3.file(key));
      console.log(`⬇️ ${dest} (${mib(size)})`);
    }
  }

  console.log(`✅ Downloaded ${selected.length} artifact(s) to ${target}`);
  setOutput("download-path", target);
}

async function remove(): Promise<void> {
  const prefix = runPrefix();
  const name = getInput("name");
  const selected = select(await artifacts(prefix), name, getInput("pattern"));

  if (name !== "" && selected.length === 0 && getBooleanInput("fail-on-error")) {
    fail(`Artifact not found: "${name}" under ${prefix}`);
  }

  let count = 0;

  for (const [, objects] of selected) {
    for (const { key } of objects) {
      await s3.delete(key);
      count++;
    }
  }

  console.log(`🧹 Deleted ${selected.length} artifact(s), ${count} object(s), under ${prefix}`);
  setOutput("deleted", selected.length);
}

const commands: Record<string, () => Promise<void>> = { upload, download, delete: remove };
const command = commands[process.argv[2] ?? ""];

await run(async () => {
  if (command === undefined) {
    fail("usage: artifact.js <upload|download|delete>");
  }

  s3 = s3Client();
  await command();
});
