/**
 * Instagram — Post Publish
 * Opens Create → Post, selects media, and sets caption.
 * Media selection via adb push is a pending TODO.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { safe } from "../../human.ts";
import { igLaunch } from "./launch.ts";

export async function runInstagramPostPublish(
  ctx: Ctx,
  post: {
    id: number;
    caption: string | null;
    media_urls?: string[];
  },
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  await safe(ctx, `post #${post.id}`, async () => {
    if (!(await ctx.driver.tapByDesc("Create"))) {
      ctx.log("warn", "Create button not found");
      return;
    }
    await sleep(randint(2500, 4500));
    await ctx.driver.tapByText("Post");
    await sleep(randint(1500, 3000));
    ctx.log("warn", "  media selection step is a TODO (needs adb push wiring)");
    if (post.caption) {
      ctx.log("info", `  would paste caption (${post.caption.length} chars)`);
    }
  });

  try { await ctx.driver.pressHome(); } catch {}
  return ctx.stats;
}
