export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Workspace preview vs deployed app. The deployer writes GROK_PROJECT_ID on
 * every publish; the sandbox preview never has it. Single source of truth for
 * the split — gate audience, gate endpoints and connector-token semantics all
 * key off this predicate.
 */
export function isWorkspacePreview(): boolean {
  return !env("GROK_PROJECT_ID");
}

/**
 * True on any real deployment. `isWorkspacePreview()` alone is not enough: a
 * self-managed Vercel deploy has no GROK_PROJECT_ID, so it would look like the
 * preview and loosen the keeper's safety checks (open tick endpoint, key stored
 * in the database). Anything running on Vercel is a deployment.
 */
export function isDeployed(): boolean {
  return !isWorkspacePreview() || Boolean(env("VERCEL")) || env("NODE_ENV") === "production" && Boolean(env("VERCEL_ENV"));
}
