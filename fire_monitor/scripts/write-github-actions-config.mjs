#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const githubSyncConfigPath = path.join(projectRoot, 'config', 'sync.github.json')
const githubProcessConfigPath = path.join(projectRoot, 'config', 'process-himawari-fire.github.json')
const githubCloudConfigPath = path.join(projectRoot, 'config', 'cloud-pipeline.github.json')
const legacyGithubSyncConfigPath = path.join(projectRoot, '.sync.config.github.json')
const legacyGithubProcessConfigPath = path.join(projectRoot, '.process-himawari-fire.github.json')
const legacyGithubCloudConfigPath = path.join(projectRoot, '.cloud-pipeline.config.github.json')

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
      },
      {
        id: 'firms_viirs_nrt',
        name: 'NASA FIRMS VIIRS Russia and Asia active fires (24h)',
        type: 'http-static',
        enabled: true,
        timeoutMs: 600000,
        provider: 'NASA FIRMS',
        kind: 'official-active-fire-reference',
        targetDir: 'firms_viirs_nrt',
        keepSnapshots: 1,
        publishLatest: false,
        alwaysDownload: true,
        files: [
          {
            name: 'J1_VIIRS_C2_Russia_Asia_24h.csv',
            url: 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Russia_Asia_24h.csv',
          },
          {
            name: 'J2_VIIRS_C2_Russia_Asia_24h.csv',
            url: 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Russia_Asia_24h.csv',
          },
          {
            name: 'SUOMI_VIIRS_C2_Russia_Asia_24h.csv',
            url: 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Russia_Asia_24h.csv',
          },
        ],
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
    paperStrictMode: false,
    algorithmMode: 'paper-adapted',
    visibleBand: '03',
    visibleReflectancePath: '',
    groundThermalSourcePath: './public/data/support/china_static_thermal_sources.geojson',
    groundThermalSourcePaths: [
      './public/data/support/china_static_thermal_sources.geojson',
      './public/data/support/china_photovoltaic_facilities.geojson',
    ],
    nonVegetationMaskPath: './public/data/support/china_non_vegetation_mask.geojson',
    inputRoot: './data-store/runtime-data/himawari9_ahi',
    outputDir: './public/data/algorithm/latest',
    statePath: './data-store/algorithm-state/himawari-fire.json',
    chinaBoundaryPath: './public/data/china-boundary.geojson',
    databasePath: './fire_monitor.geodatabase',
    officialFusion: {
      enabled: true,
      referenceGlobs: [
        './data-store/runtime-data/firms_viirs_nrt/**/*.csv',
        './data-store/runtime-data/viirs_noaa20_nrt/**/*.csv',
        './public/data/published/viirs_noaa20_nrt/**/*.csv',
      ],
      timeWindowHours: 3,
      spatialMatchKm: 4,
      acceptedViirsConfidence: ['nominal', 'high', 'n', 'h'],
      minModisConfidence: 30,
    },
    sourceSat: 'H09',
    bands: ['03', '07', '13', '14'],
    minSegmentsPerBand: 4,
    requiredSegments: ['01', '02', '03', '04'],
    maxSnapshotAgeMinutes: 30,
    failOnStaleSnapshot: true,
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
      nightAbsoluteT7K: 320,
      nightVisibleMax: 0.7,
      nightZenithDeg: 87,
      cloudVisibleReflectance: 0.28,
      cloudZenithLimitDeg: 70,
      cloudVisibleDelta: 0.15,
      cloudT13DeltaK: 5,
      edgeThresholdC: 6,
      thermalSourceRadiusKm: 4.0,
      minBackgroundPixels: 4,
      minStdT713K: 2.0,
      maxStdT713K: 4.0,
      absoluteScoreScaleK: 10.0,
      confidenceMediumScore: 2.0,
      confidenceHighScore: 3.5,
    },
    // 仅在完整历史场景与真实 VIIRS 标签回测通过后开启。
    candidateRescue: {
      enabled: false,
      dynamicFactorScale: 0.8,
      edgeThresholdC: 5.0,
      maxCandidatesPerScene: 400,
    },
    v15Scorer: {
      enabled: true,
      modelPath: './models/himawari-fire-recognition-production/candidate_classifier.txt',
      modelCardPath: './models/himawari-fire-recognition-production/model-card.json',
      temporalStatePath: './data-store/algorithm-state/himawari-v15-online-grid-temporal.parquet',
      westLonMax: 105.0,
      westBudget: 50,
      applyToNonWest: false,
      mideastEnabled: true,
      mideastModelPath: './models/himawari-fire-recognition-mideast-production/candidate_classifier.txt',
      mideastModelCardPath: './models/himawari-fire-recognition-mideast-production/model-card.json',
      mideastBudget: 50,
      scoreScale: 10.0,
      confidenceHighProb: 0.65,
      confidenceMediumProb: 0.35,
      rescueMinProbability: 0.35,
      gridDeg: 0.05,
      temporalKeepSlots: 400,
      // 云端保活：scorer 异常时回退物理规则，避免 5 分钟链路整轮失败
      failOpen: true,
      notes: 'GitHub 云端：西部 west-b70；中东部(lon>=105) mideast-phaseb 专模(F3/seed731 recall@B50=0.2316)',
    },
    mideastDistilled: {
      enabled: false,
      configPath: './config/process-himawari-mideast-distilled.json',
      failOpen: true,
      notes: '中东部改用 v15Scorer.mideastEnabled 专模；本规则仅作 failOpen 兜底，默认禁用',
    },
  }

  const cloudPipelineConfig = {
    pipelineId: 'himawari-fire',
    scheduleMinutes: 10,
    publishRoot: './cloud-build/pages',
    download: {
      enabled: true,
      command: ['node', './scripts/sync-data.mjs', '--once', '--config', './config/sync.github.json'],
      workdir: '.',
      timeoutMs: 900000,
    },
    steps: [
      {
        name: 'process-himawari-fire',
        command: ['python', './scripts/process-himawari-fire.py', '--config', './config/process-himawari-fire.github.json'],
        workdir: '.',
        timeoutMs: 900000,
      },
    ],
    outputs: [
      {
        path: './public/data/algorithm/latest/candidate_fire.geojson',
        targetPath: 'algorithm/latest/candidate_fire.geojson',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_pixels.geojson',
        targetPath: 'algorithm/latest/candidate_fire_pixels.geojson',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_clusters.geojson',
        targetPath: 'algorithm/latest/candidate_fire_clusters.geojson',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_official.geojson',
        targetPath: 'algorithm/latest/candidate_fire_official.geojson',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_grid.npz',
        targetPath: 'algorithm/latest/candidate_fire_grid.npz',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_summary.json',
        targetPath: 'algorithm/latest/candidate_fire_summary.json',
        required: true,
      },
      {
        path: './public/data/algorithm/latest/candidate_fire_v15_scorer_summary.json',
        targetPath: 'algorithm/latest/candidate_fire_v15_scorer_summary.json',
        required: false,
      },
      {
        path: './public/data/catalog.json',
        targetPath: 'catalog.json',
        required: true,
      },
    ],
  }

  await writeJson(githubSyncConfigPath, syncConfig)
  await writeJson(githubProcessConfigPath, processConfig)
  await writeJson(githubCloudConfigPath, cloudPipelineConfig)
  await writeJson(legacyGithubSyncConfigPath, syncConfig)
  await writeJson(legacyGithubProcessConfigPath, processConfig)
  await writeJson(legacyGithubCloudConfigPath, cloudPipelineConfig)

  console.log(`[github-actions-config] wrote ${path.basename(githubSyncConfigPath)}`)
  console.log(`[github-actions-config] wrote ${path.basename(githubProcessConfigPath)}`)
  console.log(`[github-actions-config] wrote ${path.basename(githubCloudConfigPath)}`)
  console.log('[github-actions-config] wrote legacy root config aliases for existing workflow paths')
  console.log(`[github-actions-config] JAXA FTP fallback ${ftpEnabled ? 'enabled' : 'disabled'}`)
}

function readEnv(key) {
  const value = process.env[key]
  return typeof value === 'string' ? value.trim() : ''
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

main().catch((error) => {
  console.error('[github-actions-config] fatal error', error)
  process.exitCode = 1
})
