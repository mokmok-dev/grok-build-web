export interface CorrelationEntry<S> {
  readonly method: string;
  readonly token: S;
}

export interface Correlation<S> {
  readonly nextId: number;
  readonly entries: ReadonlyMap<number, CorrelationEntry<S>>;
}

export const emptyCorrelation = <S>(): Correlation<S> => ({ nextId: 1, entries: new Map() });

export const allocate = <S>(
  state: Correlation<S>,
  method: string,
  token: S,
): readonly [number, Correlation<S>] => {
  const id = state.nextId;
  const entries = new Map(state.entries);
  entries.set(id, { method, token });
  return [id, { nextId: id + 1, entries }];
};

export const take = <S>(
  state: Correlation<S>,
  id: number,
): readonly [CorrelationEntry<S> | undefined, Correlation<S>] => {
  const entry = state.entries.get(id);
  if (entry === undefined) return [undefined, state];
  const entries = new Map(state.entries);
  entries.delete(id);
  return [entry, { nextId: state.nextId, entries }];
};

export const takeAll = <S>(
  state: Correlation<S>,
): readonly [readonly CorrelationEntry<S>[], Correlation<S>] => [
  [...state.entries.values()],
  { nextId: state.nextId, entries: new Map() },
];
