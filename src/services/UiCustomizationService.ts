import type { CustomUiView } from '../types/UiCustomization'

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
  return `<script>${vendors?.vue?.replace(/<\/script/giu, '<\\/script') || ''}</script>\n${result.authorSource}`
}
