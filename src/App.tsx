import { FormEvent, useState } from "react";

const A = "/assets/";

type Screen = "signin" | "signup" | "today" | "plan" | "review" | "weather" | "you";
type Unit = "C" | "F";
type Activity = {
  id: string;
  name: string;
  time: string;
  duration: string;
  type: "Outdoors" | "Indoors";
  icon: string;
  flexible: boolean;
};
type SuggestedChange = Activity & {
  before: string;
  after: string;
  note: string;
};

function formatRange(range: string, unit: Unit) {
  if (unit === "C") return range;
  const values = range.match(/\d+/g)?.map(Number) ?? [];
  if (values.length !== 2) return range;
  return `${Math.round((values[0] * 9) / 5 + 32)}–${Math.round((values[1] * 9) / 5 + 32)}°F`;
}

function durationInMinutes(duration: string) {
  const hours = duration.match(/([\d.]+)\s*hour/i);
  const minutes = duration.match(/(\d+)\s*minute/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  if (minutes) return Number(minutes[1]);
  return 60;
}

function formatTime(minutes: number) {
  const normalized = minutes % (24 * 60);
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${minute.toString().padStart(2, "0")} ${suffix}`;
}

function suggestedSchedule(
  activities: Activity[],
  gapMinutes: number,
  planningHours: string,
): SuggestedChange[] {
  const startByHours: Record<string, number> = {
    "7 AM–7 PM": 7 * 60,
    "8 AM–6 PM": 8 * 60,
    "9 AM–5 PM": 9 * 60,
  };
  let cursor = startByHours[planningHours] ?? 8 * 60;
  const flexible = activities
    .filter((activity) => activity.flexible)
    .sort((a, b) => Number(a.type === "Outdoors") - Number(b.type === "Outdoors"));

  return flexible
    .map((activity) => {
      if (activity.type === "Outdoors") cursor = Math.max(cursor, 13 * 60);
      const end = cursor + durationInMinutes(activity.duration);
      const after = `${formatTime(cursor)}–${formatTime(end)}`;
      cursor = end + gapMinutes;
      return {
        ...activity,
        before: activity.time,
        after,
        note:
          activity.type === "Indoors"
            ? "Stay focused indoors while the morning rain passes."
            : "Rain clears by noon. This fits the drier afternoon window.",
      };
    })
    .filter((change) => change.after !== change.before);
}

const initialActivities: Activity[] = [
  {
    id: "hike",
    name: "Forest Park hike",
    time: "9:00–11:00 AM",
    duration: "2 hours",
    type: "Outdoors",
    icon: "a147f.svg",
    flexible: true,
  },
  {
    id: "soccer",
    name: "Soccer practice",
    time: "11:30 AM–1:00 PM",
    duration: "90 minutes",
    type: "Outdoors",
    icon: "f713d.svg",
    flexible: true,
  },
  {
    id: "study",
    name: "Study session",
    time: "2:00–4:00 PM",
    duration: "2 hours",
    type: "Indoors",
    icon: "bbcd9.svg",
    flexible: true,
  },
];

function Icon({ src, size = 20, alt = "" }: { src: string; size?: number; alt?: string }) {
  return <img className="icon" src={`${A}${src}`} width={size} height={size} alt={alt} />;
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
}: {
  children: React.ReactNode;
  icon?: string;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className="primary-button" onClick={onClick}>
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

function BottomNav({ screen, go }: { screen: Screen; go: (screen: Screen) => void }) {
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

function SignIn({ go }: { go: (screen: Screen) => void }) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    go("today");
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
          <input type="email" placeholder="you@example.com" required />
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
          <button onClick={() => go("today")}>Google</button>
          <button onClick={() => go("today")}>Apple</button>
        </div>
      </div>
      <p className="switch-auth">
        New to Fieldday? <button onClick={() => go("signup")}>Create an account</button>
      </p>
      <p className="privacy">Your day is yours. We never sell your personal data.</p>
    </main>
  );
}

function SignUp({ go }: { go: (screen: Screen) => void }) {
  const [terms, setTerms] = useState(true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (terms) go("today");
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
          <input placeholder="Your name" required />
        </label>
        <label>
          Email address
          <input type="email" placeholder="you@example.com" required />
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
          <button onClick={() => go("today")}>Google</button>
          <button onClick={() => go("today")}>Apple</button>
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

function WeatherSummary({
  detailed = false,
  unit = "C",
  offset = 0,
}: {
  detailed?: boolean;
  unit?: Unit;
  offset?: number;
}) {
  const hours = [
    { time: "9 AM", icon: "12c99.svg", temp: 13, rain: "85% rain" },
    { time: "11 AM", icon: "12c99.svg", temp: 13, rain: "85% rain" },
    { time: "1 PM", icon: "1713c.svg", temp: 20, rain: "5% rain" },
    { time: "4 PM", icon: "1713c.svg", temp: 19, rain: "5% rain" },
  ];
  const temperature = (value: number) =>
    unit === "C" ? `${value + offset}°` : `${Math.round(((value + offset) * 9) / 5 + 32)}°`;
  return (
    <section className={`weather-summary ${detailed ? "detailed" : ""}`}>
      <div className="forecast-line">
        <Icon src="0fe59.svg" />
        Rain this morning. Sun after noon.
      </div>
      {detailed && (
        <div className="hourly">
          {hours.map((hour) => (
            <div key={hour.time}>
              <span>{hour.time}</span>
              <Icon src={hour.icon} size={24} />
              <strong>{temperature(hour.temp)}</strong>
              <span>{hour.rain}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Today({
  go,
  accepted,
  activities,
  location,
  unit,
  weatherOffset,
  rainThreshold,
  suggestionCount,
}: {
  go: (screen: Screen) => void;
  accepted: boolean;
  activities: Activity[];
  location: string;
  unit: Unit;
  weatherOffset: number;
  rainThreshold: number;
  suggestionCount: number;
}) {
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
          <p>TUESDAY, OCTOBER 14</p>
          <div>
            <h1>Today</h1>
            <span>{location}</span>
          </div>
        </section>
        <WeatherSummary detailed unit={unit} offset={weatherOffset} />
        <section className="agenda">
          <div className="section-heading">
            <h2>Your current plan</h2>
            <span>Saved</span>
          </div>
          {activities.length === 0 && (
            <div className="empty-agenda">
              <strong>No activities planned</strong>
              <span>Add something to your day from the Plan tab.</span>
            </div>
          )}
          {activities.map((activity) => {
            const rainRisk = activity.type === "Outdoors" && rainThreshold <= 85 && !accepted;
            const note = rainRisk
              ? "Outdoors · Rain may affect this plan"
              : activity.type === "Outdoors"
                ? "Outdoors · Fits your weather preferences"
                : "Indoors · A flexible block";
            return (
              <button className="agenda-item" key={activity.id} onClick={() => go("plan")}>
                <span className="activity-symbol">
                  <Icon src={activity.icon} />
                </span>
                <span className="agenda-copy">
                  <strong>{activity.name}</strong>
                  <span>
                    {activity.time} · {activity.duration}
                  </span>
                  <small className={note.includes("Rain") ? "warning" : ""}>{note}</small>
                </span>
                <Icon src="aa1f8.svg" size={14} />
              </button>
            );
          })}
        </section>
        {!accepted && suggestionCount > 0 && (
          <section className="ai-invite">
            <div>
              <Icon src="2c00e.svg" size={17} />
              <strong>A better fit for the forecast</strong>
            </div>
            <p>
              Move flexible indoor plans earlier and save outdoor activities for the drier
              afternoon.
            </p>
            <PrimaryButton icon="8197c.svg" onClick={() => go("review")}>
              Review {suggestionCount} suggested {suggestionCount === 1 ? "change" : "changes"}
            </PrimaryButton>
          </section>
        )}
      </main>
      <BottomNav screen="today" go={go} />
    </>
  );
}

const dailyForecast = [
  {
    day: "Today",
    weather: "Morning rain, sunny afternoon",
    high: 20,
    low: 12,
    rain: "85%",
    icon: "12c99.svg",
  },
  { day: "Wednesday", weather: "Mostly sunny", high: 22, low: 13, rain: "10%", icon: "1713c.svg" },
  {
    day: "Thursday",
    weather: "Cloudy with late showers",
    high: 18,
    low: 11,
    rain: "45%",
    icon: "0fe59.svg",
  },
  { day: "Friday", weather: "Bright and mild", high: 21, low: 12, rain: "5%", icon: "1713c.svg" },
  { day: "Saturday", weather: "Light rain", high: 16, low: 10, rain: "70%", icon: "12c99.svg" },
];

function Weather({
  go,
  location,
  setLocation,
  unit,
  setUnit,
  weatherOffset,
  rainThreshold,
  comfortableRange,
  forecastAlerts,
}: {
  go: (screen: Screen) => void;
  location: string;
  setLocation: (location: string) => void;
  unit: Unit;
  setUnit: (unit: Unit) => void;
  weatherOffset: number;
  rainThreshold: number;
  comfortableRange: string;
  forecastAlerts: boolean;
}) {
  const temperature = (value: number) =>
    unit === "C"
      ? `${value + weatherOffset}°`
      : `${Math.round(((value + weatherOffset) * 9) / 5 + 32)}°`;
  return (
    <>
      <main className="page weather-page">
        <header className="weather-header">
          <div>
            <p>TUESDAY, OCTOBER 14</p>
            <h1>{location.split(",")[0]} weather</h1>
            <select
              className="weather-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              aria-label="Forecast location"
            >
              <option>Portland, OR</option>
              <option>Seattle, WA</option>
              <option>San Francisco, CA</option>
              <option>New York, NY</option>
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
        <section className="current-weather">
          <div className="current-condition">
            <Icon src="1713c.svg" size={42} />
            <div>
              <strong>{temperature(20)}</strong>
              <span>Feels like {temperature(19)}</span>
            </div>
          </div>
          <div className="current-copy">
            <h2>Rain clears by noon.</h2>
            <p>
              A bright, dry afternoon is ahead. Your outdoor plans fit best after 1 PM. Your
              preferred range is {formatRange(comfortableRange, unit)}.
            </p>
          </div>
        </section>
        <section className="weather-hours">
          <div className="section-heading">
            <h2>Today by the hour</h2>
            <span>{location}</span>
          </div>
          <WeatherSummary detailed unit={unit} offset={weatherOffset} />
        </section>
        <section className="forecast-list">
          <h2>5-day forecast</h2>
          {dailyForecast.map((forecast) => (
            <article key={forecast.day}>
              <Icon src={forecast.icon} size={26} />
              <div>
                <strong>{forecast.day}</strong>
                <span>{forecast.weather}</span>
              </div>
              <small>{forecast.rain} rain</small>
              <p>
                <strong>{temperature(forecast.high)}</strong> / {temperature(forecast.low)}
              </p>
            </article>
          ))}
        </section>
        <section className="weather-plan-note">
          <Icon src="2c00e.svg" size={18} />
          <div>
            <strong>Best outdoor window · Alerts {forecastAlerts ? "on" : "off"}</strong>
            <p>1:00–6:00 PM · Rain stays below your {rainThreshold}% limit</p>
          </div>
          <button onClick={() => go("plan")}>View plan</button>
        </section>
      </main>
      <BottomNav screen="weather" go={go} />
    </>
  );
}

function ActivityCard({
  activity,
  index,
  setActivities,
}: {
  activity: Activity;
  index: number;
  setActivities: React.Dispatch<React.SetStateAction<Activity[]>>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const update = (patch: Partial<Activity>) =>
    setActivities((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const remove = () => setActivities((items) => items.filter((_, i) => i !== index));
  const beginEdit = () => {
    setEditing(true);
    setMenuOpen(false);
  };
  return (
    <article className={`activity-card ${editing ? "editing" : ""}`}>
      <div className="activity-title">
        <Icon src={activity.icon} size={18} />
        <input
          value={activity.name}
          onChange={(e) => update({ name: e.target.value })}
          aria-label="Activity name"
          readOnly={!editing}
        />
        <div className="activity-menu-wrap">
          <button
            className="activity-menu-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={`Options for ${activity.name}`}
            aria-expanded={menuOpen}
          >
            <Icon src="8d313.svg" size={18} />
          </button>
          {menuOpen && (
            <div className="activity-menu">
              <button onClick={beginEdit}>Edit activity</button>
              <button className="delete-action" onClick={remove}>
                Delete activity
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="time-grid">
        <label>
          PREFERRED TIME
          <input
            value={activity.time}
            onChange={(e) => update({ time: e.target.value })}
            readOnly={!editing}
          />
        </label>
        <label>
          DURATION
          <input
            value={activity.duration}
            onChange={(e) => update({ duration: e.target.value })}
            readOnly={!editing}
          />
        </label>
      </div>
      <div className="activity-settings">
        <button
          type="button"
          className="activity-type"
          disabled={!editing}
          onClick={() => update({ type: activity.type === "Outdoors" ? "Indoors" : "Outdoors" })}
        >
          {activity.type}
        </button>
        {editing ? (
          <button className="done-editing" onClick={() => setEditing(false)}>
            Done
          </button>
        ) : (
          <div>
            Flexible time{" "}
            <Toggle
              checked={activity.flexible}
              onChange={(value) => update({ flexible: value })}
              label={`Flexible time for ${activity.name}`}
            />
          </div>
        )}
      </div>
    </article>
  );
}

function Plan({
  go,
  activities,
  setActivities,
  flexibleDefault,
  unit,
  weatherOffset,
}: {
  go: (screen: Screen) => void;
  activities: Activity[];
  setActivities: React.Dispatch<React.SetStateAction<Activity[]>>;
  flexibleDefault: boolean;
  unit: Unit;
  weatherOffset: number;
}) {
  const addActivity = () =>
    setActivities((items) => [
      ...items,
      {
        id: `activity-${Date.now()}`,
        name: "New activity",
        time: "5:30–6:00 PM",
        duration: "30 minutes",
        type: "Indoors",
        icon: "bbcd9.svg",
        flexible: flexibleDefault,
      },
    ]);
  return (
    <>
      <main className="page plan-page">
        <TopContext
          title="Tue, Oct 14"
          onBack={() => go("today")}
          action={
            <button className="text-button" onClick={() => go("today")}>
              Save draft
            </button>
          }
        />
        <section className="page-intro">
          <h1>What’s in your day?</h1>
          <p>Start with your plan. Find a better time for anything that’s flexible.</p>
        </section>
        <WeatherSummary unit={unit} offset={weatherOffset} />
        <section className="activity-list">
          {activities.map((activity, index) => (
            <ActivityCard
              key={activity.id}
              activity={activity}
              index={index}
              setActivities={setActivities}
            />
          ))}
        </section>
        <button className="add-activity" onClick={addActivity}>
          <span>＋</span>Add another activity
        </button>
        <div className="schedule-action">
          <PrimaryButton icon="2f5d2.svg" onClick={() => go("review")}>
            Find my best schedule
          </PrimaryButton>
          <small>Durations stay the same. You approve every change.</small>
        </div>
      </main>
      <BottomNav screen="plan" go={go} />
    </>
  );
}

function Review({
  go,
  changes,
  accept,
  location,
}: {
  go: (screen: Screen) => void;
  changes: SuggestedChange[];
  accept: () => void;
  location: string;
}) {
  const totalMinutes = changes.reduce(
    (total, change) => total + durationInMinutes(change.duration),
    0,
  );
  const totalLabel =
    totalMinutes % 60 === 0
      ? `${totalMinutes / 60} hours`
      : `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  return (
    <>
      <main className="page review-page">
        <TopContext
          title={`Tue, Oct 14 · ${location}`}
          onBack={() => go("plan")}
          action={<span />}
        />
        <section className="review-intro">
          <span>AI suggestion · Not applied</span>
          <h1>Let the weather lead.</h1>
          <p>Keep the rainy morning indoors and get outside in the sunny afternoon.</p>
        </section>
        <section className="changes">
          {changes.map((change) => (
            <article className="change-card" key={change.id}>
              <div className="change-heading">
                <Icon src={change.icon} size={18} />
                <strong>{change.name}</strong>
                <span>{change.duration}</span>
              </div>
              <div className="before">
                <span>Before</span>
                <s>{change.before}</s>
              </div>
              <div className="after">
                <span>After</span>
                <strong>{change.after}</strong>
              </div>
              <p>{change.note}</p>
            </article>
          ))}
        </section>
        {changes.length > 0 ? (
          <div className="validation">
            <Icon src="8cc39.svg" size={16} />
            No overlaps · All {totalLabel} preserved
          </div>
        ) : (
          <div className="empty-agenda">
            <strong>Your plan is already up to date</strong>
            <span>Mark an activity as flexible to receive a new suggestion.</span>
          </div>
        )}
        <section className="approval">
          {changes.length > 0 && (
            <PrimaryButton icon="418aa.svg" onClick={accept}>
              Accept {changes.length === 1 ? "change" : `all ${changes.length} changes`}
            </PrimaryButton>
          )}
          <div>
            <button onClick={() => go("plan")}>Adjust times</button>
            <button onClick={() => go("today")}>Keep original plan</button>
          </div>
          <small>Your saved plan won’t change until you accept.</small>
        </section>
      </main>
      <BottomNav screen="review" go={go} />
    </>
  );
}

function Setting({
  title,
  subtitle,
  value,
  children,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="setting">
      <div>
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {children || (
        <button onClick={() => window.alert(`${title} can be adjusted here.`)}>
          {value} <span>›</span>
        </button>
      )}
    </div>
  );
}

function You({
  go,
  location,
  setLocation,
  unit,
  setUnit,
  rainThreshold,
  setRainThreshold,
  comfortableRange,
  setComfortableRange,
  forecastAlerts,
  setForecastAlerts,
  flexibleDefault,
  setFlexibleDefault,
  gapMinutes,
  setGapMinutes,
  planningHours,
  setPlanningHours,
}: {
  go: (screen: Screen) => void;
  location: string;
  setLocation: (location: string) => void;
  unit: Unit;
  setUnit: (unit: Unit) => void;
  rainThreshold: number;
  setRainThreshold: (threshold: number) => void;
  comfortableRange: string;
  setComfortableRange: (range: string) => void;
  forecastAlerts: boolean;
  setForecastAlerts: (alerts: boolean) => void;
  flexibleDefault: boolean;
  setFlexibleDefault: (flexible: boolean) => void;
  gapMinutes: number;
  setGapMinutes: (minutes: number) => void;
  planningHours: string;
  setPlanningHours: (hours: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <main className="page you-page">
        <TopContext title="Your Fieldday" onBack={() => go("today")} action={<span />} />
        <h1>Account &amp; preferences</h1>
        <section className="identity">
          <span>JL</span>
          <div>
            <strong>Jamie Lee</strong>
            <small>jamie.lee@email.com</small>
          </div>
          <button>Edit</button>
        </section>
        <section className="settings-section">
          <h2>Home base</h2>
          <Setting title="Location" subtitle="Used for your daily forecast">
            <select
              className="setting-select"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              aria-label="Home location"
            >
              <option>Portland, OR</option>
              <option>Seattle, WA</option>
              <option>San Francisco, CA</option>
              <option>New York, NY</option>
            </select>
          </Setting>
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
          <Setting title="Avoid outdoor rain above">
            <select
              className="setting-select"
              value={rainThreshold}
              onChange={(event) => setRainThreshold(Number(event.target.value))}
              aria-label="Outdoor rain threshold"
            >
              <option value={20}>20% chance</option>
              <option value={40}>40% chance</option>
              <option value={60}>60% chance</option>
              <option value={90}>90% chance</option>
            </select>
          </Setting>
          <Setting title="Comfortable temperature">
            <select
              className="setting-select"
              value={comfortableRange}
              onChange={(event) => setComfortableRange(event.target.value)}
              aria-label="Comfortable temperature range"
            >
              <option value="10–20°C">{formatRange("10–20°C", unit)}</option>
              <option value="15–24°C">{formatRange("15–24°C", unit)}</option>
              <option value="18–27°C">{formatRange("18–27°C", unit)}</option>
              <option value="21–30°C">{formatRange("21–30°C", unit)}</option>
            </select>
          </Setting>
          <Setting title="Forecast alerts" subtitle="When weather affects your plan">
            <Toggle checked={forecastAlerts} onChange={setForecastAlerts} label="Forecast alerts" />
          </Setting>
        </section>
        <section className="settings-section">
          <h2>A little room to move</h2>
          <Setting
            title="Flexible by default"
            subtitle="New activities can be suggested at other times"
          >
            <Toggle
              checked={flexibleDefault}
              onChange={setFlexibleDefault}
              label="Flexible by default"
            />
          </Setting>
          <Setting title="Time between activities">
            <select
              className="setting-select"
              value={gapMinutes}
              onChange={(event) => setGapMinutes(Number(event.target.value))}
              aria-label="Time between activities"
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={45}>45 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </Setting>
          <Setting title="Planning hours">
            <select
              className="setting-select"
              value={planningHours}
              onChange={(event) => setPlanningHours(event.target.value)}
              aria-label="Planning hours"
            >
              <option>7 AM–7 PM</option>
              <option>8 AM–6 PM</option>
              <option>9 AM–5 PM</option>
            </select>
          </Setting>
        </section>
        <div className="save-preferences">
          <PrimaryButton onClick={() => setSaved(true)}>
            {saved ? "Preferences saved" : "Save preferences"}
          </PrimaryButton>
          <small>Fieldday always asks before changing your schedule.</small>
        </div>
        <div className="account-actions">
          <button>Connected calendars</button>
          <button onClick={() => go("signin")}>Sign out</button>
        </div>
      </main>
      <BottomNav screen="you" go={go} />
    </>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("signin");
  const [activities, setActivities] = useState(initialActivities);
  const [accepted, setAccepted] = useState(false);
  const [location, setLocation] = useState("Portland, OR");
  const [unit, setUnit] = useState<Unit>("C");
  const [rainThreshold, setRainThreshold] = useState(40);
  const [comfortableRange, setComfortableRange] = useState("15–24°C");
  const [forecastAlerts, setForecastAlerts] = useState(true);
  const [flexibleDefault, setFlexibleDefault] = useState(true);
  const [gapMinutes, setGapMinutes] = useState(30);
  const [planningHours, setPlanningHours] = useState("8 AM–6 PM");
  const weatherOffsets: Record<string, number> = {
    "Portland, OR": 0,
    "Seattle, WA": -2,
    "San Francisco, CA": 3,
    "New York, NY": 1,
  };
  const weatherOffset = weatherOffsets[location] ?? 0;
  const changes = suggestedSchedule(activities, gapMinutes, planningHours);
  const updateActivities: React.Dispatch<React.SetStateAction<Activity[]>> = (next) => {
    setAccepted(false);
    setActivities(next);
  };
  const go = (next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const accept = () => {
    const times = new Map(changes.map((change) => [change.id, change.after]));
    setActivities((items) =>
      items.map((activity) =>
        times.has(activity.id) ? { ...activity, time: times.get(activity.id)! } : activity,
      ),
    );
    setAccepted(true);
    go("today");
  };
  return (
    <div className="app-shell">
      {screen === "signin" && <SignIn go={go} />}
      {screen === "signup" && <SignUp go={go} />}
      {screen === "today" && (
        <Today
          go={go}
          accepted={accepted}
          activities={activities}
          location={location}
          unit={unit}
          weatherOffset={weatherOffset}
          rainThreshold={rainThreshold}
          suggestionCount={changes.length}
        />
      )}
      {screen === "plan" && (
        <Plan
          go={go}
          activities={activities}
          setActivities={updateActivities}
          flexibleDefault={flexibleDefault}
          unit={unit}
          weatherOffset={weatherOffset}
        />
      )}
      {screen === "review" && (
        <Review go={go} changes={changes} accept={accept} location={location} />
      )}
      {screen === "weather" && (
        <Weather
          go={go}
          location={location}
          setLocation={setLocation}
          unit={unit}
          setUnit={setUnit}
          weatherOffset={weatherOffset}
          rainThreshold={rainThreshold}
          comfortableRange={comfortableRange}
          forecastAlerts={forecastAlerts}
        />
      )}
      {screen === "you" && (
        <You
          go={go}
          location={location}
          setLocation={setLocation}
          unit={unit}
          setUnit={setUnit}
          rainThreshold={rainThreshold}
          setRainThreshold={setRainThreshold}
          comfortableRange={comfortableRange}
          setComfortableRange={setComfortableRange}
          forecastAlerts={forecastAlerts}
          setForecastAlerts={setForecastAlerts}
          flexibleDefault={flexibleDefault}
          setFlexibleDefault={setFlexibleDefault}
          gapMinutes={gapMinutes}
          setGapMinutes={(minutes) => {
            setGapMinutes(minutes);
            setAccepted(false);
          }}
          planningHours={planningHours}
          setPlanningHours={(hours) => {
            setPlanningHours(hours);
            setAccepted(false);
          }}
        />
      )}
    </div>
  );
}
