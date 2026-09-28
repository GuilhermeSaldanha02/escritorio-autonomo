import type { CSSProperties } from 'react';

import palette from '../../../../../assets/office/palette.json';

export const officeThemeStyle: CSSProperties & Record<`--${string}`, string> = {
  '--office-bg': palette.colors.background,
  '--office-surface': palette.colors.surface,
  '--office-surface-elevated': palette.colors.surfaceElevated,
  '--office-border': palette.colors.border,
  '--office-text': palette.colors.textPrimary,
  '--office-muted': palette.colors.textSecondary,
  '--office-cyan': palette.categories.SEARCHING.color,
  '--office-violet': palette.categories.ANALYZING.color,
  '--office-green': palette.categories.WORKING.color,
  '--office-gold': palette.categories.WAITING.color,
  '--office-red': palette.categories.BLOCKED.color,
  '--office-sans': 'system-ui, sans-serif',
  '--office-mono': 'ui-monospace, monospace',
  '--space-1': '0.25rem',
  '--space-2': '0.5rem',
  '--space-3': '0.75rem',
  '--space-4': '1rem',
  '--space-5': '1.5rem',
  '--space-6': '2rem',
  '--radius-sm': '0.35rem',
  '--radius-md': '0.7rem',
};
