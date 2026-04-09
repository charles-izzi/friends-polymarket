<script setup lang="ts">
import { computed, ref } from 'vue'

export interface ChartSeries {
  label: string
  color: string
  data: number[]
}

const props = withDefaults(
  defineProps<{
    series: ChartSeries[]
    labels?: string[]
    yMin?: number
    yMax?: number
    yFormat?: (v: number) => string
    height?: number
    invertY?: boolean
  }>(),
  {
    labels: () => [],
    yMin: undefined,
    yMax: undefined,
    yFormat: undefined,
    height: 180,
    invertY: false,
  },
)

const SVG_W = 600
const PAD = { top: 6, right: 6, bottom: 22, left: 44 }
const plotW = SVG_W - PAD.left - PAD.right

const plotH = computed(() => props.height - PAD.top - PAD.bottom)

const dataRange = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const s of props.series) {
    for (const v of s.data) {
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!isFinite(min)) {
    min = 0
    max = 100
  }
  return { min, max }
})

const yMinVal = computed(() => props.yMin ?? dataRange.value.min)
const yMaxVal = computed(() => props.yMax ?? dataRange.value.max)
const ySpan = computed(() => yMaxVal.value - yMinVal.value || 1)

const yTicks = computed(() => {
  const span = ySpan.value
  const steps = 4
  const ticks: number[] = []
  for (let i = 0; i <= steps; i++) {
    ticks.push(yMinVal.value + (span * i) / steps)
  }
  return ticks
})

const pointCount = computed(() => {
  if (props.series.length === 0) return 0
  return Math.max(...props.series.map((s) => s.data.length))
})

const xTicks = computed(() => {
  const count = pointCount.value
  if (count < 2 || !props.labels?.length) return []
  const maxLabels = Math.min(6, props.labels.length)
  const ticks: { x: number; label: string }[] = []
  for (let i = 0; i < maxLabels; i++) {
    const idx = Math.round((i * (count - 1)) / (maxLabels - 1))
    ticks.push({
      x: PAD.left + (idx / (count - 1)) * plotW,
      label: props.labels[idx] ?? '',
    })
  }
  return ticks
})

function toY(val: number): number {
  const norm = (val - yMinVal.value) / ySpan.value
  if (props.invertY) {
    return PAD.top + norm * plotH.value
  }
  return PAD.top + (1 - norm) * plotH.value
}

const svgPaths = computed(() => {
  const count = pointCount.value
  if (count < 2) return []
  const last = count - 1
  return props.series.map((s) => {
    const d = s.data
      .map((v, i) => {
        const x = PAD.left + (i / last) * plotW
        const y = toY(v)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    return { d, color: s.color, label: s.label }
  })
})

const formatY = computed(() => {
  if (props.yFormat) return props.yFormat
  return (v: number) => v.toFixed(0)
})

// Hover
const hoverIndex = ref<number | null>(null)

const hoverInfo = computed(() => {
  if (hoverIndex.value === null || pointCount.value < 2) return null
  const last = pointCount.value - 1
  const x = PAD.left + (hoverIndex.value / last) * plotW
  const values = props.series.map((s) => ({
    label: s.label,
    value: s.data[hoverIndex.value!] ?? 0,
    formatted: formatY.value(s.data[hoverIndex.value!] ?? 0),
    color: s.color,
    y: toY(s.data[hoverIndex.value!] ?? 0),
  }))
  return { x, values }
})

function onMouseMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const mouseX = ((e.clientX - rect.left) / rect.width) * SVG_W
  const count = pointCount.value
  if (count < 2) {
    hoverIndex.value = null
    return
  }
  const last = count - 1
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i <= last; i++) {
    const px = PAD.left + (i / last) * plotW
    const dist = Math.abs(px - mouseX)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  hoverIndex.value = best
}

function onMouseLeave() {
  hoverIndex.value = null
}
</script>

<template>
  <template v-if="pointCount >= 2">
    <svg
      :viewBox="`0 0 ${SVG_W} ${height}`"
      preserveAspectRatio="xMidYMid meet"
      style="width: 100%; height: auto; display: block"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    >
      <!-- Y grid lines + labels -->
      <template v-for="tick in yTicks" :key="tick">
        <line
          :x1="PAD.left"
          :x2="SVG_W - PAD.right"
          :y1="toY(tick)"
          :y2="toY(tick)"
          stroke="rgba(128,128,128,0.15)"
          stroke-width="1"
        />
        <text :x="PAD.left - 6" :y="toY(tick) + 5" text-anchor="end" class="chart-label">
          {{ formatY(tick) }}
        </text>
      </template>

      <!-- X axis labels -->
      <text
        v-for="(tick, ti) in xTicks"
        :key="ti"
        :x="tick.x"
        :y="height - 4"
        text-anchor="middle"
        class="chart-label"
      >
        {{ tick.label }}
      </text>

      <!-- Lines -->
      <path
        v-for="(line, li) in svgPaths"
        :key="li"
        :d="line.d"
        :stroke="line.color"
        stroke-width="2.5"
        fill="none"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      <!-- Hover crosshair + dots + labels -->
      <template v-if="hoverInfo">
        <line
          :x1="hoverInfo.x"
          :x2="hoverInfo.x"
          :y1="PAD.top"
          :y2="PAD.top + plotH"
          stroke="rgba(128,128,128,0.4)"
          stroke-width="1"
          stroke-dasharray="4,3"
        />
        <template v-for="(p, pi) in hoverInfo.values" :key="pi">
          <circle
            :cx="hoverInfo.x"
            :cy="p.y"
            r="4"
            :fill="p.color"
            stroke="white"
            stroke-width="1.5"
          />
          <text :x="hoverInfo.x + 7" :y="p.y + 4" class="chart-hover-label" :fill="p.color">
            {{ p.formatted }}
          </text>
        </template>
      </template>
    </svg>
  </template>
  <p v-else class="text-body-2 text-medium-emphasis">Not enough data to display chart</p>
</template>

<style scoped>
.chart-label {
  font-size: 14px;
  fill: rgba(128, 128, 128, 0.7);
}

.chart-hover-label {
  font-size: 13px;
  font-weight: 600;
}
</style>
