/**
 * Skins: the named colour schemes that give the whole desktop one coherent
 * look, and the flat {@link Palette} of semantic roles every widget paints
 * through.
 *
 * The design follows Turbo Vision's indirection: widgets never name a colour,
 * they name a *role* (`windowFrame`, `menuSelected`, `dialogStatic`). A skin is
 * therefore a table of role → colour pairs, and switching the entire look of
 * the IDE — including which text is legible on which background — is a data
 * change, not a code change. That is what makes the classic blue screen, a
 * monochrome amber CRT, and a modern dark theme all first-class.
 *
 * All colours are 24-bit. {@link resolveStyle} in `screen.ts` downgrades them
 * to the 256-colour palette for terminals that cannot do better, so a skin
 * author never has to think about it.
 * @module @dsh-tvision/dsh-tvision/kit/skin
 */

import type { Style } from './cell.ts'

/**
 * A foreground/background pair. `undefined` on either side means "terminal
 * default", which is how a skin inherits the user's own theme.
 */
export interface Pair {
  readonly fg?: number
  readonly bg?: number
}

/**
 * Every semantic colour role the widgets may paint through.
 *
 * The names are the contract between a skin and the widget layer: adding a
 * widget that needs a new look means adding a role here, which the compiler
 * then forces every skin to supply. That is deliberate — a missing role in one
 * skin would otherwise show up as an invisible dialog in that skin only.
 */
export interface Palette {
  /** The desktop behind every window. */
  desktop: Pair
  /** Desktop text that is not inside a window (the splash hint line). */
  desktopText: Pair
  /** The 1-cell drop shadow every window and dialog casts. */
  shadow: Pair
  /** Inactive window frame. */
  windowFrame: Pair
  /** Inactive window title bar. */
  windowTitle: Pair
  /** Active (focused) window frame. */
  windowFrameActive: Pair
  /** Active window title bar. */
  windowTitleActive: Pair
  /** Window interior, default. */
  windowBody: Pair
  /** The `■` close glyph and `↑`/`↓` zoom glyph on a frame's boxes. */
  windowIcon: Pair
  /** The brightened bottom-right corner pair that marks a resize grip. */
  windowGrip: Pair
  /** Scrollbar trough. */
  scrollBar: Pair
  /** Scrollbar thumb. */
  scrollThumb: Pair
  /** The menu bar strip. */
  menuBar: Pair
  /** A menu bar item that is merely displayed. */
  menuItem: Pair
  /** The currently opened menu bar item. */
  menuItemActive: Pair
  /** A dropdown menu's frame and body. */
  menuFrame: Pair
  /** A selectable menu row. */
  menuNormal: Pair
  /** The highlighted menu row. */
  menuSelected: Pair
  /** A disabled menu row. */
  menuDisabled: Pair
  /** Menu accelerator letters. */
  menuShortcut: Pair
  /** The function-key hint strip. */
  statusBar: Pair
  /** A function-key number (`F1`) in the hint strip. */
  statusKey: Pair
  /** A function-key label in the hint strip. */
  statusLabel: Pair
  /** The right-hand status line (model, tokens, context). */
  statusLine: Pair
  /** The composer frame when the composer has focus. */
  inputFrameActive: Pair
  /** The composer frame when focus is elsewhere. */
  inputFrame: Pair
  /** The composer's text area. */
  inputBody: Pair
  /** The composer's `dsh>` prompt sigil. */
  inputPrompt: Pair
  /** Placeholder text in an empty composer. */
  inputHint: Pair
  /** Static dialog text (labels, prose). */
  dialogStatic: Pair
  /** The focused control inside a dialog. */
  dialogFocused: Pair
  /** The default button in a dialog. */
  dialogDefault: Pair
  /** A selectable list row. */
  listNormal: Pair
  /** The highlighted list row while the list has focus. */
  listFocused: Pair
  /** The highlighted list row while the list is not focused. */
  listSelected: Pair
  /** A list row whose item is disabled. */
  listDisabled: Pair
  /** Transcript: the user's own turn. */
  userLabel: Pair
  /** Transcript: the assistant's turn header. */
  assistantLabel: Pair
  /** Transcript: ordinary assistant prose. */
  bodyText: Pair
  /** Transcript: the model's reasoning. */
  reasoning: Pair
  /** Transcript: tool-call header rows. */
  toolHeader: Pair
  /** Transcript: tool-call bodies. */
  toolBody: Pair
  /** Transcript: the row for a tool that is still running. */
  toolRunning: Pair
  /** Transcript: a successful outcome. */
  toolSuccess: Pair
  /** Transcript: a failed outcome. */
  toolError: Pair
  /** Diff: an added line. */
  diffAdded: Pair
  /** Diff: a removed line. */
  diffRemoved: Pair
  /** Diff: hunk headers and line numbers. */
  diffMeta: Pair
  /** Inline code and code blocks. */
  code: Pair
  /** A notice or the answer to a slash command. */
  notice: Pair
  /** Warning text. */
  warning: Pair
  /** Error text. */
  error: Pair
  /** The one accent colour, used for emphasis and the brand mark. */
  accent: Pair
  /** The active search hit. */
  searchHit: Pair
  /** Every other search hit on screen. */
  searchHitDim: Pair
}

/** Names of every palette role, in the order `/skin` lists them. */
export const PALETTE_ROLES = [
  'desktop', 'desktopText', 'shadow',
  'windowFrame', 'windowTitle', 'windowFrameActive', 'windowTitleActive', 'windowBody',
  'windowIcon', 'windowGrip', 'scrollBar', 'scrollThumb',
  'menuBar', 'menuItem', 'menuItemActive', 'menuFrame', 'menuNormal', 'menuSelected',
  'menuDisabled', 'menuShortcut',
  'statusBar', 'statusKey', 'statusLabel', 'statusLine',
  'inputFrame', 'inputFrameActive', 'inputBody', 'inputPrompt', 'inputHint',
  'dialogStatic', 'dialogFocused', 'dialogDefault',
  'listNormal', 'listFocused', 'listSelected', 'listDisabled',
  'userLabel', 'assistantLabel', 'bodyText', 'reasoning',
  'toolHeader', 'toolBody', 'toolRunning', 'toolSuccess', 'toolError',
  'diffAdded', 'diffRemoved', 'diffMeta', 'code', 'notice', 'warning', 'error',
  'accent', 'searchHit', 'searchHitDim',
] as const satisfies readonly (keyof Palette)[]

/** One role's name, as accepted by `/skin`'s swatch output. */
export type PaletteRole = typeof PALETTE_ROLES[number]

/** A complete colour scheme. */
export interface Skin {
  /** Stable machine name, used by `--skin` and `/skin`. */
  readonly id: string
  /** Human name for the skin picker. */
  readonly name: string
  /** One-line description for the skin picker. */
  readonly description: string
  /**
   * Whether this skin relies on the 16 ANSI colours being remapped by the
   * user's terminal theme. Only used to warn in the picker; nothing branches
   * on it at paint time.
   */
  readonly ansi16?: boolean
  /** The roles. */
  readonly palette: Palette
}

/**
 * The resolved palette a widget layer paints through: the same role names, but
 * each one pre-folded into a {@link Style} so the hot path does no object
 * building.
 */
export type ResolvedPalette = { readonly [K in PaletteRole]: Style }

/**
 * Fold a skin's colour pairs into ready-to-use styles.
 * @param skin - The skin.
 * @returns One frozen style per role.
 */
export function resolvePalette(skin: Skin): ResolvedPalette {
  const out = {} as Record<PaletteRole, Style>
  for (const role of PALETTE_ROLES) {
    const pair = skin.palette[role]
    const style: Style = { fg: pair.fg, bg: pair.bg }
    if (role === 'menuShortcut' || role === 'statusKey' || role === 'userLabel'
      || role === 'assistantLabel' || role === 'toolHeader' || role === 'accent') {
      style.bold = true
    }
    if (role === 'reasoning' || role === 'inputHint' || role === 'menuDisabled'
      || role === 'diffMeta' || role === 'desktopText' || role === 'toolBody') {
      style.dim = true
    }
    if (role === 'listFocused' || role === 'menuSelected' || role === 'menuItemActive'
      || role === 'dialogDefault' || role === 'statusKey') {
      style.bold = true
    }
    out[role] = Object.freeze(style)
  }
  return Object.freeze(out)
}

/**
 * The canonical Borland blue.
 *
 * Sampled from Turbo Vision's own default palette rather than invented: the
 * desktop is the familiar dark blue, window frames are cyan, the inactive
 * title bar is a solid cyan bar with dark text, and the active frame is the
 * same cyan but its title bar inverts to blue-on-cyan.
 */
export const TURBO_VISION: Skin = {
  id: 'tvision',
  name: 'Turbo Vision',
  description: 'The Borland blue screen: cyan frames on a dark blue desktop.',
  palette: {
    desktop: { fg: 0xAAAAAA, bg: 0x0000A8 },
    desktopText: { fg: 0x00AAAA, bg: 0x0000A8 },
    shadow: { fg: 0x000000, bg: 0x000000 },
    windowFrame: { fg: 0x00AAAA, bg: 0x0000A8 },
    windowTitle: { fg: 0x0000A8, bg: 0x00AAAA },
    windowFrameActive: { fg: 0x55FFFF, bg: 0x0000A8 },
    windowTitleActive: { fg: 0xFFFFFF, bg: 0x00AAAA },
    windowBody: { fg: 0xAAAAAA, bg: 0x0000A8 },
    windowIcon: { fg: 0x0000A8, bg: 0x00AAAA },
    windowGrip: { fg: 0xFFFFFF, bg: 0x0000A8 },
    scrollBar: { fg: 0x00AAAA, bg: 0x0000A8 },
    scrollThumb: { fg: 0x0000A8, bg: 0x00AAAA },
    menuBar: { fg: 0xAAAAAA, bg: 0x00AAAA },
    menuItem: { fg: 0x000000, bg: 0x00AAAA },
    menuItemActive: { fg: 0xFFFFFF, bg: 0x0000A8 },
    menuFrame: { fg: 0x000000, bg: 0xAAAAAA },
    menuNormal: { fg: 0x000000, bg: 0xAAAAAA },
    menuSelected: { fg: 0xFFFFFF, bg: 0x0000A8 },
    menuDisabled: { fg: 0x555555, bg: 0xAAAAAA },
    menuShortcut: { fg: 0x0000A8, bg: 0xAAAAAA },
    statusBar: { fg: 0x000000, bg: 0x00AAAA },
    statusKey: { fg: 0xFFFFFF, bg: 0x0000A8 },
    statusLabel: { fg: 0x000000, bg: 0x00AAAA },
    statusLine: { fg: 0x000000, bg: 0x00AAAA },
    inputFrame: { fg: 0x00AAAA, bg: 0x0000A8 },
    inputFrameActive: { fg: 0x55FFFF, bg: 0x0000A8 },
    inputBody: { fg: 0xFFFFFF, bg: 0x0000A8 },
    inputPrompt: { fg: 0x55FF55, bg: 0x0000A8 },
    inputHint: { fg: 0x555555, bg: 0x0000A8 },
    dialogStatic: { fg: 0x000000, bg: 0xAAAAAA },
    dialogFocused: { fg: 0xFFFFFF, bg: 0x00AA00 },
    dialogDefault: { fg: 0xFFFFFF, bg: 0x00AA00 },
    listNormal: { fg: 0x000000, bg: 0xAAAAAA },
    listFocused: { fg: 0xFFFFFF, bg: 0x00AA00 },
    listSelected: { fg: 0xFFFFFF, bg: 0x0000A8 },
    listDisabled: { fg: 0x555555, bg: 0xAAAAAA },
    userLabel: { fg: 0x55FF55, bg: 0x0000A8 },
    assistantLabel: { fg: 0x55FFFF, bg: 0x0000A8 },
    bodyText: { fg: 0xFFFFFF, bg: 0x0000A8 },
    reasoning: { fg: 0x8A8A8A, bg: 0x0000A8 },
    toolHeader: { fg: 0xFFFF55, bg: 0x0000A8 },
    toolBody: { fg: 0xAAAAAA, bg: 0x0000A8 },
    toolRunning: { fg: 0x55FFFF, bg: 0x0000A8 },
    toolSuccess: { fg: 0x55FF55, bg: 0x0000A8 },
    toolError: { fg: 0xFF5555, bg: 0x0000A8 },
    diffAdded: { fg: 0x55FF55, bg: 0x0000A8 },
    diffRemoved: { fg: 0xFF5555, bg: 0x0000A8 },
    diffMeta: { fg: 0x00AAAA, bg: 0x0000A8 },
    code: { fg: 0x55FFFF, bg: 0x0000A8 },
    notice: { fg: 0xAAAAAA, bg: 0x0000A8 },
    warning: { fg: 0xFFFF55, bg: 0x0000A8 },
    error: { fg: 0xFF5555, bg: 0x0000A8 },
    accent: { fg: 0x55FFFF, bg: 0x0000A8 },
    searchHit: { fg: 0x000000, bg: 0xFFFF55 },
    searchHitDim: { fg: 0x000000, bg: 0x00AAAA },
  },
}

/**
 * A green-phosphor CRT. Every role is a shade of one hue, the way a real
 * monochrome monitor looked: brightness carries the hierarchy, colour carries
 * nothing. Chosen because it is the reader's own memory of the era rather than
 * a designer's nostalgia.
 */
export const PHOSPHOR: Skin = {
  id: 'phosphor',
  name: 'Phosphor',
  description: 'P1 green CRT: one hue, brightness does all the work.',
  palette: {
    desktop: { fg: 0x33FF66, bg: 0x001A0A },
    desktopText: { fg: 0x22AA44, bg: 0x001A0A },
    shadow: { fg: 0x000000, bg: 0x000000 },
    windowFrame: { fg: 0x22AA44, bg: 0x001A0A },
    windowTitle: { fg: 0x001A0A, bg: 0x22AA44 },
    windowFrameActive: { fg: 0x66FF99, bg: 0x001A0A },
    windowTitleActive: { fg: 0x001A0A, bg: 0x66FF99 },
    windowBody: { fg: 0x33FF66, bg: 0x001A0A },
    windowIcon: { fg: 0x001A0A, bg: 0x66FF99 },
    windowGrip: { fg: 0xCCFFDD, bg: 0x001A0A },
    scrollBar: { fg: 0x22AA44, bg: 0x001A0A },
    scrollThumb: { fg: 0x001A0A, bg: 0x66FF99 },
    menuBar: { fg: 0x001A0A, bg: 0x33FF66 },
    menuItem: { fg: 0x001A0A, bg: 0x33FF66 },
    menuItemActive: { fg: 0x66FF99, bg: 0x003311 },
    menuFrame: { fg: 0x22AA44, bg: 0x002A12 },
    menuNormal: { fg: 0x33FF66, bg: 0x002A12 },
    menuSelected: { fg: 0x001A0A, bg: 0x66FF99 },
    menuDisabled: { fg: 0x117733, bg: 0x002A12 },
    menuShortcut: { fg: 0x99FFBB, bg: 0x002A12 },
    statusBar: { fg: 0x001A0A, bg: 0x22AA44 },
    statusKey: { fg: 0x001A0A, bg: 0x66FF99 },
    statusLabel: { fg: 0x001A0A, bg: 0x22AA44 },
    statusLine: { fg: 0x001A0A, bg: 0x22AA44 },
    inputFrame: { fg: 0x22AA44, bg: 0x001A0A },
    inputFrameActive: { fg: 0x66FF99, bg: 0x001A0A },
    inputBody: { fg: 0x99FFBB, bg: 0x001A0A },
    inputPrompt: { fg: 0x66FF99, bg: 0x001A0A },
    inputHint: { fg: 0x117733, bg: 0x001A0A },
    dialogStatic: { fg: 0x33FF66, bg: 0x002A12 },
    dialogFocused: { fg: 0x001A0A, bg: 0x33FF66 },
    dialogDefault: { fg: 0x001A0A, bg: 0x66FF99 },
    listNormal: { fg: 0x33FF66, bg: 0x002A12 },
    listFocused: { fg: 0x001A0A, bg: 0x66FF99 },
    listSelected: { fg: 0x99FFBB, bg: 0x004418 },
    listDisabled: { fg: 0x117733, bg: 0x002A12 },
    userLabel: { fg: 0x99FFBB, bg: 0x001A0A },
    assistantLabel: { fg: 0x66FF99, bg: 0x001A0A },
    bodyText: { fg: 0x33FF66, bg: 0x001A0A },
    reasoning: { fg: 0x22AA44, bg: 0x001A0A },
    toolHeader: { fg: 0x99FFBB, bg: 0x001A0A },
    toolBody: { fg: 0x33FF66, bg: 0x001A0A },
    toolRunning: { fg: 0x66FF99, bg: 0x001A0A },
    toolSuccess: { fg: 0x99FFBB, bg: 0x001A0A },
    toolError: { fg: 0xFF8866, bg: 0x001A0A },
    diffAdded: { fg: 0x99FFBB, bg: 0x001A0A },
    diffRemoved: { fg: 0xFF8866, bg: 0x001A0A },
    diffMeta: { fg: 0x22AA44, bg: 0x001A0A },
    code: { fg: 0x99FFBB, bg: 0x001A0A },
    notice: { fg: 0x33FF66, bg: 0x001A0A },
    warning: { fg: 0xFFDD66, bg: 0x001A0A },
    error: { fg: 0xFF8866, bg: 0x001A0A },
    accent: { fg: 0x66FF99, bg: 0x001A0A },
    searchHit: { fg: 0x001A0A, bg: 0x99FFBB },
    searchHitDim: { fg: 0x001A0A, bg: 0x22AA44 },
  },
}

/**
 * Amber P3 phosphor, the other half of the monochrome era. Warmer and easier
 * on the eyes than green for long sessions, which is presumably why so many
 * people remember it fondly.
 */
export const AMBER: Skin = {
  id: 'amber',
  name: 'Amber',
  description: 'P3 amber CRT: warm, low-glare, still one hue.',
  palette: {
    desktop: { fg: 0xFFB000, bg: 0x1A0E00 },
    desktopText: { fg: 0xAA7000, bg: 0x1A0E00 },
    shadow: { fg: 0x000000, bg: 0x000000 },
    windowFrame: { fg: 0xAA7000, bg: 0x1A0E00 },
    windowTitle: { fg: 0x1A0E00, bg: 0xAA7000 },
    windowFrameActive: { fg: 0xFFD070, bg: 0x1A0E00 },
    windowTitleActive: { fg: 0x1A0E00, bg: 0xFFD070 },
    windowBody: { fg: 0xFFB000, bg: 0x1A0E00 },
    windowIcon: { fg: 0x1A0E00, bg: 0xFFD070 },
    windowGrip: { fg: 0xFFE9B8, bg: 0x1A0E00 },
    scrollBar: { fg: 0xAA7000, bg: 0x1A0E00 },
    scrollThumb: { fg: 0x1A0E00, bg: 0xFFD070 },
    menuBar: { fg: 0x1A0E00, bg: 0xFFB000 },
    menuItem: { fg: 0x1A0E00, bg: 0xFFB000 },
    menuItemActive: { fg: 0xFFD070, bg: 0x2A1800 },
    menuFrame: { fg: 0xAA7000, bg: 0x2A1800 },
    menuNormal: { fg: 0xFFB000, bg: 0x2A1800 },
    menuSelected: { fg: 0x1A0E00, bg: 0xFFD070 },
    menuDisabled: { fg: 0x775000, bg: 0x2A1800 },
    menuShortcut: { fg: 0xFFE0A0, bg: 0x2A1800 },
    statusBar: { fg: 0x1A0E00, bg: 0xAA7000 },
    statusKey: { fg: 0x1A0E00, bg: 0xFFD070 },
    statusLabel: { fg: 0x1A0E00, bg: 0xAA7000 },
    statusLine: { fg: 0x1A0E00, bg: 0xAA7000 },
    inputFrame: { fg: 0xAA7000, bg: 0x1A0E00 },
    inputFrameActive: { fg: 0xFFD070, bg: 0x1A0E00 },
    inputBody: { fg: 0xFFE0A0, bg: 0x1A0E00 },
    inputPrompt: { fg: 0xFFD070, bg: 0x1A0E00 },
    inputHint: { fg: 0x775000, bg: 0x1A0E00 },
    dialogStatic: { fg: 0xFFB000, bg: 0x2A1800 },
    dialogFocused: { fg: 0x1A0E00, bg: 0xFFB000 },
    dialogDefault: { fg: 0x1A0E00, bg: 0xFFD070 },
    listNormal: { fg: 0xFFB000, bg: 0x2A1800 },
    listFocused: { fg: 0x1A0E00, bg: 0xFFD070 },
    listSelected: { fg: 0xFFE0A0, bg: 0x4A2A00 },
    listDisabled: { fg: 0x775000, bg: 0x2A1800 },
    userLabel: { fg: 0xFFE0A0, bg: 0x1A0E00 },
    assistantLabel: { fg: 0xFFD070, bg: 0x1A0E00 },
    bodyText: { fg: 0xFFB000, bg: 0x1A0E00 },
    reasoning: { fg: 0xAA7000, bg: 0x1A0E00 },
    toolHeader: { fg: 0xFFE0A0, bg: 0x1A0E00 },
    toolBody: { fg: 0xFFB000, bg: 0x1A0E00 },
    toolRunning: { fg: 0xFFD070, bg: 0x1A0E00 },
    toolSuccess: { fg: 0xC8FF80, bg: 0x1A0E00 },
    toolError: { fg: 0xFF6040, bg: 0x1A0E00 },
    diffAdded: { fg: 0xC8FF80, bg: 0x1A0E00 },
    diffRemoved: { fg: 0xFF6040, bg: 0x1A0E00 },
    diffMeta: { fg: 0xAA7000, bg: 0x1A0E00 },
    code: { fg: 0xFFE0A0, bg: 0x1A0E00 },
    notice: { fg: 0xFFB000, bg: 0x1A0E00 },
    warning: { fg: 0xFFE066, bg: 0x1A0E00 },
    error: { fg: 0xFF6040, bg: 0x1A0E00 },
    accent: { fg: 0xFFD070, bg: 0x1A0E00 },
    searchHit: { fg: 0x1A0E00, bg: 0xFFD070 },
    searchHitDim: { fg: 0x1A0E00, bg: 0xAA7000 },
  },
}

/**
 * The modern dark scheme for people who want the window manager without the
 * costume. Still a character-cell desktop; just not a period piece.
 */
export const SLATE: Skin = {
  id: 'slate',
  name: 'Slate',
  description: 'Modern dark: same desktop, no nostalgia required.',
  palette: {
    desktop: { fg: 0xC8CCD4, bg: 0x15171C },
    desktopText: { fg: 0x6B7280, bg: 0x15171C },
    shadow: { fg: 0x000000, bg: 0x000000 },
    windowFrame: { fg: 0x3A4150, bg: 0x15171C },
    windowTitle: { fg: 0x9AA3B2, bg: 0x232833 },
    windowFrameActive: { fg: 0x58A6FF, bg: 0x15171C },
    windowTitleActive: { fg: 0xE6EDF3, bg: 0x1F6FEB },
    windowBody: { fg: 0xC8CCD4, bg: 0x15171C },
    windowIcon: { fg: 0x15171C, bg: 0x58A6FF },
    windowGrip: { fg: 0xB3D4FF, bg: 0x15171C },
    scrollBar: { fg: 0x3A4150, bg: 0x15171C },
    scrollThumb: { fg: 0x15171C, bg: 0x58A6FF },
    menuBar: { fg: 0xC8CCD4, bg: 0x232833 },
    menuItem: { fg: 0xC8CCD4, bg: 0x232833 },
    menuItemActive: { fg: 0xFFFFFF, bg: 0x1F6FEB },
    menuFrame: { fg: 0x3A4150, bg: 0x1C2029 },
    menuNormal: { fg: 0xC8CCD4, bg: 0x1C2029 },
    menuSelected: { fg: 0xFFFFFF, bg: 0x1F6FEB },
    menuDisabled: { fg: 0x5A6272, bg: 0x1C2029 },
    menuShortcut: { fg: 0x7EE787, bg: 0x1C2029 },
    statusBar: { fg: 0xC8CCD4, bg: 0x232833 },
    statusKey: { fg: 0xFFFFFF, bg: 0x1F6FEB },
    statusLabel: { fg: 0xC8CCD4, bg: 0x232833 },
    statusLine: { fg: 0xC8CCD4, bg: 0x232833 },
    inputFrame: { fg: 0x3A4150, bg: 0x15171C },
    inputFrameActive: { fg: 0x58A6FF, bg: 0x15171C },
    inputBody: { fg: 0xE6EDF3, bg: 0x15171C },
    inputPrompt: { fg: 0x7EE787, bg: 0x15171C },
    inputHint: { fg: 0x5A6272, bg: 0x15171C },
    dialogStatic: { fg: 0xC8CCD4, bg: 0x1C2029 },
    dialogFocused: { fg: 0xFFFFFF, bg: 0x1F6FEB },
    dialogDefault: { fg: 0xFFFFFF, bg: 0x238636 },
    listNormal: { fg: 0xC8CCD4, bg: 0x1C2029 },
    listFocused: { fg: 0xFFFFFF, bg: 0x1F6FEB },
    listSelected: { fg: 0xE6EDF3, bg: 0x2A3140 },
    listDisabled: { fg: 0x5A6272, bg: 0x1C2029 },
    userLabel: { fg: 0x7EE787, bg: 0x15171C },
    assistantLabel: { fg: 0x58A6FF, bg: 0x15171C },
    bodyText: { fg: 0xE6EDF3, bg: 0x15171C },
    reasoning: { fg: 0x8B949E, bg: 0x15171C },
    toolHeader: { fg: 0xD2A8FF, bg: 0x15171C },
    toolBody: { fg: 0xA8B1C0, bg: 0x15171C },
    toolRunning: { fg: 0x58A6FF, bg: 0x15171C },
    toolSuccess: { fg: 0x7EE787, bg: 0x15171C },
    toolError: { fg: 0xFF7B72, bg: 0x15171C },
    diffAdded: { fg: 0x7EE787, bg: 0x15171C },
    diffRemoved: { fg: 0xFF7B72, bg: 0x15171C },
    diffMeta: { fg: 0x6B7280, bg: 0x15171C },
    code: { fg: 0xA5D6FF, bg: 0x15171C },
    notice: { fg: 0x8B949E, bg: 0x15171C },
    warning: { fg: 0xE3B341, bg: 0x15171C },
    error: { fg: 0xFF7B72, bg: 0x15171C },
    accent: { fg: 0x58A6FF, bg: 0x15171C },
    searchHit: { fg: 0x15171C, bg: 0xE3B341 },
    searchHitDim: { fg: 0x15171C, bg: 0x8B949E },
  },
}

/**
 * The terminal's own sixteen colours, so the desktop inherits whatever theme
 * the user already configured. The correct choice for someone whose terminal
 * is already tuned, and the only skin guaranteed legible on a light background.
 */
export const ANSI: Skin = {
  id: 'ansi',
  name: 'ANSI',
  description: "Your terminal's own 16 colours, inherited rather than imposed.",
  ansi16: true,
  palette: {
    desktop: { fg: 7, bg: 4 },
    desktopText: { fg: 6, bg: 4 },
    shadow: { fg: 0, bg: 0 },
    windowFrame: { fg: 6, bg: 4 },
    windowTitle: { fg: 4, bg: 6 },
    windowFrameActive: { fg: 14, bg: 4 },
    windowTitleActive: { fg: 15, bg: 6 },
    windowBody: { fg: 7, bg: 4 },
    windowIcon: { fg: 4, bg: 6 },
    windowGrip: { fg: 15, bg: 4 },
    scrollBar: { fg: 6, bg: 4 },
    scrollThumb: { fg: 4, bg: 6 },
    menuBar: { fg: 7, bg: 6 },
    menuItem: { fg: 0, bg: 6 },
    menuItemActive: { fg: 15, bg: 4 },
    menuFrame: { fg: 0, bg: 7 },
    menuNormal: { fg: 0, bg: 7 },
    menuSelected: { fg: 15, bg: 4 },
    menuDisabled: { fg: 8, bg: 7 },
    menuShortcut: { fg: 4, bg: 7 },
    statusBar: { fg: 0, bg: 6 },
    statusKey: { fg: 15, bg: 4 },
    statusLabel: { fg: 0, bg: 6 },
    statusLine: { fg: 0, bg: 6 },
    inputFrame: { fg: 6, bg: 4 },
    inputFrameActive: { fg: 14, bg: 4 },
    inputBody: { fg: 15, bg: 4 },
    inputPrompt: { fg: 10, bg: 4 },
    inputHint: { fg: 8, bg: 4 },
    dialogStatic: { fg: 0, bg: 7 },
    dialogFocused: { fg: 15, bg: 2 },
    dialogDefault: { fg: 15, bg: 2 },
    listNormal: { fg: 0, bg: 7 },
    listFocused: { fg: 15, bg: 2 },
    listSelected: { fg: 15, bg: 4 },
    listDisabled: { fg: 8, bg: 7 },
    userLabel: { fg: 10, bg: 4 },
    assistantLabel: { fg: 14, bg: 4 },
    bodyText: { fg: 15, bg: 4 },
    reasoning: { fg: 8, bg: 4 },
    toolHeader: { fg: 11, bg: 4 },
    toolBody: { fg: 7, bg: 4 },
    toolRunning: { fg: 14, bg: 4 },
    toolSuccess: { fg: 10, bg: 4 },
    toolError: { fg: 9, bg: 4 },
    diffAdded: { fg: 10, bg: 4 },
    diffRemoved: { fg: 9, bg: 4 },
    diffMeta: { fg: 6, bg: 4 },
    code: { fg: 14, bg: 4 },
    notice: { fg: 7, bg: 4 },
    warning: { fg: 11, bg: 4 },
    error: { fg: 9, bg: 4 },
    accent: { fg: 14, bg: 4 },
    searchHit: { fg: 0, bg: 11 },
    searchHitDim: { fg: 0, bg: 6 },
  },
}

/** Every shipped skin, in picker order. */
export const SKINS: readonly Skin[] = Object.freeze([TURBO_VISION, PHOSPHOR, AMBER, SLATE, ANSI])

/**
 * The skin used when nothing else is configured: the terminal's own sixteen
 * colours, inherited rather than imposed. The Turbo Vision blue remains the
 * demo's showcase and `--skin tvision` away.
 */
export const DEFAULT_SKIN_ID = ANSI.id

/**
 * Look up a skin by id.
 * @param id - The skin id; case-insensitive.
 * @returns The skin, or undefined when unknown.
 */
export function findSkin(id: string): Skin | undefined {
  const wanted = id.trim().toLowerCase()
  return SKINS.find(skin => skin.id === wanted)
}

/**
 * Look up a skin by id, falling back to the default.
 * @param id - The skin id, or undefined.
 * @returns The requested skin, or the default ({@link ANSI}).
 */
export function skinOrDefault(id: string | undefined): Skin {
  if (id === undefined) return ANSI
  return findSkin(id) ?? ANSI
}

