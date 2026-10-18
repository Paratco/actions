/**
 * The slice of @actions/core these actions need, without the dependency: inputs, outputs, state
 * shared between main and post, and annotations. Also builds the S3 client every action shares.
 */
import { appendFileSync } from "node:fs";

/** A failure the action reports as an error annotation and exits non-zero on. */
export class ActionError extends Error {}

export function fail(message: string): never {
  throw new ActionError(message);
}

export function warning(message: string): void {
  console.log(`::warning::${message}`);
}

/** The runner passes `with:` values as INPUT_<NAME>, upper-cased with spaces as underscores. */
export function getInput(name: string, options: { required?: boolean } = {}): string {
  const value = (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();

  if (options.required === true && value === "") {
    fail(`Input required and not supplied: ${name}`);
  }

  return value;
}

export function getBooleanInput(name: string): boolean {
  const value = getInput(name).toLowerCase();

  if (value !== "" && value !== "true" && value !== "false") {
    fail(`Input ${name} must be true or false, got "${value}"`);
  }

  return value === "true";
}

/** Non-empty, trimmed lines of a multi-line input. */
export function getMultilineInput(name: string, options: { required?: boolean } = {}): string[] {
  return getInput(name, options)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function appendCommandFile(variable: string, name: string, value: string): void {
  const file = process.env[variable];

  if (file === undefined || file === "") {
    return;
  }

  // The heredoc form is safe for any value, multi-line included.
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;

  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function setOutput(name: string, value: string | number | boolean): void {
  appendCommandFile("GITHUB_OUTPUT", name, String(value));
}

/** Pass a value from a main step to its post step. */
export function saveState(name: string, value: string): void {
  appendCommandFile("GITHUB_STATE", name, value);
}

export function getState(name: string): string {
  return process.env[`STATE_${name}`] ?? "";
}

/** Error text for logs. Bun's network errors carry the useful part in `code` (ConnectionRefused…). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
}

export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** S3 client from the connection inputs every action shares. */
export function s3Client(): Bun.S3Client {
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

/** Run an action body, turning failures into an error annotation and a non-zero exit. */
export async function run(body: () => Promise<void>): Promise<void> {
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
