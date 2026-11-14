// Typed client for the fieldday backend (backend/main.py).
// Base URL: VITE_API_URL (see .env.example), default http://localhost:8000.

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8000";

const USER_KEY = "fieldday.userId";

export function getUserId(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function setUserId(id: string | null) {
  try {
    if (id) localStorage.setItem(USER_KEY, id);
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable: session-only sign-in */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const userId = getUserId();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(userId ? { "X-User-Id": userId } : {}),
        "X-User-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach the fieldday server at ${API_URL}. Is the backend running?`, 0);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d: { msg?: string }) => d.msg).join("; ")
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

// ── Types (mirror backend/schemas.py and routes/plans.py) ──────────────────

export type TimeOfDay = "morning" | "midday" | "afternoon" | "evening";

export type User = { id: number; auth_subject: string; email: string | null; timezone: string };

export type LocationResult = {
  weatherapi_id: number;
  name: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
};

export type Location = {
  id: number;
  name: string;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  timezone: string;
};

export type ForecastHour = {
  time_epoch: number;
  time: string; // "YYYY-MM-DD HH:MM", location-local
  temp_c: number;
  feelslike_c: number;
  chance_of_rain: number;
  chance_of_snow: number;
  wind_kph: number;
  condition_text: string;
  condition_icon: string | null;
};

export type ForecastDay = { date: string; sunrise: string; sunset: string; hours: ForecastHour[] };

export type Forecast = {
  snapshot_id: number;
  retrieved_at: string;
  location: { name: string; region: string; country: string; tz_id: string };
  days: ForecastDay[];
};

export type WeatherLimits = {
  max_rain_chance: number;
  max_snow_chance: number;
  max_wind_kph: number;
  min_feelslike_c: number;
  max_feelslike_c: number;
  require_daylight: boolean;
};

export type PreferredConditions = {
  ideal_temp_min_c: number;
  ideal_temp_max_c: number;
  preferred_times: TimeOfDay[];
  temp_weight: number;
  rain_weight: number;
  wind_weight: number;
  time_weight: number;
};

export type Preferences = {
  location_id: number;
  limits: WeatherLimits;
  preferred: PreferredConditions;
};

export type AvailabilityRule = { id?: number; weekday: number; start_local: string; end_local: string };

export type AvailabilityException = {
  id: number;
  date: string;
  start_local: string;
  end_local: string;
  kind: "available" | "blocked";
  note: string | null;
};

export type ExceptionInput = Omit<AvailabilityException, "id">;

export type Goal = {
  id: number;
  activity: string;
  duration_minutes: number;
  sessions_per_week: number;
  separate_days: boolean;
  min_gap_minutes: number;
  active: boolean;
};

export type GoalInput = Omit<Goal, "id" | "active">;

export type CandidateWeather = {
  condition_text: string | null;
  condition_icon: string | null;
  temp_c: number;
  feelslike_c: number;
  chance_of_rain: number;
  chance_of_snow: number;
  wind_kph: number;
};

export type Candidate = {
  id: number;
  start: string; // ISO with the location's offset
  end: string;
  eligible: boolean;
  violations: string[];
  score: number | null;
  rank: number | null;
  weather: CandidateWeather;
};

export type PlanSession = Candidate & {
  id: number; // session id
  candidate_id: number;
  locked: boolean;
  explanation: string | null;
  alternatives: Candidate[];
};

export type PlanChange = {
  type: "unchanged" | "moved" | "removed" | "added";
  session_id?: number;
  before?: { start: string; end: string };
  after?: { start: string; end: string };
  reason?: string;
};

export type Plan = {
  id: number;
  status: "draft" | "proposed" | "accepted" | "superseded";
  version: number;
  parent_plan_id: number | null;
  location: { id: number; name: string; timezone: string };
  goal: { id: number; activity: string; duration_minutes: number; sessions_per_week: number };
  range: { start: string; end: string };
  ranker: { name: string; model_version_id: number | null };
  notes: string | null;
  changes: PlanChange[] | null;
  created_at: string;
  forecast_retrieved_at: string;
  sessions: PlanSession[];
  stats: { candidates: number; eligible: number };
  forecast?: ForecastDay[];
};

// ── Endpoints ──────────────────────────────────────────────────────────────

export const api = {
  health: () => request<{ ok: boolean; weather_configured: boolean; gemini_configured: boolean }>("GET", "/api/health"),

  me: () => request<User>("GET", "/api/me"),
  updateMe: (patch: Partial<Pick<User, "email" | "timezone">>) => request<User>("PATCH", "/api/me", patch),

  searchLocations: (q: string) =>
    request<LocationResult[]>("GET", `/api/locations/search?q=${encodeURIComponent(q)}`),
  createLocation: (weatherapi_id: number) => request<Location>("POST", "/api/locations", { weatherapi_id }),
  locations: () => request<Location[]>("GET", "/api/locations"),
  forecast: (locationId: number, refresh = false) =>
    request<Forecast>("GET", `/api/locations/${locationId}/forecast${refresh ? "?refresh=true" : ""}`),

  preferences: (locationId: number) => request<Preferences>("GET", `/api/locations/${locationId}/preferences`),
  savePreferences: (locationId: number, body: Pick<Preferences, "limits" | "preferred">) =>
    request<Preferences>("PUT", `/api/locations/${locationId}/preferences`, body),

  availability: () =>
    request<{ rules: AvailabilityRule[]; exceptions: AvailabilityException[] }>("GET", "/api/availability"),
  replaceRules: (rules: AvailabilityRule[]) => request<AvailabilityRule[]>("PUT", "/api/availability/rules", rules),
  addException: (body: ExceptionInput) =>
    request<AvailabilityException>("POST", "/api/availability/exceptions", body),
  updateException: (id: number, body: ExceptionInput) =>
    request<AvailabilityException>("PUT", `/api/availability/exceptions/${id}`, body),
  deleteException: (id: number) => request<void>("DELETE", `/api/availability/exceptions/${id}`),

  goals: () => request<Goal[]>("GET", "/api/goals"),
  createGoal: (body: GoalInput) => request<Goal>("POST", "/api/goals", body),
  updateGoal: (id: number, body: GoalInput) => request<Goal>("PUT", `/api/goals/${id}`, body),

  generatePlan: (location_id: number, goal_id: number) =>
    request<Plan>("POST", "/api/plans/generate", { location_id, goal_id }),
  plans: (status?: Plan["status"]) =>
    request<Plan[]>("GET", `/api/plans${status ? `?status=${status}` : ""}`),
  plan: (id: number) => request<Plan>("GET", `/api/plans/${id}`),
  acceptPlan: (id: number) => request<Plan>("POST", `/api/plans/${id}/accept`),
  refreshPlan: (id: number) => request<Plan>("POST", `/api/plans/${id}/refresh`),
  updateSession: (id: number, patch: { candidate_id?: number; locked?: boolean }) =>
    request<Plan>("PATCH", `/api/sessions/${id}`, patch),

  feedback: (candidate_id: number, rating: number, reason?: string) =>
    request<{ id: number }>("POST", "/api/feedback", { candidate_id, rating, reason }),
};
