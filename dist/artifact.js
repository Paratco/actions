// @bun
// src/artifact.ts
import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";

// src/lib/action.ts
import { appendFileSync } from "fs";

class ActionError extends Error {
}
function fail(message) {
  throw new ActionError(message);
}
function warning(message) {
  console.log(`::warning::${message}`);
}
function getInput(name, options = {}) {
  const value = (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (options.required === true && value === "") {
    fail(`Input required and not supplied: ${name}`);
  }
  return value;
}
function getBooleanInput(name) {
  const value = getInput(name).toLowerCase();
  if (value !== "" && value !== "true" && value !== "false") {
    fail(`Input ${name} must be true or false, got "${value}"`);
  }
  return value === "true";
}
function getMultilineInput(name, options = {}) {
  return getInput(name, options).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}
function appendCommandFile(variable, name, value) {
  const file = process.env[variable];
  if (file === undefined || file === "") {
    return;
  }
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function setOutput(name, value) {
  appendCommandFile("GITHUB_OUTPUT", name, String(value));
}
function saveState(name, value) {
  appendCommandFile("GITHUB_STATE", name, value);
}
function getState(name) {
  return process.env[`STATE_${name}`] ?? "";
}
function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = error.code;
  return typeof code === "string" && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
}
function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function s3Client() {
  const endpoint = getInput("endpoint", { required: true });
  if (!/^https?:\/\//.test(endpoint)) {
    fail(`endpoint must start with http:// or https://, got: ${endpoint}`);
  }
  const retry = Number(getInput("retry-count") || "0");
  return new Bun.S3Client({
    endpoint,
    bucket: getInput("bucket", { required: true }),
    region: getInput("region") || "us-east-1",
    accessKeyId: getInput("access-key-id", { required: true }),
    secretAccessKey: getInput("secret-access-key", { required: true }),
    retry: Number.isInteger(retry) && retry > 0 ? retry : 0
  });
}
async function run(body) {
  try {
    await body();
  } catch (error) {
    const message = describeError(error);
    console.log(`::error::${message}`);
    if (!(error instanceof ActionError) && error instanceof Error && error.stack !== undefined) {
      console.log(error.stack);
    }
    process.exitCode = 1;
  }
}

// src/artifact.ts
var s3;
function runPrefix() {
  const value = getInput("prefix").replace(/^\/+|\/+$/g, "");
  if (value === "") {
    fail("prefix is empty");
  }
  return `${value}/`;
}
function validateName(name) {
  if (name === "" || name.includes("/") || name.includes("\\")) {
    fail(`Invalid artifact name "${name}": it must be non-empty and contain no slashes`);
  }
}
async function list(keyPrefix) {
  const objects = [];
  let continuationToken;
  do {
    const page = await s3.list({ prefix: keyPrefix, continuationToken });
    for (const object of page.contents ?? []) {
      objects.push({ key: object.key, size: object.size ?? 0 });
    }
    continuationToken = page.isTruncated === true ? page.nextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return objects;
}
async function artifacts(prefix) {
  const byName = new Map;
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
function select(all, name, pattern) {
  if (name !== "") {
    const objects = all.get(name);
    return objects === undefined ? [] : [[name, objects]];
  }
  const glob = pattern === "" ? undefined : new Bun.Glob(pattern);
  return [...all].filter(([artifact]) => glob === undefined || glob.match(artifact));
}
function resolveFiles(spec) {
  const include = new Set;
  const exclude = [];
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
function commonRoot(files) {
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
  return length <= 1 ? parse(files[0] ?? sep).root : first.slice(0, length).join(sep);
}
async function upload() {
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
      fail(`An artifact named "${name}" already exists under ${prefix} \u2014 set overwrite: true to replace it`);
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
    console.log(`\u2B06\uFE0F ${key} (${mib(size)})`);
  }
  console.log(`\u2705 Uploaded ${files.length} file(s), ${mib(total)}, as "${name}"`);
  setOutput("artifact-prefix", namePrefix);
  setOutput("artifact-size", total);
}
async function download() {
  const prefix = runPrefix();
  const name = getInput("name");
  const target = resolve(getInput("path") || ".");
  const selected = select(await artifacts(prefix), name, getInput("pattern"));
  if (name !== "" && selected.length === 0) {
    fail(`Artifact not found: "${name}" under ${prefix}`);
  }
  const flat = name !== "" || getBooleanInput("merge-multiple");
  for (const [artifact, objects] of selected) {
    for (const { key, size } of objects) {
      const rel = key.slice(`${prefix}${artifact}/`.length);
      const dest = flat ? join(target, rel) : join(target, artifact, rel);
      await Bun.write(dest, s3.file(key));
      console.log(`\u2B07\uFE0F ${dest} (${mib(size)})`);
    }
  }
  console.log(`\u2705 Downloaded ${selected.length} artifact(s) to ${target}`);
  setOutput("download-path", target);
}
async function remove() {
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
  console.log(`\uD83E\uDDF9 Deleted ${selected.length} artifact(s), ${count} object(s), under ${prefix}`);
  setOutput("deleted", selected.length);
}
var commands = { upload, download, delete: remove };
var command = commands[process.argv[2] ?? ""];
await run(async () => {
  if (command === undefined) {
    fail("usage: artifact.js <upload|download|delete>");
  }
  s3 = s3Client();
  await command();
});
