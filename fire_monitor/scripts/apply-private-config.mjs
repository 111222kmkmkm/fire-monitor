#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const privateConfigPath = path.join(projectRoot, '.private.local.json')
const templateConfigPath = path.join(projectRoot, '.sync.config.template.json')
const outputSyncConfigPath = path.join(projectRoot, '.sync.config.json')
const outputEnvPath = path.join(projectRoot, '.env.local')

async function main() {
  const [template, privateConfig] = await Promise.all([
    readJson(templateConfigPath),
    readJson(privateConfigPath),
  ])

  const mergedSyncConfig = {
    ...template,
    variables: {
      ...(template.variables ?? {}),
      ...(privateConfig.sync?.variables ?? {}),
    },
    ftp: {
      ...(template.ftp ?? {}),
      ...(privateConfig.sync?.ftp ?? {}),
    },
  }

  await fs.writeFile(outputSyncConfigPath, `${JSON.stringify(mergedSyncConfig, null, 2)}\n`, 'utf8')
  await fs.writeFile(outputEnvPath, buildEnvFile(privateConfig.frontend ?? {}), 'utf8')

  console.log(`[config] wrote ${path.basename(outputSyncConfigPath)} and ${path.basename(outputEnvPath)}`)
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

function buildEnvFile(frontendConfig) {
  const lines = Object.entries(frontendConfig)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${escapeEnvValue(String(value))}`)

  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function escapeEnvValue(value) {
  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value
}

main().catch((error) => {
  console.error('[config] failed to apply private config', error)
  process.exitCode = 1
})
