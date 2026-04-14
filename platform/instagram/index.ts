/**
 * Instagram platform automation — public API.
 *
 * Directory layout:
 *   nav.ts             — IG_PKG, tab metadata, igGoToTab
 *   launch.ts          — igLaunch, igIsOnCreateScreen
 *   explore.ts         — Explore tab + hashtag search
 *   profile.ts         — own-profile peek
 *   warmup.ts          — runInstagram orchestrator
 *   login.ts           — runInstagramLogin
 *   follow-campaign.ts — runInstagramFollowCampaign
 *   post.ts            — runInstagramPostPublish
 *   tools/
 *     scroll-feed.ts   — ScrollFeed Tool
 *     reels.ts         — Reels Tool
 *     story-viewer.ts  — StoryViewer Tool
 *     like.ts          — Like Tool
 *     comment.ts       — Comment Tool
 *     dm.ts            — DM Tool
 *     follow.ts        — Follow Tool
 *     unfollow.ts      — Unfollow Tool
 *     share.ts         — Share Tool
 */

// Core platform primitives
export { IG_PKG, igGoToTab, igValidateHome } from "./nav.ts";
export { igLaunch, igIsOnCreateScreen } from "./launch.ts";
export { igEnumerateAccounts, igSwitchAccount } from "./switcher.ts";

// Session runners
export { runInstagram } from "./warmup.ts";
export { runInstagramLogin } from "./login.ts";
export { runInstagramFollowCampaign, type FollowCampaignConfig } from "./follow-campaign.ts";
export { runInstagramPostPublish } from "./post.ts";

// Phase-based warmup runners (2026 SOP)
export {
  runInstagramPhase,
  runInstagramPhase1,
  runInstagramPhase2,
  runInstagramPhase3,
  runInstagramPhase4,
  type WarmupPhase,
  type WarmupPhaseConfig,
} from "./warmup-phases.ts";

// Individual tools (importable standalone)
export { scrollFeedTool, type ScrollFeedConfig } from "./tools/scroll-feed.ts";
export { reelsTool, type ReelsConfig } from "./tools/reels.ts";
export { storyViewerTool, type StoryViewerConfig } from "./tools/story-viewer.ts";
export { likeTool, type LikeConfig } from "./tools/like.ts";
export { commentTool, type CommentConfig } from "./tools/comment.ts";
export { dmTool, type DMConfig } from "./tools/dm.ts";
export { followTool, type FollowConfig } from "./tools/follow.ts";
export { unfollowTool, type UnfollowConfig } from "./tools/unfollow.ts";
export { shareTool, type ShareConfig } from "./tools/share.ts";
export { saveTool, type SaveConfig } from "./tools/save.ts";
