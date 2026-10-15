/** Shared public-web authority; workflow result checks verify their own target. */
export function isAssistantBrowserUrl(url: URL): boolean {
  const host = url.hostname
  return (
    url.protocol === 'https:' &&
    host.includes('.') &&
    !/^[0-9.]+$/u.test(host) &&
    !host.includes(':') &&
    !host.startsWith('[') &&
    !/(?:\.localhost|\.local|\.internal|\.intranet|\.home|\.home\.arpa|\.test|\.invalid|\.example)$/iu.test(
      host,
    ) &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443')
  )
}
