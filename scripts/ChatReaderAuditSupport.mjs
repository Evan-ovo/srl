/** Use the real import menus/file picker; setting a hidden input alone leaves the menu open. */
export async function importReaderFixtureFiles(page, files) {
  await page.getByRole('button', { name: '资源 / 备份', exact: true }).tap()
  await page.getByRole('button', { name: /本地文件.*资源/ }).tap()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /可多选.*单个资源文件/ }).tap()
  await (await chooser).setFiles(files)
}
