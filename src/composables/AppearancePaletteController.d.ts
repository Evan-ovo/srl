import type { ConfirmDialogOptions } from './UseConfirmDialog'

export interface PalettePorts {
  theme: 'light' | 'dark'
  initialCss: string
  sourceId?: string
  readDraft(): Record<string, unknown> | undefined
  writeDraft(value: Record<string, unknown>): void
  savePreset(name: string, css: string): Promise<boolean>
  importCss(name: string, css: string): Promise<boolean>
  download(css: string, name: string): Promise<void>
  preview(css: string, signal: AbortSignal): Promise<void>
  publish?(css: string, preview: HTMLElement, signal: AbortSignal): Promise<void>
  confirm(options: ConfirmDialogOptions, signal?: AbortSignal): Promise<boolean>
  notice(message: string): void
  back(): void
}

export function mountAppearancePalette(
  root: HTMLElement,
  ports: PalettePorts,
): { back(): Promise<void>; setActive(active: boolean): void; dispose(): void }
