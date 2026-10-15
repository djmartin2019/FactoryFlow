import type { OperationalStatus } from "./FactoryObject";

export const STATUS_COLORS: Record<OperationalStatus, number> = {
  idle: 0x64748b,
  running: 0x22c55e,
  blocked: 0xf59e0b,
  down: 0xef4444,
};
