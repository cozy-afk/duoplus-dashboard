/**
 * Instagram — Own profile peek.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import { safe } from "../../human.ts";
import { igGoToTab } from "./nav.ts";

export async function igOwnProfile(c: Ctx): Promise<void> {
  await safe(c, "own profile peek", async () => {
    await igGoToTab(c, "profile");
    c.stats.own_profile_views++;
    await sleep(randint(3000, 6500));
  });
}
