export function createSignaturePad(canvas) {
  const context = canvas.getContext("2d");
  const state = {
    drawing: false,
    hasInk: false,
    lastPoint: null
  };

  reset();

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointerleave", handlePointerUp);

  return {
    clear: reset,
    exportSignature,
    setColor
  };

  function reset() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = canvas.dataset.signatureColor || "#111111";
    state.drawing = false;
    state.hasInk = false;
    state.lastPoint = null;
  }

  function setColor(color) {
    canvas.dataset.signatureColor = color;
    context.strokeStyle = color;
  }

  function handlePointerDown(event) {
    canvas.setPointerCapture(event.pointerId);
    state.drawing = true;
    state.hasInk = true;
    state.lastPoint = getPoint(event);
  }

  function handlePointerMove(event) {
    if (!state.drawing) {
      return;
    }

    const nextPoint = getPoint(event);
    context.beginPath();
    context.moveTo(state.lastPoint.x, state.lastPoint.y);
    context.lineTo(nextPoint.x, nextPoint.y);
    context.stroke();
    state.lastPoint = nextPoint;
  }

  function handlePointerUp(event) {
    if (!state.drawing) {
      return;
    }

    state.drawing = false;
    state.lastPoint = null;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released when the cursor leaves the canvas.
    }
  }

  function getPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function exportSignature() {
    if (!state.hasInk) {
      return null;
    }

    const { width, height } = canvas;
    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let index = 3; index < data.length; index += 4) {
      if (data[index] === 0) {
        continue;
      }

      const pixelIndex = (index - 3) / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (maxX < 0 || maxY < 0) {
      return null;
    }

    const padding = 18;
    const sourceX = Math.max(0, minX - padding);
    const sourceY = Math.max(0, minY - padding);
    const sourceWidth = Math.min(width, maxX + padding) - sourceX;
    const sourceHeight = Math.min(height, maxY + padding) - sourceY;
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = sourceWidth;
    outputCanvas.height = sourceHeight;
    outputCanvas
      .getContext("2d")
      .drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

    return {
      dataUrl: outputCanvas.toDataURL("image/png"),
      width: sourceWidth,
      height: sourceHeight
    };
  }
}
