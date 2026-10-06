/**
 * Minimal hash router (no dependency). Routes are `#/path/segments`.
 * Unknown routes fall back to the dashboard.
 */
import { useCallback, useEffect, useState } from "react";

export interface Route {
  name: string;
  segments: string[];
  raw: string;
}

const VALID_TOP = new Set([
  "dashboard",
  "agents",
  "bonds",
  "risk",
  "attestations",
  "security",
  "verify",
  "transactions",
  "login",
]);

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/dashboard";
  const segments = raw.split("/").filter((s) => s.length > 0);
  const top = segments[0] ?? "dashboard";
  if (!VALID_TOP.has(top)) {
    return { name: "dashboard", segments: ["dashboard"], raw: "#/dashboard" };
  }
  return { name: top, segments, raw: `#/${segments.join("/")}` };
}

export function navigate(to: string): void {
  const target = to.startsWith("#") ? to : `#${to}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(window.location.hash),
  );
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function useNavigate(): (to: string) => void {
  return useCallback((to: string) => navigate(to), []);
}
