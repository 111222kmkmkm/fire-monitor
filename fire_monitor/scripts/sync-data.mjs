#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const defaultConfigPath = path.resolve(projectRoot, '.sync.config.json')
const postProcessExecutionCache = new Map()

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const config = await loadConfig(options.configPath)

  if (options.once) {
    await runSync(config, options)
    return
  }

  try {
    await runSync(config, options)
  } catch (error) {
    console.error('[sync] first run failed, scheduler will continue', error)
  }

  const intervalMs = Math.max(Number(config.scheduleMinutes ?? 30), 1) * 60_000
  console.log(`[sync] scheduler started, interval=${intervalMs / 60_000} minutes`)

  while (true) {
    await sleep(intervalMs)
    try {
      await runSync(config, options)
    } catch (error) {
      console.error('[sync] scheduled run failed, waiting for next round', error)
    }
  }
}

function parseCliArgs(argv) {
  const options = {
    once: false,
    configPath: defaultConfigPath,
    onlySource: null,
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
    if (arg === '--source') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('missing value for --source')
      }
      options.onlySource = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return options
}

async function runSync(config, options = {}) {
  const startedAt = new Date()
  console.log(`[sync] run started at ${startedAt.toISOString()}`)

  const variables = buildVariables(config.variables ?? {}, startedAt)
  const dataRoot = resolvePath(projectRoot, config.dataRoot ?? './data-store')
  const catalogOutput = resolvePath(projectRoot, config.catalogOutput ?? './public/data/catalog.json')
  const previousCatalog = await loadCatalogIfExists(catalogOutput)
  const previousBySourceId = new Map(
    Array.isArray(previousCatalog?.sources)
      ? previousCatalog.sources
          .filter((entry) => entry && typeof entry.id === 'string')
          .map((entry) => [entry.id, entry])
      : [],
  )

  await ensureDir(dataRoot)
  await ensureDir(path.dirname(catalogOutput))

  const catalog = {
    generatedAt: startedAt.toISOString(),
    dataRoot,
    sources: [],
  }

  for (const source of config.sources ?? []) {
    if (options.onlySource && source.id !== options.onlySource) {
      continue
    }

    if (!source.enabled) {
      catalog.sources.push({
        id: source.id,
        name: source.name,
        provider: source.provider ?? '',
        kind: source.kind ?? 'unknown',
        enabled: false,
        status: 'disabled',
        message: 'source disabled in config',
        latestSnapshot: null,
        latestFiles: [],
        overlay: null,
      })
      continue
    }

    try {
      console.log(`[sync] source ${source.id} started`)
      const sourceTimeoutMs = Math.max(Number(source.timeoutMs ?? config.sourceTimeoutMs ?? 180000), 10000)
      const entry = await withTimeout(
        syncSource({
          source,
          config,
          dataRoot,
          variables,
        }),
        sourceTimeoutMs,
        `${source.id} timed out after ${sourceTimeoutMs}ms`,
      )
      console.log(`[sync] source ${source.id} finished`)
      catalog.sources.push(entry)
    } catch (error) {
      const previous = previousBySourceId.get(source.id)
      const message = error instanceof Error ? error.message : String(error)
      const fallbackPublishedFiles = await readPublishedFiles(source.id)
      const previousFiles = Array.isArray(previous?.latestFiles) ? previous.latestFiles : []
      const recoveredFiles = previousFiles.length > 0 ? previousFiles : fallbackPublishedFiles
      catalog.sources.push({
        id: source.id,
        name: source.name,
        provider: source.provider ?? '',
        kind: source.kind ?? 'unknown',
        enabled: true,
        status: 'error',
        message:
          recoveredFiles.length > 0
            ? `${message} (showing last available files)`
            : message,
        latestSnapshot:
          typeof previous?.latestSnapshot === 'string' ? previous.latestSnapshot : null,
        acquisitionTime:
          typeof previous?.acquisitionTime === 'string' ? previous.acquisitionTime : null,
        downloadedAt:
          typeof previous?.downloadedAt === 'string' ? previous.downloadedAt : null,
        latestFiles: recoveredFiles,
        overlay: previous?.overlay ?? null,
      })
      console.error(`[sync] ${source.id} failed`, error)
    }
  }

  await fs.writeFile(catalogOutput, JSON.stringify(catalog, null, 2), 'utf8')
  await mirrorPublicFileToDist(catalogOutput)
  console.log(`[sync] catalog written to ${catalogOutput}`)
}

async function syncSource(context) {
  const { source, config, dataRoot, variables } = context
  const sourceRoot = path.join(dataRoot, source.targetDir ?? source.id)
  await ensureDir(sourceRoot)

  let result
  if (source.type === 'http-cycle') {
    result = await syncHttpCycle({ source, sourceRoot, variables })
  } else if (source.type === 'noaa-aws-s3-himawari') {
    result = await syncPreferredHimawariSource({ source, sourceRoot, variables, config })
  } else if (source.type === 'jaxa-ftp-himawari') {
    result = await syncJaxaFtpHimawari({ source, sourceRoot, variables, config })
  } else if (source.type === 'windy-point-grid') {
    result = await syncWindyPointGrid({ source, sourceRoot, variables })
  } else if (source.type === 'remote-reference') {
    result = await syncRemoteReference({ source, variables })
  } else if (source.type === 'http-static') {
    result = await syncHttpStatic({ source, sourceRoot })
  } else {
    throw new Error(`unsupported source type: ${source.type}`)
  }

  await cleanupExpiredSourceData({
    source,
    sourceRoot,
    latestAcquisitionTime: result.acquisitionTime ?? null,
  })
  if (!resolveRetentionMinutes(source)) {
    await cleanupOldSnapshots(sourceRoot, result.snapshotKey, source.keepSnapshots ?? 1)
  }

  let publishedFiles = []
  if (source.publishLatest) {
    publishedFiles = await publishLatestFiles(source.id, result.files)
  }

  const latestFiles = result.files.map((file, index) => ({
    fileName: path.basename(file.localPath),
    localPath: file.localPath,
    size: file.size ?? 0,
    webPath: publishedFiles[index]?.webPath ?? file.webPath ?? null,
    publishedPath: publishedFiles[index]?.publishedPath ?? null,
  }))

  const overlay = result.overlay ? resolveOverlay(result.overlay, latestFiles) : null

  if (Array.isArray(source.postProcessCommand) && source.postProcessCommand.length > 0) {
    await runPostProcessCommand({
      source,
      result,
      sourceRoot,
    })
  }

  return {
    id: source.id,
    name: source.name,
    provider: source.provider ?? '',
    kind: source.kind ?? 'unknown',
    enabled: true,
    status: 'ok',
    message: result.message ?? 'sync completed',
    latestSnapshot: result.snapshotKey,
    acquisitionTime: result.acquisitionTime ?? null,
    downloadedAt: new Date().toISOString(),
    latestFiles,
    overlay,
  }
}

async function runPostProcessCommand({ source, result, sourceRoot }) {
  const command = source.postProcessCommand.filter(Boolean)
  if (!command.length) {
    return
  }

  const [file, ...args] = command
  const workdir = resolvePath(projectRoot, source.postProcessWorkdir ?? '.')
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(source.postProcessEnv ?? {}).map(([key, value]) => [
        key,
        renderTemplate(String(value), {
          SOURCE_ID: source.id,
          SOURCE_ROOT: sourceRoot,
          SNAPSHOT_KEY: result.snapshotKey ?? '',
          ACQ_TIME: result.acquisitionTime ?? '',
        }),
      ]),
    ),
    SOURCE_ID: source.id,
    SOURCE_ROOT: sourceRoot,
    SNAPSHOT_KEY: result.snapshotKey ?? '',
    ACQ_TIME: result.acquisitionTime ?? '',
  }

  console.log(`[sync] post-process ${source.id}: ${file} ${args.join(' ')}`)
  const executionKey = [
    String(source.postProcessOnceKey ?? command.join('\u0000')),
    String(result.snapshotKey ?? ''),
    String(result.acquisitionTime ?? ''),
  ].join('::')

  let execution = postProcessExecutionCache.get(executionKey)
  if (!execution) {
    execution = execFileAsync(file, args, {
      cwd: workdir,
      env,
      timeout: Math.max(Number(source.postProcessTimeoutMs ?? source.timeoutMs ?? 180000), 1000),
    }).catch((error) => {
      postProcessExecutionCache.delete(executionKey)
      throw error
    })
    postProcessExecutionCache.set(executionKey, execution)
  } else {
    console.log(`[sync] post-process ${source.id} reused existing execution for snapshot ${result.snapshotKey ?? 'unknown'}`)
  }

  try {
    await execution
  } catch (error) {
    const failureMode = String(source.postProcessFailureMode ?? (source.postProcessOptional ? 'warn' : 'error')).toLowerCase()
    if (failureMode === 'warn') {
      console.warn(
        `[sync] post-process ${source.id} skipped after failure: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    throw error
  }
}

async function mirrorPublicFileToDist(filePath) {
  const publicRoot = path.resolve(projectRoot, 'public')
  const absolutePath = path.resolve(filePath)
  if (!isPathInsideRoot(publicRoot, absolutePath)) {
    return
  }
  const relativePath = path.relative(publicRoot, absolutePath)
  const distPath = path.resolve(projectRoot, 'dist', relativePath)
  await ensureDir(path.dirname(distPath))
  await fs.copyFile(absolutePath, distPath).catch(() => {})
}

async function syncHttpCycle({ source, sourceRoot, variables }) {
  const cycleHours = Array.isArray(source.cycleHours) && source.cycleHours.length > 0 ? source.cycleHours : ['00', '06', '12', '18']
  const forecastHours = Array.isArray(source.forecastHours) && source.forecastHours.length > 0 ? source.forecastHours : ['000']
  const cycleCandidates = buildRecentCycleCandidates(cycleHours, source.availabilityLagHours ?? 5, 8)

  for (const cycleDate of cycleCandidates) {
    const cycleVars = buildVariables(variables, cycleDate)
    const firstFileName = renderTemplate(source.fileTemplate, { ...cycleVars, FFF: forecastHours[0] })
    const snapshotKey = `${cycleVars.YYYYMMDD}${cycleVars.HH}`
    const snapshotDir = path.join(sourceRoot, snapshotKey)
    await ensureDir(snapshotDir)
    const files = []

    const firstUrl = buildCycleUrl(source, cycleVars, firstFileName)
    const firstLocalPath = path.join(snapshotDir, sanitizeFileName(firstFileName))
    try {
      if (!(await fileExists(firstLocalPath))) {
        await downloadFile(firstUrl, firstLocalPath)
      }
      const firstStats = await fs.stat(firstLocalPath)
      files.push({ localPath: firstLocalPath, size: firstStats.size })
    } catch (error) {
      if (await fileExists(firstLocalPath)) {
        await fs.rm(firstLocalPath, { force: true })
      }
      console.warn(`[sync] skip GFS cycle ${snapshotKey}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    for (const forecastHour of forecastHours.slice(1)) {
      const fileName = renderTemplate(source.fileTemplate, { ...cycleVars, FFF: forecastHour })
      const url = buildCycleUrl(source, cycleVars, fileName)
      const localPath = path.join(snapshotDir, sanitizeFileName(fileName))
      if (!(await fileExists(localPath))) {
        await downloadFile(url, localPath)
      }
      const stats = await fs.stat(localPath)
      files.push({ localPath, size: stats.size })
    }

    const overlayPath = path.join(snapshotDir, 'gfs_surface_overlay.geojson')
    await writeGfsOverlay(files[0].localPath, overlayPath, source.sampleStep ?? 16)
    const overlayStats = await fs.stat(overlayPath)
    files.push({ localPath: overlayPath, size: overlayStats.size })

    return {
      snapshotKey,
      acquisitionTime: `${cycleVars.YYYY}-${cycleVars.MM}-${cycleVars.DD}T${cycleVars.HH}:00:00Z`,
      message: `downloaded ${forecastHours.length} GFS files and built overlay`,
      files,
      overlay: {
        type: 'geojson-gfs',
        localPath: overlayPath,
        description: 'GFS 2m temperature grid with 10m wind metadata',
      },
    }
  }

  throw new Error('no available GFS cycle found')
}

async function syncPreferredHimawariSource({ source, sourceRoot, variables, config }) {
  try {
    return await syncNoaaAwsS3Himawari({ source, sourceRoot, variables, config })
  } catch (error) {
    if (source.fallbackType !== 'jaxa-ftp-himawari') {
      throw error
    }

    console.warn(
      `[sync] NOAA preferred source failed, falling back to JAXA FTP: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )

    const fallbackSource = {
      ...source,
      type: 'jaxa-ftp-himawari',
    }
    return syncJaxaFtpHimawari({ source: fallbackSource, sourceRoot, variables, config })
  }
}

async function syncNoaaAwsS3Himawari({ source, sourceRoot, variables, config }) {
  const bucket = String(source.bucket ?? 'noaa-himawari9')
  const bucketRegion = String(source.bucketRegion ?? 'us-east-1')
  const productPrefix = String(source.productPrefix ?? 'AHI-L1b-FLDK')
  const timelineMinutes = Math.max(Number(source.timelineMinutes ?? 10), 1)
  const lookbackSlots = Math.max(Number(source.lookbackSlots ?? 3), 1)
  const slotAvailabilityLagMinutes = Math.max(Number(source.slotAvailabilityLagMinutes ?? 20), 0)
  const requestTimeoutMs = Math.max(Number(source.requestTimeoutMs ?? 45000), 5000)
  const downloadTimeoutMs = Math.max(Number(source.downloadTimeoutMs ?? 240000), 10000)
  const maxDownloadRetries = Math.max(Number(source.maxDownloadRetries ?? 2), 0)
  const downloadRetryDelayMs = Math.max(Number(source.downloadRetryDelayMs ?? 1000), 0)
  const listMaxKeys = Math.min(Math.max(Number(source.listMaxKeys ?? 1000), 1), 1000)
  const maxParallelDownloads = Math.max(Number(source.maxParallelDownloads ?? 24), 1)
  const bandParallelDownloads = Math.max(Number(source.bandParallelDownloads ?? 1), 1)
  const bandDownloadTimeoutMs = Math.max(Number(source.bandDownloadTimeoutMs ?? 180000), 10000)
  const ftpFallbackBands = new Set(normalizeBands(source.ftpFallbackBands ?? ['03']))
  const progressLogEvery = Math.max(Number(source.progressLogEvery ?? 10), 1)
  const preferLatestCompleteSlot = source.preferLatestCompleteSlot !== false
  const requireAllBandsInSlot = source.requireAllBandsInSlot !== false
  const minSegmentsPerBand = Math.max(Number(source.minSegmentsPerBand ?? 1), 1)
  const skipMd5WhenEtag = source.skipMd5WhenEtag !== false
  const satellite = String(source.satellite ?? 'H09')
  const sensor = String(source.sensor ?? 'AHI')
  const roiCode = String(source.roiCode ?? variables.ROI_CODE ?? 'CN')
  const bands = normalizeBands(source.bands ?? ['07', '13', '14'])
  const targetSegments = normalizeHimawariSegments(source.targetSegments ?? [])
  const expectedSegmentsPerBand = targetSegments.length > 0 ? targetSegments.length : minSegmentsPerBand
  const acqPattern =
    typeof source.acqTimePattern === 'string' && source.acqTimePattern.trim().length > 0
      ? new RegExp(source.acqTimePattern)
      : /(?<date>\d{8})[_-](?<time>\d{4})/
  const cutoffMinutes = Math.max(Number(source.maxSceneAgeMinutes ?? timelineMinutes * (lookbackSlots + 1)), timelineMinutes)
  const cutoffTime = Date.now() - cutoffMinutes * 60_000

  const slotAnchor = new Date(Date.now() - slotAvailabilityLagMinutes * 60_000)
  const slotTimes = buildRecentTimelineSlots(timelineMinutes, lookbackSlots, slotAnchor)
  const candidates = []
  let processedSlots = 0

  for (const slotTime of slotTimes) {
    const slotVars = buildVariables(variables, slotTime)
    const timeFolder = `${slotVars.HH}${slotVars.mm}`
    const prefixBase = `${productPrefix}/${slotVars.YYYY}/${slotVars.MM}/${slotVars.DD}/${timeFolder}/`
    const slotStamp = `${slotVars.YYYYMMDD}${timeFolder}`

    try {
      const objects = await listNoaaS3Objects({
        bucket,
        bucketRegion,
        prefix: prefixBase,
        requestTimeoutMs,
        listMaxKeys,
      })
      const slotCandidates = []
      for (const object of objects) {
        const parsed = parseHimawariS3Candidate({
          object,
          satellite,
          acqPattern,
          bands,
        })
        if (parsed && matchesTargetSegment(parsed, targetSegments)) {
          slotCandidates.push(parsed)
        }
      }

      console.log(`[sync] NOAA slot=${slotStamp} objects=${objects.length} matched=${slotCandidates.length}`)
      if (slotCandidates.length === 0) {
        continue
      }

      const bandCounts = new Map()
      for (const candidate of slotCandidates) {
        bandCounts.set(candidate.band, (bandCounts.get(candidate.band) ?? 0) + 1)
      }
      const missingBands = bands.filter((band) => !bandCounts.has(band))
      if (requireAllBandsInSlot && missingBands.length > 0) {
        console.warn(`[sync] NOAA slot=${slotStamp} skipped, missing bands=${missingBands.join(',')}`)
        continue
      }

      if (expectedSegmentsPerBand > 1) {
        const shortBands = bands.filter((band) => (bandCounts.get(band) ?? 0) < expectedSegmentsPerBand)
        if (shortBands.length > 0) {
          console.warn(
            `[sync] NOAA slot=${slotStamp} skipped, incomplete bands=${shortBands.join(',')} (requiredSegments=${expectedSegmentsPerBand})`,
          )
          continue
        }
      }

      candidates.push(...slotCandidates)
      processedSlots += 1

      if (preferLatestCompleteSlot) {
        break
      }
    } catch (error) {
      console.warn(
        `[sync] NOAA S3 list failed prefix=${prefixBase}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const uniqueCandidates = deduplicateHimawariCandidates(candidates)
    .filter((candidate) => Date.parse(candidate.acqTime) >= cutoffTime)
    .sort((left, right) => left.acqTime.localeCompare(right.acqTime) || left.fileName.localeCompare(right.fileName))

  if (uniqueCandidates.length === 0) {
    throw new Error('no new NOAA Himawari objects found for current timeline window')
  }

  const files = []
  const dbRows = []
  let downloadedCount = 0
  let progressCount = 0
  const totalCount = uniqueCandidates.length
  async function downloadCandidate(candidate) {
    const snapshotKey = toSnapshotKey(candidate.acqTime)
    const snapshotDir = path.join(sourceRoot, snapshotKey)
    await ensureDir(snapshotDir)

    const localFileName = sanitizeFileName(candidate.fileName)
    const localPath = path.join(snapshotDir, localFileName)

    let downloadStatus = 'downloaded'
    if (await hasUsableDownloadedFile(localPath)) {
      downloadStatus = 'exists'
    } else {
      const objectUrl = buildNoaaS3ObjectUrl(bucket, candidate.key, bucketRegion)
      await downloadFileWithRetry({
        url: objectUrl,
        localPath,
        timeoutMs: downloadTimeoutMs,
        retries: maxDownloadRetries,
        retryDelayMs: downloadRetryDelayMs,
      })
    }

    const fileSize = Number.isFinite(candidate.size) && candidate.size > 0
      ? candidate.size
      : (await fs.stat(localPath)).size
    const checksum = skipMd5WhenEtag && candidate.eTag
      ? candidate.eTag
      : await checksumFileMd5(localPath)
    const downloadTime = new Date().toISOString()

    progressCount += 1
    if (progressCount % progressLogEvery === 0 || progressCount === totalCount) {
      console.log(`[sync] NOAA download progress ${progressCount}/${totalCount}`)
    }

    return {
      downloaded: downloadStatus === 'downloaded',
      file: { localPath, size: fileSize },
      row: {
        satellite,
        sensor,
        acqTime: candidate.acqTime,
        band: candidate.band,
        roiCode,
        filePath: localPath,
        fileSize,
        checksum,
        storeFileBlob: source.storeFileBlobInDatabase !== false,
        downloadTime,
        downloadStatus,
        sceneName: candidate.fileName,
      },
    }
  }

  async function downloadBandCandidates(candidates, concurrency) {
    return mapWithConcurrency(candidates, Math.min(concurrency, candidates.length), downloadCandidate)
  }

  const candidateGroups = [...groupHimawariCandidatesByBand(uniqueCandidates).entries()]
  const downloadResults = []
  const fallbackNotes = []
  const parallelBandCount = Math.max(1, Math.min(candidateGroups.length, maxParallelDownloads))
  const maxDownloadsPerBand = Math.max(1, Math.floor(maxParallelDownloads / parallelBandCount))
  const bandResultGroups = await Promise.all(
    candidateGroups.map(async ([band, bandCandidates]) => {
      try {
        const requestedConcurrency = band === '03' ? 1 : Math.max(bandParallelDownloads, 1)
        const bandResults = await withTimeout(
          downloadBandCandidates(
            bandCandidates,
            Math.min(requestedConcurrency, maxDownloadsPerBand),
          ),
          bandDownloadTimeoutMs,
          `band ${band} download exceeded ${bandDownloadTimeoutMs}ms`,
        )
        return {
          band,
          results: bandResults,
          fallbackNote: null,
        }
      } catch (error) {
        if (source.fallbackType !== 'jaxa-ftp-himawari' || !ftpFallbackBands.has(band)) {
          throw error
        }
        await cleanupPartialFilesForCandidates(sourceRoot, bandCandidates)
        console.warn(
          `[sync] NOAA band ${band} failed or timed out, falling back to JAXA FTP: ${error instanceof Error ? error.message : String(error)}`,
        )
        const fallbackResults = await downloadBandCandidatesViaFtp({
          source,
          sourceRoot,
          variables,
          config: { ftp: config?.ftp ?? {} },
          band,
          bandCandidates,
        })
        return {
          band,
          results: fallbackResults,
          fallbackNote: `band ${band} via FTP fallback`,
        }
      }
    }),
  )

  for (const group of bandResultGroups) {
    if (group.fallbackNote) {
      fallbackNotes.push(group.fallbackNote)
    }
    downloadResults.push(...group.results)
  }

  for (const result of downloadResults) {
    if (result.downloaded) {
      downloadedCount += 1
    }
    files.push(result.file)
    dbRows.push(result.row)
  }

  const dbPath = resolvePath(projectRoot, source.databasePath ?? './fire_monitor.geodatabase')
  await upsertRawSceneRows(dbPath, dbRows)

  const acquisitionTime = uniqueCandidates.at(-1)?.acqTime ?? new Date().toISOString()
  const snapshotKey = toSnapshotKey(acquisitionTime)

  return {
    snapshotKey,
    acquisitionTime,
    message: `NOAA Himawari synced ${files.length} files across ${processedSlots} slot(s) (${downloadedCount} downloaded, ${files.length - downloadedCount} reused)${fallbackNotes.length ? `; ${fallbackNotes.join('; ')}` : ''}`,
    files,
  }
}

async function syncJaxaFtpHimawari({ source, sourceRoot, variables, config }) {
  if (source.deterministicSlotDownload === true) {
    return syncJaxaFtpHimawariDeterministic({ source, sourceRoot, variables, config })
  }

  const ftpHost = String(source.ftpHost ?? config?.ftp?.host ?? 'ftp.ptree.jaxa.jp')
  const ftpUser = String(source.ftpUser ?? config?.ftp?.user ?? '').trim()
  const ftpPassword = String(source.ftpPassword ?? config?.ftp?.password ?? '')
  if (!ftpUser || !ftpPassword) {
    throw new Error('FTP credentials are missing, configure ftpUser and ftpPassword')
  }

  const ftpBasePath = String(source.ftpBasePath ?? '/jma/hsd').replace(/\/$/, '')
  const timelineMinutes = Math.max(Number(source.timelineMinutes ?? 10), 1)
  const lookbackSlots = Math.max(Number(source.lookbackSlots ?? 3), 1)
  const requestTimeoutMs = Math.max(Number(source.requestTimeoutMs ?? 45000), 5000)
  const downloadTimeoutMs = Math.max(Number(source.downloadTimeoutMs ?? 240000), 10000)
  const satellite = String(source.satellite ?? 'H09')
  const sensor = String(source.sensor ?? 'AHI')
  const roiCode = String(source.roiCode ?? variables.ROI_CODE ?? 'CN')
  const bands = normalizeBands(source.bands ?? ['07', '13', '14'])
  const targetSegments = normalizeHimawariSegments(source.targetSegments ?? [])
  const maxParallelDownloads = Math.max(Number(source.maxParallelDownloads ?? 12), 1)
  const ftpBatchSize = Math.max(Number(source.ftpBatchSize ?? 2), 1)
  const bandParallelConnections = Math.max(Number(source.bandParallelConnections ?? 2), 1)
  const maxParallelConnections = Math.max(
    Number(source.maxParallelConnections ?? Math.min(maxParallelDownloads, bands.length * bandParallelConnections)),
    1,
  )
  const maxDownloadRetries = Math.max(Number(source.maxDownloadRetries ?? 2), 0)
  const downloadRetryDelayMs = Math.max(Number(source.downloadRetryDelayMs ?? 1000), 0)
  const lowSpeedLimitBytes = Math.max(Number(source.lowSpeedLimitBytes ?? 1024), 0)
  const lowSpeedTimeSeconds = Math.max(Number(source.lowSpeedTimeSeconds ?? 60), 0)
  const progressLogEvery = Math.max(Number(source.progressLogEvery ?? 10), 1)
  const preferLatestCompleteSlot = source.preferLatestCompleteSlot !== false
  const requireAllBandsInSlot = source.requireAllBandsInSlot !== false
  const minSegmentsPerBand = Math.max(Number(source.minSegmentsPerBand ?? 1), 1)
  const expectedSegmentsPerBand = targetSegments.length > 0 ? targetSegments.length : minSegmentsPerBand
  const deterministicSlotDownload = source.deterministicSlotDownload === true
  const skipMd5 = source.skipMd5 !== false
  const acqPattern =
    typeof source.acqTimePattern === 'string' && source.acqTimePattern.trim().length > 0
      ? new RegExp(source.acqTimePattern)
      : /(?<date>\d{8})[_-](?<time>\d{4})/

  const cutoffMinutes = Math.max(Number(source.maxSceneAgeMinutes ?? timelineMinutes * (lookbackSlots + 1)), timelineMinutes)
  const cutoffTime = Date.now() - cutoffMinutes * 60_000

  const slotTimes = buildRecentTimelineSlots(timelineMinutes, lookbackSlots)
  const candidates = []
  let processedSlots = 0

  for (const slotTime of slotTimes) {
    const slotVars = buildVariables(variables, slotTime)
    const timeFolder = `${slotVars.HH}${slotVars.mm}`
    const slotStamp = `${slotVars.YYYYMMDD}${timeFolder}`
    const hourDir = `${ftpBasePath}/${slotVars.YYYYMM}/${slotVars.DD}/${slotVars.HH}`
    const slotRegex = deterministicSlotDownload
      ? null
      : buildHimawariFtpSlotRegex({
          satellite,
          date: slotVars.YYYYMMDD,
          time: timeFolder,
          bands,
        })

    try {
      const slotCandidates = []
      if (deterministicSlotDownload) {
        for (const band of bands) {
          const segments = targetSegments.length > 0 ? targetSegments : buildDefaultHimawariSegments(minSegmentsPerBand)
          for (const segment of segments) {
            slotCandidates.push({
              key: `${hourDir}/${buildExpectedHimawariFileName({
                satellite,
                date: slotVars.YYYYMMDD,
                time: timeFolder,
                band,
                segment,
                resolution: inferHimawariResolutionCode(band),
              })}`,
              fileName: buildExpectedHimawariFileName({
                satellite,
                date: slotVars.YYYYMMDD,
                time: timeFolder,
                band,
                segment,
                resolution: inferHimawariResolutionCode(band),
              }),
              acqTime: `${slotVars.YYYYMMDD.slice(0, 4)}-${slotVars.YYYYMMDD.slice(4, 6)}-${slotVars.YYYYMMDD.slice(6, 8)}T${timeFolder.slice(0, 2)}:${timeFolder.slice(2, 4)}:00Z`,
              band,
              segment,
              size: 0,
            })
          }
        }
        console.log(`[sync] FTP slot=${slotStamp} deterministic matched=${slotCandidates.length}`)
      } else {
        const names = await listFtpDirectory({
          host: ftpHost,
          remoteDir: hourDir,
          username: ftpUser,
          password: ftpPassword,
          requestTimeoutMs,
        })

        for (const fileName of names) {
          if (!slotRegex.test(fileName)) {
            continue
          }
          const parsed = parseHimawariFtpCandidate({
            fileName,
            remoteDir: hourDir,
            satellite,
            acqPattern,
            bands,
          })
          if (parsed && matchesTargetSegment(parsed, targetSegments)) {
            slotCandidates.push(parsed)
          }
        }
        console.log(`[sync] FTP slot=${slotStamp} listed=${names.length} matched=${slotCandidates.length}`)
      }
      if (slotCandidates.length === 0) {
        continue
      }

      const bandCounts = new Map()
      for (const candidate of slotCandidates) {
        bandCounts.set(candidate.band, (bandCounts.get(candidate.band) ?? 0) + 1)
      }
      const missingBands = bands.filter((band) => !bandCounts.has(band))
      if (requireAllBandsInSlot && missingBands.length > 0) {
        console.warn(`[sync] FTP slot=${slotStamp} skipped, missing bands=${missingBands.join(',')}`)
        continue
      }

      if (expectedSegmentsPerBand > 1) {
        const shortBands = bands.filter((band) => (bandCounts.get(band) ?? 0) < expectedSegmentsPerBand)
        if (shortBands.length > 0) {
          console.warn(
            `[sync] FTP slot=${slotStamp} skipped, incomplete bands=${shortBands.join(',')} (requiredSegments=${expectedSegmentsPerBand})`,
          )
          continue
        }
      }

      candidates.push(...slotCandidates)
      processedSlots += 1
      if (preferLatestCompleteSlot) {
        break
      }
    } catch (error) {
      console.warn(
        `[sync] FTP list failed dir=${hourDir}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const uniqueCandidates = deduplicateHimawariCandidates(candidates)
    .filter((candidate) => Date.parse(candidate.acqTime) >= cutoffTime)
    .sort((left, right) => left.acqTime.localeCompare(right.acqTime) || left.fileName.localeCompare(right.fileName))

  if (uniqueCandidates.length === 0) {
    throw new Error('no new FTP Himawari objects found for current timeline window')
  }

  const files = []
  const dbRows = []
  let downloadedCount = 0
  let progressCount = 0
  const totalCount = uniqueCandidates.length

  const preparedCandidates = await Promise.all(
    uniqueCandidates.map(async (candidate) => {
      const snapshotKey = toSnapshotKey(candidate.acqTime)
      const snapshotDir = path.join(sourceRoot, snapshotKey)
      await ensureDir(snapshotDir)

      const localFileName = sanitizeFileName(candidate.fileName)
      const localPath = path.join(snapshotDir, localFileName)
      const exists = await hasUsableDownloadedFile(localPath)
      return {
        candidate,
        localPath,
        existed: exists,
        band: candidate.band,
      }
    }),
  )

  const pendingTransfers = preparedCandidates.filter((entry) => !entry.existed)
  const transferBatches = buildBandTransferBatches(pendingTransfers, ftpBatchSize, bandParallelConnections)
  await mapWithConcurrency(transferBatches, maxParallelConnections, async (batch) => {
    if (!batch.length) {
      return
    }

    await downloadFtpBatchWithRetry({
      host: ftpHost,
      username: ftpUser,
      password: ftpPassword,
      timeoutMs: downloadTimeoutMs,
      retries: maxDownloadRetries,
      retryDelayMs: downloadRetryDelayMs,
      lowSpeedLimitBytes,
      lowSpeedTimeSeconds,
      transfers: batch.map((entry) => ({
        remotePath: entry.candidate.key,
        localPath: entry.localPath,
      })),
    })

    downloadedCount += batch.length
    progressCount += batch.length
    console.log(`[sync] FTP download progress ${Math.min(progressCount, totalCount)}/${totalCount}`)
  })

  for (const entry of preparedCandidates) {
    const downloadStatus = entry.existed ? 'exists' : 'downloaded'
    const fileSize = (await fs.stat(entry.localPath)).size
    const checksum = skipMd5 ? '' : await checksumFileMd5(entry.localPath)
    const downloadTime = new Date().toISOString()

    if (entry.existed) {
      progressCount += 1
      if (progressCount % progressLogEvery === 0 || progressCount === totalCount) {
        console.log(`[sync] FTP download progress ${progressCount}/${totalCount}`)
      }
    }

    files.push({ localPath: entry.localPath, size: fileSize })
    dbRows.push({
      satellite,
      sensor,
      acqTime: entry.candidate.acqTime,
      band: entry.candidate.band,
      roiCode,
      filePath: entry.localPath,
      fileSize,
      checksum,
      storeFileBlob: source.storeFileBlobInDatabase !== false,
      downloadTime,
      downloadStatus,
      sceneName: entry.candidate.fileName,
    })
  }

  const dbPath = resolvePath(projectRoot, source.databasePath ?? './fire_monitor.geodatabase')
  await upsertRawSceneRows(dbPath, dbRows)

  const acquisitionTime = uniqueCandidates.at(-1)?.acqTime ?? new Date().toISOString()
  const snapshotKey = toSnapshotKey(acquisitionTime)

  return {
    snapshotKey,
    acquisitionTime,
    message: `FTP Himawari synced ${files.length} files across ${processedSlots} slot(s) (${downloadedCount} downloaded, ${files.length - downloadedCount} reused)`,
    files,
  }
}

async function syncJaxaFtpHimawariDeterministic({ source, sourceRoot, variables, config }) {
  const ftpHost = String(source.ftpHost ?? config?.ftp?.host ?? 'ftp.ptree.jaxa.jp')
  const ftpUser = String(source.ftpUser ?? config?.ftp?.user ?? '').trim()
  const ftpPassword = String(source.ftpPassword ?? config?.ftp?.password ?? '')
  if (!ftpUser || !ftpPassword) {
    throw new Error('FTP credentials are missing, configure ftpUser and ftpPassword')
  }

  const ftpBasePath = String(source.ftpBasePath ?? '/jma/hsd').replace(/\/$/, '')
  const timelineMinutes = Math.max(Number(source.timelineMinutes ?? 10), 1)
  const lookbackSlots = Math.max(Number(source.lookbackSlots ?? 3), 1)
  const requestTimeoutMs = Math.max(Number(source.requestTimeoutMs ?? 45000), 5000)
  const downloadTimeoutMs = Math.max(Number(source.downloadTimeoutMs ?? 240000), 10000)
  const satellite = String(source.satellite ?? 'H09')
  const sensor = String(source.sensor ?? 'AHI')
  const roiCode = String(source.roiCode ?? variables.ROI_CODE ?? 'CN')
  const bands = normalizeBands(source.bands ?? ['03'])
  const targetSegments = normalizeHimawariSegments(source.targetSegments ?? [])
  const maxDownloadRetries = Math.max(Number(source.maxDownloadRetries ?? 2), 0)
  const downloadRetryDelayMs = Math.max(Number(source.downloadRetryDelayMs ?? 1000), 0)
  const maxParallelDownloads = Math.max(Number(source.maxParallelDownloads ?? 4), 1)
  const ftpBatchSize = Math.max(Number(source.ftpBatchSize ?? 2), 1)
  const lowSpeedLimitBytes = Math.max(Number(source.lowSpeedLimitBytes ?? 1024), 0)
  const lowSpeedTimeSeconds = Math.max(Number(source.lowSpeedTimeSeconds ?? 60), 0)
  const minSegmentsPerBand = Math.max(Number(source.minSegmentsPerBand ?? 1), 1)
  const skipMd5 = source.skipMd5 !== false
  const cutoffMinutes = Math.max(Number(source.maxSceneAgeMinutes ?? timelineMinutes * (lookbackSlots + 1)), timelineMinutes)
  const cutoffTime = Date.now() - cutoffMinutes * 60_000
  const slotTimes = buildRecentTimelineSlots(timelineMinutes, lookbackSlots)

  for (const slotTime of slotTimes) {
    const slotVars = buildVariables(variables, slotTime)
    const timeFolder = `${slotVars.HH}${slotVars.mm}`
    const slotStamp = `${slotVars.YYYYMMDD}${timeFolder}`
    const hourDir = `${ftpBasePath}/${slotVars.YYYYMM}/${slotVars.DD}/${slotVars.HH}`
    const segments = targetSegments.length > 0 ? targetSegments : buildDefaultHimawariSegments(minSegmentsPerBand)
    const slotCandidates = []
    for (const band of bands) {
      for (const segment of segments) {
        const fileName = buildExpectedHimawariFileName({
          satellite,
          date: slotVars.YYYYMMDD,
          time: timeFolder,
          band,
          segment,
          resolution: inferHimawariResolutionCode(band),
        })
        slotCandidates.push({
          key: `${hourDir}/${fileName}`,
          fileName,
          acqTime: `${slotVars.YYYYMMDD.slice(0, 4)}-${slotVars.YYYYMMDD.slice(4, 6)}-${slotVars.YYYYMMDD.slice(6, 8)}T${timeFolder.slice(0, 2)}:${timeFolder.slice(2, 4)}:00Z`,
          band,
          segment,
          size: 0,
        })
      }
    }

    console.log(`[sync] FTP slot=${slotStamp} deterministic matched=${slotCandidates.length}`)
    if (Date.parse(slotCandidates[0]?.acqTime ?? '') < cutoffTime) {
      continue
    }

    let availableNames
    try {
      availableNames = new Set(await listFtpDirectory({
        host: ftpHost,
        remoteDir: hourDir,
        username: ftpUser,
        password: ftpPassword,
        requestTimeoutMs,
      }))
    } catch (error) {
      console.warn(
        `[sync] FTP slot=${slotStamp} deterministic listing failed, trying older slot: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    const missingNames = slotCandidates
      .map((candidate) => candidate.fileName)
      .filter((fileName) => !availableNames.has(fileName))
    if (missingNames.length > 0) {
      console.warn(
        `[sync] FTP slot=${slotStamp} skipped before download, missing files=${missingNames.slice(0, 4).join(',')}${missingNames.length > 4 ? ', ...' : ''}`,
      )
      continue
    }

    const preparedCandidates = await Promise.all(
      slotCandidates.map(async (candidate) => {
        const snapshotKey = toSnapshotKey(candidate.acqTime)
        const snapshotDir = path.join(sourceRoot, snapshotKey)
        await ensureDir(snapshotDir)
        const localPath = path.join(snapshotDir, sanitizeFileName(candidate.fileName))
        return {
          candidate,
          localPath,
          existed: await hasUsableDownloadedFile(localPath),
          band: candidate.band,
        }
      }),
    )

    const pendingTransfers = preparedCandidates.filter((entry) => !entry.existed)
    try {
      const transferBatches = chunkArray(pendingTransfers, ftpBatchSize)
      await mapWithConcurrency(
        transferBatches,
        Math.min(maxParallelDownloads, transferBatches.length || 1),
        async (batch) => {
          await downloadFtpBatchWithRetry({
            host: ftpHost,
            username: ftpUser,
            password: ftpPassword,
            timeoutMs: downloadTimeoutMs,
            retries: maxDownloadRetries,
            retryDelayMs: downloadRetryDelayMs,
            lowSpeedLimitBytes,
            lowSpeedTimeSeconds,
            transfers: batch.map((entry) => ({
              remotePath: entry.candidate.key,
              localPath: entry.localPath,
            })),
          })
        },
      )
    } catch (error) {
      await cleanupPartialFilesForCandidates(sourceRoot, slotCandidates)
      console.warn(
        `[sync] FTP slot=${slotStamp} deterministic download failed, trying older slot: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    const files = []
    const dbRows = []
    for (const entry of preparedCandidates) {
      const fileSize = (await fs.stat(entry.localPath)).size
      files.push({ localPath: entry.localPath, size: fileSize })
      dbRows.push({
        satellite,
        sensor,
        acqTime: entry.candidate.acqTime,
        band: entry.candidate.band,
        roiCode,
        filePath: entry.localPath,
        fileSize,
        checksum: skipMd5 ? '' : await checksumFileMd5(entry.localPath),
        storeFileBlob: source.storeFileBlobInDatabase !== false,
        downloadTime: new Date().toISOString(),
        downloadStatus: entry.existed ? 'exists' : 'downloaded',
        sceneName: entry.candidate.fileName,
      })
    }

    const dbPath = resolvePath(projectRoot, source.databasePath ?? './fire_monitor.geodatabase')
    await upsertRawSceneRows(dbPath, dbRows)

    return {
      snapshotKey: toSnapshotKey(slotCandidates[0].acqTime),
      acquisitionTime: slotCandidates[0].acqTime,
      message: `FTP Himawari deterministic synced ${files.length} files for slot ${slotStamp}`,
      files,
    }
  }

  throw new Error('no deterministic FTP Himawari slot could be completed in the current timeline window')
}

async function syncWindyPointGrid({ source, sourceRoot, variables }) {
  const apiUrl = source.apiUrl ?? 'https://api.windy.com/api/point-forecast/v2'
  const keyVariable = source.keyVariable ?? 'WINDY_API_KEY'
  const key = source.key ?? variables[keyVariable]
  if (!key) {
    throw new Error(`Windy API key is missing, configure source.key or variables.${keyVariable}`)
  }

  const model = String(source.model ?? 'gfs')
  const parameters =
    Array.isArray(source.parameters) && source.parameters.length > 0
      ? source.parameters
      : [
          'temp',
          'dewpoint',
          'rh',
          'wind',
          'windGust',
          'pressure',
          'precip',
          'convPrecip',
          'cape',
          'lclouds',
          'mclouds',
          'hclouds',
        ]
  const levels =
    Array.isArray(source.levels) && source.levels.length > 0 ? source.levels : ['surface']
  const leadHours = Math.max(Number(source.leadHours ?? 3), 0)
  const requestTimeoutMs = Math.max(Number(source.requestTimeoutMs ?? 30000), 5000)
  const maxParallelRequests = Math.max(Number(source.maxParallelRequests ?? 8), 1)
  const grid = resolveWindyGrid(source.grid, variables)
  const points = buildWindyGridPoints(grid)
  if (points.length === 0) {
    throw new Error('Windy grid has no points to request')
  }

  let fatalWindyError = null
  const targetForecastMs = Date.now() + leadHours * 60 * 60 * 1000
  const windyRows = await mapWithConcurrency(points, maxParallelRequests, async (point) => {
    if (fatalWindyError) {
      return null
    }

    try {
      const response = await fetchWithTimeout(
        apiUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            lat: point.lat,
            lon: point.lon,
            model,
            parameters,
            levels,
            key,
          }),
        },
        requestTimeoutMs,
      )

      if (response.status === 204) {
        return null
      }

      if (!response.ok) {
        const detail = await readResponseError(response)
        if (response.status === 400 && /invalid api key/i.test(detail)) {
          fatalWindyError = new Error(
            `Windy Point Forecast API rejected the configured key. Confirm this is a Point Forecast API key, not another Windy product key. Detail: ${detail}`,
          )
          throw fatalWindyError
        }
        throw new Error(`status=${response.status}${detail ? `, detail=${detail}` : ''}`)
      }

      const payload = await response.json()
      const ts = Array.isArray(payload.ts) ? payload.ts.map((value) => Number(value)) : []
      if (ts.length === 0) {
        return null
      }

      const forecastIndex = pickForecastIndex(ts, targetForecastMs)
      if (forecastIndex < 0) {
        return null
      }

      const values = parseWindyValuesAtIndex(payload, forecastIndex)
      return {
        lat: point.lat,
        lon: point.lon,
        forecastTime: new Date(ts[forecastIndex]).toISOString(),
        ...values,
      }
    } catch (error) {
      if (fatalWindyError) {
        throw fatalWindyError
      }
      console.warn(
        `[sync] Windy point failed lat=${point.lat} lon=${point.lon}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return null
    }
  })

  const validRows = windyRows.filter((row) => row !== null)
  if (validRows.length === 0) {
    throw new Error('Windy returned no valid forecast values on sampled grid')
  }

  const newestForecastTime = validRows
    .map((row) => row.forecastTime)
    .sort()
    .at(-1)
  const acquisitionTime = newestForecastTime ?? new Date().toISOString()
  const snapshotKey = toSnapshotKey(acquisitionTime)
  const snapshotDir = path.join(sourceRoot, snapshotKey)
  await ensureDir(snapshotDir)

  const features = validRows.map((row) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [buildWindyGridRing(row.lon, row.lat, grid.stepLon, grid.stepLat)],
    },
    properties: {
      tempC: row.tempC,
      dewpointC: row.dewpointC,
      rhPct: row.rhPct,
      pressureHpa: row.pressureHpa,
      windMs: row.windMs,
      uMs: row.uMs,
      vMs: row.vMs,
      gustMs: row.gustMs,
      precip3hMm: row.precip3hMm,
      convPrecip3hMm: row.convPrecip3hMm,
      capeJkg: row.capeJkg,
      lcloudPct: row.lcloudPct,
      mcloudPct: row.mcloudPct,
      hcloudPct: row.hcloudPct,
      fireRisk: row.fireRisk,
      forecastTime: row.forecastTime,
      model,
    },
  }))

  const overlayPath = path.join(snapshotDir, 'windy_environment_overlay.geojson')
  await fs.writeFile(
    overlayPath,
    JSON.stringify({
      type: 'FeatureCollection',
      features,
    }),
    'utf8',
  )

  const snapshotPath = path.join(snapshotDir, 'windy_environment_snapshot.json')
  await fs.writeFile(
    snapshotPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        acquisitionTime,
        model,
        leadHours,
        parameters,
        levels,
        grid,
        requestedPoints: points.length,
        validPoints: validRows.length,
      },
      null,
      2,
    ),
    'utf8',
  )

  const overlayStats = await fs.stat(overlayPath)
  const snapshotStats = await fs.stat(snapshotPath)

  return {
    snapshotKey,
    acquisitionTime,
    message: `downloaded Windy grid ${validRows.length}/${points.length} points`,
    files: [
      { localPath: overlayPath, size: overlayStats.size },
      { localPath: snapshotPath, size: snapshotStats.size },
    ],
    overlay: {
      type: 'geojson-windy-environment',
      localPath: overlayPath,
      description: 'Windy fire-related environment fields sampled on a grid',
    },
  }
}

async function syncHttpStatic({ source, sourceRoot }) {
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new Error('no static file URLs configured')
  }

  const snapshotKey = 'static'
  const snapshotDir = path.join(sourceRoot, snapshotKey)
  await ensureDir(snapshotDir)
  const files = []

  for (const file of source.files) {
    const localPath = path.join(snapshotDir, sanitizeFileName(file.name || path.basename(new URL(file.url).pathname)))
    if (!(await fileExists(localPath))) {
      await downloadFile(file.url, localPath)
    }
    const stats = await fs.stat(localPath)
    files.push({ localPath, size: stats.size })
  }

  return {
    snapshotKey,
    acquisitionTime: null,
    message: `static assets ready (${files.length})`,
    files,
  }
}

async function listNoaaS3Objects({ bucket, bucketRegion, prefix, requestTimeoutMs, listMaxKeys }) {
  const objects = []
  let continuationToken = null

  do {
    const query = new URLSearchParams()
    query.set('list-type', '2')
    query.set('prefix', prefix)
    query.set('max-keys', String(listMaxKeys))
    if (continuationToken) {
      query.set('continuation-token', continuationToken)
    }

    const listUrl = `https://${buildNoaaS3Host(bucket, bucketRegion)}/?${query.toString()}`
    const response = await fetchWithTimeout(listUrl, {}, requestTimeoutMs)
    if (!response.ok) {
      const detail = await readResponseError(response)
      throw new Error(`status=${response.status}${detail ? `, detail=${detail}` : ''}`)
    }

    const xmlText = await response.text()
    const parsed = parseNoaaS3ListXml(xmlText)
    objects.push(...parsed.objects)
    continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : null
  } while (continuationToken)

  return objects
}

function parseNoaaS3ListXml(xmlText) {
  const objects = []
  for (const entry of xmlText.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = entry[1]
    const key = decodeXmlEntities(extractXmlTag(block, 'Key') ?? '')
    if (!key) {
      continue
    }
    const sizeRaw = extractXmlTag(block, 'Size')
    const eTagRaw = extractXmlTag(block, 'ETag') ?? ''
    objects.push({
      key,
      size: Number(sizeRaw ?? 0),
      eTag: eTagRaw.replace(/^"|"$/g, ''),
    })
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/i.test(xmlText)
  const nextContinuationToken = decodeXmlEntities(extractXmlTag(xmlText, 'NextContinuationToken') ?? '')
  return {
    objects,
    isTruncated,
    nextContinuationToken: nextContinuationToken || null,
  }
}

function extractXmlTag(text, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, 'i')
  const matched = regex.exec(text)
  return matched?.[1] ?? null
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function parseHimawariS3Candidate({ object, satellite, acqPattern, bands }) {
  const fileName = path.basename(object.key)
  if (!fileName) {
    return null
  }
  if (satellite && !fileName.includes(`_${satellite}_`)) {
    return null
  }

  const band = extractBand(fileName)
  if (!band || !bands.includes(band)) {
    return null
  }

  const acqTime = parseAcqTimeFromFileName(fileName, acqPattern)
  if (!acqTime) {
    return null
  }

  return {
    key: object.key,
    fileName,
    band,
    segment: extractHimawariSegment(fileName),
    acqTime,
    size: object.size,
    eTag: object.eTag,
  }
}

function parseHimawariFtpCandidate({ fileName, remoteDir, satellite, acqPattern, bands }) {
  if (!fileName) {
    return null
  }
  if (satellite && !fileName.includes(`_${satellite}_`)) {
    return null
  }

  const band = extractBand(fileName)
  if (!band || !bands.includes(band)) {
    return null
  }

  const acqTime = parseAcqTimeFromFileName(fileName, acqPattern)
  if (!acqTime) {
    return null
  }

  const key = `${remoteDir.replace(/\/$/, '')}/${fileName}`
  return {
    key,
    fileName,
    band,
    segment: extractHimawariSegment(fileName),
    acqTime,
    size: null,
    eTag: '',
  }
}

function buildHimawariFtpSlotRegex({ satellite, date, time, bands }) {
  const escapedSatellite = escapeRegExp(satellite)
  const escapedDate = escapeRegExp(date)
  const escapedTime = escapeRegExp(time)
  const escapedBands = bands.map((band) => escapeRegExp(band)).join('|')
  return new RegExp(`^HS_${escapedSatellite}_${escapedDate}_${escapedTime}_B(${escapedBands})_FLDK_.*\\.DAT\\.bz2$`, 'i')
}

function inferHimawariResolutionCode(band) {
  const normalized = String(band).padStart(2, '0')
  if (normalized === '03') {
    return '05'
  }
  return '20'
}

function buildDefaultHimawariSegments(minSegmentsPerBand) {
  return Array.from({ length: Math.max(minSegmentsPerBand, 1) }, (_, index) => String(index + 1).padStart(2, '0'))
}

function buildExpectedHimawariFileName({ satellite, date, time, band, segment, resolution }) {
  return `HS_${satellite}_${date}_${time}_B${band}_FLDK_R${resolution}_S${segment}10.DAT.bz2`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildNoaaS3Host(bucket, bucketRegion) {
  const region = String(bucketRegion ?? '').trim()
  return region ? `${bucket}.s3.${region}.amazonaws.com` : `${bucket}.s3.amazonaws.com`
}

function buildNoaaS3ObjectUrl(bucket, key, bucketRegion) {
  const encodedKey = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `https://${buildNoaaS3Host(bucket, bucketRegion)}/${encodedKey}`
}

function extractBand(fileName) {
  const match = fileName.match(/B(\d{2})/i)
  return match?.[1] ?? null
}

function extractHimawariSegment(fileName) {
  const match = String(fileName).match(/_S(\d{2})10\.DAT\.bz2$/i)
  return match?.[1] ?? null
}

function normalizeHimawariSegments(values) {
  const normalized = new Set()
  for (const value of values) {
    const digits = String(value).replace(/[^0-9]/g, '')
    if (!digits) {
      continue
    }
    const segment = Number(digits)
    if (Number.isInteger(segment) && segment >= 1 && segment <= 10) {
      normalized.add(String(segment).padStart(2, '0'))
    }
  }
  return [...normalized].sort()
}

function matchesTargetSegment(candidate, targetSegments) {
  if (!targetSegments.length) {
    return true
  }
  return Boolean(candidate.segment && targetSegments.includes(candidate.segment))
}

function parseAcqTimeFromFileName(fileName, acqPattern) {
  const match = acqPattern.exec(fileName)
  if (!match) {
    return null
  }

  const date = match.groups?.date ?? match[1]
  const time = match.groups?.time ?? match[2]
  if (!date || !time || date.length !== 8 || time.length !== 4) {
    return null
  }

  const yyyy = date.slice(0, 4)
  const mm = date.slice(4, 6)
  const dd = date.slice(6, 8)
  const hh = time.slice(0, 2)
  const min = time.slice(2, 4)
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`
}

function deduplicateHimawariCandidates(candidates) {
  const seen = new Set()
  const deduped = []
  for (const candidate of candidates) {
    const key = `${candidate.key ?? candidate.url ?? ''}|${candidate.band}|${candidate.acqTime}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(candidate)
  }
  return deduped
}

function normalizeBands(values) {
  const normalized = new Set()
  for (const value of values) {
    const digits = String(value).replace(/[^0-9]/g, '')
    if (!digits) {
      continue
    }
    normalized.add(digits.padStart(2, '0').slice(-2))
  }
  return normalized.size > 0 ? [...normalized] : ['07', '13', '14']
}

function buildRecentTimelineSlots(timelineMinutes, lookbackSlots, anchorDate = new Date()) {
  const slotMs = timelineMinutes * 60_000
  const anchorMs = Math.floor(anchorDate.getTime() / slotMs) * slotMs
  const result = []
  for (let index = 0; index < lookbackSlots; index += 1) {
    result.push(new Date(anchorMs - index * slotMs))
  }
  return result
}

async function checksumFileMd5(localPath) {
  const buffer = await fs.readFile(localPath)
  return createHash('md5').update(buffer).digest('hex')
}

async function upsertRawSceneRows(dbPath, rows) {
  if (!rows.length) {
    return
  }

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  try {
    ensureRawSceneTableForIngestion(db)

    db.exec('BEGIN;')
    const statement = db.prepare(`
      INSERT INTO raw_scene (
        satellite,
        sensor,
        acq_time,
        band,
        roi_code,
        file_path,
        file_size,
        checksum,
        file_blob,
        download_time,
        download_status,
        source_sat,
        scene_time_utc,
        scene_name,
        scene_path,
        checksum_md5,
        ingest_status,
        roi_name,
        updated_at
      ) VALUES (
        @satellite,
        @sensor,
        @acq_time,
        @band,
        @roi_code,
        @file_path,
        @file_size,
        @checksum,
        @file_blob,
        @download_time,
        @download_status,
        @source_sat,
        @scene_time_utc,
        @scene_name,
        @scene_path,
        @checksum_md5,
        @ingest_status,
        @roi_name,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(scene_path) DO UPDATE SET
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        checksum = excluded.checksum,
        file_blob = excluded.file_blob,
        download_time = excluded.download_time,
        download_status = excluded.download_status,
        source_sat = excluded.source_sat,
        scene_time_utc = excluded.scene_time_utc,
        scene_name = excluded.scene_name,
        scene_path = excluded.scene_path,
        checksum_md5 = excluded.checksum_md5,
        ingest_status = excluded.ingest_status,
        roi_name = excluded.roi_name,
        updated_at = CURRENT_TIMESTAMP
    `)

    for (const row of rows) {
      const fileBlob = row.storeFileBlob && row.filePath ? await fs.readFile(row.filePath) : null
      statement.run({
        satellite: row.satellite,
        sensor: row.sensor,
        acq_time: row.acqTime,
        band: row.band,
        roi_code: row.roiCode,
        file_path: row.filePath,
        file_size: row.fileSize,
        checksum: row.checksum,
        file_blob: fileBlob,
        download_time: row.downloadTime,
        download_status: row.downloadStatus,
        source_sat: row.satellite,
        scene_time_utc: row.acqTime,
        scene_name: row.sceneName,
        scene_path: row.filePath,
        checksum_md5: row.checksum,
        ingest_status: row.downloadStatus,
        roi_name: row.roiCode,
      })
    }

    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  } finally {
    db.close()
  }
}

function ensureRawSceneTableForIngestion(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_scene (
      scene_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sat TEXT NOT NULL,
      scene_time_utc TEXT NOT NULL,
      scene_name TEXT,
      scene_path TEXT NOT NULL,
      roi_name TEXT,
      projection TEXT,
      checksum_md5 TEXT,
      ingest_status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      satellite TEXT,
      sensor TEXT,
      acq_time TEXT,
      band TEXT,
      roi_code TEXT,
      file_path TEXT,
      file_size INTEGER,
      checksum TEXT,
      file_blob BLOB,
      download_time TEXT,
      download_status TEXT
    );
  `)

  ensureTableColumn(db, 'raw_scene', 'satellite TEXT')
  ensureTableColumn(db, 'raw_scene', 'sensor TEXT')
  ensureTableColumn(db, 'raw_scene', 'acq_time TEXT')
  ensureTableColumn(db, 'raw_scene', 'band TEXT')
  ensureTableColumn(db, 'raw_scene', 'roi_code TEXT')
  ensureTableColumn(db, 'raw_scene', 'file_path TEXT')
  ensureTableColumn(db, 'raw_scene', 'file_size INTEGER')
  ensureTableColumn(db, 'raw_scene', 'checksum TEXT')
  ensureTableColumn(db, 'raw_scene', 'file_blob BLOB')
  ensureTableColumn(db, 'raw_scene', 'download_time TEXT')
  ensureTableColumn(db, 'raw_scene', 'download_status TEXT')

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_scene_file_path_unique ON raw_scene (file_path) WHERE file_path IS NOT NULL;')
  db.exec('CREATE INDEX IF NOT EXISTS idx_raw_scene_acq_band ON raw_scene (acq_time, band);')
}

function ensureTableColumn(db, tableName, columnDefinition) {
  const [columnName] = columnDefinition.split(/\s+/, 1)
  const existing = db.prepare(`PRAGMA table_info(${tableName});`).all()
  if (existing.some((column) => String(column.name).toLowerCase() === columnName.toLowerCase())) {
    return
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition};`)
}

async function syncRemoteReference({ source, variables }) {
  const url = renderTemplate(source.urlTemplate, variables)
  const fileName = renderTemplate(source.filenameTemplate ?? path.basename(new URL(url).pathname), variables)
  return {
    snapshotKey: 'remote',
    acquisitionTime: null,
    message: `remote overlay ready: ${url}`,
    files: [{ localPath: url, size: 0, webPath: url }],
    overlay: {
      type: source.kind === 'terrain' ? 'geotiff-dem' : 'geotiff-landcover',
      localPath: url,
      webPath: url,
      description: source.provider ?? 'remote raster',
    },
  }
}

function buildSingleFileOverlay(source, file) {
  if (!file.localPath.toLowerCase().endsWith('.tif')) {
    return null
  }
  if (source.kind === 'terrain') {
    return { type: 'geotiff-dem', localPath: file.localPath, description: 'Copernicus DEM raster' }
  }
  if (source.kind === 'landcover') {
    return { type: 'geotiff-landcover', localPath: file.localPath, description: 'Land cover raster' }
  }
  return null
}

function resolveOverlay(overlay, latestFiles) {
  const matched = latestFiles.find((file) => file.localPath === overlay.localPath)
  return {
    type: overlay.type,
    fileName: matched?.fileName ?? path.basename(overlay.localPath),
    webPath: matched?.webPath ?? overlay.webPath ?? null,
    description: overlay.description ?? '',
  }
}

function buildCycleUrl(source, vars, fileName) {
  const baseUrl = renderTemplate(source.baseUrlTemplate, vars)
  const query = new URLSearchParams()
  query.set('file', fileName)
  for (const [key, value] of Object.entries(source.baseQuery ?? {})) {
    query.set(key, renderTemplate(String(value), vars))
  }
  return `${baseUrl}?${query.toString()}`
}

function buildCycleCandidates(cycleHours, daysBack) {
  const result = []
  const now = new Date()
  for (let dayOffset = 0; dayOffset <= daysBack; dayOffset += 1) {
    const baseDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset))
    for (const hour of [...cycleHours].sort().reverse()) {
      const candidate = new Date(baseDate)
      candidate.setUTCHours(Number(hour), 0, 0, 0)
      if (candidate.getTime() <= now.getTime()) {
        result.push(candidate)
      }
    }
  }
  return result.sort((a, b) => b.getTime() - a.getTime())
}

function resolveWindyGrid(grid, variables) {
  const centerLat = toFiniteNumber(variables.AOI_LAT, 39.9)
  const centerLon = toFiniteNumber(variables.AOI_LON, 116.39)

  const fallback = {
    minLat: centerLat - 8,
    maxLat: centerLat + 8,
    minLon: centerLon - 8,
    maxLon: centerLon + 8,
    stepLat: 2,
    stepLon: 2,
  }

  const minLat = clamp(toFiniteNumber(grid?.minLat, fallback.minLat), -90, 90)
  const maxLat = clamp(toFiniteNumber(grid?.maxLat, fallback.maxLat), -90, 90)
  const minLon = clamp(toFiniteNumber(grid?.minLon, fallback.minLon), -180, 180)
  const maxLon = clamp(toFiniteNumber(grid?.maxLon, fallback.maxLon), -180, 180)
  const stepLat = Math.max(toFiniteNumber(grid?.stepLat, fallback.stepLat), 0.25)
  const stepLon = Math.max(toFiniteNumber(grid?.stepLon, fallback.stepLon), 0.25)

  return {
    minLat: Math.min(minLat, maxLat),
    maxLat: Math.max(minLat, maxLat),
    minLon: Math.min(minLon, maxLon),
    maxLon: Math.max(minLon, maxLon),
    stepLat,
    stepLon,
  }
}

function buildWindyGridPoints(grid) {
  const points = []
  for (let lat = grid.minLat; lat <= grid.maxLat + 0.0001; lat += grid.stepLat) {
    for (let lon = grid.minLon; lon <= grid.maxLon + 0.0001; lon += grid.stepLon) {
      points.push({
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
      })
    }
  }
  return points
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

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  )
  await Promise.all(workers)
  return results
}

function chunkArray(items, chunkSize) {
  const result = []
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize))
  }
  return result
}

function buildBandTransferBatches(items, chunkSize, bandParallelConnections) {
  const groups = new Map()
  for (const item of items) {
    const key = String(item.band ?? '')
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(item)
  }

  const lanes = []
  for (const [, bandItems] of groups) {
    const bandLanes = Array.from({ length: Math.min(bandParallelConnections, bandItems.length) }, () => [])
    for (let index = 0; index < bandItems.length; index += 1) {
      bandLanes[index % bandLanes.length].push(bandItems[index])
    }
    for (const laneItems of bandLanes) {
      lanes.push(...chunkArray(laneItems, chunkSize))
    }
  }

  return lanes.sort((left, right) => {
    const leftBand = String(left[0]?.band ?? '')
    const rightBand = String(right[0]?.band ?? '')
    return leftBand.localeCompare(rightBand) || left.length - right.length
  })
}

function groupHimawariCandidatesByBand(candidates) {
  const groups = new Map()
  for (const candidate of candidates) {
    const band = String(candidate.band ?? '')
    if (!groups.has(band)) {
      groups.set(band, [])
    }
    groups.get(band).push(candidate)
  }
  return new Map(
    [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  )
}

async function cleanupPartialFilesForCandidates(sourceRoot, candidates) {
  const snapshotKeys = new Set(candidates.map((candidate) => toSnapshotKey(candidate.acqTime)))
  for (const snapshotKey of snapshotKeys) {
    const snapshotDir = path.join(sourceRoot, snapshotKey)
    const entries = await fs.readdir(snapshotDir).catch(() => [])
    await Promise.all(
      entries
        .filter((entry) => entry.includes('.partial-'))
        .map((entry) => fs.unlink(path.join(snapshotDir, entry)).catch(() => {})),
    )
  }
}

async function downloadBandCandidatesViaFtp({ source, sourceRoot, variables, config, band, bandCandidates }) {
  const fallbackSource = {
    ...source,
    type: 'jaxa-ftp-himawari',
    bands: [band],
    lookbackSlots: Math.max(Number(source.lookbackSlots ?? 2), 1),
    requireAllBandsInSlot: true,
    preferLatestCompleteSlot: true,
    maxParallelDownloads: 1,
    maxParallelConnections: 1,
    bandParallelConnections: 1,
    ftpBatchSize: 1,
  }
  const result = await syncJaxaFtpHimawari({ source: fallbackSource, sourceRoot, variables, config })
  const candidateByName = new Map(bandCandidates.map((candidate) => [candidate.fileName, candidate]))
  const rows = []
  for (const file of result.files) {
    const fileName = path.basename(file.localPath)
    const candidate = candidateByName.get(fileName)
    const fileSize = file.size ?? (await fs.stat(file.localPath)).size
    const checksum = await checksumFileMd5(file.localPath)
    rows.push({
      downloaded: true,
      file: { localPath: file.localPath, size: fileSize },
      row: {
        satellite: String(source.satellite ?? 'H09'),
        sensor: String(source.sensor ?? 'AHI'),
        acqTime: candidate?.acqTime ?? result.acquisitionTime ?? new Date().toISOString(),
        band,
        roiCode: String(source.roiCode ?? variables.ROI_CODE ?? 'CN'),
        filePath: file.localPath,
        fileSize,
        checksum,
        storeFileBlob: source.storeFileBlobInDatabase !== false,
        downloadTime: new Date().toISOString(),
        downloadStatus: 'downloaded',
        sceneName: fileName,
      },
    })
  }
  return rows
}

function pickForecastIndex(ts, targetForecastMs) {
  let lastValidIndex = -1
  for (let index = 0; index < ts.length; index += 1) {
    const value = Number(ts[index])
    if (!Number.isFinite(value)) {
      continue
    }
    lastValidIndex = index
    if (value >= targetForecastMs) {
      return index
    }
  }
  return lastValidIndex
}

function parseWindyValuesAtIndex(payload, index) {
  const units = payload?.units ?? {}

  const uMs = toRoundedNumber(getSeriesValue(payload, 'wind_u-surface', index), 2)
  const vMs = toRoundedNumber(getSeriesValue(payload, 'wind_v-surface', index), 2)
  const windMs =
    Number.isFinite(uMs) && Number.isFinite(vMs)
      ? Number(Math.hypot(uMs, vMs).toFixed(1))
      : null

  const tempC = toRoundedNumber(
    toCelsius(getSeriesValue(payload, 'temp-surface', index), units['temp-surface']),
    1,
  )
  const dewpointC = toRoundedNumber(
    toCelsius(getSeriesValue(payload, 'dewpoint-surface', index), units['dewpoint-surface']),
    1,
  )
  const rhPct = toRoundedNumber(getSeriesValue(payload, 'rh-surface', index), 1)
  const pressureHpa = toRoundedNumber(
    toHpa(getSeriesValue(payload, 'pressure-surface', index), units['pressure-surface']),
    1,
  )
  const gustMs = toRoundedNumber(getSeriesValue(payload, 'gust-surface', index), 1)
  const precip3hMm = toRoundedNumber(
    toMillimeters(getSeriesValue(payload, 'past3hprecip-surface', index), units['past3hprecip-surface']),
    2,
  )
  const convPrecip3hMm = toRoundedNumber(
    toMillimeters(
      getSeriesValue(payload, 'past3hconvprecip-surface', index),
      units['past3hconvprecip-surface'],
    ),
    2,
  )
  const capeJkg = toRoundedNumber(getSeriesValue(payload, 'cape-surface', index), 1)
  const lcloudPct = toRoundedNumber(getSeriesValue(payload, 'lclouds-surface', index), 1)
  const mcloudPct = toRoundedNumber(getSeriesValue(payload, 'mclouds-surface', index), 1)
  const hcloudPct = toRoundedNumber(getSeriesValue(payload, 'hclouds-surface', index), 1)

  return {
    tempC,
    dewpointC,
    rhPct,
    pressureHpa,
    windMs,
    uMs,
    vMs,
    gustMs,
    precip3hMm,
    convPrecip3hMm,
    capeJkg,
    lcloudPct,
    mcloudPct,
    hcloudPct,
    fireRisk: calcFireRisk({ tempC, rhPct, windMs, precip3hMm, convPrecip3hMm, capeJkg }),
  }
}

function getSeriesValue(payload, key, index) {
  const series = payload?.[key]
  if (!Array.isArray(series)) {
    return null
  }
  const value = Number(series[index])
  return Number.isFinite(value) ? value : null
}

function toCelsius(value, unit) {
  if (!Number.isFinite(value)) {
    return null
  }
  const normalizedUnit = String(unit ?? '').toLowerCase()
  if (normalizedUnit.includes('k')) {
    return value - 273.15
  }
  return value
}

function toHpa(value, unit) {
  if (!Number.isFinite(value)) {
    return null
  }
  const normalizedUnit = String(unit ?? '').toLowerCase()
  if (normalizedUnit === 'pa' || normalizedUnit.endsWith('*pa')) {
    return value / 100
  }
  if (normalizedUnit === 'kpa') {
    return value * 10
  }
  return value
}

function toMillimeters(value, unit) {
  if (!Number.isFinite(value)) {
    return null
  }
  const normalizedUnit = String(unit ?? '').toLowerCase()
  if (normalizedUnit === 'm') {
    return value * 1000
  }
  return value
}

function calcFireRisk(values) {
  const dryness = values.rhPct === null ? 0.4 : clamp((100 - values.rhPct) / 100, 0, 1)
  const heat = values.tempC === null ? 0.3 : clamp((values.tempC - 18) / 20, 0, 1)
  const wind = values.windMs === null ? 0.25 : clamp(values.windMs / 18, 0, 1)
  const convective = values.capeJkg === null ? 0 : clamp(values.capeJkg / 2500, 0, 1) * 0.2
  const rainfall = clamp(((values.precip3hMm ?? 0) + (values.convPrecip3hMm ?? 0)) / 6, 0, 1)
  const risk = clamp(0.38 * dryness + 0.32 * heat + 0.22 * wind + convective - 0.35 * rainfall, 0, 1)
  return Math.round(risk * 100)
}

function buildWindyGridRing(centerLon, centerLat, stepLon, stepLat) {
  const minLon = normalizeLongitude(centerLon - stepLon / 2)
  const maxLon = normalizeLongitude(centerLon + stepLon / 2)
  const minLat = clamp(centerLat - stepLat / 2, -90, 90)
  const maxLat = clamp(centerLat + stepLat / 2, -90, 90)
  const rightLon = maxLon < minLon ? maxLon + 360 : maxLon

  return [
    [minLon, minLat],
    [rightLon, minLat],
    [rightLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
}

function toRoundedNumber(value, digits) {
  if (!Number.isFinite(value)) {
    return null
  }
  return Number(value.toFixed(digits))
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function buildRecentCycleCandidates(cycleHours, availabilityLagHours, maxCandidates) {
  const result = []
  const anchor = new Date(Date.now() - availabilityLagHours * 60 * 60 * 1000)
  const sortedHours = [...cycleHours].sort((a, b) => Number(b) - Number(a))
  let cursor = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()))

  while (result.length < maxCandidates) {
    for (const hour of sortedHours) {
      const candidate = new Date(cursor)
      candidate.setUTCHours(Number(hour), 0, 0, 0)
      if (candidate.getTime() <= anchor.getTime()) {
        result.push(candidate)
        if (result.length >= maxCandidates) {
          break
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  return result
}

async function publishLatestFiles(sourceId, files) {
  const publishRoot = path.join(projectRoot, 'public', 'data', 'published', sourceId)
  await fs.rm(publishRoot, { recursive: true, force: true })
  await ensureDir(publishRoot)
  const published = []
  for (const file of files) {
    const targetPath = path.join(publishRoot, path.basename(file.localPath))
    await fs.copyFile(file.localPath, targetPath)
    published.push({
      publishedPath: targetPath,
      webPath: `/data/published/${sourceId}/${path.basename(targetPath)}`,
    })
  }
  return published
}

async function cleanupOldSnapshots(sourceRoot, latestSnapshot, keepSnapshots) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  const snapshotDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => name !== latestSnapshot).sort().reverse()
  const toDelete = snapshotDirs.slice(Math.max(keepSnapshots - 1, 0))
  for (const entry of toDelete) {
    await fs.rm(path.join(sourceRoot, entry), { recursive: true, force: true })
  }
}

async function cleanupExpiredSourceData({ source, sourceRoot, latestAcquisitionTime }) {
  const retentionMinutes = resolveRetentionMinutes(source)
  if (!retentionMinutes) {
    return
  }

  const latestMs = Date.parse(latestAcquisitionTime ?? '')
  if (!Number.isFinite(latestMs)) {
    return
  }

  const cutoffIso = new Date(latestMs - retentionMinutes * 60_000).toISOString()
  const dbPath = resolvePath(projectRoot, source.databasePath ?? './fire_monitor.geodatabase')

  await deleteExpiredRawSceneRows({
    dbPath,
    sourceRoot,
    cutoffIso,
  })
  await deleteExpiredSnapshotDirectories(sourceRoot, cutoffIso)
  await removeEmptyDirectories(sourceRoot, sourceRoot)
}

function resolveRetentionMinutes(source) {
  const configured = Number(source.retentionMinutes)
  if (Number.isFinite(configured) && configured > 0) {
    return configured
  }

  if (source.type === 'noaa-aws-s3-himawari' || source.type === 'jaxa-ftp-himawari') {
    return 60
  }

  return 0
}

async function deleteExpiredRawSceneRows({ dbPath, sourceRoot, cutoffIso }) {
  if (!(await fileExists(dbPath))) {
    return
  }

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  let inTransaction = false
  try {
    ensureRawSceneTableForIngestion(db)

    const rows = db.prepare(`
      SELECT scene_id, file_path, scene_path
      FROM raw_scene
      WHERE COALESCE(acq_time, scene_time_utc) < ?
        AND (
          file_path LIKE ?
          OR scene_path LIKE ?
        )
    `).all(cutoffIso, `${sourceRoot}%`, `${sourceRoot}%`)

    if (!rows.length) {
      return
    }

    const filePaths = new Set()
    for (const row of rows) {
      for (const candidate of [row.file_path, row.scene_path]) {
        if (typeof candidate !== 'string' || candidate.length === 0) {
          continue
        }
        if (isPathInsideRoot(sourceRoot, candidate)) {
          filePaths.add(candidate)
        }
      }
    }

    db.exec('BEGIN;')
    inTransaction = true
    const deleteById = db.prepare('DELETE FROM raw_scene WHERE scene_id = ?')
    for (const row of rows) {
      deleteById.run(row.scene_id)
    }
    db.exec('COMMIT;')
    inTransaction = false

    for (const filePath of filePaths) {
      await fs.rm(filePath, { force: true })
    }
  } catch (error) {
    if (inTransaction) {
      db.exec('ROLLBACK;')
    }
    throw error
  } finally {
    db.close()
  }
}

async function deleteExpiredSnapshotDirectories(sourceRoot, cutoffIso) {
  const cutoffMs = Date.parse(cutoffIso)
  if (!Number.isFinite(cutoffMs)) {
    return
  }

  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const snapshotMs = parseSnapshotKeyMs(entry.name)
    if (!Number.isFinite(snapshotMs) || snapshotMs >= cutoffMs) {
      continue
    }

    await fs.rm(path.join(sourceRoot, entry.name), { recursive: true, force: true })
  }
}

function parseSnapshotKeyMs(snapshotKey) {
  const matched = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(snapshotKey))
  if (!matched) {
    return Number.NaN
  }

  const [, year, month, day, hour, minute] = matched
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  )
}

function isPathInsideRoot(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath)
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

async function removeEmptyDirectories(currentDir, stopDir) {
  const resolvedCurrent = path.resolve(currentDir)
  const resolvedStop = path.resolve(stopDir)
  const entries = await fs.readdir(resolvedCurrent).catch(() => [])

  for (const entry of entries) {
    const entryPath = path.join(resolvedCurrent, entry)
    const stats = await fs.stat(entryPath).catch(() => null)
    if (stats?.isDirectory()) {
      await removeEmptyDirectories(entryPath, resolvedStop)
    }
  }

  if (resolvedCurrent === resolvedStop) {
    return
  }

  const remaining = await fs.readdir(resolvedCurrent).catch(() => null)
  if (remaining && remaining.length === 0) {
    await fs.rmdir(resolvedCurrent).catch(() => {})
  }
}

async function urlExists(url) {
  const response = await fetchWithTimeout(url, { method: 'HEAD' }, 20000)
  return response.ok
}

async function downloadFile(url, localPath, timeoutMs = 180000) {
  const tempPath = `${localPath}.partial-${process.pid}-${Date.now()}`
  const response = await fetchWithTimeout(url, {}, timeoutMs)
  if (!response.ok) {
    throw new Error(`download failed ${response.status} for ${url}`)
  }
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer()
    await fs.writeFile(tempPath, Buffer.from(arrayBuffer))
    await fs.rename(tempPath, localPath)
    return
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
    await fs.rename(tempPath, localPath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

async function downloadFileWithRetry({ url, localPath, timeoutMs, retries, retryDelayMs }) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadFile(url, localPath, timeoutMs)
      return
    } catch (error) {
      lastError = error
      await fs.unlink(localPath).catch(() => {})
      if (attempt === retries) {
        break
      }
      console.warn(`[sync] NOAA download retry ${attempt + 1}/${retries} for ${path.basename(localPath)}`)
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }
  throw lastError
}

async function listFtpDirectory({ host, remoteDir, username, password, requestTimeoutMs }) {
  const normalizedDir = `${String(remoteDir).replace(/\/+$/, '')}/`
  const url = buildFtpUrl(host, normalizedDir)
  const { stdout } = await runCurlCommand(
    [
      '--disable-epsv',
      '--ftp-method',
      'nocwd',
      '--ftp-skip-pasv-ip',
      '--fail',
      '--silent',
      '--show-error',
      '--user',
      `${username}:${password}`,
      '--list-only',
      url,
    ],
    requestTimeoutMs,
  )

  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function buildFtpUrl(host, remotePath) {
  const normalizedHost = String(host).replace(/^ftp:\/\//i, '').replace(/\/$/, '')
  const normalizedPath = String(remotePath).replace(/\\/g, '/').replace(/^\/+/, '')
  return `ftp://${normalizedHost}/${normalizedPath}`
}

async function downloadFtpFileWithRetry({
  host,
  remotePath,
  localPath,
  username,
  password,
  timeoutMs,
  retries,
  retryDelayMs,
}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadFtpFile({ host, remotePath, localPath, username, password, timeoutMs })
      return
    } catch (error) {
      lastError = error
      await fs.unlink(localPath).catch(() => {})
      if (attempt === retries) {
        break
      }
      console.warn(`[sync] FTP download retry ${attempt + 1}/${retries} for ${path.basename(localPath)}`)
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs)
      }
    }
  }
  throw lastError
}

async function downloadFtpBatchWithRetry({
  host,
  username,
  password,
  timeoutMs,
  retries,
  retryDelayMs,
  lowSpeedLimitBytes,
  lowSpeedTimeSeconds,
  transfers,
}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadFtpBatch({
        host,
        username,
        password,
        timeoutMs,
        lowSpeedLimitBytes,
        lowSpeedTimeSeconds,
        transfers,
      })
      return
    } catch (error) {
      lastError = error
      if (attempt === retries) {
        break
      }
      const label = transfers.map((transfer) => path.basename(transfer.localPath)).slice(0, 2).join(', ')
      console.warn(`[sync] FTP batch retry ${attempt + 1}/${retries} for ${label}${transfers.length > 2 ? ', ...' : ''}`)
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs)
      }
    }
  }
  throw lastError
}

async function downloadFtpBatch({ host, username, password, timeoutMs, lowSpeedLimitBytes, lowSpeedTimeSeconds, transfers }) {
  if (!Array.isArray(transfers) || transfers.length === 0) {
    return
  }

  const timeoutSeconds = Math.max(Math.ceil(timeoutMs / 1000), 10)
  const connectTimeoutSeconds = Math.max(Math.min(Math.floor(timeoutSeconds / 3), 30), 5)
  const args = []

  for (let index = 0; index < transfers.length; index += 1) {
    const transfer = transfers[index]
    args.push(
      '--disable-epsv',
      '--ftp-method',
      'nocwd',
      '--ftp-skip-pasv-ip',
      '--fail',
      '--silent',
      '--show-error',
      '--user',
      `${username}:${password}`,
      '--connect-timeout',
      String(connectTimeoutSeconds),
      '--max-time',
      String(timeoutSeconds),
      '--speed-limit',
      String(lowSpeedLimitBytes),
      '--speed-time',
      String(lowSpeedTimeSeconds),
      '--keepalive-time',
      '30',
      '--continue-at',
      '-',
      '--output',
      transfer.localPath,
      buildFtpUrl(host, transfer.remotePath),
    )
    if (index < transfers.length - 1) {
      args.push('--next')
    }
  }

  await runCurlCommand(args, timeoutMs + Math.max(15_000, transfers.length * 5_000))
}

async function downloadFtpFile({ host, remotePath, localPath, username, password, timeoutMs }) {
  const url = buildFtpUrl(host, remotePath)
  const timeoutSeconds = Math.max(Math.ceil(timeoutMs / 1000), 10)
  const connectTimeoutSeconds = Math.max(Math.min(Math.floor(timeoutSeconds / 3), 30), 5)

  await runCurlCommand(
    [
      '--disable-epsv',
      '--ftp-method',
      'nocwd',
      '--ftp-skip-pasv-ip',
      '--fail',
      '--silent',
      '--show-error',
      '--user',
      `${username}:${password}`,
      '--continue-at',
      '-',
      '--keepalive-time',
      '30',
      '--connect-timeout',
      String(connectTimeoutSeconds),
      '--max-time',
      String(timeoutSeconds),
      '--speed-limit',
      '1024',
      '--speed-time',
      '60',
      '--output',
      localPath,
      url,
    ],
    timeoutMs + 15_000,
  )
}

async function runCurlCommand(args, timeoutMs) {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl'
  try {
    return await execFileAsync(command, args, timeoutMs)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('curl is required for FTP sync but was not found in PATH')
    }
    throw error
  }
}

function execFileAsync(command, args, optionsOrTimeoutMs) {
  const options = typeof optionsOrTimeoutMs === 'number'
    ? { timeout: optionsOrTimeoutMs }
    : { ...(optionsOrTimeoutMs ?? {}) }
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim() || String(error.message ?? '').trim()
          const wrappedError = new Error(`${command} failed${detail ? `: ${detail}` : ''}`)
          wrappedError.code = error.code
          reject(wrappedError)
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponseError(response) {
  try {
    const text = await response.text()
    if (!text) {
      return ''
    }

    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.message === 'string') {
        return parsed.message
      }
      return text
    } catch {
      return text
    }
  } catch {
    return ''
  }
}

function buildVariables(baseVariables, date) {
  const target = date instanceof Date ? date : new Date()
  const year = target.getUTCFullYear()
  const month = String(target.getUTCMonth() + 1).padStart(2, '0')
  const day = String(target.getUTCDate()).padStart(2, '0')
  const hour = String(target.getUTCHours()).padStart(2, '0')
  const minute = String(target.getUTCMinutes()).padStart(2, '0')
  const aoiLon = Number(baseVariables.AOI_LON ?? 116.39)
  const aoiLat = Number(baseVariables.AOI_LAT ?? 39.9)
  return {
    ...baseVariables,
    YYYY: String(year),
    MM: month,
    DD: day,
    HH: hour,
    mm: minute,
    YYYYMM: `${year}${month}`,
    YYYYMMDD: `${year}${month}${day}`,
    AOI_LON: String(aoiLon),
    AOI_LAT: String(aoiLat),
    DEM_TILE: buildDemTileName(aoiLat, aoiLon),
    WORLDCOVER_TILE: buildWorldCoverTileName(aoiLat, aoiLon),
  }
}

function buildDemTileName(lat, lon) {
  const tileLat = Math.floor(lat)
  const tileLon = Math.floor(lon)
  return `${toHemisphere(tileLat, 'NS')}${String(Math.abs(tileLat)).padStart(2, '0')}_00_${toHemisphere(tileLon, 'EW')}${String(Math.abs(tileLon)).padStart(3, '0')}_00`
}

function buildWorldCoverTileName(lat, lon) {
  const tileLat = Math.floor(lat / 3) * 3
  const tileLon = Math.floor(lon / 3) * 3
  return `${toHemisphere(tileLat, 'NS')}${String(Math.abs(tileLat)).padStart(2, '0')}${toHemisphere(tileLon, 'EW')}${String(Math.abs(tileLon)).padStart(3, '0')}`
}

function toHemisphere(value, axis) {
  return axis === 'NS' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
}

function renderTemplate(template, variables) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => variables[key] ?? '')
}

function toSnapshotKey(value) {
  return value.replace(/[-:TZ.]/g, '').slice(0, 12)
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[<>:"/\\|?*]+/g, '_')
}

function resolvePath(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath)
}

async function loadConfig(configPath) {
  return JSON.parse(await fs.readFile(configPath, 'utf8'))
}

async function loadCatalogIfExists(catalogOutput) {
  try {
    const content = await fs.readFile(catalogOutput, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function readPublishedFiles(sourceId) {
  const publishedRoot = path.join(projectRoot, 'public', 'data', 'published', sourceId)
  try {
    const entries = await fs.readdir(publishedRoot, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      const publishedPath = path.join(publishedRoot, entry.name)
      const stats = await fs.stat(publishedPath)
      files.push({
        fileName: entry.name,
        localPath: publishedPath,
        size: stats.size,
        webPath: `/data/published/${sourceId}/${entry.name}`,
        publishedPath,
        modifiedTimeMs: stats.mtimeMs,
      })
    }

    return files
      .sort((a, b) => b.modifiedTimeMs - a.modifiedTimeMs)
      .map((file) => ({
        fileName: file.fileName,
        localPath: file.localPath,
        size: file.size,
        webPath: file.webPath,
        publishedPath: file.publishedPath,
      }))
  } catch {
    return []
  }
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true })
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function hasUsableDownloadedFile(targetPath) {
  try {
    const stats = await fs.stat(targetPath)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(taskPromise, timeoutMs, message) {
  let timer = null
  return Promise.race([
    taskPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message))
      }, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

async function writeGfsOverlay(gribPath, overlayPath, sampleStep) {
  const buffer = await fs.readFile(gribPath)
  const records = parseSimplePackedGrib2(buffer)
  const temperature = records.find((record) => record.parameterCategory === 0 && record.parameterNumber === 0 && record.surfaceType === 103 && record.surfaceValue === 2)
  const uWind = records.find((record) => record.parameterCategory === 2 && record.parameterNumber === 2 && record.surfaceType === 103 && record.surfaceValue === 10)
  const vWind = records.find((record) => record.parameterCategory === 2 && record.parameterNumber === 3 && record.surfaceType === 103 && record.surfaceValue === 10)
  if (!temperature || !uWind || !vWind) {
    throw new Error('GFS overlay records not found in forecast file')
  }

  const features = []
  for (let j = 0; j < temperature.grid.ny; j += sampleStep) {
    for (let i = 0; i < temperature.grid.nx; i += sampleStep) {
      const index = j * temperature.grid.nx + i
      const minLon = normalizeLongitude(temperature.grid.lo1 + i * temperature.grid.dx)
      const minLat = temperature.grid.la1 + j * temperature.grid.dy
      const maxLon = normalizeLongitude(
        temperature.grid.lo1 + Math.min(i + sampleStep, temperature.grid.nx - 1) * temperature.grid.dx,
      )
      const maxLat = temperature.grid.la1 + Math.min(j + sampleStep, temperature.grid.ny - 1) * temperature.grid.dy
      const tempK = getSimplePackedValue(temperature, index)
      const u = getSimplePackedValue(uWind, index)
      const v = getSimplePackedValue(vWind, index)
      if (![tempK, u, v].every(Number.isFinite)) continue
      const ring = buildGridRing(minLon, minLat, maxLon, maxLat)
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          tempC: Number((tempK - 273.15).toFixed(1)),
          windMs: Number(Math.hypot(u, v).toFixed(1)),
          uMs: Number(u.toFixed(1)),
          vMs: Number(v.toFixed(1)),
        },
      })
    }
  }

  await fs.writeFile(overlayPath, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8')
}

function buildGridRing(minLon, minLat, maxLon, maxLat) {
  const rightLon = maxLon < minLon ? maxLon + 360 : maxLon
  return [
    [minLon, minLat],
    [rightLon, minLat],
    [rightLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
}

function parseSimplePackedGrib2(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const records = []
  let offset = 0
  while (offset <= buffer.byteLength - 16) {
    if (readAscii(view, offset, 4) !== 'GRIB') {
      offset += 1
      continue
    }
    const totalLength = readUint64(view, offset + 8)
    const messageEnd = offset + totalLength
    let cursor = offset + 16
    const record = { view }
    while (cursor < messageEnd - 4) {
      const sectionLength = view.getUint32(cursor, false)
      const sectionNumber = view.getUint8(cursor + 4)
      const sectionStart = cursor + 5
      if (sectionNumber === 3) record.grid = parseGridSection(view, sectionStart)
      if (sectionNumber === 4) Object.assign(record, parseProductSection(view, sectionStart))
      if (sectionNumber === 5) record.representation = parseRepresentationSection(view, sectionStart)
      if (sectionNumber === 6 && view.getUint8(sectionStart) !== 255) throw new Error('bitmap sections are not supported')
      if (sectionNumber === 7) {
        record.section7 = {
          offset: sectionStart,
          byteLength: sectionLength - 5,
          packed: new Uint8Array(view.buffer, view.byteOffset + sectionStart, sectionLength - 5),
        }
      }
      cursor += sectionLength
    }
    if (record.grid && record.representation && record.section7) records.push(record)
    offset = messageEnd
  }
  return records
}

function parseGridSection(view, offset) {
  const template = view.getUint16(offset + 7, false)
  if (template !== 0) throw new Error(`unsupported GFS grid template: ${template}`)
  const basicAngle = normalizeBasicAngle(view.getUint32(offset + 33, false), view.getUint32(offset + 37, false))
  return {
    nx: view.getUint32(offset + 25, false),
    ny: view.getUint32(offset + 29, false),
    la1: readGribSignedInt32(view, offset + 41) * basicAngle,
    lo1: readGribSignedInt32(view, offset + 45) * basicAngle,
    dx: readGribSignedInt32(view, offset + 58) * basicAngle,
    dy: readGribSignedInt32(view, offset + 62) * basicAngle,
  }
}

function parseProductSection(view, offset) {
  return {
    parameterCategory: view.getUint8(offset + 4),
    parameterNumber: view.getUint8(offset + 5),
    surfaceType: view.getUint8(offset + 17),
    surfaceValue: view.getUint8(offset + 18) > 0 ? view.getUint32(offset + 19, false) / 10 ** view.getUint8(offset + 18) : view.getUint32(offset + 19, false),
  }
}

function parseRepresentationSection(view, offset) {
  const template = view.getUint16(offset + 4, false)
  if (template !== 0) throw new Error(`unsupported GFS data representation template: ${template}`)
  return {
    dataPointCount: view.getUint32(offset, false),
    referenceValue: view.getFloat32(offset + 6, false),
    binaryScaleFactor: view.getInt16(offset + 10, false),
    decimalScaleFactor: view.getInt16(offset + 12, false),
    bitsPerValue: view.getUint8(offset + 14),
  }
}

function getSimplePackedValue(record, index) {
  const { section7, representation } = record
  const { dataPointCount, referenceValue, binaryScaleFactor, decimalScaleFactor, bitsPerValue } = representation
  if (index < 0 || index >= dataPointCount) {
    return NaN
  }
  if (bitsPerValue === 0) return referenceValue
  const unpacked = readBits(section7.packed, index * bitsPerValue, bitsPerValue)
  return (referenceValue + unpacked * 2 ** binaryScaleFactor) / 10 ** decimalScaleFactor
}

function readBits(bytes, bitOffset, bitLength) {
  let result = 0
  for (let bitIndex = 0; bitIndex < bitLength; bitIndex += 1) {
    const absoluteBit = bitOffset + bitIndex
    const byteIndex = Math.floor(absoluteBit / 8)
    const innerBit = 7 - (absoluteBit % 8)
    result = (result << 1) | ((bytes[byteIndex] >> innerBit) & 1)
  }
  return result
}

function normalizeLongitude(lon) {
  let normalized = lon
  while (normalized > 180) normalized -= 360
  while (normalized < -180) normalized += 360
  return normalized
}

function normalizeBasicAngle(basicAngle, subdivisions) {
  return (basicAngle === 0 || basicAngle === 0xffffffff ? 1 : basicAngle) / (subdivisions === 0 || subdivisions === 0xffffffff ? 1000000 : subdivisions)
}

function readGribSignedInt32(view, offset) {
  const raw = view.getUint32(offset, false)
  const signBit = raw & 0x80000000
  const magnitude = raw & 0x7fffffff
  return signBit ? -magnitude : magnitude
}

function readUint64(view, offset) {
  return view.getUint32(offset, false) * 2 ** 32 + view.getUint32(offset + 4, false)
}

function readAscii(view, offset, length) {
  let result = ''
  for (let index = 0; index < length; index += 1) result += String.fromCharCode(view.getUint8(offset + index))
  return result
}

if (!process.env.SYNC_DATA_IMPORT_ONLY) {
  main().catch((error) => {
    console.error('[sync] fatal error', error)
    process.exitCode = 1
  })
}

export { writeGfsOverlay, parseSimplePackedGrib2 }
