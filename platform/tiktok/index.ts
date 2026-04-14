/**
 * TikTok platform automation — public API.
 *
 * Directory layout:
 *   constants.ts  — TIKTOK_PKG
 *   launch.ts     — app launch + feed-gate detection
 *   warmup.ts     — runTiktok orchestrator
 *   tools/
 *     scroll-feed.ts — ScrollFeed Tool (For You feed)
 *     like.ts        — Like Tool
 *     comment.ts     — Comment Tool
 *     dm.ts          — DM Tool
 *     follow.ts      — Follow Tool
 *     unfollow.ts    — Unfollow Tool
 *     share.ts       — Share Tool
 */

// Core platform primitives
export { TIKTOK_PKG } from "./constants.ts";
export { tiktokLaunch } from "./launch.ts";
export { tiktokValidateHome, tiktokTapHome } from "./nav.ts";
export { tiktokEnumerateAccounts, tiktokSwitchAccount } from "./switcher.ts";

// Session runners
export { runTiktok } from "./warmup.ts";

// Phase-based warmup runners (2026 SOP)
export {
  runTiktokPhase,
  runTiktokPhase1,
  runTiktokPhase2,
  runTiktokPhase3,
  runTiktokPhase4,
  type TikTokWarmupPhase,
  type TikTokWarmupPhaseConfig,
} from "./warmup-phases.ts";

// Individual tools
export { scrollFeedTool, type TikTokScrollFeedConfig } from "./tools/scroll-feed.ts";
export { likeTool, type TikTokLikeConfig } from "./tools/like.ts";
export { commentTool, type TikTokCommentConfig } from "./tools/comment.ts";
export { dmTool, type TikTokDMConfig } from "./tools/dm.ts";
export { followTool, type TikTokFollowConfig } from "./tools/follow.ts";
export { unfollowTool, type TikTokUnfollowConfig } from "./tools/unfollow.ts";
export { shareTool, type TikTokShareConfig } from "./tools/share.ts";
