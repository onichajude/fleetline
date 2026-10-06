export type User = { id: number; name: string; username: string; role: string };

export type Session = { server: string; token: string; user: User };

export type StopStatus = "pending" | "arrived" | "completed" | "skipped";

export type Stop = {
  id: number;
  seq: number;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  dwell_min: number;
  status: StopStatus;
  planned_at: number | null;
  arrived_at: number | null;
  completed_at: number | null;
  note: string | null;
};

export type Route = {
  id: number;
  code: string;
  name: string;
  status: "draft" | "dispatched" | "active" | "completed" | "cancelled";
  depot_name: string | null;
  geometry: { meters?: number } | null;
  stops: Stop[];
};

export type Vehicle = { id: number; code: string; type: string; plate: string | null; mine?: number | boolean };

export type PrivacyNotice = { version: string; title: string; points: string[] };

export type DriverState = {
  user: User;
  /** The driver must accept the current notice before a shift (and location sharing) can start. */
  privacy: { required: boolean; accepted_version: string | null; accepted_at: number | null; notice: PrivacyNotice };
  shift: { id: number; vehicle_id: number; started_at: number } | null;
  vehicle: Vehicle | null;
  vehicles: Vehicle[];
  route: Route | null;
  finished: Route | null;
  config: { geofenceM: number };
  inspection_done: boolean;
  /** [key, label] pairs for the pre-trip check. */
  inspection_items: [string, string][];
};

export type PeriodStats = {
  trips: number; delivered: number; skipped: number; arrived: number; ontime: number;
  onTimePct: number | null; km: number; drivingHours: number; shiftHours: number;
};
export type VehicleCondition = {
  id: number; code: string; type: string; plate: string | null;
  status: "good" | "service_soon" | "attention" | "out_of_service"; reasons: string[];
  odometer_km: number; next_service_km: number; service_interval_km: number; last_service_at: number | null;
  last_inspection: { created_at: number; issues: string[]; issues_open: boolean; notes: string | null } | null;
};
export type TripSummary = {
  id: number; code: string; name: string; status: string; completed_at: number | null; vehicle_code: string | null;
  total: number; delivered: number; onTimePct: number | null;
};
export type DriverProfile = {
  driver: { id: number; name: string; username: string };
  weekStart: string; weekEnd: string;
  week: PeriodStats;
  average: (Omit<PeriodStats, "skipped" | "arrived" | "ontime"> & { weeks: number }) | null;
  rank: { position: number; of: number; behindBy: number } | null;
  daily: { date: string; delivered: number; late: number; km: number }[];
  current: (TripSummary & { stops: { seq: number; status: StopStatus; planned_at: number | null; name: string }[] }) | null;
  recentTrips: TripSummary[];
  totals: { trips: number; delivered: number };
  vehicle: VehicleCondition | null;
};

export type GpsPoint = { lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; t: number };

/** Compact route summary returned by POST /api/driver/positions. */
export type RouteSummary = { id: number; code: string; name: string; status: string; stops: number; done: number } | null;
