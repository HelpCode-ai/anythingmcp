export interface InstanceVersion {
  version: string;
  commit: string;
  buildDate: string | null;
  deploymentMode: string;
}

/** Seven characters of a 40-hex SHA. `dev` stays plain text. Same rule as the backend startup log. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit;
}

/** Link target for a full git SHA. `dev` and a short value have none. */
export function commitUrl(commit: string): string | null {
  return /^[0-9a-f]{40}$/.test(commit)
    ? `https://github.com/HelpCode-ai/anythingmcp/commit/${commit}`
    : null;
}

/** Text copied from Settings → Administration. The commit is the full value. */
export function versionInfoText(info: InstanceVersion): string {
  const built = info.buildDate || 'unknown';
  return `AnythingMCP v${info.version} (commit ${info.commit}, built ${built}, mode ${info.deploymentMode})`;
}
