// Resolve a public-relative asset/data path against Vite's base URL so the app
// works whether served from "/" or a sub-path (base: "./").
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = import.meta.env.BASE_URL ?? "/";
  return base.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
}

export function dataUrl(path: string): string {
  return assetUrl(`data/${path}`)!;
}
