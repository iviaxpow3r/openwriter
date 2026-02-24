// Minimal worker — static assets are served automatically by Cloudflare.
// This handles redirects: www → apex, trailing slash normalization.

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    // Redirect www to apex
    if (url.hostname === 'www.openwriter.com') {
      url.hostname = 'openwriter.com';
      return Response.redirect(url.toString(), 301);
    }

    // Let Cloudflare serve static assets (fallthrough)
    return new Response(null, { status: 404 });
  }
};
