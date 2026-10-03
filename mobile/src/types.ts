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

export type DriverState = {
  user: User;
  shift: { id: number; vehicle_id: number; started_at: number } | null;
  vehicle: Vehicle | null;
  vehicles: Vehicle[];
  route: Route | null;
  finished: Route | null;
  config: { geofenceM: number };
};

export type GpsPoint = { lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; t: number };

/** Compact route summary returned by POST /api/driver/positions. */
export type RouteSummary = { id: number; code: string; name: string; status: string; stops: number; done: number } | null;
