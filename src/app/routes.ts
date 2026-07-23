export const STUDIO_ROUTES = [
  "translate",
  "projects",
  "style",
  "tracks",
  "tts",
  "settings",
] as const;

export type StudioRoute = (typeof STUDIO_ROUTES)[number];

export function routeFromHash(hash: string): StudioRoute {
  const candidate = hash.replace(/^#\/?/, "").trim();
  return STUDIO_ROUTES.includes(candidate as StudioRoute)
    ? candidate as StudioRoute
    : "translate";
}

export function hashForRoute(route: StudioRoute): string {
  return `#/${route}`;
}
