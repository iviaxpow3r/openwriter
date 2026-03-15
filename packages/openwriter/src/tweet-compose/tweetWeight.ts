/**
 * Weighted character counting per X/Twitter rules.
 * Uses the official twitter-text library: emojis = 2, CJK = 2, URLs = 23, Latin = 1.
 * See https://docs.x.com/en/posts/counting-characters
 */
import twitter from 'twitter-text';

const { parseTweet } = twitter;

/** Return the X-weighted character length of a string. */
export function weightedLength(text: string): number {
  return parseTweet(text).weightedLength;
}
