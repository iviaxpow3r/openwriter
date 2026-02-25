export type ColorPalette = 'ink' | 'novel' | 'mono' | 'editorial' | 'studio' | 'prose';
export type Typeface = 'charter' | 'source-serif' | 'plex-mono' | 'crimson' | 'inter' | 'baskerville' | 'grotesk' | 'literata' | 'dm-sans';
export type ThemeMode = 'light' | 'dark';
export type SidebarMode = 'default' | 'timeline' | 'board' | 'shelf';
export type SidebarStyle = 'cards';
export type SidebarDensity = 'full' | 'compact' | 'minimal';
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
  { id: 'prose', label: 'Prose', swatch: { light: '#6b9e95', dark: '#8ab8af' } },
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
  { id: 'cards', label: 'Cards' },
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

const SIDEBAR_DENSITIES: SidebarDensity[] = ['full', 'compact', 'minimal'];

const KEYS = {
  color: 'ow-color',
  typeface: 'ow-typeface',
  mode: 'ow-theme-mode',
  sidebarMode: 'ow-sidebar-mode',
  sidebarStyle: 'ow-sidebar-style',
  sidebarDensity: 'ow-sidebar-density',
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
  prose: { color: 'prose', typeface: 'baskerville' },
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
  return 'cards';
}

export function getSidebarDensity(): SidebarDensity {
  const stored = localStorage.getItem(KEYS.sidebarDensity);
  if (stored && SIDEBAR_DENSITIES.includes(stored as SidebarDensity)) return stored as SidebarDensity;
  return 'full';
}

export function setSidebarDensity(density: SidebarDensity): void {
  localStorage.setItem(KEYS.sidebarDensity, density);
  document.documentElement.setAttribute('data-sidebar-density', density);
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
  document.documentElement.setAttribute('data-sidebar-density', getSidebarDensity());
}
