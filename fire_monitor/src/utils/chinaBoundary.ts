type Position = [number, number]

export type ChinaBoundaryPolygon = {
  outer: Position[]
  holes: Position[][]
}

type GeoJsonFeature = {
  geometry?: {
    type?: string
    coordinates?: unknown
  } | null
}

type GeoJsonFeatureCollection = {
  features?: GeoJsonFeature[]
}

const CHINA_BOUNDARY_GEOJSON_URL = '/data/china-boundary.geojson'
const EPSILON = 1e-9

let chinaBoundaryPolygonsPromise: Promise<ChinaBoundaryPolygon[]> | null = null

function toPosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null
  }
  const lon = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null
  }
  return [lon, lat]
}

function toRing(value: unknown): Position[] {
  if (!Array.isArray(value)) {
    return []
  }
  const ring: Position[] = []
  for (const item of value) {
    const position = toPosition(item)
    if (position) {
      ring.push(position)
    }
  }
  return ring.length >= 3 ? ring : []
}

function parsePolygonCoordinates(coordinates: unknown): ChinaBoundaryPolygon[] {
  if (!Array.isArray(coordinates)) {
    return []
  }
  const rings = coordinates
    .map((item) => toRing(item))
    .filter((ring) => ring.length >= 3)

  if (rings.length === 0) {
    return []
  }

  return [{
    outer: rings[0]!,
    holes: rings.slice(1),
  }]
}

function parseMultiPolygonCoordinates(coordinates: unknown): ChinaBoundaryPolygon[] {
  if (!Array.isArray(coordinates)) {
    return []
  }
  const polygons: ChinaBoundaryPolygon[] = []
  for (const polygonCoordinates of coordinates) {
    polygons.push(...parsePolygonCoordinates(polygonCoordinates))
  }
  return polygons
}

function polygonsFromGeoJsonFeature(feature: GeoJsonFeature): ChinaBoundaryPolygon[] {
  const type = feature.geometry?.type
  const coordinates = feature.geometry?.coordinates
  if (type === 'Polygon') {
    return parsePolygonCoordinates(coordinates)
  }
  if (type === 'MultiPolygon') {
    return parseMultiPolygonCoordinates(coordinates)
  }
  return []
}

export async function loadChinaBoundaryPolygons() {
  if (chinaBoundaryPolygonsPromise) {
    return chinaBoundaryPolygonsPromise
  }

  chinaBoundaryPolygonsPromise = (async () => {
    const response = await fetch(CHINA_BOUNDARY_GEOJSON_URL)
    if (!response.ok) {
      throw new Error(`Failed to load china boundary: ${response.status}`)
    }

    const collection = await response.json() as GeoJsonFeatureCollection
    const features = Array.isArray(collection.features) ? collection.features : []
    const polygons = features.flatMap((feature) => polygonsFromGeoJsonFeature(feature))

    return polygons
  })().catch((error) => {
    chinaBoundaryPolygonsPromise = null
    throw error
  })

  return chinaBoundaryPolygonsPromise
}

function isPointOnSegment(lon: number, lat: number, start: Position, end: Position) {
  const [x1, y1] = start
  const [x2, y2] = end
  const cross = (lon - x1) * (y2 - y1) - (lat - y1) * (x2 - x1)
  if (Math.abs(cross) > EPSILON) {
    return false
  }

  const dot = (lon - x1) * (lon - x2) + (lat - y1) * (lat - y2)
  return dot <= EPSILON
}

function isPointInRingInclusive(lon: number, lat: number, ring: Position[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const current = ring[i]!
    const previous = ring[j]!
    if (isPointOnSegment(lon, lat, previous, current)) {
      return true
    }

    const yi = current[1]
    const yj = previous[1]
    const intersects = (yi > lat) !== (yj > lat)
    if (!intersects) {
      continue
    }

    const xi = current[0]
    const xj = previous[0]
    const intersectX = ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (lon < intersectX) {
      inside = !inside
    }
  }
  return inside
}

function isPointInPolygonInclusive(lon: number, lat: number, polygon: ChinaBoundaryPolygon) {
  if (!isPointInRingInclusive(lon, lat, polygon.outer)) {
    return false
  }
  for (const hole of polygon.holes) {
    if (isPointInRingInclusive(lon, lat, hole)) {
      return false
    }
  }
  return true
}

export function isPointInsideChinaBoundary(lon: number, lat: number, polygons: ChinaBoundaryPolygon[]) {
  for (const polygon of polygons) {
    if (isPointInPolygonInclusive(lon, lat, polygon)) {
      return true
    }
  }
  return false
}