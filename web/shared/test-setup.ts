import "@testing-library/jest-dom/vitest";

// jsdom 没有原生 <dialog> 与 matchMedia；Astryx 的 Dialog / Collapsible 会用到（同 manager/src/test/setup.ts）。
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
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close() {
    this.removeAttribute("open");
  };
}
if (typeof window !== "undefined") window.scrollTo = () => {};
