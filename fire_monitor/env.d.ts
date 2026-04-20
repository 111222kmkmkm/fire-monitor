/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_WINDY_MAP_FORECAST_KEY?: string
	readonly VITE_WINDY_API_KEY?: string
	readonly VITE_DEM_API_URL?: string
	readonly VITE_MAPTILER_KEY?: string
	readonly VITE_MAPTILER_WEATHER_KEY?: string
	readonly VITE_MAPTILER_PROXY_BASE?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

interface Window {
	windyInit?: (
		options: Record<string, unknown>,
		callback: (windyApi: { store?: { set: (key: string, value: unknown, opts?: unknown) => void } }) => void,
	) => void
}

declare module '*.vue' {
	import type { DefineComponent } from 'vue'
	const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
	export default component
}
