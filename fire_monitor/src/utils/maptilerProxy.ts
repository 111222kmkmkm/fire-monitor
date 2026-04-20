const MAPTILER_API_ORIGIN = 'https://api.maptiler.com'

let installedProxyBase = ''
let originalFetch: typeof fetch | null = null

function normalizeProxyBase(proxyBase: string) {
  return proxyBase.trim().replace(/\/+$/, '')
}

function shouldProxyUrl(url: string) {
  return url.startsWith(`${MAPTILER_API_ORIGIN}/`)
}

function toProxyUrl(url: string, proxyBase: string) {
  return `${proxyBase}/${url.slice(`${MAPTILER_API_ORIGIN}/`.length)}`
}

export function installMapTilerFetchProxy(proxyBase: string) {
  const normalizedProxyBase = normalizeProxyBase(proxyBase)
  if (!normalizedProxyBase || installedProxyBase === normalizedProxyBase) {
    return
  }

  if (!originalFetch) {
    originalFetch = globalThis.fetch.bind(globalThis)
  }

  const proxiedFetch: typeof fetch = (input, init) => {
    const requestUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : String(input)

    if (!shouldProxyUrl(requestUrl) || !originalFetch) {
      return globalThis.fetch === proxiedFetch
        ? originalFetch!(input, init)
        : globalThis.fetch(input, init)
    }

    const proxyUrl = toProxyUrl(requestUrl, normalizedProxyBase)

    if (input instanceof Request) {
      return originalFetch(new Request(proxyUrl, input))
    }

    return originalFetch(proxyUrl, init)
  }

  globalThis.fetch = proxiedFetch
  installedProxyBase = normalizedProxyBase
}
