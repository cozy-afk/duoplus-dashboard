/**
 * Instagram — Story Viewer Tool
 *
 * Picks a story from another user in the tray (never the account's own slot)
 * and watches a configurable number of stories, with Create-screen guards.
 */

import { sleep, randint, roll } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, expired } from "../../../human.ts";
import { igIsOnCreateScreen } from "../launch.ts";
import { igGoToTab } from "../nav.ts";

export interface StoryViewerConfig {
  /** Number of stories to watch. Defaults to quota range. */
  count?: number;
  /** If set, open this specific username's stories (navigates to their profile first). */
  targetUsername?: string;
}

/**
 * Pick a story tray slot belonging to someone else.
 * Rejects descs starting with "Your "/"Add " and rejects the leftmost 22% of
 * the screen (always the account's own slot).
 */
async function pickOtherUserStory(
  driver: { dumpUi(): Promise<string>; screenSize(): Promise<{ width: number; height: number }> },
  xml?: string,
): Promise<{ x: number; y: number; desc: string } | null> {
  const x = xml ?? (await driver.dumpUi());
  const { width } = await driver.screenSize();
  const leftmostLimit = Math.floor(width * 0.22);
  const re = /<node[^/]*?content-desc="([^"]*?'s story[^"]*)"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/gi;
  const candidates: Array<{ x: number; y: number; desc: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const desc = m[1];
    if (/^(Your|Add) /i.test(desc)) continue;
    const cx = Math.floor((+m[2] + +m[4]) / 2);
    const cy = Math.floor((+m[3] + +m[5]) / 2);
    if (cx < leftmostLimit) continue;
    candidates.push({ x: cx, y: cy, desc });
  }
  if (candidates.length === 0) return null;
  return candidates[randint(0, candidates.length - 1)];
}

async function bailFromCreateScreen(c: Ctx, context: string): Promise<void> {
  c.log("warn", `  [IG:story-viewer] ⚠ ${context} — pressing Back to exit`);
  await c.driver.pressBack();
  await sleep(randint(900, 1700));
  if (await igIsOnCreateScreen(c.driver)) {
    await c.driver.pressBack();
    await sleep(randint(900, 1500));
  }
}

export async function storyViewerTool(c: Ctx, config: StoryViewerConfig = {}): Promise<void> {
  const count = config.count ?? randint(c.quota.stories_min, c.quota.stories_max);
  if (count <= 0) return;
  c.log("info", `  [IG:story-viewer] × ${count}`);

  await safe(c, "stories", async () => {
    // Stories tray is ONLY on the Home tab. Make sure we're there.
    await igGoToTab(c, "home");
    await sleep(randint(1800, 3200));

    // Story tray sits at the top of the feed — scroll up hard so we see it
    // even if the feed scrolled down in an earlier section. Multiple swipe-
    // downs are the cheapest way to reach feed-top regardless of position.
    let target = await pickOtherUserStory(c.driver);
    if (!target) {
      c.log("info", "  [IG:story-viewer] tray not visible — scrolling to feed top");
      for (let i = 0; i < 3 && !target; i++) {
        await c.driver.swipeDown();
        await sleep(randint(900, 1500));
        target = await pickOtherUserStory(c.driver);
      }
    }
    if (!target) {
      c.log("info", "  [IG:story-viewer] no other-user stories in tray after scroll-up — skipping");
      return;
    }
    c.log("info", `  [IG:story-viewer] opening: ${target.desc.slice(0, 48)}`);
    await c.driver.tap(target.x, target.y, 1, "deliberate");
    await sleep(randint(2000, 3200));

    if (await igIsOnCreateScreen(c.driver)) {
      await bailFromCreateScreen(c, "landed on Create-story screen");
      return;
    }

    const size = await c.driver.screenSize();
    for (let i = 0; i < count; i++) {
      if (expired(c)) { c.stats.hit_deadline = true; return; }

      const r = Math.random();
      const watchMs =
        r < 0.45 ? randint(2500, 5000) :
        r < 0.85 ? randint(6000, 11000) :
                   randint(13000, 22000);
      // Suppress headroom must cover the watch + the bail recovery path
      // (pressBack + sleep + igIsOnCreateScreen dump + maybe a 2nd back),
      // worst case ~6s on top of watchMs. Previously was +2500 which let
      // the watchdog fire mid-bail and trigger a false-positive recovery.
      c.watchdog?.suppress(watchMs + 8000);
      await sleep(watchMs);

      // Periodic drift check BEFORE counting the view — if we drifted into
      // the Create screen, the watch didn't actually happen on a story.
      if (i > 0 && i % 2 === 0 && await igIsOnCreateScreen(c.driver)) {
        await bailFromCreateScreen(c, "drifted into Create screen mid-stories");
        return;
      }
      c.stats.stories_viewed++;

      if (roll(82)) {
        await c.driver.tap(
          Math.floor(size.width * randint(70, 92) / 100),
          Math.floor(size.height * randint(40, 60) / 100),
          0,
        );
      } else {
        await c.driver.swipeLeft();
      }
    }

    if (roll(65)) await c.driver.swipeDown();
    else await c.driver.pressBack();
    await sleep(randint(1600, 3200));

    if (await igIsOnCreateScreen(c.driver)) {
      await bailFromCreateScreen(c, "exited stories into Create screen");
    }
  });
}
