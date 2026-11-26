/** @jsxImportSource react */
// Paseo's client/decision-editing.tsx unchanged: a row with a focused input or a draft keeps its place.
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { keepEditingPositions, type EditingPositions } from "../paseo/client/decision-edit-order";

export { keepEditingPositions };

type ReportEditing = (rowKey: string, position: number, active: boolean) => void;
const Editing = createContext<(() => () => void) | null>(null);

export function useDecisionEditing(rankedKeys: readonly string[]) {
  const [positions, setPositions] = useState<EditingPositions>(() => new Map());
  const ordered = useRef(rankedKeys);
  useLayoutEffect(() => {
    ordered.current = keepEditingPositions(rankedKeys, positions);
  }, [rankedKeys, positions]);
  const onEditing = useCallback<ReportEditing>((rowKey, position, active) => {
    const order = ordered.current;
    if (active && order[position] !== rowKey) position = order.indexOf(rowKey);
    setPositions(previous => {
      if (previous.has(rowKey) === active || (active && position < 0)) return previous;
      const next = new Map(previous);
      if (active) next.set(rowKey, order.slice(0, position + 1));
      else next.delete(rowKey);
      return next;
    });
  }, []);
  return { positions, onEditing };
}

export function DecisionEditingRow({rowKey, position, onEditing, children}: {
  rowKey: string; position: number; onEditing: ReportEditing; children: ReactNode;
}) {
  const active = useRef(0);
  const index = useRef(position);
  useLayoutEffect(() => { index.current = position; }, [position]);
  // A ledger answer, its embedded PR, and the clarification thread can all have drafts.
  const register = useCallback(() => {
    if (++active.current === 1) onEditing(rowKey, index.current, true);
    return () => {
      if (--active.current === 0) onEditing(rowKey, index.current, false);
    };
  }, [onEditing, rowKey]);
  return <Editing.Provider value={register}>{children}</Editing.Provider>;
}

export function useDecisionInteraction(hasDraft: boolean) {
  const register = useContext(Editing);
  const [focused, setFocused] = useState(false);
  const active = focused || hasDraft;
  useLayoutEffect(() => { if (active) return register?.(); }, [active, register]);
  return { onFocus: () => setFocused(true), onBlur: () => setFocused(false) };
}
