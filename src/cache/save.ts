/**
 * s3-cache post step: save the paths under the primary key, unless the restore was an exact hit.
 *
 * Saves go to whichever backend the restore used (state "backend"). A failed save is a warning,
 * never a failed job, as with actions/cache.
 */
import * as ghCache from "@actions/cache";
import { ActionError, describeError, getBooleanInput, getInput, getState, mib, run, s3Client, warning } from "../lib/action";
import { entryPrefix, objectKeyFor, pathInput, resolveMembers, saveArchive } from "./common";

async function saveToGitHub(paths: string[], key: string): Promise<void> {
  if (!ghCache.isFeatureAvailable()) {
    warning("GitHub's cache service is not available to this runner; cache not saved");

    return;
  }

  await ghCache.saveCache(paths, key);
  console.log(`✅ Cache saved to GitHub's cache with key: ${key}`);
}

await run(async () => {
  if (getBooleanInput("restore-only")) {
    console.log("restore-only is set; not saving the cache");

    return;
  }

  const key = getState("primary-key") || getInput("key", { required: true });

  if (getState("matched-key") === key) {
    console.log(`Cache hit occurred on the primary key ${key}, not saving cache.`);

    return;
  }

  const paths = pathInput();

  try {
    if (getState("backend") === "github") {
      await saveToGitHub(paths, key);

      return;
    }

    const members = resolveMembers(paths);

    if (members.length === 0) {
      warning("Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.");

      return;
    }

    const s3 = s3Client();
    const objectKey = objectKeyFor(entryPrefix(paths), key);

    try {
      if (await s3.exists(objectKey)) {
        console.log(`Cache already exists for key ${key} (saved by another job); not saving`);

        return;
      }

      const size = await saveArchive(s3, objectKey, members);

      console.log(`✅ Cache saved with key: ${key} (${mib(size)})`);
    } catch (error) {
      if (error instanceof ActionError || !getBooleanInput("use-fallback")) {
        throw error;
      }

      warning(`Saving to S3 failed (${describeError(error)}); falling back to GitHub's cache`);
      await saveToGitHub(paths, key);
    }
  } catch (error) {
    warning(`Failed to save cache: ${describeError(error)}`);
  }
});
