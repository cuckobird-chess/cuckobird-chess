type CaptureSource = import("./types").CaptureSource;
type CaptureResult = import("./types").CaptureResult;
type EngineSettings = import("./types").EngineSettings;
type StockfishSettings = import("./types").StockfishSettings;
type LocalApiSettings = import("./types").LocalApiSettings;
type HiddenModeSettings = import("./types").HiddenModeSettings;

interface Window {
  screenshotApi: import("./types").ScreenshotApi;
}
