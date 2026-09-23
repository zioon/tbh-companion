// Web shell: canonical outbound links, shared by the footer, the desktop-app
// call-to-action, and the missing-prices banner so there is one source of truth.

export const REPO_URL = "https://github.com/zioon/tbh-companion";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

/**
 * The scheduled workflow that rebuilds the Lookup price snapshot. Linked from
 * the Trading/Lookup warning banner so a stuck snapshot is one click from its
 * run history.
 */
export const PRICES_WORKFLOW_URL = `${REPO_URL}/actions/workflows/lookup-prices.yml`;
