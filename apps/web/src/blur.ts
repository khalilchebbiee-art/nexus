/**
 * Real-time background blur for the local camera track.
 *
 * Uses MediaPipe's Selfie Segmenter (lazy-loaded from a CDN so it adds zero
 * weight to the main bundle and degrades gracefully when offline). The person
 * is kept sharp while the background is Gaussian-blurred, then the composited
 * canvas is captured back into a MediaStreamTrack that replaces the camera
 * track on the peer connection.
 */

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";
const MODEL_URL = `${VISION_CDN}/wasm/../models/selfie_segmenter.tflite`;
const MODEL_FALLBACK =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

export type BlurHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

export async function createBlurredTrack(source: MediaStreamTrack, blurPx = 12): Promise<BlurHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vision: any = await import(/* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);

  const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_FALLBACK || MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true
  });

  const settings = source.getSettings();
  const width = settings.width ?? 640;
  const height = settings.height ?? 480;

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  await video.play();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Offscreen canvas used to cut the sharp foreground out with the mask alpha.
  const foreground = document.createElement("canvas");
  foreground.width = width;
  foreground.height = height;
  const fgCtx = foreground.getContext("2d")!;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext("2d")!;

  let running = true;
  let raf = 0;

  const renderMask = (mask: { getAsFloat32Array: () => Float32Array }) => {
    const data = mask.getAsFloat32Array();
    const image = maskCtx.createImageData(width, height);
    for (let i = 0; i < data.length; i += 1) {
      // Confidence that the pixel is foreground -> alpha channel.
      image.data[i * 4 + 3] = Math.round(data[i] * 255);
    }
    maskCtx.putImageData(image, 0, 0);
  };

  const loop = () => {
    if (!running) return;
    try {
      const result = segmenter.segmentForVideo(video, performance.now());
      const masks = result.confidenceMasks;
      if (masks && masks[0]) {
        renderMask(masks[0]);

        // Blurred background fills the frame.
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(video, 0, 0, width, height);
        ctx.filter = "none";

        // Sharp foreground = video masked by the person silhouette.
        fgCtx.globalCompositeOperation = "source-over";
        fgCtx.clearRect(0, 0, width, height);
        fgCtx.drawImage(video, 0, 0, width, height);
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(maskCanvas, 0, 0, width, height);
        fgCtx.globalCompositeOperation = "source-over";

        ctx.drawImage(foreground, 0, 0, width, height);
      } else {
        ctx.drawImage(video, 0, 0, width, height);
      }
      result.close?.();
    } catch {
      ctx.drawImage(video, 0, 0, width, height);
    }
    raf = requestAnimationFrame(loop);
  };
  loop();

  const stream = canvas.captureStream(30);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack;

  return {
    track,
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      track.stop();
      segmenter.close?.();
      video.srcObject = null;
    }
  };
}
