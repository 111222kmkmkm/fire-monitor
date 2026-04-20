<script setup lang="ts">
// @ts-nocheck
import '@geoscene/core/assets/geoscene/themes/light/main.css'
import './styles/query-tip.css'
import Basemap from '@geoscene/core/Basemap'
import GeoSceneMap from '@geoscene/core/Map'
import Graphic from '@geoscene/core/Graphic'
import Point from '@geoscene/core/geometry/Point'
import Polygon from '@geoscene/core/geometry/Polygon'
import GeoJSONLayer from '@geoscene/core/layers/GeoJSONLayer'
import GraphicsLayer from '@geoscene/core/layers/GraphicsLayer'
import WebTileLayer from '@geoscene/core/layers/WebTileLayer'
import SimpleFillSymbol from '@geoscene/core/symbols/SimpleFillSymbol'
import SimpleMarkerSymbol from '@geoscene/core/symbols/SimpleMarkerSymbol'
import MapView from '@geoscene/core/views/MapView'
import { nextTick, onMounted, onUnmounted, ref, watch, withDefaults } from 'vue'
import MaptilerWeatherMap from './MaptilerWeatherMap.vue'

type BaseMapType = 'img' | 'vec' | 'dem'
type MapMode = 'ol' | 'maptiler'

const props = withDefaults(defineProps<{
  mapMode: MapMode
  baseMap: BaseMapType
  maptilerWeatherKey?: string
  weatherLayerIds?: string[]
  weatherForecastHour?: number
  candidateFireRefreshNonce?: number
}>(), {
  maptilerWeatherKey: '',
  weatherLayerIds: () => [],
  weatherForecastHour: 0,
  candidateFireRefreshNonce: 0,
})

const emit = defineEmits<{
  (event: 'weather-frame-loading', payload: { hour: number; loading: boolean }): void
  (event: 'weather-frame-ready', payload: { hour: number }): void
}>()

const CHINA_EXTENT_4326 = {
  xmin: 73,
  ymin: 18,
  xmax: 135.5,
  ymax: 54,
}
const CHINA_CENTER = [104.5, 35.2]
const RELATED_CITY_BOUNDARY_URL = '/data/related/city.geojson'
const RELATED_FIRE_STATION_URL = '/data/related/fire_station.geojson'
const CANDIDATE_FIRE_URL = '/data/algorithm/latest/candidate_fire.geojson'
const CANDIDATE_FIRE_SUMMARY_URL = '/data/algorithm/latest/candidate_fire_summary.json'
const FIRE_LAYER_REFRESH_MS = 15_000
const DEFAULT_DEM_API_URL = import.meta.env.DEV
  ? '/api/dem/v1/aster30m'
  : 'https://api.opentopodata.org/v1/aster30m'
const DEM_API_URL = (import.meta.env.VITE_DEM_API_URL ?? DEFAULT_DEM_API_URL).trim()
const DEM_REQUEST_TIMEOUT_MS = 12000

const mapContainer = ref<HTMLDivElement | null>(null)
const showCityBoundary = ref(true)
const showFireStations = ref(false)
const showCandidateFires = ref(true)
const cityHoverInfo = ref<{ x: number; y: number; name: string } | null>(null)
const demHoverInfo = ref<{
  x: number
  y: number
  lon: number
  lat: number
  elevationText: string
} | null>(null)
const candidateFireSummary = ref<{
  acquisitionTime?: string | null
  fireCount?: number | null
  generatedAt?: string | null
} | null>(null)

let map: any = null
let view: any = null
let cityBoundaryLayer: any = null
let fireStationLayer: any = null
let candidateFireLayer: any = null
let cityBoundaryHoverLayer: any = null
let demMarkerLayer: any = null
let demRequestController: AbortController | null = null
let fireRefreshTimer: number | null = null

function toFiniteNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatElevation(value: number | null) {
  return value === null ? '--' : `${value.toFixed(1)} m`
}

function formatTimestamp(value?: string | null) {
  if (!value) {
    return '暂无'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function buildDemUrl(lon: number, lat: number) {
  const separator = DEM_API_URL.includes('?') ? '&' : '?'
  return `${DEM_API_URL}${separator}locations=${encodeURIComponent(`${lat.toFixed(6)},${lon.toFixed(6)}`)}`
}

async function queryDemAtPoint(lon: number, lat: number) {
  if (!DEM_API_URL || !isInsideChina(lon, lat)) {
    return null
  }
  demRequestController?.abort()
  const controller = new AbortController()
  demRequestController = controller
  const timeout = window.setTimeout(() => controller.abort(), DEM_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(buildDemUrl(lon, lat), {
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }
    const data = await response.json() as { results?: Array<{ elevation?: number | null }> }
    return toFiniteNumber(data.results?.[0]?.elevation)
  } catch {
    return null
  } finally {
    window.clearTimeout(timeout)
    if (demRequestController === controller) {
      demRequestController = null
    }
  }
}

function isInsideChina(lon: number, lat: number) {
  return lon >= CHINA_EXTENT_4326.xmin &&
    lon <= CHINA_EXTENT_4326.xmax &&
    lat >= CHINA_EXTENT_4326.ymin &&
    lat <= CHINA_EXTENT_4326.ymax
}

function createTiandituLayer(layerId: string) {
  return new WebTileLayer({
    urlTemplate: `https://t{subDomain}.tianditu.gov.cn/${layerId}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layerId}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={level}&TILEROW={row}&TILECOL={col}&tk=b388b3e6dbb840eaa78326d84bf63b4c`,
    subDomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
  } as any)
}

function buildBasemap(baseMap: BaseMapType) {
  const layerSets: Record<BaseMapType, [string, string]> = {
    img: ['img', 'cia'],
    vec: ['vec', 'cva'],
    dem: ['ter', 'cta'],
  }
  const [baseLayerId, annotationLayerId] = layerSets[baseMap]
  return new Basemap({
    baseLayers: [
      createTiandituLayer(baseLayerId),
      createTiandituLayer(annotationLayerId),
    ],
    title: `tianditu-${baseMap}`,
    id: `tianditu-${baseMap}`,
  } as any)
}

async function ensureCityBoundaryLayerLoaded() {
  if (cityBoundaryLayer) {
    return
  }
  cityBoundaryLayer = new GeoJSONLayer({
    url: RELATED_CITY_BOUNDARY_URL,
    popupEnabled: false,
    renderer: {
      type: 'simple',
      symbol: new SimpleFillSymbol({
        color: [109, 194, 255, 0.04],
        outline: {
          color: [109, 194, 255, 0.85],
          width: 1.1,
        },
      } as any),
    },
  } as any)
  map.add(cityBoundaryLayer)
}

async function ensureFireStationLayerLoaded() {
  if (fireStationLayer) {
    return
  }
  fireStationLayer = new GeoJSONLayer({
    url: RELATED_FIRE_STATION_URL,
    popupEnabled: true,
    renderer: {
      type: 'simple',
      symbol: new SimpleMarkerSymbol({
        style: 'triangle',
        color: [255, 96, 88, 0.95],
        size: 10,
        outline: {
          color: [255, 255, 255, 1],
          width: 1.2,
        },
      } as any),
    },
  } as any)
  map.add(fireStationLayer)
}

function createCandidateFireLayer() {
  return new GeoJSONLayer({
    url: `${CANDIDATE_FIRE_URL}?t=${Date.now()}`,
    popupEnabled: true,
    refreshInterval: 1,
    renderer: {
      type: 'simple',
      symbol: new SimpleMarkerSymbol({
        style: 'circle',
        color: [255, 87, 34, 0.92],
        size: 8,
        outline: {
          color: [255, 244, 235, 1],
          width: 1.3,
        },
      } as any),
      visualVariables: [
        {
          type: 'size',
          field: 'score',
          stops: [
            { value: 0.5, size: 7 },
            { value: 2, size: 10 },
            { value: 4, size: 14 },
          ],
        },
      ],
    },
    popupTemplate: {
      title: '候选火点',
      content: `
        <div style="min-width:220px">
          <div><strong>时次：</strong>{acqTimeUtc}</div>
          <div><strong>评分：</strong>{score}</div>
          <div><strong>B07亮温：</strong>{btTir} K</div>
          <div><strong>B07-B13：</strong>{btDif} K</div>
          <div><strong>昼夜：</strong>{daynight}</div>
          <div><strong>状态：</strong>{fireStatus}</div>
        </div>
      `,
    },
  } as any)
}

async function ensureCandidateFireLayerLoaded() {
  if (candidateFireLayer) {
    return
  }
  candidateFireLayer = createCandidateFireLayer()
  map.add(candidateFireLayer)
}

async function loadCandidateFireSummary() {
  try {
    const response = await fetch(`${CANDIDATE_FIRE_SUMMARY_URL}?t=${Date.now()}`, {
      cache: 'no-store',
    })
    if (!response.ok) {
      candidateFireSummary.value = null
      return
    }
    candidateFireSummary.value = await response.json()
  } catch {
    candidateFireSummary.value = null
  }
}

async function refreshCandidateFireLayer() {
  await loadCandidateFireSummary()
  if (!map || !candidateFireLayer) {
    return
  }
  candidateFireLayer.url = `${CANDIDATE_FIRE_URL}?t=${Date.now()}`
  candidateFireLayer.refresh?.()
}

function startCandidateFireRefreshTimer() {
  stopCandidateFireRefreshTimer()
  fireRefreshTimer = window.setInterval(() => {
    void refreshCandidateFireLayer()
  }, FIRE_LAYER_REFRESH_MS)
}

function onWindowVisibilityRefresh() {
  if (document.visibilityState === 'visible') {
    void refreshCandidateFireLayer()
  }
}

function stopCandidateFireRefreshTimer() {
  if (fireRefreshTimer !== null) {
    window.clearInterval(fireRefreshTimer)
    fireRefreshTimer = null
  }
}

async function syncRelatedLayerVisibility() {
  if (!map) {
    return
  }
  if (showCityBoundary.value) {
    await ensureCityBoundaryLayerLoaded()
    cityBoundaryLayer.visible = props.mapMode === 'ol'
  } else if (cityBoundaryLayer) {
    cityBoundaryLayer.visible = false
  }

  if (showFireStations.value) {
    await ensureFireStationLayerLoaded()
    fireStationLayer.visible = props.mapMode === 'ol'
  } else if (fireStationLayer) {
    fireStationLayer.visible = false
  }

  if (showCandidateFires.value) {
    await ensureCandidateFireLayerLoaded()
    candidateFireLayer.visible = props.mapMode === 'ol'
    void refreshCandidateFireLayer()
  } else if (candidateFireLayer) {
    candidateFireLayer.visible = false
  }
}

function createScaledHoverGraphic(geometry: any) {
  if (!geometry || geometry.type !== 'polygon') {
    return null
  }
  const extent = geometry.extent
  const centerX = ((extent?.xmin ?? 0) + (extent?.xmax ?? 0)) / 2
  const centerY = ((extent?.ymin ?? 0) + (extent?.ymax ?? 0)) / 2
  const factor = 1.015
  const rings = (geometry.rings ?? []).map((ring: number[][]) =>
    ring.map((vertex: number[]) => {
      const x = vertex[0] ?? centerX
      const y = vertex[1] ?? centerY
      return [centerX + (x - centerX) * factor, centerY + (y - centerY) * factor]
    }),
  )

  return new Graphic({
    geometry: new Polygon({
      rings,
      spatialReference: geometry.spatialReference,
    } as any),
    symbol: new SimpleFillSymbol({
      color: [255, 214, 72, 0.16],
      outline: {
        color: [255, 214, 72, 0.95],
        width: 2.2,
      },
    } as any),
  } as any)
}

function clearCityHoverInfo() {
  cityHoverInfo.value = null
  cityBoundaryHoverLayer?.removeAll()
  if (view?.container) {
    view.container.style.cursor = ''
  }
}

function clearDemHoverInfo() {
  demHoverInfo.value = null
  demMarkerLayer?.removeAll?.()
}

function onCloseDemHover() {
  clearDemHoverInfo()
}

async function onGeoSceneMapClick(event: any) {
  if (props.mapMode !== 'ol' || props.baseMap !== 'dem') {
    clearDemHoverInfo()
    return
  }
  const lon = toFiniteNumber(event?.mapPoint?.longitude)
  const lat = toFiniteNumber(event?.mapPoint?.latitude)
  if (lon === null || lat === null) {
    clearDemHoverInfo()
    return
  }

  demMarkerLayer?.removeAll?.()
  demMarkerLayer?.add?.(new Graphic({
    geometry: new Point({
      longitude: lon,
      latitude: lat,
    } as any),
    symbol: new SimpleMarkerSymbol({
      style: 'circle',
      color: [255, 112, 67, 0.95],
      size: 10,
      outline: {
        color: [255, 255, 255, 1],
        width: 2,
      },
    } as any),
  } as any))

  demHoverInfo.value = {
    x: Math.min((event?.x ?? 0) + 16, window.innerWidth - 180),
    y: Math.min((event?.y ?? 0) + 16, window.innerHeight - 120),
    lon,
    lat,
    elevationText: '查询中...',
  }

  const elevation = await queryDemAtPoint(lon, lat)
  if (!demHoverInfo.value) {
    return
  }
  demHoverInfo.value = {
    ...demHoverInfo.value,
    elevationText: formatElevation(elevation),
  }
}

async function onMapPointerMove(event: any) {
  if (!view || props.mapMode !== 'ol' || !showCityBoundary.value || !cityBoundaryLayer?.visible) {
    clearCityHoverInfo()
    return
  }

  const hit = await view.hitTest(event, {
    include: [cityBoundaryLayer],
  } as any)
  const result = hit?.results?.find((item: any) => item.graphic?.layer === cityBoundaryLayer)
  const graphic = result?.graphic
  if (!graphic) {
    clearCityHoverInfo()
    return
  }

  const displayName = String(graphic.attributes?.name ?? '')
  if (!displayName) {
    clearCityHoverInfo()
    return
  }

  cityBoundaryHoverLayer?.removeAll()
  const hoverGraphic = createScaledHoverGraphic(graphic.geometry)
  if (hoverGraphic) {
    cityBoundaryHoverLayer?.add(hoverGraphic)
  }

  cityHoverInfo.value = {
    x: Math.min((event?.x ?? 0) + 18, window.innerWidth - 180),
    y: Math.max((event?.y ?? 0) - 16, 18),
    name: displayName,
  }
  if (view?.container) {
    view.container.style.cursor = 'pointer'
  }
}

onMounted(async () => {
  cityBoundaryHoverLayer = new GraphicsLayer()
  demMarkerLayer = new GraphicsLayer()

  map = new GeoSceneMap({
    basemap: buildBasemap(props.baseMap),
    layers: [cityBoundaryHoverLayer, demMarkerLayer],
  } as any)

  view = new MapView({
    container: mapContainer.value as HTMLDivElement,
    map,
    center: CHINA_CENTER,
    zoom: 4,
    constraints: {
      rotationEnabled: false,
      minZoom: 3,
    },
  } as any)

  view.on('pointer-move', onMapPointerMove)
  view.on('click', onGeoSceneMapClick)
  view.on('immediate-click', () => {
    clearCityHoverInfo()
  })

  await syncRelatedLayerVisibility()
  await loadCandidateFireSummary()
  startCandidateFireRefreshTimer()
  window.addEventListener('focus', onWindowVisibilityRefresh)
  document.addEventListener('visibilitychange', onWindowVisibilityRefresh)
})

watch(
  () => props.baseMap,
  (baseMap) => {
    if (!map) {
      return
    }
    map.basemap = buildBasemap(baseMap)
    if (baseMap !== 'dem') {
      clearDemHoverInfo()
    }
  },
)

watch(
  () => props.mapMode,
  async (mode) => {
    clearCityHoverInfo()
    clearDemHoverInfo()
    if (cityBoundaryLayer) {
      cityBoundaryLayer.visible = mode === 'ol' && showCityBoundary.value
    }
    if (fireStationLayer) {
      fireStationLayer.visible = mode === 'ol' && showFireStations.value
    }
    if (candidateFireLayer) {
      candidateFireLayer.visible = mode === 'ol' && showCandidateFires.value
    }
    await nextTick()
    if (mode === 'ol') {
      view?.container && (view.container.style.display = '')
      view?.resize?.()
      return
    }
    if (view?.container) {
      view.container.style.display = 'none'
    }
  },
)

watch([showCityBoundary, showFireStations, showCandidateFires], async () => {
  if (!showCityBoundary.value) {
    clearCityHoverInfo()
  }
  await syncRelatedLayerVisibility()
})

watch(
  () => props.candidateFireRefreshNonce,
  () => {
    void refreshCandidateFireLayer()
  },
)

onUnmounted(() => {
  stopCandidateFireRefreshTimer()
  window.removeEventListener('focus', onWindowVisibilityRefresh)
  document.removeEventListener('visibilitychange', onWindowVisibilityRefresh)
  clearCityHoverInfo()
  view?.destroy?.()
  map = null
  view = null
  cityBoundaryLayer = null
  fireStationLayer = null
  candidateFireLayer = null
  cityBoundaryHoverLayer = null
  demMarkerLayer = null
})
</script>

<script lang="ts">
export default {
  name: 'MapView',
}
</script>

<template>
  <div class="viewer-shell">
    <div v-show="mapMode === 'ol'" ref="mapContainer" class="map"></div>
    <MaptilerWeatherMap
      v-if="mapMode === 'maptiler'"
      :base-map="baseMap === 'dem' ? 'img' : baseMap"
      :maptiler-weather-key="maptilerWeatherKey"
      :weather-layer-ids="weatherLayerIds ?? []"
      :weather-forecast-hour="weatherForecastHour ?? 0"
      @weather-frame-loading="emit('weather-frame-loading', $event)"
      @weather-frame-ready="emit('weather-frame-ready', $event)"
    />

    <div v-if="mapMode === 'ol'" class="related-layer-panel">
      <div class="related-layer-title">辅助图层</div>
      <label class="related-layer-item">
        <input v-model="showCandidateFires" type="checkbox">
        <span>候选火点</span>
      </label>
      <label class="related-layer-item">
        <input v-model="showCityBoundary" type="checkbox">
        <span>城市边界</span>
      </label>
      <label class="related-layer-item">
        <input v-model="showFireStations" type="checkbox">
        <span>消防站点</span>
      </label>
      <div class="fire-summary-card">
        <div class="fire-summary-title">最新识别</div>
        <div class="fire-summary-row">
          <span>时次</span>
          <span>{{ formatTimestamp(candidateFireSummary?.acquisitionTime) }}</span>
        </div>
        <div class="fire-summary-row">
          <span>数量</span>
          <span>{{ candidateFireSummary?.fireCount ?? 0 }}</span>
        </div>
        <div class="fire-summary-row">
          <span>生成</span>
          <span>{{ formatTimestamp(candidateFireSummary?.generatedAt) }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="mapMode === 'ol' && cityHoverInfo"
      class="city-hover-tip"
      :style="{ left: `${cityHoverInfo.x}px`, top: `${cityHoverInfo.y}px` }"
    >
      {{ cityHoverInfo.name }}
    </div>

    <div
      v-if="mapMode === 'ol' && baseMap === 'dem' && demHoverInfo"
      class="query-tip"
      :style="{ left: `${demHoverInfo.x}px`, top: `${demHoverInfo.y}px` }"
    >
      <button type="button" class="query-tip-close" @click.stop="onCloseDemHover">×</button>
      <div class="query-tip-title">地形查询</div>
      <div class="query-tip-row">
        <span class="query-tip-key">经度</span>
        <span class="query-tip-value">{{ demHoverInfo.lon.toFixed(3) }}</span>
      </div>
      <div class="query-tip-row">
        <span class="query-tip-key">纬度</span>
        <span class="query-tip-value">{{ demHoverInfo.lat.toFixed(3) }}</span>
      </div>
      <div class="query-tip-row">
        <span class="query-tip-key">高程</span>
        <span class="query-tip-value">{{ demHoverInfo.elevationText }}</span>
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

.map {
  width: 100%;
  height: 100vh;
}

.related-layer-panel {
  position: fixed;
  top: 96px;
  right: 16px;
  width: 204px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(8, 27, 48, 0.88);
  border: 1px solid rgba(72, 134, 180, 0.42);
  box-shadow: 0 12px 32px rgba(6, 14, 22, 0.28);
  color: #eaf6ff;
  z-index: 980;
}

.related-layer-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 800;
}

.related-layer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.related-layer-item input {
  width: 14px;
  height: 14px;
}

.fire-summary-card {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(109, 194, 255, 0.18);
}

.fire-summary-title {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #ffd0a6;
}

.fire-summary-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
  font-size: 11px;
}

.fire-summary-row span:last-child {
  text-align: right;
}

.city-hover-tip {
  position: fixed;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(8, 27, 48, 0.92);
  border: 1px solid rgba(109, 194, 255, 0.4);
  color: #eef8ff;
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
  z-index: 1240;
  transform: translateY(-100%);
  box-shadow: 0 8px 20px rgba(6, 14, 22, 0.28);
}
</style>
