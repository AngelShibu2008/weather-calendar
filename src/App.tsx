import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  AvailabilityException,
  AvailabilityRule,
  Candidate,
  ExceptionInput,
  Forecast,
  ForecastHour,
  getUserId,
  Goal,
  GoalInput,
  Location,
  LocationResult,
  Plan,
  PlanSession,
  PreferredConditions,
  setUserId,
  TimeOfDay,
  WeatherLimits,
} from "./api";

const A = "/assets/";
const RUN_ICON = "a147f.svg";
const COMMITMENT_ICON = "bbcd9.svg";

type Screen = "signin" | "signup" | "today" | "plan" | "review" | "weather" | "you";
type Unit = "C" | "F";
type Prefs = { limits: WeatherLimits; preferred: PreferredConditions };
type Go = (screen: Screen) => void;

// ── Small storage helpers (per-browser conveniences only) ──────────────────

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// ── Date / time / unit helpers ─────────────────────────────────────────────
// Backend times are ISO strings carrying the location's offset, e.g. 2026-11-14T16:00:00-08:00.
// Read the wall-clock parts straight from the string so they show in the location's time zone.

function clock(hour: number, minute: number, withSuffix = true) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  const m = minute ? `:${minute.toString().padStart(2, "0")}` : withSuffix ? "" : ":00";
  return withSuffix ? `${h}${m} ${suffix}` : `${h}${m}`;
}

function isoClock(iso: string) {
  return { hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) };
}

function timeRange(startIso: string, endIso: string) {
  const s = isoClock(startIso);
  const e = isoClock(endIso);
  const fmt = (t: { hour: number; minute: number }) =>
    `${t.hour % 12 || 12}:${t.minute.toString().padStart(2, "0")}`;
  const sameHalf = s.hour >= 12 === e.hour >= 12;
  return sameHalf
    ? `${fmt(s)}–${fmt(e)} ${e.hour >= 12 ? "PM" : "AM"}`
    : `${fmt(s)} ${s.hour >= 12 ? "PM" : "AM"}–${fmt(e)} ${e.hour >= 12 ? "PM" : "AM"}`;
}

function todayIn(timeZone?: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", ...options });
}

function dayLabel(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return formatDate(date, { weekday: "short", month: "short", day: "numeric" });
}

function longDate(date: string) {
  return formatDate(date, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
}

function temp(celsius: number, unit: Unit) {
  return `${Math.round(unit === "C" ? celsius : (celsius * 9) / 5 + 32)}°`;
}

function rangeLabel(min: number, max: number, unit: Unit) {
  return unit === "C"
    ? `${min}–${max}°C`
    : `${Math.round((min * 9) / 5 + 32)}–${Math.round((max * 9) / 5 + 32)}°F`;
}

function hourLabel(hour: ForecastHour) {
  return clock(Number(hour.time.slice(11, 13)), 0);
}

function allHours(forecast: Forecast | null) {
  return forecast ? forecast.days.flatMap((day) => day.hours) : [];
}

/** Hours from the current hour onward. */
function upcomingHours(forecast: Forecast | null) {
  const now = Date.now() / 1000;
  return allHours(forecast).filter((h) => h.time_epoch + 3600 > now);
}

function outlook(hours: ForecastHour[]) {
  const next = hours.slice(0, 12);
  if (!next.length) return "Forecast unavailable.";
  const wet = next.filter((h) => h.chance_of_rain >= 50 || h.chance_of_snow >= 50);
  if (!wet.length) return `${next[0].condition_text}. Mostly dry for the next 12 hours.`;
  const firstIndex = next.indexOf(wet[0]);
  const lastIndex = next.indexOf(wet[wet.length - 1]);
  if (firstIndex === 0) {
    const clears = next[lastIndex + 1];
    return clears ? `Rain likely until about ${hourLabel(clears)}.` : "Rain likely for the next 12 hours.";
  }
  return `${next[0].condition_text} now. Rain likely from about ${hourLabel(wet[0])}.`;
}

function minutesBetween(startIso: string, endIso: string) {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);
}

function hhmm(value: string) {
  const [h, m] = value.split(":").map(Number);
  return { hour: h, minute: m };
}

// Planning hours ↔ weekly availability rules
const PLANNING_HOURS: Record<string, [string, string]> = {
  "6 AM–8 PM": ["06:00", "20:00"],
  "7 AM–7 PM": ["07:00", "19:00"],
  "8 AM–6 PM": ["08:00", "18:00"],
  "9 AM–5 PM": ["09:00", "17:00"],
};

function rulesFor(hours: string): AvailabilityRule[] {
  const [start_local, end_local] = PLANNING_HOURS[hours] ?? PLANNING_HOURS["7 AM–7 PM"];
  return Array.from({ length: 7 }, (_, weekday) => ({ weekday, start_local, end_local }));
}

function hoursFromRules(rules: AvailabilityRule[]) {
  if (rules.length !== 7) return rules.length ? "Custom" : "7 AM–7 PM";
  const [first] = rules;
  if (!rules.every((r) => r.start_local === first.start_local && r.end_local === first.end_local))
    return "Custom";
  const match = Object.entries(PLANNING_HOURS).find(
    ([, [s, e]]) => s === first.start_local && e === first.end_local,
  );
  return match ? match[0] : "Custom";
}

const COMFORT_RANGES: [number, number][] = [
  [5, 15],
  [10, 20],
  [15, 24],
  [18, 27],
];

const DEFAULT_GOAL: GoalInput = {
  activity: "run",
  duration_minutes: 30,
  sessions_per_week: 3,
  separate_days: true,
  min_gap_minutes: 0,
};

// ── Shared UI ──────────────────────────────────────────────────────────────

function Icon({ src, size = 20, alt = "" }: { src: string; size?: number; alt?: string }) {
  return <img className="icon" src={`${A}${src}`} width={size} height={size} alt={alt} />;
}

function WeatherIcon({ src, size = 24, alt = "" }: { src: string | null; size?: number; alt?: string }) {
  if (!src) return <Icon src="0fe59.svg" size={size} alt={alt} />;
  return <img className="icon" src={src} width={size} height={size} alt={alt} />;
}

function Brand() {
  return (
    <div className="brand">
      <Icon src="ace9a.svg" size={25} />
      <span>fieldday</span>
    </div>
  );
}

function PrimaryButton({
  children,
  icon,
  onClick,
  type = "button",
  disabled,
}: {
  children: React.ReactNode;
  icon?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button type={type} className="primary-button" onClick={onClick} disabled={disabled}>
      {icon && <Icon src={icon} size={17} />}
      {children}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      aria-label={label}
    >
      <span />
    </button>
  );
}

function TopContext({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="top-context">
      <button className="icon-button" onClick={onBack} aria-label="Go back">
        <Icon src="55dca.svg" />
      </button>
      <span>{title}</span>
      <div className="context-action">{action}</div>
    </div>
  );
}

const navItems = [
  { id: "today" as const, label: "Today", activeIcon: "e3fc5.svg", icon: "d5b1d.svg" },
  { id: "plan" as const, label: "Plan", activeIcon: "25a0c.svg", icon: "981e7.svg" },
  { id: "weather" as const, label: "Weather", activeIcon: "2be1d.svg", icon: "2be1d.svg" },
  { id: "you" as const, label: "You", activeIcon: "01aad.svg", icon: "4c690.svg" },
];

function BottomNav({ screen, go }: { screen: Screen; go: Go }) {
  const active = screen === "review" ? "plan" : screen;
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {navItems.map((item) => (
        <button
          key={item.id}
          className={active === item.id ? "active" : ""}
          onClick={() => go(item.id)}
          aria-current={active === item.id ? "page" : undefined}
        >
          <span className="nav-icon">
            <Icon src={active === item.id ? item.activeIcon : item.icon} />
          </span>
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function StatusBanner({
  busy,
  error,
  onDismiss,
}: {
  busy: string | null;
  error: string | null;
  onDismiss: () => void;
}) {
  if (!busy && !error) return null;
  return (
    <div className={`status-banner ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
      <span>{error ?? busy}</span>
      {error && (
        <button onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

// ── Location search (user flow step 1) ─────────────────────────────────────

function LocationSearch({
  onPick,
  placeholder = "Search for a city",
}: {
  onPick: (result: LocationResult) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setMessage(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .searchLocations(q)
        .then((found) => {
          if (cancelled) return;
          setResults(found);
          setMessage(found.length ? null : "No matching places");
        })
        .catch((err: unknown) => !cancelled && setMessage(err instanceof Error ? err.message : "Search failed"));
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="location-search">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label="Search for a location"
      />
      {(results.length > 0 || message) && (
        <div className="search-results">
          {message && <small>{message}</small>}
          {results.map((r) => (
            <button
              key={r.weatherapi_id}
              onClick={() => {
                onPick(r);
                setQuery("");
                setResults([]);
              }}
            >
              <strong>{r.name}</strong>
              <span>{[r.region, r.country].filter(Boolean).join(", ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Auth ───────────────────────────────────────────────────────────────────

function AuthHeader() {
  return (
    <div className="auth-header">
      <Brand />
      <button className="text-button" onClick={() => window.alert("Fieldday help is on the way.")}>
        Help
      </button>
    </div>
  );
}

function PasswordInput({ placeholder }: { placeholder: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-wrap">
      <input type={visible ? "text" : "password"} placeholder={placeholder} required />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        <Icon src="e9bec.svg" size={18} />
      </button>
    </div>
  );
}

function AuthDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-divider">
      <span />
      {children}
      <span />
    </div>
  );
}

const socialNotReady = () =>
  window.alert("Social sign-in isn't connected yet. Use your email for now.");

function SignIn({ go, onSignIn }: { go: Go; onSignIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSignIn(email);
  };
  return (
    <main className="auth-screen">
      <AuthHeader />
      <section className="auth-intro signin-intro">
        <p className="eyebrow">A LITTLE MORE ROOM FOR YOUR DAY</p>
        <h1>Welcome back.</h1>
        <p>Your plans, a little more in tune with the weather.</p>
      </section>
      <div className="weather-note">
        <Icon src="07e42.svg" size={35} />
        <div>
          <strong>Make space for the sunshine.</strong>
          <span>A thoughtful plan for whatever’s outside.</span>
        </div>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email address
          <input
            type="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <PasswordInput placeholder="Enter your password" />
        </label>
        <button
          type="button"
          className="forgot"
          onClick={() => window.alert("A reset link would be sent to your email.")}
        >
          Forgot password?
        </button>
        <PrimaryButton type="submit" icon="8197c.svg">
          Sign in
        </PrimaryButton>
      </form>
      <div className="social-block">
        <AuthDivider>or continue with</AuthDivider>
        <div className="social-buttons">
          <button onClick={socialNotReady}>Google</button>
          <button onClick={socialNotReady}>Apple</button>
        </div>
      </div>
      <p className="switch-auth">
        New to Fieldday? <button onClick={() => go("signup")}>Create an account</button>
      </p>
      <p className="privacy">Your day is yours. We never sell your personal data.</p>
    </main>
  );
}

function SignUp({ go, onSignIn }: { go: Go; onSignIn: (email: string, name?: string) => void }) {
  const [terms, setTerms] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (terms) onSignIn(email, name);
  };
  return (
    <main className="auth-screen signup-screen">
      <AuthHeader />
      <section className="auth-intro">
        <p className="eyebrow">GOOD DAYS START WITH A LITTLE SPACE</p>
        <h1>Make the day yours.</h1>
        <p>Create an account for plans that work with your life—and the forecast.</p>
      </section>
      <form className="auth-form signup-form" onSubmit={submit}>
        <label>
          Full name
          <input placeholder="Your name" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Email address
          <input
            type="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <PasswordInput placeholder="Create a password" />
          <small>Use at least 8 characters, including a number.</small>
        </label>
        <label className="terms">
          <input
            type="checkbox"
            checked={terms}
            onChange={(event) => setTerms(event.target.checked)}
          />
          <span>I agree to the Terms of service and Privacy policy.</span>
        </label>
        <PrimaryButton type="submit" icon="8197c.svg">
          Create account
        </PrimaryButton>
      </form>
      <div className="social-block">
        <AuthDivider>or sign up with</AuthDivider>
        <div className="social-buttons">
          <button onClick={socialNotReady}>Google</button>
          <button onClick={socialNotReady}>Apple</button>
        </div>
      </div>
      <p className="switch-auth">
        Already have an account? <button onClick={() => go("signin")}>Sign in</button>
      </p>
      <div className="promise">
        <Icon src="64b60.svg" size={18} />
        Suggestions, never surprises. You approve every change to your day.
      </div>
    </main>
  );
}

// ── Weather summary (shared) ───────────────────────────────────────────────

function WeatherSummary({
  forecast,
  detailed = false,
  unit,
}: {
  forecast: Forecast | null;
  detailed?: boolean;
  unit: Unit;
}) {
  const hours = upcomingHours(forecast);
  const picks = [0, 2, 4, 6].map((i) => hours[i]).filter(Boolean);
  return (
    <section className={`weather-summary ${detailed ? "detailed" : ""}`}>
      <div className="forecast-line">
        <Icon src="0fe59.svg" />
        {forecast ? outlook(hours) : "Choose a location to see the forecast."}
      </div>
      {detailed && picks.length > 0 && (
        <div className="hourly">
          {picks.map((hour, i) => (
            <div key={hour.time_epoch}>
              <span>{i === 0 ? "Now" : hourLabel(hour)}</span>
              <WeatherIcon src={hour.condition_icon} size={28} alt={hour.condition_text} />
              <strong>{temp(hour.temp_c, unit)}</strong>
              <span>{hour.chance_of_rain}% rain</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function sessionWeatherLine(c: Candidate, unit: Unit) {
  const w = c.weather;
  return `${w.condition_text ?? "Forecast"} · ${temp(w.temp_c, unit)} · ${Math.round(w.chance_of_rain)}% rain · ${Math.round(w.wind_kph)} kph wind`;
}

// ── Today ──────────────────────────────────────────────────────────────────

function Today({
  go,
  location,
  forecast,
  unit,
  acceptedPlan,
  pendingPlan,
  goal,
  onPickLocation,
  onGenerate,
  onRefresh,
  onOpenPlan,
}: {
  go: Go;
  location: Location | null;
  forecast: Forecast | null;
  unit: Unit;
  acceptedPlan: Plan | null;
  pendingPlan: Plan | null;
  goal: Goal | null;
  onPickLocation: (r: LocationResult) => void;
  onGenerate: () => void;
  onRefresh: () => void;
  onOpenPlan: (plan: Plan) => void;
}) {
  const today = todayIn(location?.timezone);
  const now = Date.now();
  const upcoming = (acceptedPlan?.sessions ?? []).filter((s) => Date.parse(s.end) > now);
  return (
    <>
      <main className="page today-page">
        <header className="app-header">
          <Brand />
          <button className="icon-button" onClick={() => go("plan")} aria-label="Add plan">
            <Icon src="13e9c.svg" />
          </button>
        </header>
        <section className="day-heading">
          <p>{longDate(today)}</p>
          <div>
            <h1>Today</h1>
            <span>{location ? location.name : "No location yet"}</span>
          </div>
        </section>
        {!location ? (
          <section className="ai-invite">
            <div>
              <Icon src="2c00e.svg" size={17} />
              <strong>Where do you run?</strong>
            </div>
            <p>Pick a location so we can plan around its forecast.</p>
            <LocationSearch onPick={onPickLocation} />
          </section>
        ) : (
          <WeatherSummary forecast={forecast} detailed unit={unit} />
        )}
        <section className="agenda">
          <div className="section-heading">
            <h2>Your runs</h2>
            <span>{acceptedPlan ? "Accepted" : "Not planned"}</span>
          </div>
          {upcoming.length === 0 && (
            <div className="empty-agenda">
              <strong>No runs planned</strong>
              <span>Set your goal and commitments in the Plan tab.</span>
            </div>
          )}
          {acceptedPlan &&
            upcoming.map((session) => {
              const warn = !session.eligible;
              return (
                <button className="agenda-item" key={session.id} onClick={() => onOpenPlan(acceptedPlan)}>
                  <span className="activity-symbol">
                    <Icon src={RUN_ICON} />
                  </span>
                  <span className="agenda-copy">
                    <strong>
                      {dayLabel(session.start.slice(0, 10), today)} run{session.locked ? " · Locked" : ""}
                    </strong>
                    <span>
                      {timeRange(session.start, session.end)} ·{" "}
                      {minutesBetween(session.start, session.end)} minutes
                    </span>
                    <small className={warn ? "warning" : ""}>
                      {warn
                        ? `Outside your limits · ${session.violations.join("; ")}`
                        : sessionWeatherLine(session, unit)}
                    </small>
                  </span>
                  <Icon src="aa1f8.svg" size={14} />
                </button>
              );
            })}
        </section>
        {location && goal && pendingPlan && (
          <section className="ai-invite">
            <div>
              <Icon src="2c00e.svg" size={17} />
              <strong>A suggested plan is waiting</strong>
            </div>
            <p>Review the proposed run times before anything changes.</p>
            <PrimaryButton icon="8197c.svg" onClick={() => onOpenPlan(pendingPlan)}>
              Review suggested plan
            </PrimaryButton>
          </section>
        )}
        {location && goal && !pendingPlan && (
          <section className="ai-invite">
            <div>
              <Icon src="2c00e.svg" size={17} />
              <strong>{acceptedPlan ? "Weather changes. Your plan can too." : "Plan your runs"}</strong>
            </div>
            <p>
              {acceptedPlan
                ? "Check the latest forecast and review any suggested moves."
                : `${goal.sessions_per_week} × ${goal.duration_minutes}-minute runs, fitted around your commitments and the forecast.`}
            </p>
            <PrimaryButton icon="8197c.svg" onClick={acceptedPlan ? onRefresh : onGenerate}>
              {acceptedPlan ? "Check latest forecast" : "Find my best schedule"}
            </PrimaryButton>
          </section>
        )}
      </main>
      <BottomNav screen="today" go={go} />
    </>
  );
}

// ── Weather ────────────────────────────────────────────────────────────────

function Weather({
  go,
  locations,
  location,
  setLocationId,
  forecast,
  unit,
  setUnit,
  prefs,
  acceptedPlan,
  forecastAlerts,
}: {
  go: Go;
  locations: Location[];
  location: Location | null;
  setLocationId: (id: number) => void;
  forecast: Forecast | null;
  unit: Unit;
  setUnit: (unit: Unit) => void;
  prefs: Prefs | null;
  acceptedPlan: Plan | null;
  forecastAlerts: boolean;
}) {
  const today = todayIn(location?.timezone);
  const hours = upcomingHours(forecast);
  const now = hours[0];
  const nextRun = acceptedPlan?.sessions.find((s) => Date.parse(s.end) > Date.now());
  return (
    <>
      <main className="page weather-page">
        <header className="weather-header">
          <div>
            <p>{longDate(today)}</p>
            <h1>{location ? `${location.name} weather` : "Weather"}</h1>
            <select
              className="weather-location"
              value={location?.id ?? ""}
              onChange={(event) =>
                event.target.value === "add" ? go("you") : setLocationId(Number(event.target.value))
              }
              aria-label="Forecast location"
            >
              {!location && <option value="">Choose a location</option>}
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {[l.name, l.region].filter(Boolean).join(", ")}
                </option>
              ))}
              <option value="add">＋ Add a location…</option>
            </select>
          </div>
          <button
            className="unit-toggle"
            onClick={() => setUnit(unit === "C" ? "F" : "C")}
            aria-label="Change temperature unit"
          >
            °{unit}
          </button>
        </header>
        {now && (
          <section className="current-weather">
            <div className="current-condition">
              <WeatherIcon src={now.condition_icon} size={42} alt={now.condition_text} />
              <div>
                <strong>{temp(now.temp_c, unit)}</strong>
                <span>Feels like {temp(now.feelslike_c, unit)}</span>
              </div>
            </div>
            <div className="current-copy">
              <h2>{outlook(hours)}</h2>
              <p>
                {now.condition_text}, wind {Math.round(now.wind_kph)} kph.
                {prefs &&
                  ` Your comfortable range is ${rangeLabel(
                    prefs.preferred.ideal_temp_min_c,
                    prefs.preferred.ideal_temp_max_c,
                    unit,
                  )} and you skip runs above ${prefs.limits.max_rain_chance}% rain.`}
              </p>
            </div>
          </section>
        )}
        <section className="weather-hours">
          <div className="section-heading">
            <h2>Next hours</h2>
            <span>{location?.name ?? "—"}</span>
          </div>
          <WeatherSummary forecast={forecast} detailed unit={unit} />
        </section>
        {forecast && (
          <section className="forecast-list">
            <h2>{forecast.days.length}-day forecast</h2>
            {forecast.days.map((day) => {
              const midday = day.hours[13] ?? day.hours[0];
              const temps = day.hours.map((h) => h.temp_c);
              const rain = Math.max(...day.hours.map((h) => h.chance_of_rain));
              return (
                <article key={day.date}>
                  <WeatherIcon src={midday.condition_icon} size={26} alt={midday.condition_text} />
                  <div>
                    <strong>{dayLabel(day.date, today)}</strong>
                    <span>{midday.condition_text}</span>
                  </div>
                  <small>{rain}% rain</small>
                  <p>
                    <strong>{temp(Math.max(...temps), unit)}</strong> / {temp(Math.min(...temps), unit)}
                  </p>
                </article>
              );
            })}
          </section>
        )}
        <section className="weather-plan-note">
          <Icon src="2c00e.svg" size={18} />
          <div>
            <strong>Next run · Alerts {forecastAlerts ? "on" : "off"}</strong>
            <p>
              {nextRun
                ? `${dayLabel(nextRun.start.slice(0, 10), today)} ${timeRange(nextRun.start, nextRun.end)} · ${Math.round(nextRun.weather.chance_of_rain)}% rain`
                : "No runs planned yet"}
            </p>
          </div>
          <button onClick={() => go("plan")}>View plan</button>
        </section>
      </main>
      <BottomNav screen="weather" go={go} />
    </>
  );
}

// ── Plan: running goal + commitments (user flow steps 2–3) ─────────────────

function GoalCard({ goal, onChange }: { goal: Goal; onChange: (patch: Partial<GoalInput>) => void }) {
  return (
    <article className="activity-card goal-card">
      <div className="activity-title">
        <Icon src={RUN_ICON} size={18} />
        <strong>Running goal</strong>
      </div>
      <div className="time-grid">
        <label>
          SESSIONS PER WEEK
          <select
            value={goal.sessions_per_week}
            onChange={(e) => onChange({ sessions_per_week: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "run" : "runs"}
              </option>
            ))}
          </select>
        </label>
        <label>
          DURATION
          <select
            value={goal.duration_minutes}
            onChange={(e) => onChange({ duration_minutes: Number(e.target.value) })}
          >
            {[20, 30, 45, 60, 90].map((n) => (
              <option key={n} value={n}>
                {n} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="activity-settings">
        <span className="activity-type">Outdoors</span>
        <div>
          Separate days
          <Toggle
            checked={goal.separate_days}
            onChange={(value) => onChange({ separate_days: value })}
            label="Run on separate days"
          />
        </div>
      </div>
    </article>
  );
}

function CommitmentCard({
  commitment,
  today,
  startEditing,
  onSave,
  onDelete,
}: {
  commitment: AvailabilityException;
  today: string;
  startEditing: boolean;
  onSave: (body: ExceptionInput) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState<ExceptionInput>({
    date: commitment.date,
    start_local: commitment.start_local,
    end_local: commitment.end_local,
    kind: "blocked",
    note: commitment.note,
  });
  const update = (patch: Partial<ExceptionInput>) => setDraft((d) => ({ ...d, ...patch }));
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  if (!days.includes(draft.date)) days.unshift(draft.date);
  const s = hhmm(draft.start_local);
  const e = hhmm(draft.end_local);

  const finish = async () => {
    if (draft.end_local <= draft.start_local) {
      window.alert("The end time needs to be after the start time.");
      return;
    }
    if (await onSave(draft)) setEditing(false);
  };

  return (
    <article className={`activity-card ${editing ? "editing" : ""}`}>
      <div className="activity-title">
        <Icon src={COMMITMENT_ICON} size={18} />
        <input
          value={draft.note ?? ""}
          onChange={(ev) => update({ note: ev.target.value })}
          aria-label="Commitment name"
          placeholder="Class, work, practice…"
          readOnly={!editing}
        />
        <div className="activity-menu-wrap">
          <button
            className="activity-menu-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={`Options for ${draft.note ?? "commitment"}`}
            aria-expanded={menuOpen}
          >
            <Icon src="8d313.svg" size={18} />
          </button>
          {menuOpen && (
            <div className="activity-menu">
              <button
                onClick={() => {
                  setEditing(true);
                  setMenuOpen(false);
                }}
              >
                Edit commitment
              </button>
              <button className="delete-action" onClick={onDelete}>
                Delete commitment
              </button>
            </div>
          )}
        </div>
      </div>
      {editing ? (
        <div className="time-grid three">
          <label>
            DAY
            <select value={draft.date} onChange={(ev) => update({ date: ev.target.value })}>
              {days.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d, today)}
                </option>
              ))}
            </select>
          </label>
          <label>
            FROM
            <input
              type="time"
              value={draft.start_local}
              onChange={(ev) => update({ start_local: ev.target.value })}
            />
          </label>
          <label>
            TO
            <input
              type="time"
              value={draft.end_local}
              onChange={(ev) => update({ end_local: ev.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="time-grid">
          <label>
            WHEN
            <input
              readOnly
              value={`${dayLabel(draft.date, today)} · ${clock(s.hour, s.minute)}–${clock(e.hour, e.minute)}`}
            />
          </label>
          <label>
            BLOCKS
            <input readOnly value="Runs" />
          </label>
        </div>
      )}
      <div className="activity-settings">
        <span className="activity-type">Commitment</span>
        {editing ? (
          <button className="done-editing" onClick={finish}>
            Done
          </button>
        ) : (
          <div>No runs during this time</div>
        )}
      </div>
    </article>
  );
}

function PlanScreen({
  go,
  location,
  forecast,
  unit,
  goal,
  commitments,
  newCommitmentId,
  onGoalChange,
  onAddCommitment,
  onSaveCommitment,
  onDeleteCommitment,
  onGenerate,
}: {
  go: Go;
  location: Location | null;
  forecast: Forecast | null;
  unit: Unit;
  goal: Goal | null;
  commitments: AvailabilityException[];
  newCommitmentId: number | null;
  onGoalChange: (patch: Partial<GoalInput>) => void;
  onAddCommitment: () => void;
  onSaveCommitment: (id: number, body: ExceptionInput) => Promise<boolean>;
  onDeleteCommitment: (id: number) => void;
  onGenerate: () => void;
}) {
  const today = todayIn(location?.timezone);
  const visible = commitments
    .filter((c) => c.kind === "blocked" && c.date >= today)
    .sort((a, b) => (a.date + a.start_local).localeCompare(b.date + b.start_local));
  return (
    <>
      <main className="page plan-page">
        <TopContext
          title={location ? `Plan · ${location.name}` : "Plan"}
          onBack={() => go("today")}
          action={
            <button className="text-button" onClick={() => go("today")}>
              Done
            </button>
          }
        />
        <section className="page-intro">
          <h1>What’s in your week?</h1>
          <p>Set your running goal and add classes or other commitments. Runs are fitted around them.</p>
        </section>
        <WeatherSummary forecast={forecast} unit={unit} />
        <section className="activity-list">
          {goal && <GoalCard goal={goal} onChange={onGoalChange} />}
          {visible.map((c) => (
            <CommitmentCard
              key={c.id}
              commitment={c}
              today={today}
              startEditing={c.id === newCommitmentId}
              onSave={(body) => onSaveCommitment(c.id, body)}
              onDelete={() => onDeleteCommitment(c.id)}
            />
          ))}
        </section>
        <button className="add-activity" onClick={onAddCommitment}>
          <span>＋</span>Add a commitment
        </button>
        <div className="schedule-action">
          <PrimaryButton icon="2f5d2.svg" onClick={onGenerate} disabled={!location || !goal}>
            Find my best schedule
          </PrimaryButton>
          <small>
            {location
              ? `Uses the ${forecast?.days.length ?? 3}-day forecast. You approve every change.`
              : "Choose a location on the You tab first."}
          </small>
        </div>
      </main>
      <BottomNav screen="plan" go={go} />
    </>
  );
}

// ── Review (user flow steps 6–8) ───────────────────────────────────────────

function SessionCard({
  session,
  index,
  plan,
  today,
  unit,
  onSwap,
  onLock,
  onFeedback,
}: {
  session: PlanSession;
  index: number;
  plan: Plan;
  today: string;
  unit: Unit;
  onSwap: (sessionId: number, candidateId: number) => void;
  onLock: (sessionId: number, locked: boolean) => void;
  onFeedback: (candidateId: number, rating: number) => void;
}) {
  const [rated, setRated] = useState<number | null>(null);
  const editable = plan.status !== "superseded";
  const rate = (rating: number) => {
    setRated(rating);
    onFeedback(session.candidate_id, rating);
  };
  return (
    <article className="change-card">
      <div className="change-heading">
        <Icon src={RUN_ICON} size={18} />
        <strong>Run {index + 1}</strong>
        <span>{minutesBetween(session.start, session.end)} min</span>
      </div>
      <div className="after">
        <span>{dayLabel(session.start.slice(0, 10), today)}</span>
        <strong>{timeRange(session.start, session.end)}</strong>
      </div>
      <div className="session-weather">
        <WeatherIcon src={session.weather.condition_icon} size={22} alt="" />
        <span>{sessionWeatherLine(session, unit)}</span>
      </div>
      {session.explanation && <p>{session.explanation}</p>}
      {!session.eligible && session.violations.length > 0 && (
        <p className="warning">Outside your limits: {session.violations.join("; ")}</p>
      )}
      {editable && session.alternatives.length > 0 && (
        <div className="alt-times">
          <span>Other times</span>
          {session.alternatives.map((alt) => (
            <button
              key={alt.id}
              onClick={() => onSwap(session.id, alt.id)}
              title={sessionWeatherLine(alt, unit)}
            >
              {dayLabel(alt.start.slice(0, 10), today)} {clock(isoClock(alt.start).hour, isoClock(alt.start).minute)}
            </button>
          ))}
        </div>
      )}
      {editable && (
        <div className="session-actions">
          <button className={session.locked ? "on" : ""} onClick={() => onLock(session.id, !session.locked)}>
            {session.locked ? "Locked · keeps this time" : "Lock this time"}
          </button>
          <div>
            <button className={rated === 4 ? "on" : ""} onClick={() => rate(4)}>
              Good time
            </button>
            <button className={rated === 0 ? "on" : ""} onClick={() => rate(0)}>
              Not for me
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function Review({
  go,
  plan,
  unit,
  busy,
  onAccept,
  onSwap,
  onLock,
  onFeedback,
}: {
  go: Go;
  plan: Plan | null;
  unit: Unit;
  busy: boolean;
  onAccept: () => void;
  onSwap: (sessionId: number, candidateId: number) => void;
  onLock: (sessionId: number, locked: boolean) => void;
  onFeedback: (candidateId: number, rating: number) => void;
}) {
  if (!plan) {
    return (
      <>
        <main className="page review-page">
          <TopContext title="Review" onBack={() => go("plan")} action={<span />} />
          <div className="empty-agenda">
            <strong>Nothing to review yet</strong>
            <span>Generate a schedule from the Plan tab.</span>
          </div>
        </main>
        <BottomNav screen="review" go={go} />
      </>
    );
  }
  const today = todayIn(plan.location.timezone);
  const sessions = [...plan.sessions].sort((a, b) => a.start.localeCompare(b.start));
  const totalMinutes = sessions.reduce((t, s) => t + minutesBetween(s.start, s.end), 0);
  const pending = plan.status === "draft" || plan.status === "proposed";
  const changes = (plan.changes ?? []).filter((c) => c.type !== "unchanged");
  const statusLabel = {
    draft: "Suggested plan · Not applied",
    proposed: "Forecast update · Not applied",
    accepted: "Your accepted plan",
    superseded: "Older version",
  }[plan.status];

  return (
    <>
      <main className="page review-page">
        <TopContext
          title={`${plan.location.name} · ${formatDate(plan.range.start, { month: "short", day: "numeric" })}–${formatDate(plan.range.end, { month: "short", day: "numeric" })}`}
          onBack={() => go("plan")}
          action={<span />}
        />
        <section className="review-intro">
          <span>{statusLabel}</span>
          <h1>{plan.status === "proposed" ? "The forecast moved." : "Let the weather lead."}</h1>
          <p>
            {sessions.length} of {plan.goal.sessions_per_week} runs scheduled · {plan.stats.eligible} of{" "}
            {plan.stats.candidates} open windows fit your weather limits.
          </p>
        </section>
        {plan.notes && (
          <div className="empty-agenda">
            <span>{plan.notes}</span>
          </div>
        )}
        {plan.status === "proposed" && (
          <section className="changes">
            {changes.length === 0 ? (
              <div className="validation">
                <Icon src="8cc39.svg" size={16} />
                No changes needed · your runs still fit the latest forecast
              </div>
            ) : (
              changes.map((change, i) => (
                <article className="change-card" key={i}>
                  <div className="change-heading">
                    <Icon src={RUN_ICON} size={18} />
                    <strong>
                      {change.type === "moved" ? "Moved run" : change.type === "added" ? "Added run" : "Dropped run"}
                    </strong>
                  </div>
                  {change.before && (
                    <div className="before">
                      <span>Before</span>
                      <s>
                        {dayLabel(change.before.start.slice(0, 10), today)}{" "}
                        {timeRange(change.before.start, change.before.end)}
                      </s>
                    </div>
                  )}
                  {change.after && (
                    <div className="after">
                      <span>After</span>
                      <strong>
                        {dayLabel(change.after.start.slice(0, 10), today)}{" "}
                        {timeRange(change.after.start, change.after.end)}
                      </strong>
                    </div>
                  )}
                  {change.reason && <p>{change.reason}</p>}
                </article>
              ))
            )}
          </section>
        )}
        <section className="changes">
          {sessions.map((session, index) => (
            <SessionCard
              key={session.id}
              session={session}
              index={index}
              plan={plan}
              today={today}
              unit={unit}
              onSwap={onSwap}
              onLock={onLock}
              onFeedback={onFeedback}
            />
          ))}
        </section>
        {sessions.length > 0 ? (
          <div className="validation">
            <Icon src="8cc39.svg" size={16} />
            No overlaps · {sessions.length} {sessions.length === 1 ? "run" : "runs"} · {totalMinutes} minutes
          </div>
        ) : (
          <div className="empty-agenda">
            <strong>No run times fit</strong>
            <span>Try widening your planning hours or loosening your weather limits.</span>
          </div>
        )}
        <section className="approval">
          {pending && sessions.length > 0 && (
            <PrimaryButton icon="418aa.svg" onClick={onAccept} disabled={busy}>
              {plan.status === "proposed" ? "Accept updated plan" : "Accept plan"}
            </PrimaryButton>
          )}
          <div>
            <button onClick={() => go("plan")}>Adjust goal</button>
            <button onClick={() => go("today")}>{pending ? "Keep current plan" : "Back to today"}</button>
          </div>
          <small>
            {pending ? "Your saved plan won’t change until you accept." : "Lock a run to keep it when the forecast updates."}
          </small>
        </section>
      </main>
      <BottomNav screen="review" go={go} />
    </>
  );
}

// ── You: location, limits, preferences (user flow steps 1 & 4) ────────────

function Setting({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="setting">
      <div>
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

type PreferenceDraft = {
  rain: number;
  comfort: string; // "min-max" °C
  wind: number;
  preferredTime: TimeOfDay | "any";
  daylight: boolean;
  gap: number;
  planningHours: string;
};

function You({
  go,
  displayName,
  email,
  locations,
  location,
  setLocationId,
  onPickLocation,
  unit,
  setUnit,
  forecastAlerts,
  setForecastAlerts,
  prefs,
  goal,
  rules,
  onSave,
  onSignOut,
}: {
  go: Go;
  displayName: string;
  email: string;
  locations: Location[];
  location: Location | null;
  setLocationId: (id: number) => void;
  onPickLocation: (r: LocationResult) => void;
  unit: Unit;
  setUnit: (unit: Unit) => void;
  forecastAlerts: boolean;
  setForecastAlerts: (alerts: boolean) => void;
  prefs: Prefs | null;
  goal: Goal | null;
  rules: AvailabilityRule[];
  onSave: (draft: PreferenceDraft) => Promise<boolean>;
  onSignOut: () => void;
}) {
  const initial = useMemo<PreferenceDraft>(
    () => ({
      rain: prefs?.limits.max_rain_chance ?? 40,
      comfort: prefs ? `${prefs.preferred.ideal_temp_min_c}-${prefs.preferred.ideal_temp_max_c}` : "10-20",
      wind: prefs?.limits.max_wind_kph ?? 30,
      preferredTime: prefs?.preferred.preferred_times[0] ?? "any",
      daylight: prefs?.limits.require_daylight ?? true,
      gap: goal?.min_gap_minutes ?? 0,
      planningHours: hoursFromRules(rules),
    }),
    [prefs, goal, rules],
  );
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
  const update = (patch: Partial<PreferenceDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  };
  const comfortOptions = COMFORT_RANGES.map(([a, b]) => `${a}-${b}`);
  if (!comfortOptions.includes(draft.comfort)) comfortOptions.unshift(draft.comfort);
  const initials =
    displayName
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

  return (
    <>
      <main className="page you-page">
        <TopContext title="Your Fieldday" onBack={() => go("today")} action={<span />} />
        <h1>Account &amp; preferences</h1>
        <section className="identity">
          <span>{initials}</span>
          <div>
            <strong>{displayName}</strong>
            <small>{email}</small>
          </div>
          <button onClick={() => window.alert("Profile editing is coming soon.")}>Edit</button>
        </section>
        <section className="settings-section">
          <h2>Home base</h2>
          <Setting title="Location" subtitle="Used for your forecast and run plans">
            {locations.length > 0 && (
              <select
                className="setting-select"
                value={location?.id ?? ""}
                onChange={(event) => setLocationId(Number(event.target.value))}
                aria-label="Home location"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {[l.name, l.region].filter(Boolean).join(", ")}
                  </option>
                ))}
              </select>
            )}
          </Setting>
          <LocationSearch
            onPick={onPickLocation}
            placeholder={locations.length ? "Add another location" : "Search for your city"}
          />
          <Setting title="Temperature">
            <select
              className="setting-select"
              value={unit}
              onChange={(event) => setUnit(event.target.value as Unit)}
              aria-label="Temperature unit"
            >
              <option value="C">Celsius · °C</option>
              <option value="F">Fahrenheit · °F</option>
            </select>
          </Setting>
        </section>
        <section className="weather-preferences">
          <h2>
            <Icon src="fa37e.svg" size={18} />
            Your kind of weather
          </h2>
          <Setting title="Skip runs when rain is above">
            <select
              className="setting-select"
              value={draft.rain}
              onChange={(event) => update({ rain: Number(event.target.value) })}
              aria-label="Rain limit"
            >
              {[20, 40, 60, 90].map((v) => (
                <option key={v} value={v}>
                  {v}% chance
                </option>
              ))}
            </select>
          </Setting>
          <Setting title="Skip runs when wind is above">
            <select
              className="setting-select"
              value={draft.wind}
              onChange={(event) => update({ wind: Number(event.target.value) })}
              aria-label="Wind limit"
            >
              {[20, 30, 40, 60].map((v) => (
                <option key={v} value={v}>
                  {v} kph
                </option>
              ))}
            </select>
          </Setting>
          <Setting title="Comfortable temperature" subtitle="Preferred, not required">
            <select
              className="setting-select"
              value={draft.comfort}
              onChange={(event) => update({ comfort: event.target.value })}
              aria-label="Comfortable temperature range"
            >
              {comfortOptions.map((v) => {
                const [a, b] = v.split("-").map(Number);
                return (
                  <option key={v} value={v}>
                    {rangeLabel(a, b, unit)}
                  </option>
                );
              })}
            </select>
          </Setting>
          <Setting title="Favorite time to run" subtitle="Preferred, not required">
            <select
              className="setting-select"
              value={draft.preferredTime}
              onChange={(event) => update({ preferredTime: event.target.value as PreferenceDraft["preferredTime"] })}
              aria-label="Preferred time of day"
            >
              <option value="any">Any time</option>
              <option value="morning">Morning</option>
              <option value="midday">Midday</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
            </select>
          </Setting>
          <Setting title="Daylight only" subtitle="Between sunrise and sunset">
            <Toggle checked={draft.daylight} onChange={(v) => update({ daylight: v })} label="Daylight only" />
          </Setting>
          <Setting title="Forecast alerts" subtitle="When weather affects your plan">
            <Toggle checked={forecastAlerts} onChange={setForecastAlerts} label="Forecast alerts" />
          </Setting>
        </section>
        <section className="settings-section">
          <h2>A little room to move</h2>
          <Setting title="Planning hours" subtitle="When runs can be scheduled, every day">
            <select
              className="setting-select"
              value={draft.planningHours}
              onChange={(event) => update({ planningHours: event.target.value })}
              aria-label="Planning hours"
            >
              {draft.planningHours === "Custom" && <option>Custom</option>}
              {Object.keys(PLANNING_HOURS).map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
          </Setting>
          <Setting title="Time between runs">
            <select
              className="setting-select"
              value={draft.gap}
              onChange={(event) => update({ gap: Number(event.target.value) })}
              aria-label="Time between runs"
            >
              {[0, 60, 240, 720].map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "No minimum" : v < 60 ? `${v} minutes` : `${v / 60} hours`}
                </option>
              ))}
            </select>
          </Setting>
        </section>
        <div className="save-preferences">
          <PrimaryButton
            disabled={!location}
            onClick={async () => setSaved(await onSave(draft))}
          >
            {saved ? "Preferences saved" : "Save preferences"}
          </PrimaryButton>
          <small>
            {location ? "Fieldday always asks before changing your schedule." : "Add a location to save weather preferences."}
          </small>
        </div>
        <div className="account-actions">
          <button onClick={() => window.alert("Calendar sync is coming soon.")}>Connected calendars</button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </main>
      <BottomNav screen="you" go={go} />
    </>
  );
}

// ── App: state + backend wiring ────────────────────────────────────────────

export default function App() {
  const [userId, setUserIdState] = useState<string | null>(getUserId);
  const [screen, setScreen] = useState<Screen>(getUserId() ? "today" : "signin");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [unit, setUnitState] = useState<Unit>(readLocal("fieldday.unit") === "F" ? "F" : "C");
  const [forecastAlerts, setForecastAlertsState] = useState(readLocal("fieldday.alerts") !== "off");
  const [displayName, setDisplayName] = useState(readLocal("fieldday.name") ?? "");

  const [email, setEmail] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationIdState] = useState<number | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [rules, setRules] = useState<AvailabilityRule[]>([]);
  const [commitments, setCommitments] = useState<AvailabilityException[]>([]);
  const [newCommitmentId, setNewCommitmentId] = useState<number | null>(null);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [acceptedPlan, setAcceptedPlan] = useState<Plan | null>(null);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [reviewPlan, setReviewPlan] = useState<Plan | null>(null);

  const location = locations.find((l) => l.id === locationId) ?? null;

  const go = useCallback((next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /** Run an API action with a status message; returns undefined on failure. */
  const run = useCallback(async <T,>(label: string | null, action: () => Promise<T>) => {
    if (label) setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong");
      return undefined;
    } finally {
      if (label) setBusy(null);
    }
  }, []);

  const setUnit = (u: Unit) => {
    setUnitState(u);
    writeLocal("fieldday.unit", u);
  };
  const setForecastAlerts = (on: boolean) => {
    setForecastAlertsState(on);
    writeLocal("fieldday.alerts", on ? "on" : "off");
  };
  const setLocationId = (id: number) => {
    setLocationIdState(id);
    writeLocal("fieldday.locationId", String(id));
  };

  // Bootstrap after sign-in: user, locations, availability, goal, plans.
  const bootstrapped = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || bootstrapped.current === userId) return;
    bootstrapped.current = userId;
    run("Loading your plan…", async () => {
      const health = await api.health();
      if (!health.weather_configured) setError("The server has no WEATHERAPI_KEY set (backend/.env).");
      let me = await api.me();
      if (!me.email && me.auth_subject.includes("@")) me = await api.updateMe({ email: me.auth_subject });
      setEmail(me.email ?? me.auth_subject);
      const [locs, availability, goals, accepted, drafts, proposed] = await Promise.all([
        api.locations(),
        api.availability(),
        api.goals(),
        api.plans("accepted"),
        api.plans("draft"),
        api.plans("proposed"),
      ]);
      setLocations(locs);
      const savedId = Number(readLocal("fieldday.locationId"));
      setLocationIdState(locs.find((l) => l.id === savedId)?.id ?? locs[0]?.id ?? null);

      setRules(
        availability.rules.length ? availability.rules : await api.replaceRules(rulesFor("7 AM–7 PM")),
      );
      setCommitments(availability.exceptions);
      setGoal(goals[0] ?? (await api.createGoal(DEFAULT_GOAL)));

      const latest = (plans: Plan[]) => (plans.length ? plans[0] : null);
      const acceptedLatest = latest(accepted);
      setAcceptedPlan(acceptedLatest ? await api.plan(acceptedLatest.id) : null);
      const pending = latest([...proposed, ...drafts].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setPendingPlan(pending);
    });
  }, [userId, run]);

  // Forecast + preferences follow the selected location.
  useEffect(() => {
    if (!userId || locationId === null) {
      setForecast(null);
      setPrefs(null);
      return;
    }
    let cancelled = false;
    run(null, async () => {
      const [fc, pr] = await Promise.all([api.forecast(locationId), api.preferences(locationId)]);
      if (cancelled) return;
      setForecast(fc);
      setPrefs({ limits: pr.limits, preferred: pr.preferred });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, locationId, run]);

  // ── Actions ──

  const signIn = (rawEmail: string, name?: string) => {
    const id = rawEmail.trim().toLowerCase();
    if (!id) return;
    if (name) {
      setDisplayName(name);
      writeLocal("fieldday.name", name);
    } else if (!readLocal("fieldday.name")) {
      setDisplayName(id.split("@")[0]);
    }
    setUserId(id);
    setUserIdState(id);
    go("today");
  };

  const signOut = () => {
    setUserId(null);
    setUserIdState(null);
    bootstrapped.current = null;
    setLocations([]);
    setLocationIdState(null);
    setGoal(null);
    setRules([]);
    setCommitments([]);
    setAcceptedPlan(null);
    setPendingPlan(null);
    setReviewPlan(null);
    go("signin");
  };

  const pickLocation = (result: LocationResult) =>
    run(`Adding ${result.name}…`, async () => {
      const created = await api.createLocation(result.weatherapi_id);
      setLocations((ls) => [...ls, created]);
      setLocationId(created.id);
    });

  const changeGoal = (patch: Partial<GoalInput>) => {
    if (!goal) return;
    const next = { ...goal, ...patch };
    setGoal(next);
    run(null, async () => {
      const { id, active: _active, ...body } = next;
      setGoal(await api.updateGoal(id, body));
    });
  };

  const addCommitment = () =>
    run(null, async () => {
      const created = await api.addException({
        date: todayIn(location?.timezone),
        start_local: "17:00",
        end_local: "18:00",
        kind: "blocked",
        note: "New commitment",
      });
      setCommitments((cs) => [...cs, created]);
      setNewCommitmentId(created.id);
    });

  const saveCommitment = async (id: number, body: ExceptionInput) => {
    const updated = await run(null, () => api.updateException(id, body));
    if (!updated) return false;
    setCommitments((cs) => cs.map((c) => (c.id === id ? updated : c)));
    return true;
  };

  const deleteCommitment = (id: number) =>
    run(null, async () => {
      await api.deleteException(id);
      setCommitments((cs) => cs.filter((c) => c.id !== id));
    });

  const openPlan = (plan: Plan) => {
    setReviewPlan(plan);
    go("review");
  };

  const generate = () => {
    if (!location || !goal) {
      setError("Choose a location first.");
      return;
    }
    run("Finding your best run times…", async () => {
      const plan = await api.generatePlan(location.id, goal.id);
      setPendingPlan(plan);
      openPlan(plan);
    });
  };

  const refresh = () => {
    if (!acceptedPlan) return;
    run("Checking the latest forecast…", async () => {
      const plan = await api.refreshPlan(acceptedPlan.id);
      setPendingPlan(plan);
      if (location) setForecast(await api.forecast(location.id));
      openPlan(plan);
    });
  };

  const accept = () => {
    if (!reviewPlan || busy) return;
    run("Saving your plan…", async () => {
      const plan = await api.acceptPlan(reviewPlan.id);
      setAcceptedPlan(plan);
      setPendingPlan(null);
      setReviewPlan(null);
      go("today");
    });
  };

  // Functional updates: a late response only replaces the plan it belongs to.
  const applyPlanUpdate = (plan: Plan) => {
    const same = (current: Plan | null) => (current?.id === plan.id ? plan : current);
    setReviewPlan(same);
    setAcceptedPlan(same);
    setPendingPlan(same);
  };

  const swapSession = (sessionId: number, candidateId: number) =>
    run("Updating…", async () => applyPlanUpdate(await api.updateSession(sessionId, { candidate_id: candidateId })));

  const lockSession = (sessionId: number, locked: boolean) =>
    run("Updating…", async () => applyPlanUpdate(await api.updateSession(sessionId, { locked })));

  const sendFeedback = (candidateId: number, rating: number) =>
    run(null, () => api.feedback(candidateId, rating));

  const savePreferences = async (draft: PreferenceDraft) => {
    if (!location || !prefs || !goal) return false;
    const [min, max] = draft.comfort.split("-").map(Number);
    const result = await run("Saving preferences…", async () => {
      const saved = await api.savePreferences(location.id, {
        limits: {
          ...prefs.limits,
          max_rain_chance: draft.rain,
          max_wind_kph: draft.wind,
          require_daylight: draft.daylight,
        },
        preferred: {
          ...prefs.preferred,
          ideal_temp_min_c: min,
          ideal_temp_max_c: max,
          preferred_times: draft.preferredTime === "any" ? [] : [draft.preferredTime],
        },
      });
      setPrefs({ limits: saved.limits, preferred: saved.preferred });
      if (draft.planningHours !== "Custom" && draft.planningHours !== hoursFromRules(rules)) {
        setRules(await api.replaceRules(rulesFor(draft.planningHours)));
      }
      if (draft.gap !== goal.min_gap_minutes) {
        const { id, active: _active, ...body } = goal;
        setGoal(await api.updateGoal(id, { ...body, min_gap_minutes: draft.gap }));
      }
      return true;
    });
    return result ?? false;
  };

  return (
    <div className="app-shell">
      <StatusBanner busy={busy} error={error} onDismiss={() => setError(null)} />
      {screen === "signin" && <SignIn go={go} onSignIn={signIn} />}
      {screen === "signup" && <SignUp go={go} onSignIn={signIn} />}
      {screen === "today" && (
        <Today
          go={go}
          location={location}
          forecast={forecast}
          unit={unit}
          acceptedPlan={acceptedPlan}
          pendingPlan={pendingPlan}
          goal={goal}
          onPickLocation={pickLocation}
          onGenerate={generate}
          onRefresh={refresh}
          onOpenPlan={openPlan}
        />
      )}
      {screen === "plan" && (
        <PlanScreen
          go={go}
          location={location}
          forecast={forecast}
          unit={unit}
          goal={goal}
          commitments={commitments}
          newCommitmentId={newCommitmentId}
          onGoalChange={changeGoal}
          onAddCommitment={addCommitment}
          onSaveCommitment={saveCommitment}
          onDeleteCommitment={deleteCommitment}
          onGenerate={generate}
        />
      )}
      {screen === "review" && (
        <Review
          go={go}
          plan={reviewPlan}
          unit={unit}
          busy={busy !== null}
          onAccept={accept}
          onSwap={swapSession}
          onLock={lockSession}
          onFeedback={sendFeedback}
        />
      )}
      {screen === "weather" && (
        <Weather
          go={go}
          locations={locations}
          location={location}
          setLocationId={setLocationId}
          forecast={forecast}
          unit={unit}
          setUnit={setUnit}
          prefs={prefs}
          acceptedPlan={acceptedPlan}
          forecastAlerts={forecastAlerts}
        />
      )}
      {screen === "you" && (
        <You
          go={go}
          displayName={displayName || email.split("@")[0] || "You"}
          email={email}
          locations={locations}
          location={location}
          setLocationId={setLocationId}
          onPickLocation={pickLocation}
          unit={unit}
          setUnit={setUnit}
          forecastAlerts={forecastAlerts}
          setForecastAlerts={setForecastAlerts}
          prefs={prefs}
          goal={goal}
          rules={rules}
          onSave={savePreferences}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}
