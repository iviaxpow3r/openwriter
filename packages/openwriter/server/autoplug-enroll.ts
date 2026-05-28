/**
 * Manual-post → autoplug enrollment bridge.
 *
 * API/scheduler posts enter the platform's autoplug tracking at post time
 * (the platform calls autoTrackTweet on /connections/:id/post, post-thread,
 * the scheduler cron, and on POST /publications). Manual posts only ever
 * wrote local `tweetContext.lastPost` frontmatter and never told the platform,
 * so they never enrolled — and quote tweets, which the X API cannot post and
 * therefore ALWAYS go through manual mark-sent, could never be autoplug-tracked.
 *
 * This reconciles the two: when a tweet/article doc is marked posted with a
 * tweet URL, we record a publication on the platform. The platform's
 * POST /publications handler enrolls X publications into autoplug tracking,
 * so engagement-threshold autoplugs now fire on manually-posted tweets the
 * same way they do for API/scheduler posts.
 */

import { isAuthenticated, platformFetch } from './connections.js';

const TWEET_ID_RE = /(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i;

/** Pull the numeric tweet id out of an x.com / twitter.com status URL. */
export function extractTweetId(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = TWEET_ID_RE.exec(url);
  return m ? m[1] : null;
}

/**
 * Enroll a manually-posted tweet into platform autoplug tracking.
 *
 * Best-effort and idempotent: skips when the tweet is already recorded as a
 * publication for this doc, so re-marking, unmark/remark, and autosave churn
 * never duplicate the enrollment. Never throws — enrollment must never block
 * or break the mark-sent metadata write.
 */
export async function enrollManualPostForAutoplug(
  docId: string,
  tweetUrl: string,
  text: string,
): Promise<void> {
  if (!isAuthenticated()) return;

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) return;

  try {
    // Idempotency: the platform's publications table has no unique constraint,
    // so dedupe here before recording another row + re-enrolling.
    const existingRes = await platformFetch(`/publications?documentId=${encodeURIComponent(docId)}`);
    if (existingRes.ok) {
      const data = await existingRes.json() as {
        publications?: Array<{ platform?: string; external_id?: string }>;
      };
      const already = (data.publications || []).some(
        (p) => p.platform === 'x' && p.external_id === tweetId,
      );
      if (already) return;
    }

    // Recording the publication triggers autoTrackTweet platform-side, which
    // enrolls the tweet for autoplug rule evaluation (guarded there by the
    // profile having ≥1 enabled goal + an active X connection).
    const res = await platformFetch('/publications', {
      method: 'POST',
      body: JSON.stringify({
        document_id: docId,
        platform: 'x',
        external_id: tweetId,
        url: tweetUrl,
        meta: { text: text || '', last_tweet_id: tweetId },
      }),
    });

    if (res.ok) {
      console.log(`[Autoplug] Enrolled manual post ${tweetId} (doc ${docId}) into tracking`);
    }
  } catch {
    // Best-effort: platform may be unreachable / unauthenticated. Mark-sent
    // already succeeded locally; tracking simply won't enroll this time.
  }
}
