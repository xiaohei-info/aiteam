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
}

if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.showPopover ??= function showPopover() {
    this.setAttribute("popover-open", "");
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "open" });
    this.dispatchEvent(event);
  };
  HTMLElement.prototype.hidePopover ??= function hidePopover() {
    this.removeAttribute("popover-open");
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "closed" });
    this.dispatchEvent(event);
  };
  const matches = HTMLElement.prototype.matches;
  HTMLElement.prototype.matches = function matchesWithPopover(selector: string): boolean {
    return selector === ":popover-open"
      ? this.hasAttribute("popover-open")
      : matches.call(this, selector);
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

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close() {
    this.removeAttribute("open");
  };
}
