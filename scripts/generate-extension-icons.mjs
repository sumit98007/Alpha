import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { crc32 } from './lib/crc32.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = path.join(ROOT, 'extension', 'assets', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLE_GRID = 4;

const COLORS = Object.freeze({
  blue: [0x23, 0x3d, 0x4d, 0xff],
  orange: [0xfe, 0x7f, 0x2d, 0xff],
  black: [0x00, 0x00, 0x00, 0xff],
  transparent: [0x00, 0x00, 0x00, 0x00]
});

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), 8 + data.length);
  return output;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++
  ) {
    const [currentX, currentY] = points[current];
    const [previousX, previousY] = points[previous];
    const crosses =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function insideRoundedSquare(x, y) {
  const halfSize = 0.96;
  const radius = 0.3;
  const offsetX = Math.abs(x) - (halfSize - radius);
  const offsetY = Math.abs(y) - (halfSize - radius);
  const outsideDistance = Math.hypot(Math.max(offsetX, 0), Math.max(offsetY, 0));
  const insideDistance = Math.min(Math.max(offsetX, offsetY), 0);
  return outsideDistance + insideDistance <= radius;
}

function colorAt(x, y) {
  if (!insideRoundedSquare(x, y)) return COLORS.transparent;
  if (Math.hypot(x, y) > 0.66) return COLORS.blue;

  const spark = [
    [0, -0.44],
    [0.105, -0.105],
    [0.44, 0],
    [0.105, 0.105],
    [0, 0.44],
    [-0.105, 0.105],
    [-0.44, 0],
    [-0.105, -0.105]
  ];
  return pointInPolygon(x, y, spark) ? COLORS.black : COLORS.orange;
}

function renderRgba(size) {
  const output = Buffer.alloc(size * size * 4);
  const sampleCount = SAMPLE_GRID * SAMPLE_GRID;

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      const colorTotals = [0, 0, 0];
      let alphaTotal = 0;
      for (let sampleY = 0; sampleY < SAMPLE_GRID; sampleY += 1) {
        for (let sampleX = 0; sampleX < SAMPLE_GRID; sampleX += 1) {
          const x = ((pixelX + (sampleX + 0.5) / SAMPLE_GRID) / size) * 2 - 1;
          const y = ((pixelY + (sampleY + 0.5) / SAMPLE_GRID) / size) * 2 - 1;
          const color = colorAt(x, y);
          alphaTotal += color[3];
          for (let channel = 0; channel < 3; channel += 1) {
            colorTotals[channel] += color[channel] * color[3];
          }
        }
      }

      const outputOffset = (pixelY * size + pixelX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        output[outputOffset + channel] =
          alphaTotal === 0 ? 0 : Math.round(colorTotals[channel] / alphaTotal);
      }
      output[outputOffset + 3] = Math.round(alphaTotal / sampleCount);
    }
  }
  return output;
}

function encodePng(size) {
  const rgba = renderRgba(size);
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const targetOffset = row * (size * 4 + 1);
    scanlines[targetOffset] = 0;
    rgba.copy(scanlines, targetOffset + 1, row * size * 4, (row + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
for (const size of SIZES) {
  await writeFile(path.join(OUTPUT_DIRECTORY, `icon-${size}.png`), encodePng(size));
}

console.log(`Generated Alpha extension icons: ${SIZES.join(', ')}px`);
