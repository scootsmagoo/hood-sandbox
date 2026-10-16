/**
 * The entity registry: stable numeric IDs and the state every entity carries. IDs start at 1, are
 * never reused within a session and fit a u32, so they can go over the wire as they are.
 */

export const EntityKind = {
  Ped: 1,
  Vehicle: 2,
  /** A police helicopter: a kinematic flyer (see `HeliFlag`). */
  Helicopter: 3,
  /** A spike strip lying across a lane. */
  SpikeStrip: 4,
  /** A metro train (src/sim/transit): its cars follow its route; the record carries where it is along it (see `TrainFlag`). */
  Train: 5,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export type EntityId = number;

/** Who may change an entity's state. Single player is always `local`; a server will hand out `remote`. */
export const Authority = {
  /** This simulation owns the entity. */
  Local: 0,
  /** Another peer owns it; this simulation only mirrors it. */
  Remote: 1,
} as const;
export type Authority = (typeof Authority)[keyof typeof Authority];

export interface EntityBase {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** Player slot that controls it, or 0 for none. */
  owner: number;
  authority: Authority;
  health: number;
}

export class EntityRegistry<E extends EntityBase = EntityBase> {
  private nextId = 1;
  private readonly byId = new Map<EntityId, E>();

  /** Reserves an ID. Pass the result to the entity's constructor, then `add` it. */
  allocateId(): EntityId {
    return this.nextId++;
  }

  add(entity: E): E {
    if (this.byId.has(entity.id)) throw new Error(`entity ${entity.id} already registered`);
    this.byId.set(entity.id, entity);
    return entity;
  }

  get(id: EntityId): E | undefined {
    return this.byId.get(id);
  }

  remove(id: EntityId): boolean {
    return this.byId.delete(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Entities in creation order. */
  values(): IterableIterator<E> {
    return this.byId.values();
  }

  ofKind<K extends E['kind']>(kind: K): E[] {
    const out: E[] = [];
    for (const e of this.byId.values()) if (e.kind === kind) out.push(e);
    return out;
  }
}
