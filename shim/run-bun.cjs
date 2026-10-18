// Entry shim shared by every action in this repo.
//
// GitHub only runs JavaScript actions on Node, but the actions are written for Bun (its S3 client,
// globbing and zstd streams). So each action's main/post is a two-line file that calls this: it
// fetches a pinned Bun into the runner's tool cache (once per runner and version) and runs the
// bundled script with it. Same idea as jcbhmr/configure-bun-action, without committing Bun
// binaries into the repo.
//
// Bun comes from the npm registry's @oven/bun-<platform> packages: they are .tgz archives, which
// plain `tar` unpacks on Linux, macOS and Windows alike, and the registry publishes a SHA-512 for
// each one that is verified before anything is extracted.
//
// Kept dependency-free and in CommonJS on purpose: it runs before Bun exists, straight from source.
"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUN_VERSION = "1.4.2";

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function isMusl() {
  if (process.platform !== "linux") {
    return false;
  }

  const report = process.report && process.report.getReport();

  return !(report && report.header && report.header.glibcVersionRuntime);
}

/** The @oven/bun-<target> package for this runner. x64 uses baseline builds: no AVX2 required. */
function bunTarget() {
  const arch = { x64: "x64", arm64: "aarch64" }[process.arch];

  if (arch === undefined) {
    fail(`Unsupported runner architecture: ${process.arch}`);
  }

  const baseline = arch === "x64" ? "-baseline" : "";

  switch (process.platform) {
    case "linux":
      return `linux-${arch}${isMusl() ? "-musl" : ""}${baseline}`;
    case "darwin":
      return `darwin-${arch}${baseline}`;
    case "win32":
      return `windows-${arch}${baseline}`;
    default:
      return fail(`Unsupported runner OS: ${process.platform}`);
  }
}

function tarBinary() {
  // Git for Windows puts GNU tar first on PATH, and GNU tar reads "C:" as a remote host. The
  // bsdtar that ships with Windows handles both .tgz and drive letters.
  const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

  return process.platform === "win32" && fs.existsSync(system) ? system : "tar";
}

async function download(target, dir) {
  const pkg = `@oven/bun-${target}`;
  const meta = await fetch(`https://registry.npmjs.org/${pkg}/${BUN_VERSION}`);

  if (!meta.ok) {
    fail(`Could not look up ${pkg}@${BUN_VERSION}: HTTP ${meta.status}`);
  }

  const { dist } = await meta.json();
  const res = await fetch(dist.tarball);

  if (!res.ok) {
    fail(`Could not download ${dist.tarball}: HTTP ${res.status}`);
  }

  const data = Buffer.from(await res.arrayBuffer());
  const [algorithm, expected] = String(dist.integrity).split("-", 2);
  const actual = createHash(algorithm).update(data).digest("base64");

  if (actual !== expected) {
    fail(`Integrity check failed for ${dist.tarball}`);
  }

  // Extract into a private directory and rename it into place, so two runners sharing a tool
  // cache never see a half-written Bun.
  const staging = `${dir}.tmp-${process.pid}`;

  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "bun.tgz"), data);

  const tar = spawnSync(tarBinary(), ["-xzf", "bun.tgz"], { cwd: staging, stdio: "inherit" });

  if (tar.status !== 0) {
    fail(`Extracting ${dist.tarball} failed`);
  }

  fs.rmSync(path.join(staging, "bun.tgz"));

  try {
    fs.renameSync(staging, dir);
  } catch (error) {
    // Lost the race to another runner: theirs is just as good.
    fs.rmSync(staging, { recursive: true, force: true });

    if (!fs.existsSync(dir)) {
      throw error;
    }
  }
}

async function ensureBun() {
  const target = bunTarget();
  const root = process.env.RUNNER_TOOL_CACHE || os.tmpdir();
  const dir = path.join(root, "paratco-actions-bun", BUN_VERSION, target);
  const exe = path.join(dir, "package", "bin", process.platform === "win32" ? "bun.exe" : "bun");

  if (!fs.existsSync(exe)) {
    console.log(`Fetching Bun ${BUN_VERSION} (${target})`);
    await download(target, dir);
    fs.chmodSync(exe, 0o755);
  }

  return exe;
}

/** Run a bundled script under the pinned Bun, forwarding its exit code. */
module.exports = async function run(script, args = []) {
  const bun = await ensureBun();
  const env = { ...process.env };

  // Set before Bun starts rather than from inside the script, so every TLS connection it makes
  // sees it.
  if ((process.env["INPUT_SKIP-TLS-VERIFY"] || "").toLowerCase() === "true") {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const result = spawnSync(bun, [script, ...args], { stdio: "inherit", env });

  if (result.error) {
    fail(`Could not start Bun: ${result.error.message}`);
  }

  process.exitCode = result.status === null ? 1 : result.status;
};
