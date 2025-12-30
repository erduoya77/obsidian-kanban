import { createContext } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { StateManager } from 'src/StateManager';
import { IntersectionObserverHandler } from 'src/dnd/managers/ScrollManager';

import { BoardModifiers } from '../helpers/boardModifiers';
import { Item, Lane, LaneSort } from './types';

export interface KanbanContextProps {
  filePath?: string;
  stateManager: StateManager;
  boardModifiers: BoardModifiers;
  view: KanbanView;
}

export const KanbanContext = createContext<KanbanContextProps>(null);

export interface SearchContextProps {
  query: string;
  items: Set<Item>;
  lanes: Set<Lane>;
  search: (query: string, immediate?: boolean) => void;
  // 状态过滤：'all' | 'pending' | 'in-progress' | 'done'
  statusFilter: 'all' | 'pending' | 'in-progress' | 'done';
  setStatusFilter: (filter: 'all' | 'pending' | 'in-progress' | 'done') => void;
  // 项目过滤：项目标签数组，空数组表示显示所有项目
  projectFilters: Set<string>;
  setProjectFilters: (projects: Set<string>) => void;
  toggleProjectFilter: (project: string) => void;
}

export const SearchContext = createContext<SearchContextProps | null>(null);
export const SortContext = createContext<LaneSort | string | null>(null);
export const IntersectionObserverContext = createContext<{
  registerHandler: (el: HTMLElement, handler: IntersectionObserverHandler) => void;
  unregisterHandler: (el: HTMLElement) => void;
} | null>(null);
