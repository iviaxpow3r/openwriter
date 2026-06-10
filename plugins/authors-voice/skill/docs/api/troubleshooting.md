# Troubleshooting

**"Unauthorized"** — Check `AV_API_KEY` is set and starts with `av_live_`.

**"profileId query parameter is required"** — Some REST endpoints need profileId. For MCP tools, omit profileId to use the default profile.

**Empty document list** — Connection is active but no documents match. Try without a query filter.
