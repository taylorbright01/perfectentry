// Public configuration only. Never put Whop secrets or Supabase service keys here.
export const config = Object.freeze({
  feedUrl: null, // Protected HTTPS endpoint returning the contract in docs/perfect-view.md.
  refreshSeconds: 60,
  loginUrl: null, // Set when the shared server-side Whop OAuth flow is deployed.
  workspaceUrl: null // Reserved for authenticated, per-account server persistence.
});
