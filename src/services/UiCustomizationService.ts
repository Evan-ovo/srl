import type { CustomUiView } from '../types/UiCustomization'

/** Identifies compiler inputs; activation and legacy network flags do not alter compilation. */
export function customUiSourceKey(view: CustomUiView): string {
  return JSON.stringify([view.entryPath, view.files])
}

/** Serialized into this UI sandbox only; Vue catches component errors before window.error. */
function installVueErrorBoundary() {
  type VueFactories = {
    -readonly [Name in 'createApp' | 'createSSRApp']: (typeof import('vue'))[Name]
  }
  const vue = (window as unknown as { Vue: VueFactories }).Vue
  for (const name of ['createApp', 'createSSRApp'] as const) {
    const create = vue[name]
    vue[name] = (...args: Parameters<typeof create>) => {
      const app = create(...args)
      app.config.errorHandler = (error) => {
        window.dispatchEvent(
          new ErrorEvent('error', {
            error,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      return app
    }
  }
}

export async function compileCustomUiView(
  view: CustomUiView,
  engine?: import('./FrontendWorkshopBrowserSourceCompilerService').FrontendWorkshopBrowserBuildEngine,
): Promise<string> {
  const { FrontendWorkshopBrowserSourceCompilerService } =
    await import('./FrontendWorkshopBrowserSourceCompilerService')
  const { loadPreviewVendorLibs } = await import('../utils/PreviewVendorLibs')
  const files = view.files.map((file) => ({
    path: file.path,
    contents:
      file.encoding === 'base64'
        ? Uint8Array.from(atob(file.contents), (character) => character.charCodeAt(0))
        : file.contents,
  }))
  const [result, vendors] = await Promise.all([
    new FrontendWorkshopBrowserSourceCompilerService(engine).compile({
      entryPath: view.entryPath,
      files,
    }),
    loadPreviewVendorLibs({ jquery: false, vue: true }),
  ])
  return `<script>${vendors?.vue?.replace(/<\/script/giu, '<\\/script') || ''}\n;(${installVueErrorBoundary.toString()})()</script>\n${result.authorSource}`
}
