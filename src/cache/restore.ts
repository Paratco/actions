/**
 * s3-cache main step: restore the newest matching entry from the bucket.
 *
 * Failing to reach the bucket is never fatal, as with actions/cache: it is a cache miss with a
 * warning, or with `use-fallback: true` a restore from GitHub's own cache service instead. The
 * post step reads which backend was used from state and saves to the same one.
 */
import * as ghCache from "@actions/cache";
import { ActionError, describeError, getBooleanInput, getInput, getMultilineInput, mib, run, s3Client, saveState, setOutput, warning } from "../lib/action";
import { entryPrefix, findEntry, pathInput, restoreArchive, validateKey, workspace } from "./common";

function report(primaryKey: string, matchedKey: string | undefined, size?: number): void {
  setOutput("cache-hit", matchedKey === primaryKey);
  setOutput("cache-primary-key", primaryKey);
  setOutput("cache-matched-key", matchedKey ?? "");
  setOutput("cache-size", size ?? "");
  saveState("matched-key", matchedKey ?? "");
}

async function restoreFromGitHub(paths: string[], key: string, restoreKeys: string[], lookupOnly: boolean): Promise<void> {
  saveState("backend", "github");

  if (!ghCache.isFeatureAvailable()) {
    warning("GitHub's cache service is not available to this runner either; continuing without a cache");
    report(key, undefined);

    return;
  }

  const matched = await ghCache.restoreCache(paths, key, restoreKeys, { lookupOnly });

  if (matched === undefined) {
    console.log(`Cache not found in GitHub's cache for input keys: ${[key, ...restoreKeys].join(", ")}`);
  } else {
    console.log(`Cache restored from GitHub's cache with key: ${matched}`);
  }

  report(key, matched);
}

await run(async () => {
  const key = getInput("key", { required: true });
  const restoreKeys = getMultilineInput("restore-keys");
  const paths = pathInput();
  const lookupOnly = getBooleanInput("lookup-only");
  const useFallback = getBooleanInput("use-fallback");

  for (const k of [key, ...restoreKeys]) {
    validateKey(k);
  }

  saveState("primary-key", key);

  const s3 = s3Client();
  const base = entryPrefix(paths);
  let entry;

  try {
    entry = await findEntry(s3, base, key, restoreKeys);
  } catch (error) {
    if (error instanceof ActionError) {
      throw error;
    }

    const message = describeError(error);

    if (useFallback) {
      warning(`S3 cache is unreachable (${message}); falling back to GitHub's cache`);
      await restoreFromGitHub(paths, key, restoreKeys, lookupOnly);
    } else {
      warning(`S3 cache is unreachable (${message}); continuing without a cache`);
      saveState("backend", "s3");
      report(key, undefined);
    }

    return;
  }

  saveState("backend", "s3");

  if (entry === undefined) {
    console.log(`Cache not found for input keys: ${[key, ...restoreKeys].join(", ")}`);
    report(key, undefined);

    return;
  }

  if (lookupOnly) {
    console.log(`Cache found with key: ${entry.key} (${mib(entry.size)}), not downloaded (lookup-only)`);
    report(key, entry.key, entry.size);

    return;
  }

  try {
    console.log(`Restoring ${entry.key} (${mib(entry.size)}) into ${workspace()}`);
    await restoreArchive(s3, entry.objectKey);
  } catch (error) {
    warning(`Restoring the cache failed (${describeError(error)}); continuing without it`);
    report(key, undefined);

    return;
  }

  console.log(`✅ Cache restored from key: ${entry.key}`);
  report(key, entry.key, entry.size);
});
