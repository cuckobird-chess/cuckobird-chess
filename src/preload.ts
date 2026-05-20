import { contextBridge, ipcRenderer } from "electron";
import type { CaptureResult, CaptureSource, ScreenshotApi } from "./types";

const api: ScreenshotApi = {
  listSources: () => ipcRenderer.invoke("sources:list") as Promise<CaptureSource[]>,
  captureSource: (sourceId: string) =>
    ipcRenderer.invoke("source:capture", sourceId) as Promise<CaptureResult>,
  captureImageDataUrl: (sourceId, sourceKind, imageDataUrl, frameCaptureMs) =>
    ipcRenderer.invoke("source:capture-image-data-url", sourceId, sourceKind, imageDataUrl, frameCaptureMs) as ReturnType<ScreenshotApi["captureImageDataUrl"]>,
  getEngineSettings: () => ipcRenderer.invoke("engine:get-settings") as ReturnType<ScreenshotApi["getEngineSettings"]>,
  setMaiaRating: (rating: number) =>
    ipcRenderer.invoke("engine:set-maia-rating", rating) as ReturnType<ScreenshotApi["setMaiaRating"]>,
  getStockfishSettings: () => ipcRenderer.invoke("stockfish:get-settings") as ReturnType<ScreenshotApi["getStockfishSettings"]>,
  setStockfishMoveTime: (moveTimeMs: number) =>
    ipcRenderer.invoke("stockfish:set-move-time", moveTimeMs) as ReturnType<ScreenshotApi["setStockfishMoveTime"]>,
  getLocalApiSettings: () => ipcRenderer.invoke("local-api:get-settings") as ReturnType<ScreenshotApi["getLocalApiSettings"]>,
  getHiddenModeSettings: () =>
    ipcRenderer.invoke("hidden-mode:get-settings") as ReturnType<ScreenshotApi["getHiddenModeSettings"]>,
  setHiddenMode: (enabled: boolean) =>
    ipcRenderer.invoke("hidden-mode:set-enabled", enabled) as ReturnType<ScreenshotApi["setHiddenMode"]>
};

contextBridge.exposeInMainWorld("screenshotApi", api);
