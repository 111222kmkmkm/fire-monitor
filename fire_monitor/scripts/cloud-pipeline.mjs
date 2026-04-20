#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const defaultConfigPath = path.resolve(projectRoot, '.cloud-pipeline.config.json')

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const config = await loadJson(options.configPath)

  if (options.once) {
    await runPipeline(config)
    return
  }

  await runPipeline(config)
  const intervalMs = Math.max(Number(config.scheduleMinutes ?? 10), 1) * 60_000
  console.log(`[cloud-pipeline] scheduler started, interval=${intervalMs / 60_000} minutes`)
  while (true) {
    await sleep(intervalMs)
    try {
      await runPipeline(config)
    } catch (error) {
      console.error('[cloud-pipeline] scheduled run failed', error)
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

async function runPipeline(config) {
  const startedAt = new Date()
  const pipelineId = String(config.pipelineId ?? 'himawari-cloud')
  const publishRoot = resolvePath(projectRoot, config.publishRoot ?? `./public/data/cloud-pipelines/${pipelineId}`)
  const tmpRoot = `${publishRoot}.tmp`
  const runVersion = startedAt.toISOString().replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z')

  console.log(`[cloud-pipeline] started id=${pipelineId} at ${startedAt.toISOString()}`)

  if (config.download?.enabled !== false) {
    await runCommandStep(config.download, { PIPELINE_ID: pipelineId })
  }

  for (const step of config.steps ?? []) {
    await runCommandStep(step, { PIPELINE_ID: pipelineId, RUN_VERSION: runVersion })
  }

  const collectedFiles = await collectPublishedFiles(config.outputs ?? [])
  if (collectedFiles.length === 0) {
    throw new Error('no output files were collected for publishing')
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.mkdir(tmpRoot, { recursive: true })

  const manifestFiles = []
  for (const file of collectedFiles) {
    const targetPath = path.join(tmpRoot, file.relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(file.absolutePath, targetPath)
    const stats = await fs.stat(targetPath)
    manifestFiles.push({
      path: file.relativePath.replace(/\\/g, '/'),
      size: stats.size,
      sha256: await checksumFileSha256(targetPath),
    })
  }

  const manifest = {
    pipelineId,
    generatedAt: startedAt.toISOString(),
    version: runVersion,
    files: manifestFiles,
  }

  await fs.writeFile(path.join(tmpRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await fs.rm(publishRoot, { recursive: true, force: true })
  await fs.rename(tmpRoot, publishRoot)

  console.log(`[cloud-pipeline] published ${manifestFiles.length} file(s) to ${publishRoot}`)
}

async function runCommandStep(step, extraEnv = {}) {
  const enabled = step?.enabled !== false
  if (!enabled) {
    return
  }

  const command = Array.isArray(step.command) ? step.command.filter(Boolean) : []
  if (command.length === 0) {
    throw new Error('command step is missing command array')
  }

  const [file, ...args] = command
  const workdir = resolvePath(projectRoot, step.workdir ?? '.')
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [key, renderTemplate(String(value), extraEnv)]),
    ),
    ...extraEnv,
  }

  console.log(`[cloud-pipeline] exec ${file} ${args.join(' ')}`)
  await execFileAsync(file, args, {
    cwd: workdir,
    env,
    timeout: Math.max(Number(step.timeoutMs ?? 900000), 1000),
  })
}

async function collectPublishedFiles(outputs) {
  const files = []
  for (const output of outputs) {
    const outputPath = resolvePath(projectRoot, output.path)
    const stats = await fs.stat(outputPath).catch(() => null)
    if (!stats) {
      console.warn(`[cloud-pipeline] output missing: ${outputPath}`)
      continue
    }

    if (stats.isDirectory()) {
      const baseName = output.targetDir ?? path.basename(outputPath)
      const dirFiles = await walkFiles(outputPath)
      for (const filePath of dirFiles) {
        const rel = path.relative(outputPath, filePath)
        files.push({
          absolutePath: filePath,
          relativePath: path.join(baseName, rel),
        })
      }
      continue
    }

    files.push({
      absolutePath: outputPath,
      relativePath: output.targetPath ?? path.basename(outputPath),
    })
  }

  return dedupeByRelativePath(files)
}

function dedupeByRelativePath(files) {
  const seen = new Set()
  const deduped = []
  for (const file of files) {
    const key = file.relativePath.replace(/\\/g, '/')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(file)
  }
  return deduped
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

async function checksumFileSha256(filePath) {
  const hash = createHash('sha256')
  const buffer = await fs.readFile(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

function renderTemplate(template, variables) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => variables[key] ?? '')
}

function resolvePath(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath)
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || String(error.message ?? '').trim()
        reject(new Error(`${command} failed${detail ? `: ${detail}` : ''}`))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

main().catch((error) => {
  console.error('[cloud-pipeline] fatal error', error)
  process.exitCode = 1
})
