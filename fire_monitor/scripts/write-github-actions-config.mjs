#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const githubSyncConfigPath = path.join(projectRoot, '.sync.config.github.json')
const githubProcessConfigPath = path.join(projectRoot, '.process-himawari-fire.github.json')
const githubCloudConfigPath = path.join(projectRoot, '.cloud-pipeline.config.github.json')

async function main() {
  const ftpUser = readEnv('JAXA_FTP_USER')
  const ftpPassword = readEnv('JAXA_FTP_PASSWORD')
  const ftpEnabled = Boolean(ftpUser && ftpPassword)

  const syncConfig = {
    scheduleMinutes: 1,
    dataRoot: './data-store/runtime-data',
    catalogOutput: './public/data/catalog.json',
    sources: [
      {
        id: 'himawari9_ahi_b03_b07_b13_b14',
        name: 'Himawari-9 AHI fire inputs',
        type: 'noaa-aws-s3-himawari',
        enabled: true,
        timeoutMs: 900000,
        provider: 'NOAA Open Data on AWS',
        kind: 'satellite-thermal',
        targetDir: 'himawari9_ahi',
        keepSnapshots: 2,
        publishLatest: false,
        timelineMinutes: 10,
        lookbackSlots: 2,
        slotAvailabilityLagMinutes: 12,
        requestTimeoutMs: 30000,
        downloadTimeoutMs: 180000,
        listMaxKeys: 1000,
        maxParallelDownloads: 36,
        bandParallelDownloads: 3,
        bandDownloadTimeoutMs: 180000,
        maxDownloadRetries: 2,
        downloadRetryDelayMs: 500,
        skipMd5WhenEtag: true,
        progressLogEvery: 10,
        bucket: 'noaa-himawari9',
        bucketRegion: 'us-east-1',
        productPrefix: 'AHI-L1b-FLDK',
        preferLatestCompleteSlot: true,
        requireAllBandsInSlot: true,
        targetSegments: ['01', '02', '03', '04'],
        minSegmentsPerBand: 4,
        deterministicSlotDownload: true,
        skipMd5: true,
        retentionMinutes: 60,
        storeFileBlobInDatabase: false,
        acqTimePattern: '(?<date>\\d{8})_(?<time>\\d{4})',
        bands: ['03', '07', '13', '14'],
        satellite: 'H09',
        sensor: 'AHI',
        roiCode: 'CN',
        databasePath: './fire_monitor.geodatabase',
        postProcessCommand: ['python', './scripts/process-himawari-fire.py', '--config', './.process-himawari-fire.github.json'],
        postProcessFailureMode: 'warn',
        postProcessOnceKey: 'github-actions-himawari-fire',
        postProcessTimeoutMs: 900000,
      },
    ],
  }

  if (ftpEnabled) {
    syncConfig.ftp = {
      host: 'ftp.ptree.jaxa.jp',
      user: ftpUser,
      password: ftpPassword,
      secure: false,
    }
    syncConfig.sources[0].fallbackType = 'jaxa-ftp-himawari'
    syncConfig.sources[0].ftpFallbackBands = ['03']
    syncConfig.sources[0].ftpBasePath = '/jma/hsd'
  }

  const processConfig = {
    paperStrictMode: true,
    visibleBand: '03',
    visibleReflectancePath: '',
    groundThermalSourcePath: './public/data/support/china_static_thermal_sources.geojson',
    nonVegetationMaskPath: './public/data/support/china_non_vegetation_mask.geojson',
    inputRoot: './data-store/runtime-data/himawari9_ahi',
    outputDir: './public/data/algorithm/latest',
    statePath: './data-store/algorithm-state/himawari-fire.json',
    chinaBoundaryPath: './public/data/china-boundary.geojson',
    databasePath: './fire_monitor.geodatabase',
    sourceSat: 'H09',
    bands: ['03', '07', '13', '14'],
    minSegmentsPerBand: 4,
    maxSnapshotAgeMinutes: 30,
    cropMarginPixels: 24,
    roi: {
      minLon: 73.0,
      maxLon: 135.5,
      minLat: 18.0,
      maxLat: 54.0,
    },
    windowSizes: [7, 9, 11, 19],
    thresholds: {
      suspiciousOffsetK: 20,
      suspiciousVisibleFactor: 100,
      minValidRatio: 0.2,
      nightAbsoluteT7K: 360,
      nightVisibleMax: 0.7,
      nightZenithDeg: 87,
      cloudVisibleReflectance: 0.28,
      cloudZenithLimitDeg: 70,
      cloudVisibleDelta: 0.15,
      cloudT13DeltaK: 5,
      edgeThresholdC: 8,
      thermalSourceRadiusKm: 4.0,
      minBackgroundPixels: 4,
    },
  }

  const cloudPipelineConfig = {
    pipelineId: 'himawari-fire',
    scheduleMinutes: 10,
    publishRoot: './cloud-build/pages',
    download: {
      enabled: true,
      command: ['node', './scripts/sync-data.mjs', '--once', '--config', './.sync.config.github.json', '--source', 'himawari9_ahi_b03_b07_b13_b14'],
      workdir: '.',
      timeoutMs: 900000,
    },
    steps: [],
    outputs: [
      {
        path: './public/data/algorithm/latest',
        targetDir: 'algorithm/latest',
      },
      {
        path: './public/data/catalog.json',
        targetPath: 'catalog.json',
      },
    ],
  }

  await writeJson(githubSyncConfigPath, syncConfig)
  await writeJson(githubProcessConfigPath, processConfig)
  await writeJson(githubCloudConfigPath, cloudPipelineConfig)

  console.log(`[github-actions-config] wrote ${path.basename(githubSyncConfigPath)}`)
  console.log(`[github-actions-config] wrote ${path.basename(githubProcessConfigPath)}`)
  console.log(`[github-actions-config] wrote ${path.basename(githubCloudConfigPath)}`)
  console.log(`[github-actions-config] JAXA FTP fallback ${ftpEnabled ? 'enabled' : 'disabled'}`)
}

function readEnv(key) {
  const value = process.env[key]
  return typeof value === 'string' ? value.trim() : ''
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

main().catch((error) => {
  console.error('[github-actions-config] fatal error', error)
  process.exitCode = 1
})
