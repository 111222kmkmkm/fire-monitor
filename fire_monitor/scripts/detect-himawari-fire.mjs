#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const defaultConfigPath = path.resolve(projectRoot, '.detect-himawari-fire.config.json')

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const config = await loadJson(options.configPath)
  await runDetection(config)
}

function parseCliArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
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

async function runDetection(config) {
  const scenePath = resolvePath(projectRoot, config.scenePath)
  const outputDir = resolvePath(projectRoot, config.outputDir ?? './public/data/algorithm/latest')
  const dbPath = config.databasePath ? resolvePath(projectRoot, config.databasePath) : null
  const scene = await loadJson(scenePath)
  const raster = await loadSceneRaster(scenePath, scene)
  validateSceneRaster(raster)

  const thresholds = {
    suspiciousOffsetK: Number(config.thresholds?.suspiciousOffsetK ?? 20),
    suspiciousVisibleFactor: Number(config.thresholds?.suspiciousVisibleFactor ?? 100),
    minValidRatio: Number(config.thresholds?.minValidRatio ?? 0.2),
    minStdT713K: Number(config.thresholds?.minStdT713K ?? 2),
    maxStdT713K: Number(config.thresholds?.maxStdT713K ?? 4),
    nightAbsoluteT7K: Number(config.thresholds?.nightAbsoluteT7K ?? 360),
    nightVisibleMax: Number(config.thresholds?.nightVisibleMax ?? 0.7),
    nightZenithDeg: Number(config.thresholds?.nightZenithDeg ?? 87),
    cloudVisibleDelta: Number(config.thresholds?.cloudVisibleDelta ?? 0.15),
    cloudT13DeltaK: Number(config.thresholds?.cloudT13DeltaK ?? 5),
    edgeThresholdC: Number(config.thresholds?.edgeThresholdC ?? 8),
    scoreScaleK: Number(config.thresholds?.scoreScaleK ?? 10),
  }

  const detection = detectFirePixels(raster, {
    windowSizes: Array.isArray(config.windowSizes) && config.windowSizes.length > 0 ? config.windowSizes : [7, 9, 11, 19],
    thresholds,
  })

  await fs.mkdir(outputDir, { recursive: true })
  const geojsonPath = path.join(outputDir, 'candidate_fire.geojson')
  const summaryPath = path.join(outputDir, 'candidate_fire_summary.json')

  const features = detection.fires.map((fire) => toGeoJsonFeature(fire))
  await fs.writeFile(geojsonPath, JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'utf8')
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sceneId: raster.sceneId ?? null,
        acquisitionTime: raster.acquisitionTime,
        width: raster.width,
        height: raster.height,
        fireCount: detection.fires.length,
        cloudPixelCount: detection.cloudPixelCount,
        notes: detection.notes,
      },
      null,
      2,
    ),
    'utf8',
  )

  if (dbPath) {
    await upsertCandidateFireRows(dbPath, detection.fires, raster)
  }

  console.log(`[detect-himawari-fire] detected ${detection.fires.length} candidate fire pixel(s)`)
}

async function loadSceneRaster(scenePath, scene) {
  const sceneRoot = path.dirname(scenePath)
  const width = Number(scene.width)
  const height = Number(scene.height)
  const size = width * height

  const b07 = await loadRasterBand(sceneRoot, scene.bands?.b07, size, 'b07')
  const b13 = await loadRasterBand(sceneRoot, scene.bands?.b13, size, 'b13')
  const b14 = await loadRasterBand(sceneRoot, scene.bands?.b14, size, 'b14')
  const rvis = scene.bands?.rvis ? await loadRasterBand(sceneRoot, scene.bands.rvis, size, 'rvis') : new Float32Array(size)
  const landMask = scene.masks?.land ? await loadMaskBand(sceneRoot, scene.masks.land, size, 'land') : null
  const nonVegetationMask = scene.masks?.nonVegetation ? await loadMaskBand(sceneRoot, scene.masks.nonVegetation, size, 'nonVegetation') : null
  const staticHotMask = scene.masks?.staticHot ? await loadMaskBand(sceneRoot, scene.masks.staticHot, size, 'staticHot') : null
  const highReflectanceMask = scene.masks?.highReflectance ? await loadMaskBand(sceneRoot, scene.masks.highReflectance, size, 'highReflectance') : null

  return {
    sceneId: scene.sceneId ?? null,
    acquisitionTime: String(scene.acquisitionTime),
    width,
    height,
    b07,
    b13,
    b14,
    rvis,
    landMask,
    nonVegetationMask,
    staticHotMask,
    highReflectanceMask,
    grid: {
      lon0: Number(scene.grid?.lon0),
      lat0: Number(scene.grid?.lat0),
      lonStep: Number(scene.grid?.lonStep),
      latStep: Number(scene.grid?.latStep),
    },
  }
}

function validateSceneRaster(raster) {
  if (!Number.isFinite(raster.width) || !Number.isFinite(raster.height) || raster.width <= 0 || raster.height <= 0) {
    throw new Error('scene width/height are invalid')
  }
  if (!raster.acquisitionTime || !Number.isFinite(Date.parse(raster.acquisitionTime))) {
    throw new Error('scene acquisitionTime is invalid')
  }
  if (![raster.grid.lon0, raster.grid.lat0, raster.grid.lonStep, raster.grid.latStep].every(Number.isFinite)) {
    throw new Error('scene grid metadata is invalid')
  }
}

async function loadRasterBand(sceneRoot, descriptor, size, label) {
  if (!descriptor?.path) {
    throw new Error(`missing band descriptor for ${label}`)
  }
  const filePath = resolvePath(sceneRoot, descriptor.path)
  const format = String(descriptor.format ?? 'float32le')

  if (format === 'float32le') {
    const buffer = await fs.readFile(filePath)
    const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
    if (view.length !== size) {
      throw new Error(`band ${label} size mismatch: expected ${size}, got ${view.length}`)
    }
    return new Float32Array(view)
  }

  if (format === 'json-array') {
    const values = JSON.parse(await fs.readFile(filePath, 'utf8'))
    if (!Array.isArray(values) || values.length !== size) {
      throw new Error(`band ${label} json-array size mismatch`)
    }
    return Float32Array.from(values.map((value) => Number(value)))
  }

  throw new Error(`unsupported band format for ${label}: ${format}`)
}

async function loadMaskBand(sceneRoot, descriptor, size, label) {
  const values = await loadRasterBand(sceneRoot, descriptor, size, label)
  const mask = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) {
    mask[index] = Number(values[index]) > 0 ? 1 : 0
  }
  return mask
}

function detectFirePixels(raster, options) {
  const { width, height, b07, b13, b14, rvis } = raster
  const size = width * height
  const windowSizes = options.windowSizes
  const notes = []
  if (!raster.nonVegetationMask) {
    notes.push('nonVegetation mask missing; Pv defaults to 0')
  }
  if (!raster.landMask) {
    notes.push('land mask missing; water filtering disabled')
  }
  if (!hasNonZero(rvis)) {
    notes.push('Rvis missing or empty; daytime cloud/high-reflection rejection is degraded')
  }

  const solar = buildSolarGeometry(raster)
  const t713 = new Float32Array(size)
  const cloudMask = new Uint8Array(size)

  for (let index = 0; index < size; index += 1) {
    t713[index] = b07[index] - b13[index]
  }

  for (let index = 0; index < size; index += 1) {
    cloudMask[index] = isCloudPixel(index, raster, solar.altitudeDeg, t713) ? 1 : 0
  }

  const fires = []
  for (let index = 0; index < size; index += 1) {
    if (!Number.isFinite(b07[index]) || !Number.isFinite(b13[index]) || !Number.isFinite(b14[index])) {
      continue
    }
    if (raster.landMask && raster.landMask[index] === 0) {
      continue
    }
    if (cloudMask[index]) {
      continue
    }
    if (raster.staticHotMask?.[index]) {
      continue
    }
    if (raster.highReflectanceMask?.[index]) {
      continue
    }

    const background = buildBackgroundContext(index, raster, solar.altitudeDeg, cloudMask, t713, windowSizes, options.thresholds)
    if (!background) {
      continue
    }

    const nightHot = b07[index] > options.thresholds.nightAbsoluteT7K
      && rvis[index] < options.thresholds.nightVisibleMax
      && solar.zenithDeg[index] > options.thresholds.nightZenithDeg

    const pv = background.nonVegetationRatio
    const pc = background.cloudRatio
    const altitude = solar.altitudeDeg[index]
    const dynamicFactor = altitude < 60
      ? (Math.sin(toRadians(Math.max(altitude, 0))) + 1) * (1 + pv) * (1 + pc)
      : (1.2 * Math.sin(toRadians(Math.max(altitude, 0))) + 1) * (1 + pv) * (1 + pc) ** 2

    const relativeHot = b07[index] >= background.t7Bg + dynamicFactor * background.stdT7
      && t713[index] >= background.t713Bg + dynamicFactor * background.stdT713

    if (!nightHot && !relativeHot) {
      continue
    }

    const cloudRejected = rvis[index] >= background.rvisBg + options.thresholds.cloudVisibleDelta
      && b13[index] <= background.t13Bg - options.thresholds.cloudT13DeltaK
    if (cloudRejected) {
      continue
    }

    const edgeRejected = b07[index] <= background.t7Bg + options.thresholds.edgeThresholdC * background.stdT7
      && t713[index] <= background.t713Bg + options.thresholds.edgeThresholdC * background.stdT713
    if (edgeRejected) {
      continue
    }

    const { lon, lat } = pixelToLonLat(index, raster)
    const score = computeFireScore(
      b07[index],
      t713[index],
      background.t7Bg,
      background.t713Bg,
      background.stdT7,
      background.stdT713,
      dynamicFactor,
      options.thresholds.scoreScaleK,
    )
    fires.push({
      index,
      sourceSat: 'H09',
      acqTimeUtc: raster.acquisitionTime,
      daynight: solar.zenithDeg[index] > 85 ? 'N' : 'D',
      fireStatus: 'suspected',
      score,
      btTir: roundNumber(b07[index], 2),
      btDif: roundNumber(t713[index], 2),
      lon,
      lat,
      minx: lon,
      maxx: lon,
      miny: lat,
      maxy: lat,
      geomWkt: `POINT (${lon} ${lat})`,
      sceneId: raster.sceneId ?? null,
      diagnostics: {
        dynamicFactor: roundNumber(dynamicFactor, 3),
        pv: roundNumber(pv, 3),
        pc: roundNumber(pc, 3),
        t7Bg: roundNumber(background.t7Bg, 2),
        t713Bg: roundNumber(background.t713Bg, 2),
      },
    })
  }

  return {
    fires,
    cloudPixelCount: countMask(cloudMask),
    notes,
  }
}

function buildBackgroundContext(centerIndex, raster, altitudeDeg, cloudMask, t713, windowSizes, thresholds) {
  for (const windowSize of windowSizes) {
    const context = sampleBackgroundWindow(centerIndex, raster, altitudeDeg, cloudMask, t713, windowSize, thresholds)
    if (context) {
      return context
    }
  }
  return null
}

function sampleBackgroundWindow(centerIndex, raster, altitudeDeg, cloudMask, t713, windowSize, thresholds) {
  const { width, height, b07, b13, rvis, nonVegetationMask, landMask } = raster
  const centerRow = Math.floor(centerIndex / width)
  const centerCol = centerIndex % width
  const radius = Math.floor(windowSize / 2)
  const candidates = []
  const available = []

  for (let dr = -radius; dr <= radius; dr += 1) {
    const row = centerRow + dr
    if (row < 0 || row >= height) {
      continue
    }
    for (let dc = -radius; dc <= radius; dc += 1) {
      const col = centerCol + dc
      if (col < 0 || col >= width) {
        continue
      }
      const index = row * width + col
      if (index === centerIndex) {
        continue
      }
      if (!Number.isFinite(b07[index]) || !Number.isFinite(b13[index])) {
        continue
      }
      if (landMask && landMask[index] === 0) {
        continue
      }

      const suspicious = b07[index] >= b13[index] + thresholds.suspiciousVisibleFactor * rvis[index] + thresholds.suspiciousOffsetK
      const pixel = {
        index,
        t7: b07[index],
        t13: b13[index],
        t713: t713[index],
        rvis: rvis[index],
        cloud: cloudMask[index] === 1,
        suspicious,
        nonVegetation: nonVegetationMask?.[index] === 1,
      }
      candidates.push(pixel)
      if (!pixel.cloud && !pixel.suspicious) {
        available.push(pixel)
      }
    }
  }

  const minValid = Math.ceil(candidates.length * thresholds.minValidRatio)
  if (available.length < minValid) {
    return null
  }

  const t7Bg = averageOf(available, (item) => item.t7)
  const t13Bg = averageOf(available, (item) => item.t13)
  const t713Bg = averageOf(available, (item) => item.t713)
  const rvisBg = averageOf(available, (item) => item.rvis)
  const stdT7 = Math.max(stddevOf(available, t7Bg, (item) => item.t7), 0.5)
  const stdT713Raw = stddevOf(available, t713Bg, (item) => item.t713)
  const stdT713 = clamp(stdT713Raw, thresholds.minStdT713K, thresholds.maxStdT713K)
  const cloudRatio = candidates.length > 0 ? candidates.filter((item) => item.cloud).length / candidates.length : 0
  const nonVegetationRatio = candidates.length > 0 ? candidates.filter((item) => item.nonVegetation).length / candidates.length : 0

  return {
    t7Bg,
    t13Bg,
    t713Bg,
    rvisBg,
    stdT7,
    stdT713,
    cloudRatio,
    nonVegetationRatio,
  }
}

function isCloudPixel(index, raster, altitudeDeg, t713) {
  const t7 = raster.b07[index]
  const t13 = raster.b13[index]
  const t14 = raster.b14[index]
  const rvis = raster.rvis[index]
  const altitude = altitudeDeg[index]

  return t713[index] < 4
    || (t713[index] > 20 && (t7 < 275 || t13 < 270))
    || (rvis > 0.28 && altitude < 70)
    || t14 < 265
    || (t13 < 270 && (t13 - t14 < 4 || t13 - t14 > 60))
}

function buildSolarGeometry(raster) {
  const size = raster.width * raster.height
  const altitudeDeg = new Float32Array(size)
  const zenithDeg = new Float32Array(size)
  const timestamp = new Date(raster.acquisitionTime)
  const dayOfYear = getDayOfYear(timestamp)
  const utcHour = timestamp.getUTCHours() + timestamp.getUTCMinutes() / 60 + timestamp.getUTCSeconds() / 3600
  const declinationRad = toRadians(23.45 * Math.sin(toRadians((360 / 365) * (284 + dayOfYear))))

  for (let index = 0; index < size; index += 1) {
    const { lon, lat } = pixelToLonLat(index, raster)
    const solarTime = utcHour + lon / 15
    const hourAngleDeg = 15 * (solarTime - 12)
    const latRad = toRadians(lat)
    const hourAngleRad = toRadians(hourAngleDeg)
    const sinAltitude = Math.sin(latRad) * Math.sin(declinationRad)
      + Math.cos(latRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad)
    const altitude = toDegrees(Math.asin(clamp(sinAltitude, -1, 1)))
    altitudeDeg[index] = altitude
    zenithDeg[index] = 90 - altitude
  }

  return { altitudeDeg, zenithDeg }
}

function pixelToLonLat(index, raster) {
  const col = index % raster.width
  const row = Math.floor(index / raster.width)
  const lon = raster.grid.lon0 + col * raster.grid.lonStep
  const lat = raster.grid.lat0 + row * raster.grid.latStep
  return {
    lon: roundNumber(lon, 6),
    lat: roundNumber(lat, 6),
  }
}

function computeFireScore(t7, t713, t7Bg, t713Bg, stdT7, stdT713, dynamicFactor, scoreScaleK) {
  const z1 = (t7 - (t7Bg + dynamicFactor * stdT7)) / Math.max(scoreScaleK, 0.1)
  const z2 = (t713 - (t713Bg + dynamicFactor * stdT713)) / Math.max(scoreScaleK, 0.1)
  return roundNumber(Math.max(0, 0.5 + z1 + z2), 3)
}

function toGeoJsonFeature(fire) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [fire.lon, fire.lat],
    },
    properties: {
      sourceSat: fire.sourceSat,
      acqTimeUtc: fire.acqTimeUtc,
      daynight: fire.daynight,
      fireStatus: fire.fireStatus,
      score: fire.score,
      btTir: fire.btTir,
      btDif: fire.btDif,
      sceneId: fire.sceneId,
      ...fire.diagnostics,
    },
  }
}

async function upsertCandidateFireRows(dbPath, fires, raster) {
  if (!fires.length) {
    return
  }

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  try {
    const existingSceneId = raster.sceneId ?? findSceneId(db, raster.acquisitionTime)
    db.exec('BEGIN;')
    const insert = db.prepare(`
      INSERT INTO candidate_fire (
        source_sat,
        acq_time_utc,
        daynight,
        fire_status,
        score,
        bt_tir,
        bt_dif,
        lon,
        lat,
        geom_wkt,
        minx,
        maxx,
        miny,
        maxy,
        scene_id
      ) VALUES (
        @source_sat,
        @acq_time_utc,
        @daynight,
        @fire_status,
        @score,
        @bt_tir,
        @bt_dif,
        @lon,
        @lat,
        @geom_wkt,
        @minx,
        @maxx,
        @miny,
        @maxy,
        @scene_id
      )
    `)

    const cleanup = db.prepare('DELETE FROM candidate_fire WHERE source_sat = ? AND acq_time_utc = ?')
    cleanup.run('H09', raster.acquisitionTime)

    for (const fire of fires) {
      insert.run({
        source_sat: fire.sourceSat,
        acq_time_utc: fire.acqTimeUtc,
        daynight: fire.daynight,
        fire_status: fire.fireStatus,
        score: fire.score,
        bt_tir: fire.btTir,
        bt_dif: fire.btDif,
        lon: fire.lon,
        lat: fire.lat,
        geom_wkt: fire.geomWkt,
        minx: fire.minx,
        maxx: fire.maxx,
        miny: fire.miny,
        maxy: fire.maxy,
        scene_id: existingSceneId,
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

function findSceneId(db, acquisitionTime) {
  const row = db.prepare(`
    SELECT scene_id
    FROM raw_scene
    WHERE acq_time = ?
    ORDER BY scene_id DESC
    LIMIT 1
  `).get(acquisitionTime)
  return row?.scene_id ?? null
}

function averageOf(items, getter) {
  if (!items.length) {
    return 0
  }
  let sum = 0
  for (const item of items) {
    sum += getter(item)
  }
  return sum / items.length
}

function stddevOf(items, mean, getter) {
  if (!items.length) {
    return 0
  }
  let sum = 0
  for (const item of items) {
    const delta = getter(item) - mean
    sum += delta * delta
  }
  return Math.sqrt(sum / items.length)
}

function countMask(mask) {
  let total = 0
  for (const value of mask) {
    total += value ? 1 : 0
  }
  return total
}

function hasNonZero(values) {
  for (const value of values) {
    if (Number(value) !== 0) {
      return true
    }
  }
  return false
}

function clamp(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue)
}

function roundNumber(value, digits) {
  return Number(value.toFixed(digits))
}

function toRadians(value) {
  return (value * Math.PI) / 180
}

function toDegrees(value) {
  return (value * 180) / Math.PI
}

function getDayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.floor((current - start) / 86400000)
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

function resolvePath(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath)
}

main().catch((error) => {
  console.error('[detect-himawari-fire] fatal error', error)
  process.exitCode = 1
})
