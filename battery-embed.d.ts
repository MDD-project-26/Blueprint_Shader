export type BatteryVariant = 'vertical' | 'sideways';
export type BatteryModel = 'ep5' | 'ep12';

export interface BatterySceneOptions {
  variant: BatteryVariant;
  /** Units shown: 3–9 for 'vertical', 1–4 for 'sideways'. */
  count: number;
  /** 'sideways' only: the model in view. Defaults to 'ep5'. */
  model?: BatteryModel;
  /** true: the stack appears assembled and count changes apply instantly. */
  reducedMotion: boolean;
  /** Folder the OBJ/MTL files are served from, e.g. '/models/battery/'. */
  modelBaseUrl: string;
  /** The models have loaded and the scene is drawing. */
  onReady: () => void;
  /** WebGL is unavailable, or a model failed to load or parse. */
  onError: (error: unknown) => void;
}

export interface BatteryScene {
  /** Throws a RangeError outside the variant's range. */
  setCount(count: number): void;
  /** 'sideways' only; does nothing on 'vertical'. */
  setModel(model: BatteryModel): void;
  /** Removes every listener and observer, stops rendering, frees GPU memory. */
  destroy(): void;
}

/**
 * Draws into `root.querySelector('canvas[data-battery-canvas]')`, sized to
 * `root`. Throws synchronously on invalid arguments (unknown variant, count
 * out of range, no canvas); everything that fails later goes to `onError`.
 */
export function createBatteryScene(root: HTMLElement, options: BatterySceneOptions): BatteryScene;
