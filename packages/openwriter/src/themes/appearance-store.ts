export type ColorPalette = 'ink' | 'novel' | 'mono' | 'editorial' | 'studio' | 'calm' | 'prose' | 'craft' | 'literata' | 'swiss';
export type Typeface = 'charter' | 'source-serif' | 'plex-mono' | 'crimson' | 'inter' | 'baskerville' | 'grotesk' | 'literata' | 'dm-sans';
export type ThemeMode = 'light' | 'dark';
export type SidebarMode = 'default' | 'timeline' | 'board' | 'shelf';
export type SidebarStyle = 'default' | 'cards' | 'tight' | 'ultra';
export type CanvasStyle = 'seamless' | 'outline' | 'page' | 'paper';
export type SpacingPreset = 'default' | 'butterick' | 'web' | 'blog';

export interface ColorInfo {
  id: ColorPalette;
  label: string;
  swatch: { light: string; dark: string };
}

export interface TypefaceInfo {
  id: Typeface;
  label: string;
  description: string;
}

export const COLORS: ColorInfo[] = [
  { id: 'ink', label: 'Ink', swatch: { light: '#5b7a9d', dark: '#7d9bba' } },
  { id: 'novel', label: 'Novel', swatch: { light: '#a68b6b', dark: '#c4a882' } },
  { id: 'mono', label: 'Mono', swatch: { light: '#787878', dark: '#a0a0a0' } },
  { id: 'editorial', label: 'Editorial', swatch: { light: '#9e6b6b', dark: '#b88a8a' } },
  { id: 'studio', label: 'Studio', swatch: { light: '#8b7baa', dark: '#a899c4' } },
  { id: 'calm', label: 'Calm', swatch: { light: '#8a9e6b', dark: '#a4b886' } },
  { id: 'prose', label: 'Prose', swatch: { light: '#6b9e95', dark: '#8ab8af' } },
  { id: 'craft', label: 'Craft', swatch: { light: '#7b6b9e', dark: '#9a8ab8' } },
  { id: 'literata', label: 'Literata', swatch: { light: '#b09070', dark: '#c8a88a' } },
  { id: 'swiss', label: 'Swiss', swatch: { light: '#c47a6b', dark: '#d49a8c' } },
];

export const TYPEFACES: TypefaceInfo[] = [
  { id: 'charter', label: 'Charter', description: 'Charter serif' },
  { id: 'source-serif', label: 'Source Serif', description: 'Source Serif 4' },
  { id: 'plex-mono', label: 'Plex Mono', description: 'IBM Plex Mono' },
  { id: 'crimson', label: 'Crimson', description: 'Crimson Pro' },
  { id: 'inter', label: 'Inter', description: 'Inter sans-serif' },
  { id: 'baskerville', label: 'Baskerville', description: 'Libre Baskerville' },
  { id: 'grotesk', label: 'Grotesk', description: 'Space Grotesk' },
  { id: 'literata', label: 'Literata', description: 'Literata serif' },
  { id: 'dm-sans', label: 'DM Sans', description: 'DM Sans + Serif' },
];

export const SIDEBAR_MODES: { id: SidebarMode; label: string; icon: string }[] = [
  { id: 'default', label: 'Tree', icon: 'tree' },
  { id: 'timeline', label: 'Timeline', icon: 'timeline' },
  { id: 'board', label: 'Board', icon: 'board' },
  { id: 'shelf', label: 'Shelf', icon: 'shelf' },
];

export const SIDEBAR_STYLES: { id: SidebarStyle; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'cards', label: 'Cards' },
  { id: 'tight', label: 'Tight' },
  { id: 'ultra', label: 'Ultra' },
];

export const CANVAS_STYLES: { id: CanvasStyle; label: string }[] = [
  { id: 'seamless', label: 'Seamless' },
  { id: 'outline', label: 'Outline' },
  { id: 'page', label: 'Page' },
  { id: 'paper', label: 'Paper' },
];

export const SPACING_PRESETS: { id: SpacingPreset; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'web', label: 'Web' },
  { id: 'blog', label: 'Blog' },
  { id: 'butterick', label: 'Butterick' },
];

const KEYS = {
  color: 'ow-color',
  typeface: 'ow-typeface',
  mode: 'ow-theme-mode',
  sidebarMode: 'ow-sidebar-mode',
  sidebarStyle: 'ow-sidebar-style',
  spacing: 'ow-spacing',
  canvas: 'ow-canvas',
} as const;

// Migration mapping from old ow-theme → (color, typeface)
const THEME_MIGRATION: Record<string, { color: ColorPalette; typeface: Typeface }> = {
  ink: { color: 'ink', typeface: 'charter' },
  novel: { color: 'novel', typeface: 'source-serif' },
  mono: { color: 'mono', typeface: 'plex-mono' },
  editorial: { color: 'editorial', typeface: 'crimson' },
  studio: { color: 'studio', typeface: 'inter' },
  calm: { color: 'calm', typeface: 'inter' },
  prose: { color: 'prose', typeface: 'baskerville' },
  craft: { color: 'craft', typeface: 'grotesk' },
  literata: { color: 'literata', typeface: 'literata' },
  swiss: { color: 'swiss', typeface: 'dm-sans' },
};

function migrateIfNeeded(): void {
  // Migrate ow-theme → ow-color + ow-typeface
  const oldTheme = localStorage.getItem('ow-theme');
  if (oldTheme && !localStorage.getItem(KEYS.color)) {
    const mapping = THEME_MIGRATION[oldTheme];
    if (mapping) {
      localStorage.setItem(KEYS.color, mapping.color);
      localStorage.setItem(KEYS.typeface, mapping.typeface);
    }
    localStorage.removeItem('ow-theme');
  }

  // Migrate ow-typography → ow-spacing
  const oldTypography = localStorage.getItem('ow-typography');
  if (oldTypography && !localStorage.getItem(KEYS.spacing)) {
    localStorage.setItem(KEYS.spacing, oldTypography);
    localStorage.removeItem('ow-typography');
  }
}

export function getColor(): ColorPalette {
  const stored = localStorage.getItem(KEYS.color);
  if (stored && COLORS.some(c => c.id === stored)) return stored as ColorPalette;
  return 'ink';
}

export function getTypeface(): Typeface {
  const stored = localStorage.getItem(KEYS.typeface);
  if (stored && TYPEFACES.some(t => t.id === stored)) return stored as Typeface;
  return 'charter';
}

export function getMode(): ThemeMode {
  const stored = localStorage.getItem(KEYS.mode);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getSidebarMode(): SidebarMode {
  const stored = localStorage.getItem(KEYS.sidebarMode);
  if (stored && SIDEBAR_MODES.some(m => m.id === stored)) return stored as SidebarMode;
  return 'default';
}

export function getSidebarStyle(): SidebarStyle {
  const stored = localStorage.getItem(KEYS.sidebarStyle);
  if (stored && SIDEBAR_STYLES.some(s => s.id === stored)) return stored as SidebarStyle;
  return 'default';
}

export function getSpacing(): SpacingPreset {
  const stored = localStorage.getItem(KEYS.spacing);
  if (stored && SPACING_PRESETS.some(t => t.id === stored)) return stored as SpacingPreset;
  return 'default';
}

export function getCanvasStyle(): CanvasStyle {
  const stored = localStorage.getItem(KEYS.canvas);
  if (stored && CANVAS_STYLES.some(c => c.id === stored)) return stored as CanvasStyle;
  return 'seamless';
}

export function applyAppearance(
  color: ColorPalette,
  typeface: Typeface,
  mode: ThemeMode,
  sidebarMode: SidebarMode,
  sidebarStyle: SidebarStyle,
  spacing: SpacingPreset = 'default',
  canvas: CanvasStyle = 'seamless',
): void {
  const el = document.documentElement;
  el.setAttribute('data-color', color);
  el.setAttribute('data-typeface', typeface);
  el.setAttribute('data-mode', mode);
  el.setAttribute('data-sidebar-mode', sidebarMode);
  el.setAttribute('data-sidebar-style', sidebarStyle);
  if (spacing === 'default') {
    el.removeAttribute('data-spacing');
  } else {
    el.setAttribute('data-spacing', spacing);
  }
  if (canvas === 'seamless') {
    el.removeAttribute('data-canvas');
  } else {
    el.setAttribute('data-canvas', canvas);
  }
  localStorage.setItem(KEYS.color, color);
  localStorage.setItem(KEYS.typeface, typeface);
  localStorage.setItem(KEYS.mode, mode);
  localStorage.setItem(KEYS.sidebarMode, sidebarMode);
  localStorage.setItem(KEYS.sidebarStyle, sidebarStyle);
  localStorage.setItem(KEYS.spacing, spacing);
  localStorage.setItem(KEYS.canvas, canvas);
}

export function initAppearance(): void {
  migrateIfNeeded();
  applyAppearance(getColor(), getTypeface(), getMode(), getSidebarMode(), getSidebarStyle(), getSpacing(), getCanvasStyle());
}
