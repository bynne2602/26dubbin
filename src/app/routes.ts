export const STUDIO_ROUTES = [
  "dubbin",
  "script-shorts",
  "editor",
  "extract",
  "projects",
  "style",
  "tracks",
  "tts",
  "export",
  "settings",
] as const;

export type StudioRoute = (typeof STUDIO_ROUTES)[number];

export function routeFromHash(hash: string): StudioRoute {
  const candidate = hash.replace(/^#\/?/, "").trim();
  // legacy alias
  if (candidate === "translate") return "dubbin";
  return STUDIO_ROUTES.includes(candidate as StudioRoute)
    ? candidate as StudioRoute
    : "dubbin";
}

export function hashForRoute(route: StudioRoute): string {
  return `#/${route}`;
}
