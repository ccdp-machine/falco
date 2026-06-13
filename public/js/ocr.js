// Screen capture + OCR: grabs a frame of the user's screen (or window/tab)
// with getDisplayMedia, then extracts the text with Tesseract.js.
//
// Tesseract.js is loaded lazily from a CDN only when the user first runs a
// capture, so the rest of the app works offline.

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let tesseractLoading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_CDN;
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error('Could not load the OCR library. Check your network connection.'));
      document.head.appendChild(script);
    });
  }
  return tesseractLoading;
}

export function isCaptureSupported() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

// Prompts the user to pick a screen/window/tab and returns one frame of it
// as a canvas.
export async function captureScreenFrame() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: false,
  });
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    // Give the stream a moment to deliver a real frame.
    await new Promise((r) => setTimeout(r, 300));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || track.getSettings().width || 1280;
    canvas.height = video.videoHeight || track.getSettings().height || 720;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// Runs OCR on a canvas or image. onProgress receives 0..1.
export async function recognizeText(image, onProgress) {
  await loadTesseract();
  const result = await window.Tesseract.recognize(image, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    },
  });
  return result.data.text.trim();
}
