/**
 * Unit test for the manual-post → autoplug enrollment bridge.
 *
 * Bug pattern this protects against:
 *   Manually-posted tweets (esp. quote tweets, which the X API can't post and
 *   so ALWAYS go through "mark sent") wrote local `tweetContext.lastPost`
 *   frontmatter but never told the platform, so they never enrolled into
 *   autoplug tracking. Engagement-threshold autoplugs therefore never fired
 *   on manual posts, silently zeroing the quote-tweet → newsletter funnel.
 *
 * Fix verified here (openwriter-side half):
 *   - extractTweetId() pulls the numeric id out of every shape of x.com /
 *     twitter.com status URL the mark-sent input accepts, and rejects
 *     non-status / malformed URLs.
 *   - enrollManualPostForAutoplug() is a safe no-op when there's no tweet id
 *     and when the platform isn't authenticated (it must never throw into the
 *     mark-sent metadata-save path).
 *
 * The platform half (POST /publications → autoTrackTweet → autoplug_tracking)
 * is already-deployed openwriter-publish code and is exercised live post-merge.
 *
 * Run: `node scripts/test-autoplug-enroll.mjs`
 */

import { extractTweetId, enrollManualPostForAutoplug } from '../dist/server/autoplug-enroll.js';

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.error(`  FAIL: ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('extractTweetId — real URLs from the 2026-05-28 bug report');
// doc dc51d4b2 → tweet 2059823344695033931 (~1.2K likes)
eq(extractTweetId('https://x.com/ExampleUser/status/2059823344695033931'), '2059823344695033931', 'brief QT #1 (x.com)');
// doc 70c69b8b → tweet 2059488671259312447 (~141 likes)
eq(extractTweetId('https://x.com/ExampleUser/status/2059488671259312447'), '2059488671259312447', 'brief QT #2 (x.com)');

console.log('extractTweetId — URL shapes the mark-sent input accepts');
eq(extractTweetId('https://twitter.com/jack/status/20'), '20', 'legacy twitter.com host');
eq(extractTweetId('https://x.com/user/status/123456789?s=20&t=abc'), '123456789', 'trailing query params');
eq(extractTweetId('http://x.com/user/status/987654321'), '987654321', 'http scheme');
eq(extractTweetId('https://www.x.com/user/status/555'), '555', 'www subdomain');
eq(extractTweetId('https://mobile.twitter.com/user/status/777'), '777', 'mobile.twitter host');
eq(extractTweetId('x.com/user/status/42'), '42', 'no scheme (paste form)');
eq(extractTweetId('https://x.com/user/status/100/'), '100', 'trailing slash');

console.log('extractTweetId — must reject (no enrollment)');
eq(extractTweetId(''), null, 'empty string');
eq(extractTweetId(undefined), null, 'undefined');
eq(extractTweetId(null), null, 'null');
eq(extractTweetId('https://x.com/ExampleUser'), null, 'profile URL, no status');
eq(extractTweetId('https://example.com/user/status/123'), null, 'non-x/twitter host');
eq(extractTweetId('https://x.com/user/statuses/123'), null, 'wrong path segment');
eq(extractTweetId('just some text'), null, 'free text');

console.log('enrollManualPostForAutoplug — safe guard (no throw, no network)');
// A URL with no extractable tweet id must return before ANY platform call,
// regardless of auth state — so this is safe to run on an authenticated machine
// (it must never accidentally enroll a bogus tweet id into the live platform).
let threw = false;
try {
  await enrollManualPostForAutoplug('doc1234a', 'https://x.com/u', 'hi');
} catch (err) {
  threw = true;
  console.error(`  FAIL: enroll threw: ${err?.message || err}`);
}
eq(threw, false, 'enroll never throws into the mark-sent path (no-id URL)');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
