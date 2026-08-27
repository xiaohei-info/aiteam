/** Build a same-host link to a separately published local component service. */
export function serviceUrl(port: number, pathname = "/"): string {
  const url = new URL(
    typeof window === "undefined" ? "http://127.0.0.1/" : window.location.href,
  );
  url.port = String(port);
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
