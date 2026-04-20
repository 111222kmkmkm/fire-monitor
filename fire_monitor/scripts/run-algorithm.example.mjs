#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

async function main() {
  const outputDir = path.join(projectRoot, 'public', 'data', 'algorithm', 'latest')
  await fs.mkdir(outputDir, { recursive: true })

  const payload = {
    generatedAt: new Date().toISOString(),
    message: 'Replace this script with your real fire-detection algorithm.',
    outputs: [
      'public/data/algorithm/latest/candidate_fire.geojson',
      'public/data/algorithm/manifest.json',
    ],
  }

  await fs.writeFile(
    path.join(outputDir, 'candidate_fire.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: [] }, null, 2),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'public', 'data', 'algorithm', 'manifest.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  )

  console.log('[algorithm-example] placeholder outputs written')
}

main().catch((error) => {
  console.error('[algorithm-example] fatal error', error)
  process.exitCode = 1
})
