<script setup lang="ts">
// @ts-nocheck
import '@maptiler/sdk/dist/maptiler-sdk.css'
import './styles/query-tip.css'
import * as maptilersdk from '@maptiler/sdk'
import { PressureLayer, PrecipitationLayer, RadarLayer, TemperatureLayer, WindLayer } from '@maptiler/weather'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { installMapTilerFetchProxy } from './utils/maptilerProxy'

type BaseMapType = 'img' | 'vec' | 'dem'
type WeatherLayerId = 'radar' | 'precipitation' | 'wind-speed' | 'air-temperature' | 'pressure'
type WeatherLayerInstance = TemperatureLayer | PressureLayer | PrecipitationLayer | RadarLayer | WindLayer
type WeatherValueRow = {
  label: string
  value: string
}
type WeatherHoverInfo = {
  x: number
  y: number
  lon: number
  lat: number
  rows: WeatherValueRow[]
}

const props = defineProps<{
  baseMap: BaseMapType
  maptilerWeatherKey: string
  weatherLayerIds: WeatherLayerId[]
  weatherForecastHour: number
}>()

const emit = defineEmits<{
  (event: 'weather-frame-loading', payload: { hour: number; loading: boolean }): void
  (event: 'weather-frame-ready', payload: { hour: number }): void
}>()

const CHINA_CENTER: [number, number] = [104.5, 35.2]
const MAPTILER_PROXY_BASE = (import.meta.env.VITE_MAPTILER_PROXY_BASE ?? '').trim()
const SLOW_LOADING_THRESHOLD_MS = 5000
const WEATHER_FRAME_VISIBLE_DELAY_MS = 2000

const WEATHER_LABELS: Record<WeatherLayerId, string> = {
  radar: '天气雷达',
  precipitation: '降水',
  'wind-speed': '风速',
  'air-temperature': '气温',
  pressure: '气压',
}

const container = ref<HTMLDivElement | null>(null)
const weatherLoading = ref(false)
const weatherError = ref('')
const weatherFrameText = ref('未加载')
const weatherHoverInfo = ref<WeatherHoverInfo | null>(null)
const showSlowLoadingOverlay = ref(false)

let map: maptilersdk.Map | null = null
let weatherSyncToken = 0
let queryMarker: maptilersdk.Marker | null = null
let slowLoadingTimer: number | null = null
let isMapBootLoading = false
const weatherLayers = new Map<WeatherLayerId, WeatherLayerInstance>()

const selectedWeatherLabelText = computed(() =>
  props.weatherLayerIds.map((item) => WEATHER_LABELS[item] ?? item).join(' / '),
)

function formatCoordinate(value: number) {
  return value.toFixed(3)
}

function formatFixed(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--'
}

function getMapStyle() {
  const styleId = props.baseMap === 'img' ? 'satellite' : 'streets-v2'
  const baseUrl = MAPTILER_PROXY_BASE || 'https://api.maptiler.com'
  return `${baseUrl}/maps/${styleId}/style.json?key=${encodeURIComponent(props.maptilerWeatherKey)}`
}

function getWeatherInsertionLayerId() {
  if (!map) {
    return undefined
  }

  const styleLayers = map.getStyle()?.layers ?? []
  return styleLayers.find((layer) => layer.id === 'Water')?.id
    ?? styleLayers.find((layer) => layer.type === 'symbol')?.id
    ?? undefined
}

function createWeatherLayer(layerId: WeatherLayerId) {
  const common = {
    id: `weather-sdk-${layerId}`,
    smooth: true,
  }

  if (layerId === 'radar') {
    return new RadarLayer({ ...common, opacity: 0.92 })
  }
  if (layerId === 'precipitation') {
    return new PrecipitationLayer({ ...common, opacity: 0.82 })
  }
  if (layerId === 'wind-speed') {
    return new WindLayer({ ...common, opacity: 0.88 })
  }
  if (layerId === 'pressure') {
    return new PressureLayer({ ...common, opacity: 0.72 })
  }
  return new TemperatureLayer({ ...common, opacity: 0.78 })
}

function clearWeatherLayers() {
  if (!map) {
    weatherLayers.clear()
    return
  }

  for (const layer of weatherLayers.values()) {
    if (map.getLayer(layer.id)) {
      map.removeLayer(layer.id)
    }
  }

  weatherLayers.clear()
}

function removeWeatherQueryMarker() {
  queryMarker?.remove()
  queryMarker = null
}

function clearWeatherHoverInfo() {
  weatherHoverInfo.value = null
  removeWeatherQueryMarker()
}

function ensureWeatherQueryMarker(lon: number, lat: number) {
  if (!map) {
    return
  }

  if (!queryMarker) {
    const element = document.createElement('div')
    element.className = 'weather-query-marker'
    queryMarker = new maptilersdk.Marker({ element, anchor: 'center' })
      .setLngLat([lon, lat])
      .addTo(map)
    return
  }

  queryMarker.setLngLat([lon, lat])
}

function getLayerAnimationBounds(layer: WeatherLayerInstance) {
  const getStart = (layer as WeatherLayerInstance & { getAnimationStart?: () => number }).getAnimationStart
  const getEnd = (layer as WeatherLayerInstance & { getAnimationEnd?: () => number }).getAnimationEnd
  return {
    start: typeof getStart === 'function' ? getStart.call(layer) : null,
    end: typeof getEnd === 'function' ? getEnd.call(layer) : null,
  }
}

function applyWeatherAnimationTime(layer: WeatherLayerInstance) {
  const { start, end } = getLayerAnimationBounds(layer)
  const target = Math.floor(Date.now() / 1000) + Math.max(0, props.weatherForecastHour) * 3600
  const time = Math.min(end ?? target, Math.max(start ?? target, target))
  ;(layer as WeatherLayerInstance & { setAnimationTime: (time: number) => void }).setAnimationTime(time)
}

function getWeatherLayerTime(layer: WeatherLayerInstance) {
  const getAnimationTimeDate = (layer as WeatherLayerInstance & { getAnimationTimeDate?: () => Date }).getAnimationTimeDate
  if (typeof getAnimationTimeDate === 'function') {
    return getAnimationTimeDate.call(layer)
  }
  return null
}

function buildWindDirectionText(picked: { compassDirection?: string; directionAngle?: number }) {
  if (!Number.isFinite(picked.directionAngle)) {
    return '--'
  }
  const direction = picked.compassDirection ?? '--'
  return `${direction} ${formatFixed(Number(picked.directionAngle), 0)}°`
}

function buildWeatherValueRows(lon: number, lat: number) {
  const rows: WeatherValueRow[] = []

  for (const layerId of props.weatherLayerIds) {
    const layer = weatherLayers.get(layerId)
    if (!layer) {
      continue
    }

    if (layerId === 'air-temperature') {
      const picked = (layer as TemperatureLayer & { pickAt: (x: number, y: number) => { value: number } | null }).pickAt(lon, lat)
      rows.push({
        label: WEATHER_LABELS[layerId],
        value: picked ? `${formatFixed(picked.value, 1)} °C` : '--',
      })
      continue
    }

    if (layerId === 'pressure') {
      const picked = (layer as PressureLayer & { pickAt: (x: number, y: number) => { value: number } | null }).pickAt(lon, lat)
      rows.push({
        label: WEATHER_LABELS[layerId],
        value: picked ? `${formatFixed(picked.value, 0)} hPa` : '--',
      })
      continue
    }

    if (layerId === 'precipitation') {
      const picked = (layer as PrecipitationLayer & { pickAt: (x: number, y: number) => { value: number } | null }).pickAt(lon, lat)
      rows.push({
        label: WEATHER_LABELS[layerId],
        value: picked ? `${formatFixed(picked.value, 2)} mm/h` : '--',
      })
      continue
    }

    if (layerId === 'radar') {
      const picked = (layer as RadarLayer & { pickAt: (x: number, y: number) => { value: number } | null }).pickAt(lon, lat)
      rows.push({
        label: WEATHER_LABELS[layerId],
        value: picked ? `${formatFixed(picked.value, 1)} dBZ` : '--',
      })
      continue
    }

    const picked = (layer as WindLayer & {
      pickAt: (x: number, y: number) => {
        speedMetersPerSecond?: number
        compassDirection?: string
        directionAngle?: number
      } | null
    }).pickAt(lon, lat)

    rows.push({
      label: WEATHER_LABELS[layerId],
      value: picked?.speedMetersPerSecond !== undefined ? `${formatFixed(picked.speedMetersPerSecond, 1)} m/s` : '--',
    })
    rows.push({
      label: '风向',
      value: picked ? buildWindDirectionText(picked) : '--',
    })
  }

  return rows
}

function onCloseWeatherHover() {
  clearWeatherHoverInfo()
}

function onMapClick(event: { lngLat?: { lng: number; lat: number }; point?: { x: number; y: number } }) {
  const rawLon = event.lngLat?.lng
  const rawLat = event.lngLat?.lat
  if (!Number.isFinite(rawLon) || !Number.isFinite(rawLat)) {
    return
  }

  const lon = Number(rawLon)
  const lat = Number(rawLat)
  const x = Math.min((event.point?.x ?? 0) + 14, window.innerWidth - 240)
  const y = Math.min((event.point?.y ?? 0) + 14, window.innerHeight - 220)

  ensureWeatherQueryMarker(lon, lat)
  weatherHoverInfo.value = {
    x,
    y,
    lon,
    lat,
    rows: buildWeatherValueRows(lon, lat),
  }
}

function clearSlowLoadingTimer() {
  if (slowLoadingTimer !== null) {
    window.clearTimeout(slowLoadingTimer)
    slowLoadingTimer = null
  }
}

function beginSlowLoadingWatch() {
  isMapBootLoading = true
  showSlowLoadingOverlay.value = false
  clearSlowLoadingTimer()
  slowLoadingTimer = window.setTimeout(() => {
    if (isMapBootLoading) {
      showSlowLoadingOverlay.value = true
    }
  }, SLOW_LOADING_THRESHOLD_MS)
}

function endSlowLoadingWatch() {
  isMapBootLoading = false
  showSlowLoadingOverlay.value = false
  clearSlowLoadingTimer()
}

function waitForTimeout(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function waitForMapIdle() {
  if (!map) {
    return
  }

  if (map.loaded()) {
    await waitForAnimationFrame()
    return
  }

  await new Promise<void>((resolve) => {
    if (!map) {
      resolve()
      return
    }

    const onIdle = () => {
      map?.off('idle', onIdle)
      resolve()
    }

    map.on('idle', onIdle)
  })
}

async function waitForWeatherFrameVisible(token: number) {
  if (!map || weatherSyncToken !== token) {
    return false
  }

  map.triggerRepaint()
  await waitForMapIdle()
  if (!map || weatherSyncToken !== token) {
    return false
  }

  await waitForAnimationFrame()
  await waitForAnimationFrame()
  if (!map || weatherSyncToken !== token) {
    return false
  }

  await waitForTimeout(WEATHER_FRAME_VISIBLE_DELAY_MS)
  return weatherSyncToken === token
}

async function waitForMapStyleReady() {
  if (!map) {
    return false
  }

  if (map.isStyleLoaded()) {
    return true
  }

  await new Promise<void>((resolve, reject) => {
    if (!map) {
      resolve()
      return
    }

    const cleanup = () => {
      map?.off('styledata', onStyleData)
      map?.off('load', onReady)
      map?.off('error', onError)
    }

    const onReady = () => {
      cleanup()
      resolve()
    }

    const onStyleData = () => {
      if (map?.isStyleLoaded()) {
        onReady()
      }
    }

    const onError = () => {
      cleanup()
      reject(new Error('MapTiler 样式加载失败'))
    }

    map.on('styledata', onStyleData)
    map.on('load', onReady)
    map.on('error', onError)
  })

  return Boolean(map?.isStyleLoaded())
}

async function syncWeatherLayers() {
  if (!map) {
    return
  }

  const requestedHour = props.weatherForecastHour
  weatherSyncToken += 1
  const token = weatherSyncToken
  weatherLoading.value = true
  weatherError.value = ''
  weatherFrameText.value = '加载中...'

  emit('weather-frame-loading', { hour: requestedHour, loading: true })
  clearWeatherLayers()
  clearWeatherHoverInfo()

  if (!props.maptilerWeatherKey) {
    weatherLoading.value = false
    weatherError.value = '未配置 MapTiler Weather Key'
    weatherFrameText.value = '未加载'
    emit('weather-frame-loading', { hour: requestedHour, loading: false })
    emit('weather-frame-ready', { hour: requestedHour })
    return
  }

  if (props.weatherLayerIds.length === 0) {
    weatherLoading.value = false
    weatherFrameText.value = '未选择'
    emit('weather-frame-loading', { hour: requestedHour, loading: false })
    emit('weather-frame-ready', { hour: requestedHour })
    return
  }

  try {
    const ready = await waitForMapStyleReady()
    if (!ready || weatherSyncToken !== token || !map) {
      return
    }

    const beforeId = getWeatherInsertionLayerId()
    const layers = props.weatherLayerIds.map((layerId) => {
      const layer = createWeatherLayer(layerId)
      weatherLayers.set(layerId, layer)
      map?.addLayer(layer as unknown as maptilersdk.CustomLayerInterface, beforeId)
      return layer
    })

    await Promise.all(layers.map(async (layer) => {
      await layer.onSourceReadyAsync()
      if (weatherSyncToken !== token) {
        return
      }
      applyWeatherAnimationTime(layer)
    }))

    if (weatherSyncToken !== token) {
      return
    }

    const referenceTime = layers.map(getWeatherLayerTime).find(Boolean) ?? null
    weatherFrameText.value = referenceTime
      ? referenceTime.toLocaleString('zh-CN', { hour12: false })
      : '实时/最近时次'

    const visible = await waitForWeatherFrameVisible(token)
    if (visible) {
      emit('weather-frame-ready', { hour: requestedHour })
    }
  } catch (error) {
    weatherError.value = error instanceof Error ? error.message : String(error)
    weatherFrameText.value = '加载失败'
    emit('weather-frame-ready', { hour: requestedHour })
  } finally {
    if (weatherSyncToken === token) {
      weatherLoading.value = false
      emit('weather-frame-loading', { hour: requestedHour, loading: false })
    }
  }
}

async function buildMap() {
  if (!container.value) {
    return
  }

  beginSlowLoadingWatch()

  if (MAPTILER_PROXY_BASE) {
    installMapTilerFetchProxy(MAPTILER_PROXY_BASE)
  }

  maptilersdk.config.apiKey = props.maptilerWeatherKey
  maptilersdk.config.telemetry = false
  maptilersdk.config.session = false

  map = new maptilersdk.Map({
    container: container.value,
    apiKey: props.maptilerWeatherKey,
    style: getMapStyle(),
    center: CHINA_CENTER,
    zoom: 3.2,
    pitch: 0,
    projection: 'mercator',
  })

  map.addControl(new maptilersdk.NavigationControl(), 'top-right')
  map.on('click', onMapClick as never)

  await new Promise<void>((resolve, reject) => {
    if (!map) {
      resolve()
      return
    }

    const onLoad = async () => {
      try {
        await syncWeatherLayers()
        resolve()
      } catch (error) {
        reject(error)
      }
    }

    const onError = () => {
      reject(new Error('MapTiler 底图加载失败'))
    }

    map.once('load', onLoad)
    map.once('error', onError)
  }).finally(() => {
    endSlowLoadingWatch()
  })
}

async function rebuildMap() {
  clearWeatherHoverInfo()
  clearWeatherLayers()
  endSlowLoadingWatch()
  map?.remove()
  map = null
  await nextTick()
  await buildMap()
}

onMounted(async () => {
  try {
    await buildMap()
  } catch (error) {
    weatherError.value = error instanceof Error ? error.message : String(error)
    weatherLoading.value = false
    weatherFrameText.value = '加载失败'
    endSlowLoadingWatch()
  }
})

watch(
  () => props.baseMap,
  async () => {
    try {
      await rebuildMap()
    } catch (error) {
      weatherError.value = error instanceof Error ? error.message : String(error)
      weatherLoading.value = false
      weatherFrameText.value = '加载失败'
      endSlowLoadingWatch()
    }
  },
)

watch(
  () => [props.weatherLayerIds.join('|'), props.weatherForecastHour, props.maptilerWeatherKey] as const,
  async () => {
    await syncWeatherLayers()
  },
)

onUnmounted(() => {
  endSlowLoadingWatch()
  clearWeatherHoverInfo()
  clearWeatherLayers()
  map?.remove()
  map = null
})
</script>

<template>
  <div class="viewer-shell">
    <div ref="container" class="maptiler-map"></div>

    <div v-if="showSlowLoadingOverlay" class="slow-loading-overlay">
      <div class="slow-loading-card">
        <div class="slow-loading-spinner"></div>
        <div class="slow-loading-title">加载中</div>
        <div class="slow-loading-message">当前加载速度较慢，可通过 VPN 提高加载速度</div>
      </div>
    </div>

    <aside class="legend">
      <div class="weather-legend-title">MapTiler Weather SDK</div>
      <div class="weather-legend-row">图层：{{ selectedWeatherLabelText || '未选择' }}</div>
      <div class="weather-legend-row">时次：{{ weatherFrameText }}</div>
      <div v-if="weatherLoading" class="weather-legend-info loading">环境图层加载中...</div>
      <div v-else-if="weatherError" class="weather-legend-info error">{{ weatherError }}</div>
    </aside>

    <div
      v-if="weatherHoverInfo"
      class="query-tip"
      :style="{ left: `${weatherHoverInfo.x}px`, top: `${weatherHoverInfo.y}px` }"
    >
      <button type="button" class="query-tip-close" @click.stop="onCloseWeatherHover">×</button>
      <div class="query-tip-title">环境场查询</div>
      <div class="query-tip-row">
        <span class="query-tip-key">经度</span>
        <span class="query-tip-value">{{ formatCoordinate(weatherHoverInfo.lon) }}</span>
      </div>
      <div class="query-tip-row">
        <span class="query-tip-key">纬度</span>
        <span class="query-tip-value">{{ formatCoordinate(weatherHoverInfo.lat) }}</span>
      </div>
      <div v-for="row in weatherHoverInfo.rows" :key="`${row.label}:${row.value}`" class="query-tip-row">
        <span class="query-tip-key">{{ row.label }}</span>
        <span class="query-tip-value">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer-shell {
  position: relative;
  width: 100%;
  height: 100vh;
}

.maptiler-map {
  width: 100%;
  height: 100%;
}

:deep(.weather-query-marker) {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 112, 67, 0.95);
  border: 2px solid #ffffff;
  box-shadow: 0 0 0 6px rgba(255, 112, 67, 0.18);
}

.slow-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(7, 20, 31, 0.42);
  backdrop-filter: blur(8px);
  z-index: 970;
}

.slow-loading-card {
  width: min(360px, calc(100vw - 40px));
  padding: 22px 20px;
  border-radius: 18px;
  background: linear-gradient(140deg, rgba(12, 32, 48, 0.95), rgba(24, 72, 92, 0.92));
  border: 1px solid rgba(164, 206, 226, 0.28);
  box-shadow: 0 18px 40px rgba(5, 13, 19, 0.32);
  color: #eef7ff;
  text-align: center;
}

.slow-loading-spinner {
  width: 42px;
  height: 42px;
  margin: 0 auto 14px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.18);
  border-top-color: #ff9c56;
  animation: slow-loading-spin 0.85s linear infinite;
}

.slow-loading-title {
  font-size: 18px;
  font-weight: 800;
}

.slow-loading-message {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.55;
  color: rgba(238, 247, 255, 0.82);
}

.legend {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: min(340px, calc(100vw - 32px));
  padding: 12px;
  border-radius: 14px;
  background: rgba(246, 251, 255, 0.94);
  border: 1px solid rgba(169, 194, 216, 0.5);
  box-shadow: 0 16px 32px rgba(16, 32, 43, 0.2);
  z-index: 980;
}

.weather-legend-title {
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 800;
  color: #133247;
}

.weather-legend-row {
  font-size: 12px;
  color: #294b62;
  font-weight: 700;
}

.weather-legend-row + .weather-legend-row {
  margin-top: 4px;
}

.weather-legend-info {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
}

.weather-legend-info.loading {
  color: #2e88a9;
}

.weather-legend-info.error {
  color: #b7493a;
}

@keyframes slow-loading-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 960px) {
  .legend {
    width: auto;
    left: 16px;
  }

  .slow-loading-card {
    width: calc(100vw - 28px);
  }
}
</style>
