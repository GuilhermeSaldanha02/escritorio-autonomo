export function getWorkspaceClassName(selectedAgentId: string | null): string {
  return selectedAgentId === null
    ? 'office-workspace is-empty'
    : 'office-workspace has-selection';
}
