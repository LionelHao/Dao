declare const dispatchReservationBrand: unique symbol;

export type DispatchReservation = Readonly<{ [dispatchReservationBrand]: true }>;
export type DispatchLatchState = "entered";

export interface DispatchOnceLatch {
  reserve(): DispatchReservation | undefined;
  release(reservation: DispatchReservation): void;
  enter(reservation: DispatchReservation, dispatchId: string): boolean;
  state(dispatchId: string): DispatchLatchState | undefined;
  close(): void;
}

export function createDispatchOnceLatch(options: Readonly<{ capacity: number }>): DispatchOnceLatch {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || options.capacity > 65_536) {
    throw new TypeError("Dispatch once-latch capacity was invalid");
  }
  const reservations = new WeakSet<object>();
  const dispatches = new Map<string, DispatchLatchState>();
  let reserved = 0;
  let closed = false;

  const finishReservation = (reservation: DispatchReservation): boolean => {
    if (typeof reservation !== "object" || reservation === null ||
        !reservations.delete(reservation as object)) return false;
    reserved -= 1;
    return true;
  };

  return Object.freeze({
    reserve(): DispatchReservation | undefined {
      if (closed || dispatches.size + reserved >= options.capacity) return undefined;
      const reservation = Object.freeze({});
      reservations.add(reservation);
      reserved += 1;
      return reservation as DispatchReservation;
    },
    release(reservation: DispatchReservation): void {
      finishReservation(reservation);
    },
    enter(reservation: DispatchReservation, dispatchId: string): boolean {
      if (!finishReservation(reservation) || dispatchId.length === 0 ||
          dispatches.has(dispatchId) || dispatches.size >= options.capacity) return false;
      dispatches.set(dispatchId, "entered");
      return true;
    },
    state(dispatchId: string): DispatchLatchState | undefined {
      return dispatches.get(dispatchId);
    },
    close(): void {
      closed = true;
    },
  });
}
