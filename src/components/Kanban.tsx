import animateScrollTo from 'animated-scroll-to';
import classcat from 'classcat';
import update from 'immutability-helper';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { StateManager } from 'src/StateManager';
import { useIsAnythingDragging } from 'src/dnd/components/DragOverlay';
import { ScrollContainer } from 'src/dnd/components/ScrollContainer';
import { SortPlaceholder } from 'src/dnd/components/SortPlaceholder';
import { Sortable } from 'src/dnd/components/Sortable';
import { createHTMLDndHandlers } from 'src/dnd/managers/DragManager';
import { t } from 'src/lang/helpers';

import { DndScope } from '../dnd/components/Scope';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { frontmatterKey } from '../parsers/common';
import { getTaskStatusDone } from '../parsers/helpers/inlineMetadata';
import { Path } from '../dnd/types';
import { FilterToolbar } from './FilterToolbar';
import { Icon } from './Icon/Icon';
import { Lanes } from './Lane/Lane';
import { LaneForm } from './Lane/LaneForm';
import { TableView } from './Table/Table';
import { KanbanContext, SearchContext } from './context';
import { baseClassName, c, useSearchValue } from './helpers';
import { DataTypes, Item, Lane, LaneTemplate } from './types';

const boardScrollTiggers = [DataTypes.Item, DataTypes.Lane];
const boardAccepts = [DataTypes.Lane];

interface KanbanProps {
  stateManager: StateManager;
  view: KanbanView;
}

function getCSSClass(frontmatter: Record<string, any>): string[] {
  const classes = [];
  if (Array.isArray(frontmatter.cssclass)) {
    classes.push(...frontmatter.cssclass);
  } else if (typeof frontmatter.cssclass === 'string') {
    classes.push(frontmatter.cssclass);
  }
  if (Array.isArray(frontmatter.cssclasses)) {
    classes.push(...frontmatter.cssclasses);
  } else if (typeof frontmatter.cssclasses === 'string') {
    classes.push(frontmatter.cssclasses);
  }

  return classes;
}

export const Kanban = ({ view, stateManager }: KanbanProps) => {
  const boardData = stateManager.useState();
  const isAnythingDragging = useIsAnythingDragging();

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'in-progress' | 'done'>('all');
  const [projectFilters, setProjectFilters] = useState<Set<string>>(new Set());

  const [isLaneFormVisible, setIsLaneFormVisible] = useState<boolean>(
    boardData?.children.length === 0
  );

  const filePath = stateManager.file.path;
  const maxArchiveLength = stateManager.useSetting('max-archive-size');
  const dateColors = stateManager.useSetting('date-colors');
  const tagColors = stateManager.useSetting('tag-colors');
  const boardView = view.useViewState(frontmatterKey);

  const closeLaneForm = useCallback(() => {
    if (boardData?.children.length > 0) {
      setIsLaneFormVisible(false);
    }
  }, [boardData?.children.length]);

  useEffect(() => {
    if (boardData?.children.length === 0 && !stateManager.hasError()) {
      setIsLaneFormVisible(true);
    }
  }, [boardData?.children.length, stateManager]);

  const onNewLane = useCallback(() => {
    rootRef.current?.win.setTimeout(() => {
      const board = rootRef.current?.getElementsByClassName(c('board'));

      if (board?.length) {
        animateScrollTo([board[0].scrollWidth, 0], {
          elementToScroll: board[0],
          speed: 300,
          minDuration: 150,
          easing: (x: number) => {
            return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
          },
        });
      }
    });
  }, []);

  useEffect(() => {
    const onSearchHotkey = (data: { commandId: string; data: string }) => {
      if (data.commandId === 'editor:open-search') {
        if (typeof data.data === 'string') {
          setIsSearching(true);
          setSearchQuery(data.data);
          setDebouncedSearchQuery(data.data);
        } else {
          setIsSearching((val) => !val);
        }
      }
    };

    const showLaneForm = () => {
      setIsLaneFormVisible(true);
    };

    view.emitter.on('hotkey', onSearchHotkey);
    view.emitter.on('showLaneForm', showLaneForm);

    return () => {
      view.emitter.off('hotkey', onSearchHotkey);
      view.emitter.off('showLaneForm', showLaneForm);
    };
  }, [view]);

  useEffect(() => {
    if (isSearching) {
      searchRef.current?.focus();
    }
  }, [isSearching]);

  useEffect(() => {
    const win = view.getWindow();
    const trimmed = searchQuery.trim();
    let id: number;

    if (trimmed) {
      id = win.setTimeout(() => {
        setDebouncedSearchQuery(trimmed);
      }, 250);
    } else {
      setDebouncedSearchQuery('');
    }

    return () => {
      win.clearTimeout(id);
    };
  }, [searchQuery, view]);

  useEffect(() => {
    if (maxArchiveLength === undefined || maxArchiveLength === -1) {
      return;
    }

    if (typeof maxArchiveLength === 'number' && boardData?.data.archive.length > maxArchiveLength) {
      stateManager.setState((board) =>
        update(board, {
          data: {
            archive: {
              $set: board.data.archive.slice(maxArchiveLength * -1),
            },
          },
        })
      );
    }
  }, [boardData?.data.archive.length, maxArchiveLength]);

  const html5DragHandlers = createHTMLDndHandlers(stateManager);

  const doneChar = getTaskStatusDone();

  // 当有项目筛选时，重新组织数据为状态列
  const getFilteredBoardData = useMemo(() => {
    if (projectFilters.size === 0) {
      return boardData;
    }

    // 使用Map来高效分组
    const statusGroups = new Map<string, Item[]>([
      ['pending', []],
      ['in-progress', []],
      ['done', []]
    ]);

    // 收集所有选中项目的卡片并分组
    boardData.children.forEach((lane) => {
      if (projectFilters.has(lane.data.title)) {
        lane.children.forEach((item) => {
          const checkChar = item.data.checkChar;
          if (checkChar === ' ') {
            statusGroups.get('pending')!.push(item);
          } else if (checkChar === '/') {
            statusGroups.get('in-progress')!.push(item);
          } else if (checkChar === doneChar) {
            statusGroups.get('done')!.push(item);
          }
        });
      }
    });

    // 创建新的lanes
    const statusLanes: Lane[] = [
      {
        ...LaneTemplate,
        id: 'filtered-pending',
        children: statusGroups.get('pending')!,
        data: {
          title: t('Pending'),
          shouldMarkItemsComplete: false,
        },
      },
      {
        ...LaneTemplate,
        id: 'filtered-in-progress',
        children: statusGroups.get('in-progress')!,
        data: {
          title: t('In Progress'),
          shouldMarkItemsComplete: false,
        },
      },
      {
        ...LaneTemplate,
        id: 'filtered-done',
        children: statusGroups.get('done')!,
        data: {
          title: t('Done'),
          shouldMarkItemsComplete: false,
        },
      },
    ];

    return {
      ...boardData,
      children: statusLanes,
    };
  }, [boardData, projectFilters, doneChar]);

  const boardModifiers = useMemo(() => {
    const baseModifiers = getBoardModifiers(view, stateManager);

    // 如果有项目筛选，创建包装的modifiers来处理路径映射
    if (projectFilters.size > 0) {
      return {
        ...baseModifiers,
        updateItem: (path: Path, item: Item) => {
          // 在项目视图模式下，需要将操作映射回原始的lane
          if (path.length >= 2 && typeof path[0] === 'number') {
            const filteredLaneIndex = path[0] as number;
            const itemIndex = path[1] as number;

            // 根据filtered lane的ID找到对应的状态
            const filteredLane = getFilteredBoardData.children[filteredLaneIndex];
            if (filteredLane && filteredLane.id.startsWith('filtered-')) {
              // 找到原始项目中对应的item，并使用传入的item状态（而不是根据filtered lane推断）
              let found = false;
              boardData.children.forEach((originalLane, laneIdx) => {
                if (projectFilters.has(originalLane.data.title)) {
                  originalLane.children.forEach((originalItem, itemIdx) => {
                    if (originalItem.id === item.id) {
                      // 直接使用传入的item状态，而不是根据filtered lane推断
                      // 这样状态切换才能正常工作
                      baseModifiers.updateItem([laneIdx, itemIdx], item);
                      found = true;
                    }
                  });
                }
              });

              if (found) return;
            }
          }

          // 回退到默认行为
          baseModifiers.updateItem(path, item);
        },

        deleteEntity: (path: Path) => {
          // 在项目视图模式下，删除操作也需要映射回原始lane
          if (path.length >= 2 && typeof path[0] === 'number') {
            const filteredLaneIndex = path[0] as number;
            const itemIndex = path[1] as number;

            const filteredLane = getFilteredBoardData.children[filteredLaneIndex];
            if (filteredLane && filteredLane.id.startsWith('filtered-')) {
              // 找到原始项目中对应的item并删除
              boardData.children.forEach((originalLane, laneIdx) => {
                if (projectFilters.has(originalLane.data.title)) {
                  originalLane.children.forEach((originalItem, itemIdx) => {
                    if (originalItem.id === filteredLane.children[itemIndex]?.id) {
                      baseModifiers.deleteEntity([laneIdx, itemIdx]);
                      return;
                    }
                  });
                }
              });
              return;
            }
          }

          // 回退到默认行为
          baseModifiers.deleteEntity(path);
        },

        appendItems: (path: Path, items: Item[]) => {
          // 在项目视图模式下，插入操作也需要映射回原始lane
          if (path.length >= 1 && typeof path[0] === 'number') {
            const filteredLaneIndex = path[0] as number;

            const filteredLane = getFilteredBoardData.children[filteredLaneIndex];
            if (filteredLane && filteredLane.id.startsWith('filtered-')) {
              // 为新items设置正确的状态
              const statusType = filteredLane.id.replace('filtered-', '');
              const statusChar = statusType === 'pending' ? ' ' : statusType === 'in-progress' ? '/' : doneChar;

              const updatedItems = items.map(item => update(item, {
                data: {
                  checkChar: { $set: statusChar },
                  checked: { $set: statusChar === doneChar }
                }
              }));

              // 获取唯一选中的项目（每次只能选中一个项目）
              const selectedProjects = Array.from(projectFilters);
              if (selectedProjects.length === 1) {
                const selectedProject = selectedProjects[0];

                // 找到对应的原始lane
                for (let i = 0; i < boardData.children.length; i++) {
                  const originalLane = boardData.children[i];
                  if (originalLane.data.title.trim() === selectedProject.trim()) {
                    baseModifiers.appendItems([i, originalLane.children.length], updatedItems);
                    return;
                  }
                }
                // 如果没有找到匹配的lane，不插入以避免错误位置
                return;
              }
            }
          }

          // 回退到默认行为
          baseModifiers.appendItems(path, items);
        },

        prependItems: (path: Path, items: Item[]) => {
          // 在项目视图模式下，插入操作也需要映射回原始lane
          if (path.length >= 1 && typeof path[0] === 'number') {
            const filteredLaneIndex = path[0] as number;

            const filteredLane = getFilteredBoardData.children[filteredLaneIndex];
            if (filteredLane && filteredLane.id.startsWith('filtered-')) {
              // 为新items设置正确的状态
              const statusType = filteredLane.id.replace('filtered-', '');
              const statusChar = statusType === 'pending' ? ' ' : statusType === 'in-progress' ? '/' : doneChar;

              const updatedItems = items.map(item => update(item, {
                data: {
                  checkChar: { $set: statusChar },
                  checked: { $set: statusChar === doneChar }
                }
              }));

              // 获取唯一选中的项目（每次只能选中一个项目）
              const selectedProjects = Array.from(projectFilters);
              if (selectedProjects.length === 1) {
                const selectedProject = selectedProjects[0];

                // 找到对应的原始lane
                for (let i = 0; i < boardData.children.length; i++) {
                  const originalLane = boardData.children[i];
                  if (originalLane.data.title.trim() === selectedProject.trim()) {
                    baseModifiers.prependItems([i, 0], updatedItems);
                    return;
                  }
                }
                // 如果没有找到匹配的lane，不插入以避免错误位置
                return;
              }
            }
          }

          // 回退到默认行为
          baseModifiers.prependItems(path, items);
        },

        insertItems: (path: Path, items: Item[]) => {
          console.log('insertItems called with path:', path, 'projectFilters size:', projectFilters.size);
          // 在项目视图模式下，插入操作也需要映射回原始lane
          if (path.length >= 1 && typeof path[0] === 'number') {
            const filteredLaneIndex = path[0] as number;

            const filteredLane = getFilteredBoardData.children[filteredLaneIndex];
            console.log('filteredLane id:', filteredLane?.id);
            if (filteredLane && filteredLane.id.startsWith('filtered-')) {
              console.log('In project view mode');
              // 为新items设置正确的状态
              const statusType = filteredLane.id.replace('filtered-', '');
              const statusChar = statusType === 'pending' ? ' ' : statusType === 'in-progress' ? '/' : doneChar;

              const updatedItems = items.map(item => update(item, {
                data: {
                  checkChar: { $set: statusChar },
                  checked: { $set: statusChar === doneChar }
                }
              }));

              // 获取唯一选中的项目（每次只能选中一个项目）
              const selectedProjects = Array.from(projectFilters);
              console.log('selectedProjects:', selectedProjects);
              if (selectedProjects.length === 1) {
                const selectedProject = selectedProjects[0];
                console.log('Selected project for insertion:', selectedProject);

                // 找到对应的原始lane
                for (let i = 0; i < boardData.children.length; i++) {
                  const originalLane = boardData.children[i];
                  if (originalLane.data.title.trim() === selectedProject.trim()) {
                    console.log('Inserting to lane:', i, 'title:', originalLane.data.title);
                    baseModifiers.insertItems([i, originalLane.children.length], updatedItems);
                    return;
                  }
                }
                console.log('No matching lane found for project:', selectedProject);
                // 如果没有找到匹配的lane，不插入以避免错误位置
                return;
              } else {
                console.log('selectedProjects length not 1');
              }
            }
          }

          // 回退到默认行为
          console.log('Falling back to default insert');
          baseModifiers.insertItems(path, items);
        }
      };
    }

    return baseModifiers;
  }, [view, stateManager, projectFilters, getFilteredBoardData, boardData, doneChar]);

  const kanbanContext = useMemo(() => {
    return {
      view,
      stateManager,
      boardModifiers,
      filePath,
    };
  }, [view, stateManager, boardModifiers, filePath, dateColors, tagColors]);

  if (boardData === null || boardData === undefined)
    return (
      <div className={c('loading')}>
        <div className="sk-pulse"></div>
      </div>
    );

  if (boardData.data.errors.length > 0) {
    return (
      <div>
        <div>Error:</div>
        {boardData.data.errors.map((e, i) => {
          return (
            <div key={i}>
              <div>{e.description}</div>
              <pre>{e.stack}</pre>
            </div>
          );
        })}
      </div>
    );
  }

  const axis = boardView === 'list' ? 'vertical' : 'horizontal';
  const searchValue = useSearchValue(
    getFilteredBoardData,
    debouncedSearchQuery,
    setSearchQuery,
    setDebouncedSearchQuery,
    setIsSearching,
    statusFilter,
    setStatusFilter,
    projectFilters,
    setProjectFilters
  );

  return (
    <DndScope id={view.id}>
      <KanbanContext.Provider value={kanbanContext}>
        <SearchContext.Provider value={searchValue}>
          <div
            ref={rootRef}
            className={classcat([
              baseClassName,
              {
                'something-is-dragging': isAnythingDragging,
              },
              ...getCSSClass(boardData.data.frontmatter),
            ])}
            {...html5DragHandlers}
          >
            {(isLaneFormVisible || boardData.children.length === 0) && (
              <LaneForm onNewLane={onNewLane} closeLaneForm={closeLaneForm} />
            )}
            {/* 过滤器工具栏 - 始终显示在左上角 */}
            <FilterToolbar
              stateManager={stateManager}
              boardData={getFilteredBoardData}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              projectFilters={projectFilters}
              searchValue={searchValue}
            />
            {isSearching && (
              <div className={c('search-wrapper')}>
                <input
                  ref={searchRef}
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery((e.target as HTMLInputElement).value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      setDebouncedSearchQuery('');
                      (e.target as HTMLInputElement).blur();
                      setIsSearching(false);
                    }
                  }}
                  type="text"
                  className={c('filter-input')}
                  placeholder={t('Search...')}
                />
                <a
                  className={`${c('search-cancel-button')} clickable-icon`}
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearchQuery('');
                    setIsSearching(false);
                  }}
                  aria-label={t('Cancel')}
                >
                  <Icon name="lucide-x" />
                </a>
              </div>
            )}
            {boardView === 'table' ? (
              <TableView boardData={getFilteredBoardData} stateManager={stateManager} />
            ) : (
              <ScrollContainer
                id={view.id}
                className={classcat([
                  c('board'),
                  {
                    [c('horizontal')]: boardView !== 'list',
                    [c('vertical')]: boardView === 'list',
                    'is-adding-lane': isLaneFormVisible,
                  },
                ])}
                triggerTypes={boardScrollTiggers}
              >
                <div>
                  <Sortable axis={axis}>
                    <Lanes lanes={getFilteredBoardData.children} collapseDir={axis} />
                    <SortPlaceholder
                      accepts={boardAccepts}
                      className={c('lane-placeholder')}
                      index={getFilteredBoardData.children.length}
                    />
                  </Sortable>
                </div>
              </ScrollContainer>
            )}
          </div>
        </SearchContext.Provider>
      </KanbanContext.Provider>
    </DndScope>
  );
};
