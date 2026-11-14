// Computer-use driver contract. One implementation per OS; the tool layer and
// the policy engine sit above it so behaviour is identical everywhere.
//
// Coordinates are absolute screen points with the origin at the primary
// display's top-left. `capture` returns a downscaled JPEG plus the scale factor
// so callers can map image pixels back to screen points.

export type WindowInfo = {
  id: string;
  title: string;
  app: string;
  bounds: { x: number; y: number; w: number; h: number };
  focused: boolean;
};

export type OcrBox = { text: string; x: number; y: number; w: number; h: number };

export type Capture = { jpeg: Buffer; width: number; height: number; scale: number };

export interface Driver {
  capture(opts?: { x?: number; y?: number; w?: number; h?: number }): Promise<Capture>;
  windows(): Promise<WindowInfo[]>;
  activate(appName: string): Promise<void>;
  click(opts: { x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }): Promise<void>;
  move(opts: { x: number; y: number }): Promise<void>;
  scroll(opts: { dy: number; x?: number; y?: number }): Promise<void>;
  drag(opts: { from: { x: number; y: number }; to: { x: number; y: number } }): Promise<void>;
  type(text: string): Promise<void>;
  key(chord: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  ocr(region: { x: number; y: number; w: number; h: number }): Promise<OcrBox[]>;
  waitForText(needle: string, timeoutMs: number): Promise<boolean>;
}
