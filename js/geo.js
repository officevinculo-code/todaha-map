// 緯度経度から都道府県を判定するレイキャスティング法（点が多角形内にあるかの判定）。
// PREFECTURES_GEO の rings は [lng, lat] の配列（GeoJSON順）。

function isPointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceToRing(lng, lat, ring) {
  let min = Infinity;
  for (const [x, y] of ring) {
    const d = Math.hypot(x - lng, y - lat);
    if (d < min) min = d;
  }
  return min;
}

// 簡略化した境界データのため、海岸線付近ではズレる場合がある。
// 多角形内で見つからない場合は、最も近い都道府県を許容距離内で採用する（呼び出し側で必ず確認UIを挟む前提）。
const NEAREST_FALLBACK_DEG = 0.05; // 約5km

function findPrefectureByLatLng(lat, lng) {
  for (const feature of PREFECTURES_GEO) {
    for (const ring of feature.rings) {
      if (isPointInRing(lng, lat, ring)) {
        return { feature, exact: true };
      }
    }
  }

  let nearest = null;
  let nearestDist = Infinity;
  for (const feature of PREFECTURES_GEO) {
    for (const ring of feature.rings) {
      const d = distanceToRing(lng, lat, ring);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = feature;
      }
    }
  }
  if (nearest && nearestDist <= NEAREST_FALLBACK_DEG) {
    return { feature: nearest, exact: false };
  }
  return null;
}
