import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { MrBarTone, RingSlice, RingStatus } from "./logic";
import { trayIconPng } from "./icons";

const CAPSULE_FILL = "rgba(14, 23, 36, 0.84)"; // ~ Swift calibratedRed 0.055,0.09,0.14
const CAPSULE_STROKE = "rgba(255, 255, 255, 0.16)";
const DIVIDER = "rgba(255, 255, 255, 0.22)";
const LABEL_MR = "rgb(255, 255, 255)";
const LABEL_READY = "rgb(52, 199, 89)";
const LABEL_WAIT = "rgb(255, 159, 10)";
const LABEL_MUTED = "rgb(142, 142, 147)";
const LABEL_RUN = "rgb(50, 173, 230)"; // systemCyan-ish
const LABEL_FAIL = "rgb(255, 69, 58)"; // systemRed-ish

const HEIGHT = 26;
const PAD_Y = 3;
const RING_X = 5;
const RING_SIZE = HEIGHT - PAD_Y * 2; // 20
const fontFor = (px: number): string =>
  `500 ${px}px ".AppleSystemUIFontMonospacedDigit", "SF Pro Text", Menlo, monospace`;
const FONT = fontFor(12);

export interface CapsuleCounts {
  mergeRequests: number;
  running: number;
  failed: number;
  /** Color of the MR count. Omitted counts stay white. */
  mrTone?: MrBarTone;
}

export function mrCounterColor(tone: MrBarTone | undefined): string {
  switch (tone) {
    case "ready":
      return LABEL_READY;
    case "running":
      return LABEL_WAIT;
    case "failed":
      return LABEL_FAIL;
    case "pending":
      return LABEL_MUTED;
    default:
      return LABEL_MR;
  }
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function counterParts(counts: CapsuleCounts): { text: string; color: string }[] {
  const parts: { text: string; color: string }[] = [];
  if (counts.mergeRequests > 0) {
    parts.push({ text: `MR ${counts.mergeRequests}`, color: mrCounterColor(counts.mrTone) });
  }
  if (counts.running > 0) parts.push({ text: `Run ${counts.running}`, color: LABEL_RUN });
  if (counts.failed > 0) parts.push({ text: `Fail ${counts.failed}`, color: LABEL_FAIL });
  return parts;
}

/**
 * Swift MenuBarCapsule: dark inset pill, progress ring, optional MR/Run/Fail counters.
 * Row (default) puts counters side by side with dividers. Stacked puts one counter
 * per line to the right of the ring, so the menu bar item takes less width.
 * Returns a 2× PNG buffer (width×height in points); caller sets scaleFactor.
 */
export async function trayCapsulePng(
  status: RingStatus,
  progress: number,
  failing: boolean,
  counts: CapsuleCounts,
  slices: RingSlice[] = [],
  stacked = false,
): Promise<{ png: Buffer; width: number; height: number }> {
  const scale = 2;
  const parts = counterParts(counts);
  // Stacked lines share the 26pt height, so 3 lines need a smaller face.
  const stackFont = parts.length >= 3 ? fontFor(9) : fontFor(11);
  const font = stacked && parts.length > 0 ? stackFont : FONT;
  const measure = createCanvas(4, 4).getContext("2d");
  measure.font = font;
  const textWidths = parts.map((p) => Math.ceil(measure.measureText(p.text).width));
  const textSpan = stacked
    ? Math.max(0, ...textWidths)
    : textWidths.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * 16;
  const width = parts.length === 0
    ? RING_X + RING_SIZE + RING_X
    : 38 + textSpan;

  const canvas = createCanvas(Math.ceil(width * scale), Math.ceil(HEIGHT * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Capsule background (inset 1pt like Swift).
  roundRect(ctx, 1, 1, width - 2, HEIGHT - 2, 8);
  ctx.fillStyle = CAPSULE_FILL;
  ctx.fill();
  ctx.strokeStyle = CAPSULE_STROKE;
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Progress ring.
  const ringPng = trayIconPng(failing ? "failed" : status, progress, failing, RING_SIZE * scale, slices);
  const ring = await loadImage(ringPng);
  ctx.drawImage(ring, RING_X, PAD_Y, RING_SIZE, RING_SIZE);

  // Counters + dividers. Center on glyph ink (not font line box). Use ?? so
  // descent 0 for caps like "MR 2" is kept — || treated 0 as missing and sat high.
  let x = RING_X + RING_SIZE + 6;
  ctx.textBaseline = "alphabetic";
  ctx.font = font;
  if (stacked) {
    // One line per counter, each centered in an equal slice of the height.
    // Keep 2pt clear of the top and bottom edge so lines don't sit on the curve.
    const inset = 2;
    const slice = (HEIGHT - inset * 2) / Math.max(1, parts.length);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const m = ctx.measureText(part.text);
      const ascent = m.actualBoundingBoxAscent ?? 9;
      const descent = m.actualBoundingBoxDescent ?? 3;
      const top = inset + i * slice;
      const textY = top + (slice - (ascent + descent)) / 2 + ascent;
      ctx.fillStyle = part.color;
      ctx.fillText(part.text, x, textY);
    }
  } else {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const m = ctx.measureText(part.text);
      const ascent = m.actualBoundingBoxAscent ?? 9;
      const descent = m.actualBoundingBoxDescent ?? 3;
      const textY = (HEIGHT - (ascent + descent)) / 2 + ascent;
      ctx.fillStyle = part.color;
      ctx.fillText(part.text, x, textY);
      x += textWidths[i];
      if (i < parts.length - 1) {
        x += 8;
        ctx.strokeStyle = DIVIDER;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD_Y + 2);
        ctx.lineTo(x, HEIGHT - PAD_Y - 2);
        ctx.stroke();
        x += 8;
      }
    }
  }

  return { png: canvas.toBuffer("image/png"), width, height: HEIGHT };
}
