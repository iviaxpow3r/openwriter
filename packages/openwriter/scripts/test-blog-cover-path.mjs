/**
 * Regression test for the per-site blog image contract.
 * adr: adr/blog-image-contract.md
 *
 * The cover-image reference is a PER-SITE CONTRACT — path style + deterministic
 * filename — not a hardcoded global assumption. This test pins the pure
 * resolvers the github plugin uses in post_to_blog, the frontmatter they feed,
 * the idempotent (no-orphan) republish behavior, and the lastPublish-durability
 * invariant that the blogContext deep-merge guarantees.
 *
 * Run from packages/openwriter: `node scripts/test-blog-cover-path.mjs`
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import {
  imageRef,
  coverFilename,
  pathStyleOf,
  buildFrontmatter,
  inferImageConventions,
} from '../../../plugins/github/dist/blog-tools.js';
import { mergeMetadataUpdates } from '../dist/server/state.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const TMP = join(homedir(), '.openwriter', `_test-blog-cover-${Date.now()}`);
function cleanup() { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

console.log('\n[1] imageRef — path style governs the leading slash');
// Stored prefix carries a leading slash; style alone decides emit.
eq(imageRef('/images/og', 'og-foo-bar.png', 'relative'), 'images/og/og-foo-bar.png', 'relative drops leading slash');
eq(imageRef('/images/og', 'og-foo-bar.png', 'absolute'), '/images/og/og-foo-bar.png', 'absolute keeps leading slash');
// Stored prefix WITHOUT a leading slash → identical output (storage-agnostic).
eq(imageRef('images/og', 'x.png', 'absolute'), '/images/og/x.png', 'absolute normalizes slashless prefix');
eq(imageRef('images/og/', 'x.png', 'relative'), 'images/og/x.png', 'relative strips trailing slash');
// Empty prefix
eq(imageRef('', 'x.png', 'relative'), 'x.png', 'empty prefix relative');
eq(imageRef('', 'x.png', 'absolute'), '/x.png', 'empty prefix absolute');
// Protocol-relative bug the brief flagged must NOT happen
assert(!imageRef('/images/og', 'x.png', 'relative').startsWith('/'), 'relative never emits a leading slash (no //protocol-relative)');

console.log('\n[2] coverFilename — deterministic slug-based naming, ext preserved');
eq(coverFilename('og-{slug}.{ext}', 'foo-bar', '.png'), 'og-foo-bar.png', 'template with {ext}');
eq(coverFilename(undefined, 'foo-bar', '.png'), 'og-foo-bar.png', 'default template');
eq(coverFilename('og-{slug}.{ext}', 'foo-bar', '.jpg'), 'og-foo-bar.jpg', 'preserves source ext (.jpg)');
eq(coverFilename('og-{slug}.png', 'foo-bar', '.png'), 'og-foo-bar.png', 'literal-ext template respected');
eq(coverFilename('{slug}.{ext}', 'foo-bar', '.webp'), 'foo-bar.webp', 'bare {slug} template');
// Same slug + DIFFERENT source name ⇒ SAME dest name (idempotent)
eq(
  coverFilename('og-{slug}.{ext}', 'foo-bar', extname('/_images/hashAAA.png'.replace(/^\/_images\//, ''))),
  coverFilename('og-{slug}.{ext}', 'foo-bar', extname('/_images/hashBBB.png'.replace(/^\/_images\//, ''))),
  'same slug ⇒ same filename regardless of source name',
);

console.log('\n[3] pathStyleOf — absent key defaults to legacy absolute');
eq(pathStyleOf({}), 'absolute', 'no key ⇒ absolute (legacy)');
eq(pathStyleOf({ image_path_style: 'relative' }), 'relative', 'explicit relative');
eq(pathStyleOf({ image_path_style: 'absolute' }), 'absolute', 'explicit absolute');

console.log('\n[4] buildFrontmatter — relative site emits NO leading slash');
{
  // The exact brief scenario: coverImage=/_images/<hash>.png, slug foo-bar.
  const slug = 'foo-bar';
  const site = {
    image_dir: 'public/images/og',
    image_public_prefix: '/images/og',
    image_path_style: 'relative',
    image_naming: 'og-{slug}.png',
    frontmatter_field_map: { coverImage: 'image' },
  };
  const ext = extname('/_images/abc123.png'.replace(/^\/_images\//, '')) || '.png';
  const coverPath = imageRef(site.image_public_prefix, coverFilename(site.image_naming, slug, ext), pathStyleOf(site));
  eq(coverPath, 'images/og/og-foo-bar.png', 'resolved cover path (relative)');
  const fm = buildFrontmatter('My Title', { active: true }, site, coverPath);
  assert(fm.includes('image: "images/og/og-foo-bar.png"'), 'frontmatter has relative image field');
  assert(!fm.includes('image: "/images/og'), 'frontmatter image has NO leading slash');
  assert(!fm.includes('coverImage:'), 'field_map renamed coverImage → image');
}

console.log('\n[5] buildFrontmatter — absolute site keeps the leading slash');
{
  const slug = 'foo-bar';
  const site = {
    image_dir: 'public/blog-images',
    image_public_prefix: '/blog-images',
    image_path_style: 'absolute',
    // no field_map, no image_naming → default cover field + default naming
  };
  const ext = extname('/_images/abc123.png'.replace(/^\/_images\//, '')) || '.png';
  const coverPath = imageRef(site.image_public_prefix, coverFilename(site.image_naming, slug, ext), pathStyleOf(site));
  eq(coverPath, '/blog-images/og-foo-bar.png', 'resolved cover path (absolute)');
  const fm = buildFrontmatter('My Title', { active: true }, site, coverPath);
  assert(fm.includes('coverImage: "/blog-images/og-foo-bar.png"'), 'frontmatter has absolute coverImage field');
}

console.log('\n[6] Republish is idempotent — same slug overwrites, never orphans');
{
  const imagesDir = join(TMP, '_images');
  const destDir = join(TMP, 'public', 'images', 'og');
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
  // Publish #1: cover sourced from hashAAA.png
  writeFileSync(join(imagesDir, 'hashAAA.png'), 'AAA');
  // Publish #2: cover REGENERATED → different source name hashBBB.png
  writeFileSync(join(imagesDir, 'hashBBB.png'), 'BBB');

  const slug = 'foo-bar';
  const name1 = coverFilename('og-{slug}.{ext}', slug, extname('hashAAA.png'));
  const name2 = coverFilename('og-{slug}.{ext}', slug, extname('hashBBB.png'));
  eq(name1, name2, 'both publishes resolve to the same dest filename');

  copyFileSync(join(imagesDir, 'hashAAA.png'), join(destDir, name1));
  copyFileSync(join(imagesDir, 'hashBBB.png'), join(destDir, name2));

  const dest = readdirSync(destDir);
  eq(dest.length, 1, 'exactly ONE cover file in dest (no orphan)');
  eq(dest[0], 'og-foo-bar.png', 'the file is the deterministic slug name');
  eq(readFileSync(join(destDir, name2), 'utf-8'), 'BBB', 'second publish overwrote the first');
}

console.log('\n[7] lastPublish durability — blogContext deep-merge keeps the publish link');
{
  // The brief scenario: a metadata edit touching blogContext after a publish.
  const existing = {
    content_type: 'blog',
    blogContext: { active: true, slug: 'foo-bar', lastPublish: { commit: 'abc123', file: 'blog/foo-bar.md' } },
  };
  const merged = mergeMetadataUpdates(existing, { blogContext: { coverImage: '/_images/new.png' } });
  assert(merged?.blogContext?.lastPublish?.commit === 'abc123', 'lastPublish.commit survives a blogContext edit');
  eq(merged?.blogContext?.coverImage, '/_images/new.png', 'the new coverImage edit applied');
  assert(merged?.blogContext?.active === true, 'active flag preserved');

  // Even when the contamination guard drops a non-active blogContext update,
  // the existing lastPublish must remain untouched.
  const existing2 = {
    blogContext: { active: false, lastPublish: { commit: 'def456' } },
  };
  const merged2 = mergeMetadataUpdates(existing2, { blogContext: { coverImage: '/_images/x.png' }, status: 'draft' });
  assert(merged2?.blogContext?.lastPublish?.commit === 'def456', 'lastPublish survives even when the guard drops the update');
}

console.log('\n[8] inferImageConventions — derives the contract from real posts (paybot shape)');
{
  // Mirrors paybot-website's actual 18 posts: relative paths under images/og,
  // `og-` prefixed filenames with hand-shortened middles (so they do NOT all
  // equal og-{slug} exactly), quoted values, field name `image`.
  const q = (s) => `"${s}"`;
  const paybot = [
    { slug: 'automations-zapier-webhooks',            fm: { image: q('images/og/og-automations-webhooks.png') } },
    { slug: 'building-trading-communities-on-discord', fm: { image: q('images/og/og-trading-communities.png') } },
    { slug: 'creator-tools-now-free',                  fm: { image: q('images/og/og-creator-tools-free.png') } },
    { slug: 'free-trials-discord-memberships',         fm: { image: q('images/og/og-free-trials-discord-memberships.png') } },
    { slug: 'gift-free-time-subscriber-credits',       fm: { image: q('images/og/og-gift-free-time.png') } },
    { slug: 'high-ticket-one-time-purchases-discord',  fm: { image: q('images/og/og-high-ticket.png') } },
  ];
  const conv = inferImageConventions(paybot);
  eq(conv.image_field, 'image', 'detects cover field name = image');
  eq(conv.image_path_style, 'relative', 'detects relative path style');
  eq(conv.image_public_prefix, 'images/og', 'detects prefix dir images/og');
  eq(conv.image_naming, 'og-{slug}.png', 'detects og-{slug}.png naming convention');

  // Absolute-style site with exact {slug} naming + coverImage field.
  const exact = [
    { slug: 'first-post',  fm: { coverImage: q('/blog-images/first-post.png') } },
    { slug: 'second-post', fm: { coverImage: q('/blog-images/second-post.png') } },
  ];
  const conv2 = inferImageConventions(exact);
  eq(conv2.image_field, 'coverImage', 'detects coverImage field');
  eq(conv2.image_path_style, 'absolute', 'detects absolute path style');
  eq(conv2.image_naming, '{slug}.png', 'detects bare {slug} naming');

  // No image field anywhere ⇒ empty inference (caller falls back to defaults).
  const none = [{ slug: 'x', fm: { title: 'hi', draft: 'false' } }];
  eq(Object.keys(inferImageConventions(none)).length, 0, 'no cover field ⇒ no inference');
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
