#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const defaultConfigPath = path.resolve(projectRoot, '.pull-cloud-results.config.json')

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const config = await loadJson(options.configPath)

  if (options.once) {
    await syncCloudResults(config)
    return
  }

  await syncCloudResults(config)
  const intervalMs = Math.max(Number(config.scheduleMinutes ?? 1), 1) * 60_000
  console.log(`[pull-cloud-results] scheduler started, interval=${intervalMs / 60_000} minutes`)
  while (true) {
    await sleep(intervalMs)
    try {
      await syncCloudResults(config)
    } catch (error) {
      console.error('[pull-cloud-results] scheduled run failed', error)
    }
  }
}

function parseCliArgs(argv) {
  const options = {
    once: false,
    configPath: defaultConfigPath,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--once') {
      options.once = true
      continue
    }
    if (arg === '--config') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('missing value for --config')
      }
      options.configPath = resolvePath(projectRoot, value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return options
}

async function syncCloudResults(config) {
  const manifestUrl = String(config.manifestUrl ?? '').trim()
  if (!manifestUrl) {
    throw new Error('manifestUrl is required')
  }

  const targetRoot = resolvePath(projectRoot, config.targetRoot ?? './public/data/published/cloud-results')
  const statePath = resolvePath(projectRoot, config.statePath ?? './data-store/cloud-results-state.json')
  const requestTimeoutMs = Math.max(Number(config.requestTimeoutMs ?? 30000), 1000)
  const maxParallelDownloads = Math.max(Number(config.maxParallelDownloads ?? 6), 1)

  const manifest = await fetchJson(manifestUrl, requestTimeoutMs)
  const previousState = await loadJsonIfExists(statePath)
  const baseUrl = new URL('.', manifestUrl).toString()
  const files = Array.isArray(manifest.files) ? manifest.files : []

  await fs.mkdir(targetRoot, { recursive: true })
  const pendingChecks = await Promise.all(
    files.map(async (file) => ({
      file,
      shouldDownload: await shouldDownloadFile(file, previousState, targetRoot),
    })),
  )
  const pending = pendingChecks.filter((entry) => entry.shouldDownload).map((entry) => entry.file)

  await mapWithConcurrency(pending, maxParallelDownloads, async (file) => {
    const fileUrl = new URL(file.path, baseUrl).toString()
    const localPath = path.join(targetRoot, file.path)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await downloadFile(fileUrl, localPath, requestTimeoutMs)
  })

  await pruneMissingFiles(targetRoot, files)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.writeFile(statePath, JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`[pull-cloud-results] synced ${pending.length}/${files.length} file(s) from cloud manifest`)
}

async function shouldDownloadFile(file, previousState, targetRoot) {
  if (!file || typeof file.path !== 'string') {
    return false
  }

  const previousFiles = Array.isArray(previousState?.files) ? previousState.files : []
  const previous = previousFiles.find((entry) => entry.path === file.path)
  const localPath = path.join(targetRoot, file.path)

  if (!previous) {
    return true
  }
  if (previous.sha256 !== file.sha256 || previous.size !== file.size) {
    return true
  }
  return !(await pathExists(localPath))
}

async function pruneMissingFiles(targetRoot, files) {
  const keep = new Set(files.map((file) => path.normalize(file.path)))
  const existing = await walkFiles(targetRoot).catch(() => [])
  for (const filePath of existing) {
    const relative = path.normalize(path.relative(targetRoot, filePath))
    if (keep.has(relative)) {
      continue
    }
    await fs.rm(filePath, { force: true })
  }
}

async function fetchJson(url, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs)
  if (!response.ok) {
    throw new Error(`manifest request failed: ${response.status}`)
  }
  return response.json()
}

async function downloadFile(url, localPath, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs)
  if (!response.ok) {
    throw new Error(`download failed ${response.status} for ${url}`)
  }
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer()
    await fs.writeFile(localPath, Buffer.from(arrayBuffer))
    return
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath))
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  await Promise.all(workers)
  return results
}

async function walkFiles(rootDir) {
  const results = []
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkFiles(fullPath))
    } else if (entry.isFile()) {
      results.push(fullPath)
    }
  }
  return results
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function loadJsonIfExists(filePath) {
  try {
    return await loadJson(filePath)
  } catch {
    return null
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function resolvePath(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error('[pull-cloud-results] fatal error', error)
  process.exitCode = 1
})
