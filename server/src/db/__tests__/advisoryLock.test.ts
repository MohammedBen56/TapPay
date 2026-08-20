import { afterAll, describe, expect, it } from "vitest";
import { withAdvisoryLock } from "../advisoryLock.js";
import { db } from "../kysely.js";

// A key distinct from the app's own SWEEPER_/TRIPWIRE_ADVISORY_LOCK_KEY
// constants -- this test's own lock must never collide with a real sweeper/
// tripwire tick that might also be running against the same database.
const TEST_LOCK_KEY = 999_999_001;

describe("withAdvisoryLock", () => {
  it("only one concurrent caller acquires the same key; it releases once that caller's transaction ends", async () => {
    let releaseFirst: (() => void) | undefined;
    const holdUntilReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = withAdvisoryLock(db, TEST_LOCK_KEY, async () => {
      await holdUntilReleased; // keeps the transaction -- and the lock -- open
      return "first";
    });

    // Give the first call's transaction time to actually issue
    // pg_try_advisory_xact_lock before the second one races it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await withAdvisoryLock(db, TEST_LOCK_KEY, async () => "second");
    expect(second).toBeNull(); // lock still held by the first, in-flight caller

    releaseFirst?.();
    const first = await firstPromise;
    expect(first).toBe("first");

    // Released with the first call's transaction (commit) -- a fresh call
    // now succeeds.
    const third = await withAdvisoryLock(db, TEST_LOCK_KEY, async () => "third");
    expect(third).toBe("third");
  }, 10_000);

  it("a distinct key is never blocked by another key's held lock", async () => {
    let releaseFirst: (() => void) | undefined;
    const holdUntilReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = withAdvisoryLock(db, TEST_LOCK_KEY, async () => {
      await holdUntilReleased;
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const other = await withAdvisoryLock(db, TEST_LOCK_KEY + 1, async () => "unrelated key");
    expect(other).toBe("unrelated key");

    releaseFirst?.();
    await firstPromise;
  }, 10_000);
});

afterAll(async () => {
  await db.destroy();
});
