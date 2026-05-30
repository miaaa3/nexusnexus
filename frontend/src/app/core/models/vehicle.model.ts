export type VehicleType = 'CAR' | 'BUS' | 'TRUCK' | 'MOTORCYCLE' | 'EMERGENCY';

export interface VehicleUpdate {
  id: string;
  lat: number;
  lon: number;
  speed: number;
  direction: number;
  type: VehicleType;
  /** True while this vehicle is wrecked (frozen as an accident obstacle). */
  wrecked?: boolean;
}

export interface SimulationFrame {
  timestamp: number;
  vehicleCount: number;
  /**
   * Either the full fleet (when {@link keyframe} is true) or only the vehicles
   * whose state changed since the previous tick (delta).
   *
   * The WebSocketService accumulates deltas internally and re-emits frames as
   * full lists to the rest of the app, so consumers can treat this as a
   * full snapshot — these two fields are only present on the wire.
   */
  vehicles: VehicleUpdate[];
  /** True on a full snapshot, false on a delta. Optional for back-compat. */
  keyframe?: boolean;
  /** IDs no longer present (delta frames only). */
  removed?: string[];
}

// Color per vehicle type — used by WebGL renderer
export const VEHICLE_COLORS: Record<VehicleType, [number, number, number]> = {
  CAR:        [0.20, 0.60, 1.00],   // blue
  BUS:        [0.10, 0.85, 0.40],   // green
  TRUCK:      [1.00, 0.65, 0.10],   // orange
  MOTORCYCLE: [0.80, 0.20, 0.90],   // purple
  EMERGENCY:  [1.00, 0.15, 0.15],   // red
};

// Size multiplier per type (normalized)
export const VEHICLE_SIZES: Record<VehicleType, number> = {
  CAR:        1.0,
  BUS:        1.8,
  TRUCK:      1.6,
  MOTORCYCLE: 0.7,
  EMERGENCY:  1.2,
};

// Wrecked vehicles: rendered as a large hot-red hazard blob so accidents
// (and the traffic queue behind them) are obvious at a glance.
export const WRECK_COLOR: [number, number, number] = [1.0, 0.12, 0.05];
export const WRECK_SIZE = 2.4;
