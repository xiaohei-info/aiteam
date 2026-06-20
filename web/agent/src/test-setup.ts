import "@testing-library/jest-dom";

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
