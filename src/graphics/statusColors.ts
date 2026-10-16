import type { OperationalStatus } from "./FactoryObject";

export const STATUS_COLORS: Record<OperationalStatus, number> = {
  idle: 0x5b7a9d,
  running: 0x2ee6a6,
  blocked: 0xffb454,
  down: 0xff5c7a,
};
