const imageInput = document.getElementById("imageInput");
const thresholdInput = document.getElementById("threshold");
const blurInput = document.getElementById("blur");
const invertInput = document.getElementById("invert");
const autoBridgesInput = document.getElementById("autoBridges");
const bridgeWidthInput = document.getElementById("bridgeWidth");
const islandMinAreaInput = document.getElementById("islandMinArea");
const paperFormatInput = document.getElementById("paperFormat");
const orientationInput = document.getElementById("orientation");
const dpiInput = document.getElementById("dpi");

const thresholdValue = document.getElementById("thresholdValue");
const blurValue = document.getElementById("blurValue");
const bridgeWidthValue = document.getElementById("bridgeWidthValue");
const hint = document.getElementById("hint");
const downloadBtn = document.getElementById("downloadBtn");
const printBtn = document.getElementById("printBtn");

const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d", { willReadFrequently: true });

const workingCanvas = document.createElement("canvas");
const workingCtx = workingCanvas.getContext("2d", { willReadFrequently: true });

let sourceImage = null;
let renderData = null;

const PAPER_MM = {
  a4: [210, 297],
  letter: [215.9, 279.4],
};

function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

function getPaperPixels() {
  const format = paperFormatInput.value;
  const dpi = Math.max(72, Math.min(600, Number(dpiInput.value) || 300));
  const [wMm, hMm] = PAPER_MM[format] ?? PAPER_MM.a4;

  let width = mmToPx(wMm, dpi);
  let height = mmToPx(hMm, dpi);

  if (orientationInput.value === "landscape") {
    [width, height] = [height, width];
  }

  return { width, height, dpi };
}

function fitContain(srcW, srcH, dstW, dstH) {
  const ratio = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.round(srcW * ratio);
  const h = Math.round(srcH * ratio);
  const x = Math.round((dstW - w) / 2);
  const y = Math.round((dstH - h) / 2);
  return { x, y, w, h };
}

function paintDisk(mask, width, height, cx, cy, radius) {
  const startY = Math.max(0, cy - radius);
  const endY = Math.min(height - 1, cy + radius);
  const r2 = radius * radius;

  for (let y = startY; y <= endY; y += 1) {
    const dy = y - cy;
    const dxLimit = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
    const startX = Math.max(0, cx - dxLimit);
    const endX = Math.min(width - 1, cx + dxLimit);
    const row = y * width;

    for (let x = startX; x <= endX; x += 1) {
      mask[row + x] = 1;
    }
  }
}

function drawBridge(mask, width, height, x0, y0, x1, y1, bridgeWidth) {
  const radius = Math.max(1, Math.round(bridgeWidth / 2));
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    paintDisk(mask, width, height, x, y, radius);
    if (x === x1 && y === y1) break;

    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

const BRIDGE_DIRECTIONS = [
  { dx: 1, dy: 0, penalty: 0 },
  { dx: -1, dy: 0, penalty: 0 },
  { dx: 0, dy: 1, penalty: 0 },
  { dx: 0, dy: -1, penalty: 0 },
  { dx: 1, dy: 1, penalty: 0.2 },
  { dx: -1, dy: -1, penalty: 0.2 },
  { dx: -1, dy: 1, penalty: 0.2 },
  { dx: 1, dy: -1, penalty: 0.2 },
];

function findSmartBridge(componentId, boundary, componentMap, width, height, maxLen) {
  if (!boundary.length) return null;

  let best = null;
  const sampleStep = Math.max(1, Math.floor(boundary.length / 320));

  for (let b = 0; b < boundary.length; b += sampleStep) {
    const startIdx = boundary[b];
    const sx = startIdx % width;
    const sy = Math.floor(startIdx / width);

    for (let d = 0; d < BRIDGE_DIRECTIONS.length; d += 1) {
      const dir = BRIDGE_DIRECTIONS[d];
      let x = sx;
      let y = sy;
      let crossedBlack = 0;

      for (let dist = 1; dist <= maxLen; dist += 1) {
        x += dir.dx;
        y += dir.dy;
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const idx = y * width + x;
        const id = componentMap[idx];

        if (id === componentId) break;
        if (id >= 0 && id !== componentId) {
          if (crossedBlack < 1) break;
          const score = dist + dir.penalty;
          if (!best || score < best.score) {
            best = { score, sx, sy, tx: x, ty: y };
          }
          break;
        }

        crossedBlack += 1;
      }
    }
  }

  return best;
}

function applyAutoBridges(imageData, width, height, bridgeWidth, minArea) {
  const pixelCount = width * height;
  if (pixelCount > 14000000) return -1;

  const data = imageData.data;
  const mask = new Uint8Array(pixelCount);
  const componentMap = new Int32Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  componentMap.fill(-1);

  for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
    mask[i] = data[p] === 255 ? 1 : 0;
  }

  const components = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (!mask[start] || componentMap[start] !== -1) continue;

    const compId = components.length;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    componentMap[start] = compId;

    let area = 0;
    let touchBorder = false;
    let nearestBorderIdx = start;
    let nearestBorderDist = Number.POSITIVE_INFINITY;
    const boundary = [];

    while (head < tail) {
      const idx = queue[head];
      head += 1;
      area += 1;

      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchBorder = true;
      }

      const edgeDist = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (edgeDist < nearestBorderDist) {
        nearestBorderDist = edgeDist;
        nearestBorderIdx = idx;
      }

      let isBoundary = false;

      if (x > 0) {
        const left = idx - 1;
        if (mask[left]) {
          if (componentMap[left] === -1) {
            componentMap[left] = compId;
            queue[tail] = left;
            tail += 1;
          }
        } else {
          isBoundary = true;
        }
      } else {
        isBoundary = true;
      }

      if (x < width - 1) {
        const right = idx + 1;
        if (mask[right]) {
          if (componentMap[right] === -1) {
            componentMap[right] = compId;
            queue[tail] = right;
            tail += 1;
          }
        } else {
          isBoundary = true;
        }
      } else {
        isBoundary = true;
      }

      if (y > 0) {
        const up = idx - width;
        if (mask[up]) {
          if (componentMap[up] === -1) {
            componentMap[up] = compId;
            queue[tail] = up;
            tail += 1;
          }
        } else {
          isBoundary = true;
        }
      } else {
        isBoundary = true;
      }

      if (y < height - 1) {
        const down = idx + width;
        if (mask[down]) {
          if (componentMap[down] === -1) {
            componentMap[down] = compId;
            queue[tail] = down;
            tail += 1;
          }
        } else {
          isBoundary = true;
        }
      } else {
        isBoundary = true;
      }

      if (isBoundary && boundary.length < 1400) {
        boundary.push(idx);
      }
    }

    components.push({
      area,
      touchBorder,
      nearestBorderIdx,
      boundary,
    });
  }

  let bridgeCount = 0;
  const maxBridges = 400;
  const maxRayLen = Math.max(24, Math.round(Math.min(width, height) * 0.35));

  for (let compId = 0; compId < components.length && bridgeCount < maxBridges; compId += 1) {
    const comp = components[compId];
    if (comp.touchBorder || comp.area < minArea) continue;

    const smartBridge = findSmartBridge(
      compId,
      comp.boundary,
      componentMap,
      width,
      height,
      maxRayLen,
    );

    if (smartBridge) {
      drawBridge(
        mask,
        width,
        height,
        smartBridge.sx,
        smartBridge.sy,
        smartBridge.tx,
        smartBridge.ty,
        bridgeWidth,
      );
      bridgeCount += 1;
      continue;
    }

    const fallbackX = comp.nearestBorderIdx % width;
    const fallbackY = Math.floor(comp.nearestBorderIdx / width);
    const leftDist = fallbackX;
    const rightDist = width - 1 - fallbackX;
    const topDist = fallbackY;
    const bottomDist = height - 1 - fallbackY;
    const minDist = Math.min(leftDist, rightDist, topDist, bottomDist);
    let targetX = fallbackX;
    let targetY = fallbackY;

    if (minDist === leftDist) targetX = 0;
    else if (minDist === rightDist) targetX = width - 1;
    else if (minDist === topDist) targetY = 0;
    else targetY = height - 1;

    drawBridge(mask, width, height, fallbackX, fallbackY, targetX, targetY, bridgeWidth);
    bridgeCount += 1;
  }

  for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
    const value = mask[i] ? 255 : 0;
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }

  return bridgeCount;
}

function buildStencil() {
  if (!sourceImage) return;

  const { width, height } = getPaperPixels();
  workingCanvas.width = width;
  workingCanvas.height = height;

  workingCtx.fillStyle = "white";
  workingCtx.fillRect(0, 0, width, height);

  const fit = fitContain(sourceImage.width, sourceImage.height, width, height);
  const blur = Number(blurInput.value) || 0;

  workingCtx.save();
  workingCtx.filter = blur > 0 ? `grayscale(1) blur(${blur}px)` : "grayscale(1)";
  workingCtx.drawImage(sourceImage, fit.x, fit.y, fit.w, fit.h);
  workingCtx.restore();

  const threshold = Number(thresholdInput.value);
  const invert = invertInput.checked;
  const autoBridges = autoBridgesInput.checked;
  const bridgeWidth = Math.max(2, Number(bridgeWidthInput.value) || 14);
  const minArea = Math.max(10, Number(islandMinAreaInput.value) || 250);
  const imageData = workingCtx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i];
    const isInk = invert ? gray >= threshold : gray < threshold;
    const value = isInk ? 0 : 255;

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  let bridgeCount = 0;
  if (autoBridges) {
    bridgeCount = applyAutoBridges(imageData, width, height, bridgeWidth, minArea);
  }

  workingCtx.putImageData(imageData, 0, 0);
  renderData = imageData;

  drawPreview(width, height);
  if (autoBridges && bridgeCount >= 0) {
    hint.textContent = `Aperçu généré (${width} × ${height}px), ponts ajoutés: ${bridgeCount}`;
  } else if (autoBridges && bridgeCount < 0) {
    hint.textContent =
      "Image très grande: ponts auto ignorés pour garder une génération fluide. Baisse le DPI pour les activer.";
  } else {
    hint.textContent = `Aperçu généré (${width} × ${height}px)`;
  }
  downloadBtn.disabled = false;
  printBtn.disabled = false;
}

function drawPreview(renderWidth, renderHeight) {
  const maxPreviewSide = 1200;
  const scale = Math.min(maxPreviewSide / renderWidth, maxPreviewSide / renderHeight, 1);
  previewCanvas.width = Math.max(1, Math.round(renderWidth * scale));
  previewCanvas.height = Math.max(1, Math.round(renderHeight * scale));

  if (!renderData) return;

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = renderWidth;
  tempCanvas.height = renderHeight;
  tempCanvas.getContext("2d").putImageData(renderData, 0, 0);

  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(tempCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
}

function downloadPng() {
  if (!sourceImage) return;
  buildStencil();

  const a = document.createElement("a");
  a.href = workingCanvas.toDataURL("image/png");
  a.download = `pochoir-${Date.now()}.png`;
  a.click();
}

function printStencil() {
  if (!sourceImage) return;
  buildStencil();

  const dataUrl = workingCanvas.toDataURL("image/png");
  const printWindow = window.open("", "_blank");
  if (!printWindow) return;

  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Impression pochoir</title>
        <style>
          @page { margin: 0; }
          body { margin: 0; display: grid; place-items: center; }
          img { width: 100vw; height: 100vh; object-fit: contain; image-rendering: crisp-edges; }
        </style>
      </head>
      <body>
        <img src="${dataUrl}" alt="Pochoir" />
        <script>
          window.onload = () => {
            window.focus();
            window.print();
          };
        <\/script>
      </body>
    </html>
  `);

  printWindow.document.close();
}

function handleImageUpload(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      buildStencil();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

thresholdInput.addEventListener("input", () => {
  thresholdValue.textContent = thresholdInput.value;
  buildStencil();
});

blurInput.addEventListener("input", () => {
  blurValue.textContent = blurInput.value;
  buildStencil();
});

invertInput.addEventListener("change", buildStencil);
autoBridgesInput.addEventListener("change", buildStencil);
bridgeWidthInput.addEventListener("input", () => {
  bridgeWidthValue.textContent = bridgeWidthInput.value;
  buildStencil();
});
islandMinAreaInput.addEventListener("input", buildStencil);
paperFormatInput.addEventListener("change", buildStencil);
orientationInput.addEventListener("change", buildStencil);
dpiInput.addEventListener("input", buildStencil);

imageInput.addEventListener("change", (event) => {
  handleImageUpload(event.target.files?.[0]);
});

downloadBtn.addEventListener("click", downloadPng);
printBtn.addEventListener("click", printStencil);
