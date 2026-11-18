export interface LinkConfig {
  appMtuBytes: number;
  windowSizePkts: number;
  initialRtoMs: number;
  minRtoMs: number;
  maxRtoMs: number;
  ackDelayMs: number;
  keepaliveMs: number;
  fecXorGroup: number;
}

export const TERRESTRIAL_HIGH_BER_PROFILE: LinkConfig = Object.freeze({
  appMtuBytes: 220,
  windowSizePkts: 32,
  initialRtoMs: 60,
  minRtoMs: 30,
  maxRtoMs: 1000,
  ackDelayMs: 10,
  keepaliveMs: 200,
  fecXorGroup: 4,
});

export const STARLINK_PROFILE: LinkConfig = Object.freeze({
  appMtuBytes: 900,
  windowSizePkts: 64,
  initialRtoMs: 180,
  minRtoMs: 100,
  maxRtoMs: 3000,
  ackDelayMs: 25,
  keepaliveMs: 500,
  fecXorGroup: 0,
});

export enum DeliveryMode {
  RELIABLE_ORDERED = 'RELIABLE_ORDERED',
  UNRELIABLE_UNORDERED = 'UNRELIABLE_UNORDERED',
}

export interface ChannelConfig {
  id: number;
  name: string;
  mode: DeliveryMode;
  priority: number;
  windowSize: number;
}

export const DEFAULT_CHANNELS: ReadonlyArray<ChannelConfig> = Object.freeze([
  Object.freeze({
    id: 0,
    name: 'c2',
    mode: DeliveryMode.RELIABLE_ORDERED,
    priority: 0,
    windowSize: 16,
  }),
  Object.freeze({
    id: 1,
    name: 'telemetry',
    mode: DeliveryMode.UNRELIABLE_UNORDERED,
    priority: 1,
    windowSize: 0,
  }),
  Object.freeze({
    id: 2,
    name: 'bulk_xfer',
    mode: DeliveryMode.RELIABLE_ORDERED,
    priority: 2,
    windowSize: 64,
  }),
]);
