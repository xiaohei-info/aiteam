/** vitest 全局 setup：jsdom 环境 + @testing-library/jest-dom 匹配器。 */
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined" && !window.matchMedia) {
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
  window.scrollTo = () => {};
}

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.showPopover ??= function showPopover() {
    this.setAttribute("popover-open", "");
  };
  HTMLElement.prototype.hidePopover ??= function hidePopover() {
    this.removeAttribute("popover-open");
  };
}

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close() {
    this.removeAttribute("open");
  };
}

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    beginPath: () => {},
    arc: () => {},
    stroke: () => {},
    lineCap: "round",
    lineWidth: 1,
    strokeStyle: "",
    globalAlpha: 1,
  }),
});
