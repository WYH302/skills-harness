import { createContext, useContext } from 'react';
import type { AppState } from '../shared/types';

export type Translate = (zh: string, en: string) => string;
export interface AppContextValue {
  state: AppState;
  t: Translate;
  refresh: () => Promise<void>;
  act: <T = unknown>(method: string, args?: unknown, success?: string) => Promise<T | undefined>;
  confirm: (title: string, detail: string, destructive?: boolean, labels?:{confirm?:string;cancel?:string}) => Promise<boolean>;
  guardNavigation:(guard:()=>Promise<boolean>)=>()=>void;
  pending: Set<string>;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('Application context unavailable');
  return value;
}
export function formatDate(value: string | undefined, language: 'zh'|'en') {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {year: 'numeric', month: 'short', day: 'numeric'}).format(date) : '—';
}
