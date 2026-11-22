import { api } from "./api.js";

const initialState = {
  user: null,
  route: "overview",
  range: "30d",
  includeSimulated: false,
  granularity: "auto",
  overview: null,
  analytics: null,
  licenses: [],
  webhooksConfig: null,
  deliveries: [],
  notificationsConfig: null,
  notificationLogs: [],
  releases: [],
  loading: false,
};

let currentState = { ...initialState };
const listeners = new Set();

export const store = {
  get() {
    return currentState;
  },
  set(partial) {
    currentState = { ...currentState, ...(typeof partial === "function" ? partial(currentState) : partial) };
    for (const fn of listeners) {
      try {
        fn(currentState);
      } catch (err) {
        console.error("[store] erro no subscriber:", err);
      }
    }
    return currentState;
  },
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  reset() {
    currentState = { ...initialState };
    for (const fn of listeners) fn(currentState);
  },
};

export async function refreshDashboardData(scopes = ["all"]) {
  const scopeSet = new Set(Array.isArray(scopes) ? scopes : [scopes]);
  const loadAll = scopeSet.has("all");
  const { range, includeSimulated, granularity } = store.get();

  const tasks = [];
  const assigners = [];

  if (loadAll || scopeSet.has("overview")) {
    tasks.push(api("/api/admin/overview"));
    assigners.push((res) => ({ overview: res }));
  }

  if (loadAll || scopeSet.has("analytics")) {
    const qs = `range=${encodeURIComponent(range)}&include_simulated=${Boolean(includeSimulated)}&granularity=${encodeURIComponent(granularity)}`;
    tasks.push(api(`/api/admin/analytics/sales?${qs}`));
    assigners.push((res) => ({ analytics: res }));
  }

  if (loadAll || scopeSet.has("licenses")) {
    tasks.push(api("/api/admin/licenses?limit=200"));
    assigners.push((res) => ({ licenses: res.licenses || [] }));
  }

  if (loadAll || scopeSet.has("webhooks") || scopeSet.has("webhooksConfig")) {
    tasks.push(api("/api/admin/webhooks/config"));
    assigners.push((res) => ({ webhooksConfig: res }));
  }

  if (loadAll || scopeSet.has("webhooks") || scopeSet.has("deliveries")) {
    tasks.push(api("/api/admin/webhooks/deliveries?limit=60"));
    assigners.push((res) => ({ deliveries: res.deliveries || [] }));
  }

  if (loadAll || scopeSet.has("messaging") || scopeSet.has("notifications") || scopeSet.has("notificationsConfig")) {
    tasks.push(api("/api/admin/notifications/config"));
    assigners.push((res) => ({ notificationsConfig: res }));
  }

  if (loadAll || scopeSet.has("messaging") || scopeSet.has("notifications") || scopeSet.has("notificationLogs")) {
    tasks.push(api("/api/admin/notifications/logs"));
    assigners.push((res) => ({ notificationLogs: res.logs || [] }));
  }

  if (loadAll || scopeSet.has("releases")) {
    tasks.push(api("/api/admin/releases"));
    assigners.push((res) => ({ releases: res.releases || [] }));
  }

  if (!tasks.length) return store.get();

  store.set({ loading: true });
  try {
    const settled = await Promise.allSettled(tasks);
    const patch = { loading: false };
    settled.forEach((entry, idx) => {
      if (entry.status === "fulfilled" && entry.value) {
        Object.assign(patch, assigners[idx](entry.value));
      }
    });
    return store.set(patch);
  } catch (err) {
    store.set({ loading: false });
    throw err;
  }
}
