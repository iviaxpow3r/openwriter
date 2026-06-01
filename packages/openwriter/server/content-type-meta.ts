// Single source of truth for content-type scaffolding metadata. Maps a
// content_type to the frontmatter it needs: the `content_type` field itself
// (which owns the editor surface — adr: adr/browser-write-fidelity.md) plus the
// type's context object (tweetContext / articleContext / blogContext / …).
//
// Used by both the MCP create_document handler and the HTTP POST /api/documents
// endpoint (the "Create variant" path) so a typed empty doc is scaffolded the
// same way regardless of who creates it. adr: docs/variants.md

export function resolveTypeMeta(type: string, url?: string): Record<string, any> | undefined {
  switch (type) {
    case 'tweet': return { content_type: 'tweet', tweetContext: { mode: 'tweet' } };
    case 'reply': return { content_type: 'reply', tweetContext: { mode: 'reply', ...(url ? { url } : {}) } };
    case 'quote': return { content_type: 'quote', tweetContext: { mode: 'quote', ...(url ? { url } : {}) } };
    case 'article': return { content_type: 'article', articleContext: { active: true } };
    case 'linkedin': return { content_type: 'linkedin', linkedinContext: { active: true } };
    case 'newsletter': return { content_type: 'newsletter', newsletterContext: { active: true } };
    case 'blog': return { content_type: 'blog', blogContext: { active: true } };
    default: return undefined;
  }
}
