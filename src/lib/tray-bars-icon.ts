import { Image } from "@tauri-apps/api/image"

import type { TrayPrimaryBar } from "@/lib/tray-primary-progress"
import type { TrayIconStyle } from "@/lib/settings"

function rgbaToImageDataBytes(rgba: Uint8ClampedArray): Uint8Array {
  // Image.new expects Uint8Array. Uint8ClampedArray shares the same buffer layout.
  return new Uint8Array(rgba.buffer)
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function makeRoundedBarPath(args: {
  x: number
  y: number
  w: number
  h: number
  leftRadius: number
  rightRadius: number
}): string {
  const { x, y, w, h } = args
  const leftRadius = Math.max(0, Math.min(args.leftRadius, h / 2, w / 2))
  const rightRadius = Math.max(0, Math.min(args.rightRadius, h / 2, w / 2))
  const x1 = x + w
  const y1 = y + h
  return [
    `M ${x + leftRadius} ${y}`,
    `L ${x1 - rightRadius} ${y}`,
    `A ${rightRadius} ${rightRadius} 0 0 1 ${x1} ${y + rightRadius}`,
    `L ${x1} ${y1 - rightRadius}`,
    `A ${rightRadius} ${rightRadius} 0 0 1 ${x1 - rightRadius} ${y1}`,
    `L ${x + leftRadius} ${y1}`,
    `A ${leftRadius} ${leftRadius} 0 0 1 ${x} ${y1 - leftRadius}`,
    `L ${x} ${y + leftRadius}`,
    `A ${leftRadius} ${leftRadius} 0 0 1 ${x + leftRadius} ${y}`,
    "Z",
  ].join(" ")
}

function normalizePercentText(style: TrayIconStyle, percentText: string | undefined): string | undefined {
  void style
  if (typeof percentText !== "string") return undefined
  const trimmed = percentText.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getBarsForStyle(style: TrayIconStyle, bars: TrayPrimaryBar[]): TrayPrimaryBar[] {
  if (style === "circle" || style === "textOnly") return bars.slice(0, 1)
  return bars
}

function getSvgLayout(args: {
  sizePx: number
  style: TrayIconStyle
  hasPercentText: boolean
}): {
  width: number
  height: number
  pad: number
  gap: number
  barsX: number
  barsWidth: number
  textX: number
  textY: number
  fontSize: number
} {
  const { sizePx, style, hasPercentText } = args
  const verticalNudgePx = 1
  const pad = Math.max(1, Math.round(sizePx * 0.08)) // ~2px at 24–36px
  const gap = Math.max(1, Math.round(sizePx * 0.03)) // ~1px at 36px

  const height = sizePx
  const barsX = pad
  const barsWidth = sizePx - 2 * pad
  const fontSize = Math.max(9, Math.round(sizePx * 0.72))
  // Optical correction + global nudge down to align with the tray slot center.
  const textY = Math.round(sizePx / 2) + 1 + verticalNudgePx

  if (style === "textOnly") {
    const textWidth = Math.max(12, Math.round(sizePx * 1.08))
    return {
      width: hasPercentText ? textWidth + 2 * pad : sizePx,
      height,
      pad,
      gap,
      barsX,
      barsWidth,
      textX: pad,
      textY,
      fontSize,
    }
  }

  if (!hasPercentText) {
    return {
      width: sizePx,
      height,
      pad,
      gap,
      barsX,
      barsWidth,
      textX: 0,
      textY,
      fontSize,
    }
  }

  const textGap = Math.max(2, Math.round(sizePx * 0.08))
  const textAreaWidth = Math.max(20, Math.round(sizePx * 1.5))
  const rightPad = pad

  return {
    width: sizePx + textGap + textAreaWidth + rightPad,
    height,
    pad,
    gap,
    barsX,
    barsWidth,
    textX: sizePx + textGap,
    textY,
    fontSize,
  }
}

export function makeTrayBarsSvg(args: {
  bars: TrayPrimaryBar[]
  sizePx: number
  style?: TrayIconStyle
  percentText?: string
}): string {
  const { bars, sizePx, style = "bars", percentText } = args
  const barsForStyle = getBarsForStyle(style, bars)
  const n = Math.max(1, Math.min(4, barsForStyle.length || 1))
  const text = normalizePercentText(style, percentText)
  const layout = getSvgLayout({
    sizePx,
    style,
    hasPercentText: Boolean(text),
  })

  const width = layout.width
  const height = layout.height
  const trackW = layout.barsWidth

  // For 1 bar, use same height as 2 bars (so it's not too chunky)
  const layoutN = Math.max(2, n)
  const trackH = Math.max(
    1,
    Math.floor((height - 2 * layout.pad - (layoutN - 1) * layout.gap) / layoutN)
  )
  const rx = Math.max(1, Math.floor(trackH / 3))

  // Calculate vertical offset to center bars
  const totalBarsHeight = n * trackH + (n - 1) * layout.gap
  const availableHeight = height - 2 * layout.pad
  const yOffset = layout.pad + Math.floor((availableHeight - totalBarsHeight) / 2)

  const trackOpacity = 0.22
  const fillOpacity = 1

  const parts: string[] = []
  parts.push(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`
  )

  if (style === "circle") {
    const chartSize = Math.max(6, sizePx - 2 * layout.pad)
    const cx = layout.barsX + chartSize / 2
    const cy = height / 2 + 1
    const strokeW = Math.max(2, Math.round(chartSize * 0.16))
    const radius = Math.max(1, Math.floor(chartSize / 2 - strokeW / 2) + 0.5)

    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="black" stroke-width="${strokeW}" opacity="${trackOpacity}" shape-rendering="geometricPrecision" />`
    )

    const fraction = barsForStyle[0]?.fraction
    if (typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0) {
      const clamped = Math.max(0, Math.min(1, fraction))
      if (clamped > 0) {
        const circumference = 2 * Math.PI * radius
        const dash = circumference * clamped
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="black" stroke-width="${strokeW}" stroke-linecap="butt" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 ${cx} ${cy})" opacity="${fillOpacity}" shape-rendering="geometricPrecision" />`
        )
      }
    }
  } else if (style !== "textOnly") {
    for (let i = 0; i < n; i += 1) {
      const bar = barsForStyle[i]
      const y = yOffset + i * (trackH + layout.gap) + 1
      const x = layout.barsX

      // Track
      parts.push(
        `<rect x="${x}" y="${y}" width="${trackW}" height="${trackH}" rx="${rx}" fill="black" opacity="${trackOpacity}" />`
      )

      const fraction = bar?.fraction
      if (typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0) {
        const clamped = Math.max(0, Math.min(1, fraction))
        const fillW = Math.max(0, Math.round(trackW * clamped))
        if (fillW > 0) {
          const movingEdgeRadius = Math.max(0, Math.floor(rx * 0.35))
          if (fillW >= trackW) {
            parts.push(
              `<rect x="${x}" y="${y}" width="${fillW}" height="${trackH}" rx="${rx}" fill="black" opacity="${fillOpacity}" />`
            )
          } else {
            const fillPath = makeRoundedBarPath({
              x,
              y,
              w: fillW,
              h: trackH,
              leftRadius: rx,
              rightRadius: movingEdgeRadius,
            })
            parts.push(`<path d="${fillPath}" fill="black" opacity="${fillOpacity}" />`)
          }
        }
      }
    }
  }

  if (text) {
    parts.push(
      `<text x="${layout.textX}" y="${layout.textY}" fill="black" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif" font-size="${layout.fontSize}" font-weight="700" dominant-baseline="middle">${escapeXmlText(text)}</text>`
    )
  }

  parts.push(`</svg>`)
  return parts.join("")
}

async function rasterizeSvgToRgba(svg: string, widthPx: number, heightPx: number): Promise<Uint8Array> {
  const blob = new Blob([svg], { type: "image/svg+xml" })
  const url = URL.createObjectURL(blob)
  try {
    const img = new window.Image()
    img.decoding = "async"

    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error("Failed to load SVG into image"))
    })

    img.src = url
    await loaded

    const canvas = document.createElement("canvas")
    canvas.width = widthPx
    canvas.height = heightPx

    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Canvas 2D context missing")

    // Clear to transparent; template icons use alpha as mask.
    ctx.clearRect(0, 0, widthPx, heightPx)
    ctx.drawImage(img, 0, 0, widthPx, heightPx)

    const imageData = ctx.getImageData(0, 0, widthPx, heightPx)
    return rgbaToImageDataBytes(imageData.data)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function renderTrayBarsIcon(args: {
  bars: TrayPrimaryBar[]
  sizePx: number
  style?: TrayIconStyle
  percentText?: string
}): Promise<Image> {
  const { bars, sizePx, style = "bars", percentText } = args
  const text = normalizePercentText(style, percentText)
  const svg = makeTrayBarsSvg({ bars, sizePx, style, percentText: text })
  const layout = getSvgLayout({
    sizePx,
    style,
    hasPercentText: Boolean(text),
  })
  const rgba = await rasterizeSvgToRgba(svg, layout.width, layout.height)
  return await Image.new(rgba, layout.width, layout.height)
}

export function getTrayIconSizePx(devicePixelRatio: number | undefined): number {
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1
  // 18pt-ish slot -> render at 18px * dpr for crispness (36px on Retina).
  return Math.max(18, Math.round(18 * dpr))
}
