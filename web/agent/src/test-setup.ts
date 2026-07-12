import "@testing-library/jest-dom";

class TestResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}

class TestIntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
}

// jsdom 不实现 matchMedia / scrollTo，组件库/路由测试偶尔依赖，补最小 stub。
if (typeof window !== "undefined" && !window.matchMedia) {
  // 仅测试环境补 stub，不污染生产类型。
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

if (typeof window !== "undefined" && !window.scrollTo) {
  (window as unknown as { scrollTo: unknown }).scrollTo = () => {};
}

// Astryx Button 的 loading Spinner 使用 Canvas 画环；jsdom 未实现 2D context。
// 这里提供最小无副作用 context，保留组件的真实 loading 路径且避免测试输出噪声。
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => ({
    lineCap: "round",
    lineWidth: 0,
    strokeStyle: "",
    globalAlpha: 1,
    beginPath: () => {},
    arc: () => {},
    stroke: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
