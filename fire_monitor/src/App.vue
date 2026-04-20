<script setup lang="ts">
// @ts-nocheck
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MapView from './Map.vue'

type CatalogSource = {
  id: string
  name: string
  provider: string
  kind: string
  enabled: boolean
  status: string
  message: string
  latestSnapshot: string | null
  acquisitionTime?: string | null
  downloadedAt?: string | null
  latestFiles: Array<{
    fileName: string
    localPath: string
    size: number
    webPath: string | null
  }>
}

type CatalogResponse = {
  generatedAt: string | null
  sources: CatalogSource[]
}

type BaseMapType = 'img' | 'vec' | 'dem'
type MapMode = 'ol' | 'maptiler'
type WeatherLayerId = 'radar' | 'precipitation' | 'wind-speed' | 'air-temperature' | 'pressure'

const WEATHER_LAYER_OPTIONS: Array<{ id: WeatherLayerId; label: string }> = [
  { id: 'radar', label: '天气雷达' },
  { id: 'precipitation', label: '降水' },
  { id: 'wind-speed', label: '风场' },
  { id: 'air-temperature', label: '气温' },
  { id: 'pressure', label: '气压' },
]

const WEATHER_AUTOPLAY_STEP_HOURS = 3
const CLOUD_PULL_INTERVAL_MS = 30_000

const catalog = ref<CatalogResponse>({ generatedAt: null, sources: [] })
const loading = ref(false)
const loadError = ref('')
const syncInProgress = ref(false)
const syncMessage = ref('')
const candidateFireRefreshNonce = ref(0)

const mapMode = ref<MapMode>('ol')
const baseMap = ref<BaseMapType>('img')
const maptilerWeatherKey = import.meta.env.VITE_MAPTILER_WEATHER_KEY ?? import.meta.env.VITE_MAPTILER_KEY ?? ''
const weatherLayerIds = ref<WeatherLayerId[]>([])
const weatherForecastHour = ref(0)
const weatherAutoplay = ref(false)
const weatherFrameLoading = ref(false)
const weatherAutoplayAwaitingHour = ref<number | null>(null)

let refreshTimer: number | null = null
let cloudPullTimer: number | null = null
let weatherAutoplayTimer: number | null = null

const staleMinutes = computed(() => {
  if (!catalog.value.generatedAt) {
    return null
  }
  const parsed = new Date(catalog.value.generatedAt).getTime()
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.floor((Date.now() - parsed) / 60_000)
})

const isCatalogStale = computed(() => staleMinutes.value !== null && staleMinutes.value > 12)
const weatherForecastLabel = computed(() =>
  weatherForecastHour.value === 0 ? '实时/最近时次' : `未来 ${weatherForecastHour.value} 小时`,
)

async function loadCatalog() {
  loading.value = true
  loadError.value = ''

  try {
    const response = await fetch(`/data/catalog.json?t=${Date.now()}`)
    if (!response.ok) {
      throw new Error(`catalog request failed: ${response.status}`)
    }
    catalog.value = await response.json() as CatalogResponse
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function triggerRealtimeSync() {
  if (syncInProgress.value) {
    return
  }

  syncInProgress.value = true
  syncMessage.value = '正在拉取云端最新结果...'

  try {
    const response = await fetch('/api/local/sync-now', {
      method: 'POST',
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => null)

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message ?? `sync request failed: ${response.status}`)
    }

    syncMessage.value = '云端结果已更新到本地'
    await loadCatalog()
    candidateFireRefreshNonce.value += 1
  } catch (error) {
    syncMessage.value = `同步失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    syncInProgress.value = false
    window.setTimeout(() => {
      if (!syncInProgress.value) {
        syncMessage.value = ''
      }
    }, 4000)
  }
}

function toggleWeatherLayer(layerId: WeatherLayerId) {
  const next = new Set(weatherLayerIds.value)
  if (next.has(layerId)) {
    next.delete(layerId)
  } else {
    next.add(layerId)
  }
  weatherLayerIds.value = WEATHER_LAYER_OPTIONS.map((item) => item.id).filter((item) => next.has(item))
}

function formatTime(value?: string | null) {
  if (!value) {
    return '暂无'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function clearWeatherAutoplayTimer() {
  if (weatherAutoplayTimer !== null) {
    window.clearTimeout(weatherAutoplayTimer)
    weatherAutoplayTimer = null
  }
}

function getNextWeatherForecastHour() {
  const currentHour = Number(weatherForecastHour.value) || 0
  return currentHour >= 72 ? 0 : currentHour + WEATHER_AUTOPLAY_STEP_HOURS
}

function scheduleNextWeatherAutoplayTick() {
  clearWeatherAutoplayTimer()

  if (!weatherAutoplay.value || mapMode.value !== 'maptiler' || weatherFrameLoading.value || weatherAutoplayAwaitingHour.value !== null) {
    return
  }

  weatherAutoplayTimer = window.setTimeout(() => {
    weatherAutoplayTimer = null
    if (!weatherAutoplay.value || mapMode.value !== 'maptiler' || weatherFrameLoading.value || weatherAutoplayAwaitingHour.value !== null) {
      return
    }
    const nextHour = getNextWeatherForecastHour()
    weatherAutoplayAwaitingHour.value = nextHour
    weatherForecastHour.value = nextHour
  }, 1200)
}

function stopWeatherAutoplay() {
  weatherAutoplay.value = false
  weatherAutoplayAwaitingHour.value = null
  clearWeatherAutoplayTimer()
}

function startWeatherAutoplay() {
  weatherAutoplay.value = true
  weatherAutoplayAwaitingHour.value = null
  scheduleNextWeatherAutoplayTick()
}

function toggleWeatherAutoplay() {
  if (weatherAutoplay.value) {
    stopWeatherAutoplay()
    return
  }
  startWeatherAutoplay()
}

function onWeatherFrameLoading(payload: { hour: number; loading: boolean }) {
  if (payload.hour !== weatherForecastHour.value) {
    return
  }

  weatherFrameLoading.value = payload.loading
  if (!payload.loading && weatherAutoplay.value && weatherAutoplayAwaitingHour.value === null) {
    scheduleNextWeatherAutoplayTick()
  }
}

function onWeatherFrameReady(payload: { hour: number }) {
  if (payload.hour !== weatherForecastHour.value) {
    return
  }

  weatherAutoplayAwaitingHour.value = null
  if (weatherAutoplay.value && !weatherFrameLoading.value) {
    scheduleNextWeatherAutoplayTick()
  }
}

onMounted(() => {
  void loadCatalog()
  void triggerRealtimeSync()
  refreshTimer = window.setInterval(loadCatalog, 60_000)
  cloudPullTimer = window.setInterval(() => {
    void triggerRealtimeSync()
  }, CLOUD_PULL_INTERVAL_MS)
})

watch(
  () => mapMode.value,
  (mode) => {
    if (mode !== 'maptiler') {
      stopWeatherAutoplay()
    }
  },
)

onUnmounted(() => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer)
  }
  if (cloudPullTimer !== null) {
    window.clearInterval(cloudPullTimer)
  }
  stopWeatherAutoplay()
})
</script>

<template>
  <div class="app-shell">
    <header class="top-nav">
      <div class="nav-brand">
        <div class="title">火情动态监测与决策系统</div>
        <div class="meta">
          <span>目录时间：{{ formatTime(catalog.generatedAt) }}</span>
          <span v-if="loading">正在刷新...</span>
          <span v-if="syncInProgress">{{ syncMessage }}</span>
          <span v-else-if="syncMessage">{{ syncMessage }}</span>
          <span v-else-if="loadError" class="error">{{ loadError }}</span>
          <span v-else-if="isCatalogStale" class="warn">同步可能已停止（{{ staleMinutes }} 分钟未更新）</span>
          <span v-if="mapMode === 'maptiler'">MapTiler：{{ weatherForecastLabel }}</span>
        </div>
      </div>

      <div class="nav-actions">
        <div class="chip-group">
          <button type="button" class="chip" :class="{ active: mapMode === 'ol' }" @click="mapMode = 'ol'">
            GeoScene
          </button>
          <button
            type="button"
            class="chip"
            :class="{ active: mapMode === 'maptiler' }"
            @click="mapMode = 'maptiler'"
          >
            MapTiler
          </button>
        </div>

        <div v-if="mapMode === 'ol'" class="chip-group">
          <button type="button" class="chip" :class="{ active: baseMap === 'img' }" @click="baseMap = 'img'">
            影像
          </button>
          <button type="button" class="chip" :class="{ active: baseMap === 'vec' }" @click="baseMap = 'vec'">
            矢量
          </button>
          <button type="button" class="chip" :class="{ active: baseMap === 'dem' }" @click="baseMap = 'dem'">
            DEM
          </button>
        </div>

        <div v-if="mapMode === 'maptiler'" class="chip-group weather-chip-group">
          <button
            v-for="layer in WEATHER_LAYER_OPTIONS"
            :key="layer.id"
            type="button"
            class="chip secondary-chip"
            :class="{ active: weatherLayerIds.includes(layer.id) }"
            @click="toggleWeatherLayer(layer.id)"
          >
            {{ layer.label }}
          </button>
        </div>

        <button type="button" class="refresh" @click="loadCatalog">刷新</button>
      </div>
    </header>

    <MapView
      :map-mode="mapMode"
      :base-map="baseMap"
      :maptiler-weather-key="maptilerWeatherKey"
      :weather-layer-ids="weatherLayerIds"
      :weather-forecast-hour="weatherForecastHour"
      :candidate-fire-refresh-nonce="candidateFireRefreshNonce"
      @weather-frame-loading="onWeatherFrameLoading"
      @weather-frame-ready="onWeatherFrameReady"
    />

    <div v-if="mapMode === 'maptiler'" class="timeline-bar">
      <div class="timeline-head">
        <div class="timeline-title">
          <span>预报时次</span>
          <strong>{{ weatherForecastLabel }}</strong>
        </div>
        <button type="button" class="timeline-play" :class="{ active: weatherAutoplay }" @click="toggleWeatherAutoplay">
          {{ weatherAutoplay ? '暂停' : '播放' }}
        </button>
      </div>
      <input v-model.number="weatherForecastHour" class="timeline-slider" type="range" min="0" max="72" step="3">
      <div class="timeline-scale">
        <span>0h</span>
        <span>24h</span>
        <span>48h</span>
        <span>72h</span>
      </div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

body {
  position: relative;
}
</style>

<style scoped>
.app-shell {
  width: 100%;
  height: 100vh;
  overflow: hidden;
  background:
    radial-gradient(circle at 18% 14%, rgba(255, 210, 136, 0.15), transparent 34%),
    radial-gradient(circle at 86% 18%, rgba(76, 150, 197, 0.16), transparent 30%),
    #0f1f2c;
}

.top-nav {
  position: fixed;
  top: 4px;
  left: 8px;
  right: 8px;
  min-height: 68px;
  padding: 10px 14px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  background: linear-gradient(135deg, rgba(10, 31, 48, 0.95), rgba(20, 64, 78, 0.9));
  box-shadow: 0 16px 36px rgba(6, 16, 24, 0.35);
  border: 1px solid rgba(164, 206, 226, 0.28);
  color: #eaf6ff;
  z-index: 1200;
  backdrop-filter: blur(10px);
}

.nav-brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.05em;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: rgba(232, 246, 255, 0.82);
}

.error {
  color: #ffb9a6;
}

.warn {
  color: #ffd17b;
}

.nav-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.chip-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.weather-chip-group {
  max-width: min(48vw, 560px);
}

.chip,
.refresh {
  height: 34px;
  border: 0;
  border-radius: 999px;
  padding: 0 14px;
  cursor: pointer;
  font-weight: 700;
  font-size: 13px;
}

.chip {
  background: rgba(255, 255, 255, 0.14);
  color: #eaf6ff;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.secondary-chip {
  background: rgba(255, 255, 255, 0.08);
}

.chip.active {
  background: #ff9c56;
  color: #10202c;
}

.refresh {
  background: #2dc5bd;
  color: #0d2d3a;
}

.timeline-bar {
  position: fixed;
  z-index: 1150;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  width: min(560px, calc(100vw - 32px));
  padding: 12px 14px 10px;
  border-radius: 16px;
  background: rgba(8, 27, 48, 0.92);
  border: 1px solid rgba(90, 150, 197, 0.42);
  box-shadow: 0 16px 38px rgba(6, 14, 22, 0.34);
  backdrop-filter: blur(10px);
  color: #eaf6ff;
}

.timeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
}

.timeline-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.timeline-play {
  min-width: 72px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: #eaf6ff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease, transform 0.12s ease;
}

.timeline-play.active {
  background: #ff9c56;
  color: #10202c;
}

.timeline-play:active {
  transform: scale(0.97);
}

.timeline-slider {
  width: 100%;
}

.timeline-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: rgba(230, 243, 255, 0.66);
}

@media (max-width: 1200px) {
  .top-nav {
    align-items: flex-start;
  }

  .nav-actions {
    width: 100%;
  }
}

@media (max-width: 960px) {
  .top-nav {
    flex-direction: column;
  }

  .weather-chip-group {
    max-width: none;
  }

  .timeline-bar {
    width: calc(100vw - 24px);
    bottom: 12px;
  }
}
</style>
