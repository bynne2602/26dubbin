import { useCallback, useEffect, useState } from "react";
import StudioController from "./StudioController";
import { hashForRoute, routeFromHash, type StudioRoute } from "./app/routes";

/**
 * Application router only. Feature state and workflows live in StudioController;
 * global layout lives in components/layout.
 */
export default function App() {
  const [route, setRoute] = useState<StudioRoute>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const syncRoute = () => {
      const nextRoute = routeFromHash(window.location.hash);
      const canonicalHash = hashForRoute(nextRoute);
      if (window.location.hash !== canonicalHash) {
        window.history.replaceState(null, "", canonicalHash);
      }
      setRoute(nextRoute);
    };
    syncRoute();
    const handleHashChange = () => syncRoute();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = useCallback((nextRoute: StudioRoute) => {
    if (nextRoute === route) return;
    window.location.hash = hashForRoute(nextRoute);
  }, [route]);

  return <StudioController activeRoute={route} onNavigate={navigate} />;
}
