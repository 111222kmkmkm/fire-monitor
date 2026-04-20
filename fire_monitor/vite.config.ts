import { fileURLToPath, URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import path from 'node:path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import type { PreviewServer, ViteDevServer } from 'vite'

function remoteGeoTiffProxy() {
  return {
    name: 'remote-geotiff-proxy',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/__remote_tiff__', async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? '', 'http://localhost')
          const remoteUrl = requestUrl.searchParams.get('url')

          if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
            res.statusCode = 400
            res.end('missing remote url')
            return
          }

          const upstreamResponse = await fetch(remoteUrl, {
            headers: {
              range: req.headers.range ?? '',
            },
          })

          res.statusCode = upstreamResponse.status
          upstreamResponse.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'access-control-allow-origin') {
              return
            }
            res.setHeader(key, value)
          })

          res.setHeader('access-control-allow-origin', '*')

          if (!upstreamResponse.body) {
            res.end()
            return
          }

          const reader = upstreamResponse.body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            res.write(Buffer.from(value))
          }
          res.end()
        } catch (error) {
          res.statusCode = 502
          res.end(error instanceof Error ? error.message : String(error))
        }
      })
    },
  }
}

function createMapTilerProxyMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    try {
      const requestUrl = new URL(req.url ?? '', 'http://localhost')
      const upstreamPath = requestUrl.pathname
        .replace(/^\/api\/maptiler\/?/, '')
        .replace(/^\/+/, '')
      const upstreamUrl = new URL(`https://api.maptiler.com/${upstreamPath}`)
      upstreamUrl.search = requestUrl.search

      const body = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
        ? undefined
        : req

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            Object.entries(req.headers).filter(([key]) =>
              !['host', 'connection', 'content-length'].includes(key.toLowerCase()),
            ),
          ),
        },
        body,
        duplex: body ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' })

      res.statusCode = upstreamResponse.status
      res.setHeader('x-maptiler-upstream-url', upstreamUrl.toString())
      upstreamResponse.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase()
        if (
          lowerKey === 'access-control-allow-origin' ||
          lowerKey === 'content-encoding' ||
          lowerKey === 'content-length' ||
          lowerKey === 'transfer-encoding'
        ) {
          return
        }
        res.setHeader(key, value)
      })
      res.setHeader('access-control-allow-origin', '*')

      if (!upstreamResponse.body) {
        res.end()
        return
      }

      const reader = upstreamResponse.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        res.write(Buffer.from(value))
      }
      res.end()
    } catch (error) {
      res.statusCode = 502
      res.end(error instanceof Error ? error.message : String(error))
    }
  }
}

function mapTilerProxy() {
  const middleware = createMapTilerProxyMiddleware()

  const attach = (middlewares: { use: (path: string, handler: typeof middleware) => void }) => {
    middlewares.use('/api/maptiler', middleware)
  }

  return {
    name: 'maptiler-local-proxy',
    configureServer(server: ViteDevServer) {
      attach(server.middlewares)
    },
    configurePreviewServer(server: PreviewServer) {
      attach(server.middlewares)
    },
  }
}

function localRealtimeSync() {
  const projectRoot = fileURLToPath(new URL('.', import.meta.url))
  const pullCloudResultsScriptPath = path.join(projectRoot, 'scripts', 'pull-cloud-results.mjs')
  const pullCloudResultsConfigPath = path.join(projectRoot, '.pull-cloud-results.github-pages.example.json')
  type SyncResult = {
    startedAt: string
    finishedAt: string
    stdout: string
    stderr: string
    mode: 'cloud-pull'
  }

  let runningSync: Promise<SyncResult> | null = null

  const execNodeScript = (args: string[]) => {
    const startedAt = new Date().toISOString()
    return new Promise<SyncResult>((resolve, reject) => {
      execFile(
        process.execPath,
        args,
        {
          cwd: projectRoot,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const finishedAt = new Date().toISOString()
          const payload = {
            startedAt,
            finishedAt,
            stdout,
            stderr,
            mode: 'cloud-pull' as const,
          }

          if (error) {
            reject(Object.assign(error, payload))
            return
          }

          resolve(payload)
        },
      )
    })
  }

  const runSyncOnce = () => {
    if (runningSync) {
      return runningSync
    }

    runningSync = execNodeScript([pullCloudResultsScriptPath, '--once', '--config', pullCloudResultsConfigPath]).finally(() => {
      runningSync = null
    })

    return runningSync
  }

  const middleware = async (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, message: 'method not allowed' }))
      return
    }

    try {
      const result = await runSyncOnce()
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        ok: true,
        ...result,
      }))
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        startedAt: typeof error === 'object' && error && 'startedAt' in error ? error.startedAt : null,
        finishedAt: typeof error === 'object' && error && 'finishedAt' in error ? error.finishedAt : null,
        stdout: typeof error === 'object' && error && 'stdout' in error ? error.stdout : '',
        stderr: typeof error === 'object' && error && 'stderr' in error ? error.stderr : '',
      }))
    }
  }

  const attach = (middlewares: { use: (path: string, handler: typeof middleware) => void }) => {
    middlewares.use('/api/local/sync-now', middleware)
  }

  return {
    name: 'local-realtime-sync',
    configureServer(server: ViteDevServer) {
      attach(server.middlewares)
    },
    configurePreviewServer(server: PreviewServer) {
      attach(server.middlewares)
    },
  }
}

export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    remoteGeoTiffProxy(),
    mapTilerProxy(),
    localRealtimeSync(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: false,
    proxy: {
      '/api/dem': {
        target: 'https://api.opentopodata.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/dem/, ''),
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 10000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
