/**
 * Threads platform automation — public API.
 *
 * Directory layout:
 *   nav.ts      — THREADS_PKG, tab metadata, threadsGoToTab
 *   warmup.ts   — runThreads orchestrator
 *   login.ts    — runThreadsLogin
 *   tools/
 *     scroll-feed.ts — ScrollFeed Tool
 *     like.ts        — Like Tool
 *     comment.ts     — Comment Tool
 *     dm.ts          — DM Tool
 *     follow.ts      — Follow Tool
 *     unfollow.ts    — Unfollow Tool
 *     share.ts       — Share Tool
 */

// Core platform primitives
export { THREADS_PKG, threadsGoToTab, threadsValidateHome } from "./nav.ts";
export { threadsEnumerateAccounts, threadsSwitchAccount } from "./switcher.ts";

// Session runners
export { runThreads } from "./warmup.ts";
export { runThreadsLogin } from "./login.ts";

// Individual tools (importable standalone)
export { scrollFeedTool, type ThreadsScrollFeedConfig } from "./tools/scroll-feed.ts";
export { likeTool, type ThreadsLikeConfig } from "./tools/like.ts";
export { commentTool, type ThreadsCommentConfig } from "./tools/comment.ts";
export { dmTool, type ThreadsDMConfig } from "./tools/dm.ts";
export { followTool, type ThreadsFollowConfig } from "./tools/follow.ts";
export { unfollowTool, type ThreadsUnfollowConfig } from "./tools/unfollow.ts";
export { shareTool, type ThreadsShareConfig } from "./tools/share.ts";
