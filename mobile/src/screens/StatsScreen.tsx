import { Text, View } from "react-native";
import type { DriverProfile } from "../types";
import { Card } from "../ui";
import { mono, useTheme, type Palette } from "../theme";
import { hm } from "../format";

const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const dayName = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const dateOf = (t: number | null) => (t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) : "—");
const condition = (c: Palette) => ({
  good: ["Good", c.ok], service_soon: ["Service soon", c.warn], attention: ["Needs attention", c.crit], out_of_service: ["Out of service", c.idle],
}) as const;

function Tile({ label, value, avg, unit = "", digits = 0 }: { label: string; value: number | null; avg?: number | null; unit?: string; digits?: number }) {
  const c = useTheme();
  let sub = <Text style={{ color: c.muted, fontSize: 12 }}>first week</Text>;
  if (avg != null && value != null) {
    const diff = value - avg;
    sub = Math.abs(diff) < 0.05
      ? <Text style={{ color: c.muted, fontSize: 12 }}>same as your average</Text>
      : <Text style={{ fontSize: 12 }}><Text style={{ color: diff >= 0 ? c.ok : c.warn }}>{diff > 0 ? "▲" : "▼"} {fmt(Math.abs(diff), digits)}{unit}</Text><Text style={{ color: c.muted }}> vs avg {fmt(avg, digits)}</Text></Text>;
  }
  return (
    <View style={{ flexBasis: "47%", flexGrow: 1, backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, borderRadius: 12, padding: 12, gap: 2 }}>
      <Text style={{ color: c.muted, fontSize: 12, letterSpacing: 0.6 }}>{label.toUpperCase()}</Text>
      <Text style={[{ color: c.fg, fontSize: 24, fontWeight: "700" }, mono]}>{fmt(value, digits)}<Text style={{ fontSize: 13, color: c.muted }}>{unit}</Text></Text>
      {sub}
    </View>
  );
}

function Bars({ daily }: { daily: DriverProfile["daily"] }) {
  const c = useTheme();
  const top = Math.max(4, Math.ceil(Math.max(...daily.map((d) => d.delivered)) / 4) * 4);
  return (
    <View accessibilityLabel="Deliveries per day, last 14 days">
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: 100, gap: 4 }}>
        {daily.map((d) => {
          const late = Math.min(d.late, d.delivered), ok = d.delivered - late;
          return (
            <View key={d.date} style={{ flex: 1, justifyContent: "flex-end", height: "100%" }}>
              {late > 0 ? <View style={{ height: `${(late / top) * 100}%`, backgroundColor: c.warn, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} /> : null}
              {ok > 0 ? <View style={{ height: `${(ok / top) * 100}%`, backgroundColor: c.info, borderTopLeftRadius: late ? 0 : 2, borderTopRightRadius: late ? 0 : 2 }} /> : null}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
        {daily.map((d, i) => <Text key={d.date} style={[{ flex: 1, textAlign: "center", fontSize: 10, color: c.muted }, mono]}>{i % 2 ? new Date(`${d.date}T12:00:00`).getDate() : ""}</Text>)}
      </View>
      <View style={{ flexDirection: "row", gap: 14, marginTop: 6 }}>
        <Text style={{ color: c.muted, fontSize: 13 }}><Text style={{ color: c.info }}>■</Text> On time</Text>
        <Text style={{ color: c.muted, fontSize: 13 }}><Text style={{ color: c.warn }}>■</Text> Late</Text>
      </View>
    </View>
  );
}

const H = ({ children }: { children: React.ReactNode }) => {
  const c = useTheme();
  return <Text style={{ color: c.muted, fontWeight: "700", letterSpacing: 1, fontSize: 13, marginTop: 6 }}>{children}</Text>;
};

export function StatsScreen({ profile }: { profile: DriverProfile | null }) {
  const c = useTheme();
  if (!profile) return <Card><Text style={{ color: c.muted }}>Loading your stats…</Text></Card>;
  const { week: w, average: a, rank, vehicle: v } = profile;
  return (
    <View style={{ gap: 12 }}>
      <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.fg, fontWeight: "700", fontSize: 16 }}>Week of {dayName(profile.weekStart)}</Text>
          <Text style={{ color: c.muted, fontSize: 14 }}>
            {rank ? (rank.position === 1 ? "You're the top driver this week. Keep it up!" : `${rank.behindBy} deliver${rank.behindBy === 1 ? "y" : "ies"} behind #${rank.position - 1}.`) : "Start a shift to get ranked this week."}
          </Text>
        </View>
        {rank ? (
          <View style={{ alignItems: "center" }}>
            <Text style={{ color: c.accent, fontSize: 40, fontWeight: "800" }}>#{rank.position}</Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>of {rank.of} drivers</Text>
          </View>
        ) : null}
      </Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Tile label="Trips" value={w.trips} avg={a?.trips} />
        <Tile label="Deliveries" value={w.delivered} avg={a?.delivered} />
        <Tile label="On time" value={w.onTimePct} avg={a?.onTimePct} unit="%" />
        <Tile label="Distance" value={w.km} avg={a?.km} unit=" km" />
        <Tile label="Hours on shift" value={w.shiftHours} avg={a?.shiftHours} unit=" h" digits={1} />
        <Tile label="Driving" value={w.drivingHours} avg={a?.drivingHours} unit=" h" digits={1} />
      </View>
      {a ? <Text style={{ color: c.muted, fontSize: 13 }}>Averages are from your previous {a.weeks} week{a.weeks > 1 ? "s" : ""}.</Text> : null}

      <H>DELIVERIES, LAST 14 DAYS</H>
      <Card><Bars daily={profile.daily} /></Card>

      <H>YOUR ROUTE</H>
      <Card>
        {profile.current ? (
          <>
            <Text style={{ color: c.fg, fontWeight: "700" }}>{profile.current.code} · {profile.current.name}</Text>
            <Text style={{ color: c.muted }}>{profile.current.delivered}/{profile.current.total} delivered</Text>
            {profile.current.stops.map((s) => (
              <Text key={s.seq} style={{ color: ["completed", "skipped"].includes(s.status) ? c.muted : c.fg }}>
                {s.seq}. {s.name} <Text style={[{ color: c.muted }, mono]}>· due {hm(s.planned_at)}</Text>
              </Text>
            ))}
          </>
        ) : <Text style={{ color: c.muted }}>No route assigned right now.</Text>}
      </Card>

      <H>YOUR VEHICLE</H>
      {v ? (
        <Card style={{ borderLeftWidth: 5, borderLeftColor: condition(c)[v.status][1] }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={[{ color: c.fg, fontWeight: "700", fontSize: 18 }, mono]}>{v.code}</Text>
            <Text style={{ color: condition(c)[v.status][1], fontWeight: "700" }}>{condition(c)[v.status][0]}</Text>
          </View>
          <Text style={{ color: c.muted }}>Odometer <Text style={[{ color: c.fg }, mono]}>{fmt(v.odometer_km)} km</Text></Text>
          <Text style={{ color: c.muted }}>Next service <Text style={[{ color: c.fg }, mono]}>{v.next_service_km <= 0 ? `overdue by ${fmt(-v.next_service_km)} km` : `in ${fmt(v.next_service_km)} km`}</Text></Text>
          <Text style={{ color: c.muted }}>Last check <Text style={{ color: c.fg }}>{v.last_inspection ? `${dateOf(v.last_inspection.created_at)} · ${v.last_inspection.issues.length ? (v.last_inspection.issues_open ? "problems reported" : "problem since fixed") : "all OK"}` : "none yet"}</Text></Text>
          {v.reasons.map((r) => <Text key={r} style={{ color: c.fg }}>• {r}</Text>)}
        </Card>
      ) : <Card><Text style={{ color: c.muted }}>No vehicle assigned yet.</Text></Card>}

      <H>RECENT TRIPS · {fmt(profile.totals.trips)} TOTAL</H>
      <Card style={{ paddingVertical: 6 }}>
        {profile.recentTrips.length ? profile.recentTrips.map((t, i) => (
          <View key={t.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
            <View>
              <Text style={{ color: c.fg, fontWeight: "600" }}>{t.code} · {dateOf(t.completed_at)}</Text>
              <Text style={[{ color: c.muted, fontSize: 13 }, mono]}>{t.delivered}/{t.total} delivered{t.vehicle_code ? ` · ${t.vehicle_code}` : ""}</Text>
            </View>
            <Text style={{ color: t.onTimePct != null && t.onTimePct >= 80 ? c.ok : c.warn, fontWeight: "600" }}>{t.onTimePct == null ? "" : `${t.onTimePct}% on time`}</Text>
          </View>
        )) : <Text style={{ color: c.muted }}>Your finished trips appear here.</Text>}
      </Card>
    </View>
  );
}
