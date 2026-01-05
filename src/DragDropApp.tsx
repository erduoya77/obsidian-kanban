import classcat from 'classcat';
import update from 'immutability-helper';
import { JSX, createPortal, memo, useCallback, useMemo } from 'preact/compat';

import { KanbanView } from './KanbanView';
import { DraggableItem } from './components/Item/Item';
import { DraggableLane } from './components/Lane/Lane';
import { KanbanContext } from './components/context';
import { c, maybeCompleteForMove } from './components/helpers';
import { Board, DataTypes, Item, Lane } from './components/types';
import { DndContext } from './dnd/components/DndContext';
import { DragOverlay } from './dnd/components/DragOverlay';
import { Entity, Nestable, Path } from './dnd/types';
import {
  getEntityFromPath,
  insertEntity,
  moveEntity,
  removeEntity,
  updateEntity,
} from './dnd/util/data';
import { getBoardModifiers } from './helpers/boardModifiers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';
import {
  getTaskStatusDone,
  getTaskStatusPreDone,
  toggleTask,
} from './parsers/helpers/inlineMetadata';

export function createApp(win: Window, plugin: KanbanPlugin) {
  return <DragDropApp win={win} plugin={plugin} />;
}

const View = memo(function View({ view }: { view: KanbanView }) {
  return createPortal(view.getPortal(), view.contentEl);
});

export function DragDropApp({ win, plugin }: { win: Window; plugin: KanbanPlugin }) {
  const views = plugin.useKanbanViews(win);
  const portals: JSX.Element[] = views.map((view) => <View key={view.id} view={view} />);

  const handleDrop = useCallback(
    (dragEntity: Entity, dropEntity: Entity) => {
      if (!dragEntity || !dropEntity) {
        return;
      }

      if (dragEntity.scopeId === 'htmldnd') {
        const data = dragEntity.getData();
        const stateManager = plugin.getStateManagerFromViewID(data.viewId, data.win);
        const dropPath = dropEntity.getPath();
        const destinationParent = getEntityFromPath(stateManager.state, dropPath.slice(0, -1));

        try {
          const items: Item[] = data.content.map((title: string) => {
            let item = stateManager.getNewItem(title, ' ');
            const isComplete = !!destinationParent?.data?.shouldMarkItemsComplete;

            if (isComplete) {
              item = update(item, { data: { checkChar: { $set: getTaskStatusPreDone() } } });
              const updates = toggleTask(item, stateManager.file);
              if (updates) {
                const [itemStrings, checkChars, thisIndex] = updates;
                const nextItem = itemStrings[thisIndex];
                const checkChar = checkChars[thisIndex];
                return stateManager.getNewItem(nextItem, checkChar);
              }
            }

            return update(item, {
              data: {
                checked: {
                  $set: !!destinationParent?.data?.shouldMarkItemsComplete,
                },
                checkChar: {
                  $set: destinationParent?.data?.shouldMarkItemsComplete
                    ? getTaskStatusDone()
                    : ' ',
                },
              },
            });
          });

          return stateManager.setState((board) => insertEntity(board, dropPath, items));
        } catch (e) {
          stateManager.setError(e);
          console.error(e);
        }

        return;
      }

      const dragPath = dragEntity.getPath();
      const dropPath = dropEntity.getPath();
      const dragEntityData = dragEntity.getData();
      const dropEntityData = dropEntity.getData();
      const [, sourceFile] = dragEntity.scopeId.split(':::');
      const [, destinationFile] = dropEntity.scopeId.split(':::');

      const inDropArea =
        dropEntityData.acceptsSort && !dropEntityData.acceptsSort.includes(dragEntityData.type);

      // Same board
      if (sourceFile === destinationFile) {
        const view = plugin.getKanbanView(dragEntity.scopeId, dragEntityData.win);
        const stateManager = plugin.stateManagers.get(view.file);

        // 检测视图模式：检查是否是项目视图模式（通过检查路径指向的 lane id）
        const isProjectViewMode = (() => {
          try {
            // 检查 dragPath 指向的 lane
            if (dragPath.length >= 1) {
              const dragLanePath = dragPath.slice(0, 1);
              const dragLane = getEntityFromPath(stateManager.state, dragLanePath);
              if (dragLane && dragLane.type === DataTypes.Lane) {
                const dragLaneId = (dragLane as Lane).id;
                if (dragLaneId?.startsWith('filtered-')) {
                  return true;
                }
              }
            }
            // 检查 dropPath 指向的 lane
            if (dropPath.length >= 1) {
              const dropLanePath = dropPath.slice(0, 1);
              const dropLane = getEntityFromPath(stateManager.state, dropLanePath);
              if (dropLane && dropLane.type === DataTypes.Lane) {
                const dropLaneId = (dropLane as Lane).id;
                if (dropLaneId?.startsWith('filtered-')) {
                  return true;
                }
              }
            }
            // 检查 dropEntityData 的 id（如果是 lane）
            if (dropEntityData.type === DataTypes.Lane) {
              const dropLaneId = dropEntityData.id;
              if (dropLaneId?.startsWith('filtered-')) {
                return true;
              }
            }
          } catch (e) {
            // 如果路径无效，不在项目视图模式
          }
          return false;
        })();

        // 在项目视图模式下，使用基于 ID 的拖拽逻辑
        if (isProjectViewMode && dragEntityData.type === DataTypes.Item) {
          const dragItemId = dragEntityData.id;
          
          // 确定目标状态
          let targetStatusChar: string | null = null;
          try {
            // 优先从 dropEntityData 获取（如果是 lane）
            if (dropEntityData.type === DataTypes.Lane) {
              const dropLaneId = dropEntityData.id;
              if (dropLaneId?.startsWith('filtered-')) {
                const statusType = dropLaneId.replace('filtered-', '');
                const doneChar = getTaskStatusDone();
                targetStatusChar = statusType === 'pending' ? ' ' : statusType === 'in-progress' ? '/' : doneChar;
              }
            } else if (dropPath.length >= 1) {
              // 如果 dropEntityData 不是 lane，从 dropPath 获取
              const dropLanePath = dropPath.slice(0, 1);
              const dropLane = getEntityFromPath(stateManager.state, dropLanePath);
              if (dropLane && dropLane.type === DataTypes.Lane) {
                const dropLaneId = (dropLane as Lane).id;
                if (dropLaneId?.startsWith('filtered-')) {
                  const statusType = dropLaneId.replace('filtered-', '');
                  const doneChar = getTaskStatusDone();
                  targetStatusChar = statusType === 'pending' ? ' ' : statusType === 'in-progress' ? '/' : doneChar;
                }
              }
            }
          } catch (e) {
            // 如果无法确定目标状态，使用当前状态
          }

          return stateManager.setState((board) => {
            // 通过 item.id 在原始 board 中查找 item（确保操作正确的项目）
            let sourceLaneIdx = -1;
            let sourceItemIdx = -1;
            let sourceItem: Item | null = null;
            
            for (let laneIdx = 0; laneIdx < board.children.length; laneIdx++) {
              const lane = board.children[laneIdx];
              for (let itemIdx = 0; itemIdx < lane.children.length; itemIdx++) {
                if (lane.children[itemIdx].id === dragItemId) {
                  sourceLaneIdx = laneIdx;
                  sourceItemIdx = itemIdx;
                  sourceItem = lane.children[itemIdx];
                  break;
                }
              }
              if (sourceItem) break;
            }
            
            if (!sourceItem || sourceLaneIdx === -1) {
              return board; // 找不到 item，返回原始 board
            }
            
            const sourceLane = board.children[sourceLaneIdx];
            
            // 如果状态改变了，更新状态
            if (targetStatusChar !== null && sourceItem.data.checkChar !== targetStatusChar) {
              const updatedItem = update(sourceItem, {
                data: {
                  checkChar: { $set: targetStatusChar },
                  checked: { $set: targetStatusChar === getTaskStatusDone() }
                }
              });
              
              // 找到目标状态的所有 items，确定插入位置
              const targetStatusItems: { item: Item; index: number }[] = [];
              for (let i = 0; i < sourceLane.children.length; i++) {
                if (sourceLane.children[i].data.checkChar === targetStatusChar) {
                  targetStatusItems.push({ item: sourceLane.children[i], index: i });
                }
              }
              
              // 确定目标位置
              let targetIndex: number;
              if (dropPath.length >= 2) {
                const dropItemIndex = dropPath[1] as number;
                if (dropItemIndex < targetStatusItems.length) {
                  targetIndex = targetStatusItems[dropItemIndex].index;
                } else {
                  targetIndex = targetStatusItems.length > 0 
                    ? targetStatusItems[targetStatusItems.length - 1].index + 1
                    : sourceLane.children.length;
                }
              } else {
                // 拖拽到 lane 的 drop area，放在目标状态 items 的末尾
                targetIndex = targetStatusItems.length > 0 
                  ? targetStatusItems[targetStatusItems.length - 1].index + 1
                  : sourceLane.children.length;
              }
              
              // 移除 item 并在新位置插入
              const boardWithoutItem = removeEntity(board, [sourceLaneIdx, sourceItemIdx]);
              const adjustedTargetIndex = sourceItemIdx < targetIndex 
                ? targetIndex - 1 
                : targetIndex;
              return insertEntity(boardWithoutItem, [sourceLaneIdx, adjustedTargetIndex], [updatedItem]);
            } else {
              // 状态没有改变，只是改变位置
              // 找到相同状态的所有 items
              const sameStatusItems: { item: Item; index: number }[] = [];
              for (let i = 0; i < sourceLane.children.length; i++) {
                if (sourceLane.children[i].data.checkChar === sourceItem.data.checkChar) {
                  sameStatusItems.push({ item: sourceLane.children[i], index: i });
                }
              }
              
              const currentIndexInSameStatus = sameStatusItems.findIndex(
                s => s.item.id === dragItemId
              );
              
              if (dropPath.length >= 2 && currentIndexInSameStatus !== -1) {
                const dropItemIndex = dropPath[1] as number;
                if (dropItemIndex !== currentIndexInSameStatus && dropItemIndex < sameStatusItems.length) {
                  const targetItemInSameStatus = sameStatusItems[dropItemIndex];
                  const targetGlobalIndex = targetItemInSameStatus.index;
                  
                  // 使用 moveEntity 移动位置
                  return moveEntity(
                    board,
                    [sourceLaneIdx, sourceItemIdx],
                    [sourceLaneIdx, targetGlobalIndex]
                  );
                }
              }
            }
            
            return board;
          });
        }

        // 全部项目视图模式：使用正常的路径操作，但通过 ID 验证确保操作正确的 item
        if (inDropArea) {
          dropPath.push(0);
        }

        return stateManager.setState((board) => {
          // 验证：确保通过路径获取的 entity 的 id 与 dragEntityData.id 匹配
          const entity = getEntityFromPath(board, dragPath);
          
          // 如果是 item，验证 id 是否匹配
          if (entity.type === DataTypes.Item && dragEntityData.type === DataTypes.Item) {
            const entityId = (entity as Item).id;
            const dragItemId = dragEntityData.id;
            
            if (entityId !== dragItemId) {
              // ID 不匹配，通过 ID 查找正确的 item
              let correctLaneIdx = -1;
              let correctItemIdx = -1;
              
              for (let laneIdx = 0; laneIdx < board.children.length; laneIdx++) {
                const lane = board.children[laneIdx];
                for (let itemIdx = 0; itemIdx < lane.children.length; itemIdx++) {
                  if (lane.children[itemIdx].id === dragItemId) {
                    correctLaneIdx = laneIdx;
                    correctItemIdx = itemIdx;
                    break;
                  }
                }
                if (correctLaneIdx !== -1) break;
              }
              
              if (correctLaneIdx !== -1) {
                // 使用正确的路径
                const correctDragPath: Path = [correctLaneIdx, correctItemIdx];
                const entity = getEntityFromPath(board, correctDragPath);
                
                const newBoard: Board = moveEntity(
                  board,
                  correctDragPath,
                  dropPath,
                  (entity) => {
                    if (entity.type === DataTypes.Item) {
                      const { next } = maybeCompleteForMove(
                        stateManager,
                        board,
                        correctDragPath,
                        stateManager,
                        board,
                        dropPath,
                        entity
                      );
                      return next;
                    }
                    return entity;
                  },
                  (entity) => {
                    if (entity.type === DataTypes.Item) {
                      const { replacement } = maybeCompleteForMove(
                        stateManager,
                        board,
                        correctDragPath,
                        stateManager,
                        board,
                        dropPath,
                        entity
                      );
                      return replacement;
                    }
                  }
                );
                
                // Remove sorting in the destination lane
                const destinationParentPath = dropPath.slice(0, -1);
                const destinationParent = getEntityFromPath(board, destinationParentPath);
                
                if (destinationParent?.data?.sorted !== undefined) {
                  return updateEntity(newBoard, destinationParentPath, {
                    data: {
                      $unset: ['sorted'],
                    },
                  });
                }
                
                return newBoard;
              }
            }
          }
          
          // 正常路径操作
          const newBoard: Board = moveEntity(
            board,
            dragPath,
            dropPath,
            (entity) => {
              if (entity.type === DataTypes.Item) {
                const { next } = maybeCompleteForMove(
                  stateManager,
                  board,
                  dragPath,
                  stateManager,
                  board,
                  dropPath,
                  entity
                );
                return next;
              }
              return entity;
            },
            (entity) => {
              if (entity.type === DataTypes.Item) {
                const { replacement } = maybeCompleteForMove(
                  stateManager,
                  board,
                  dragPath,
                  stateManager,
                  board,
                  dropPath,
                  entity
                );
                return replacement;
              }
            }
          );

          if (entity.type === DataTypes.Lane) {
            const from = dragPath.last();
            let to = dropPath.last();

            if (from < to) to -= 1;

            const collapsedState = view.getViewState('list-collapse');
            const op = (collapsedState: boolean[]) => {
              const newState = [...collapsedState];
              newState.splice(to, 0, newState.splice(from, 1)[0]);
              return newState;
            };

            view.setViewState('list-collapse', undefined, op);

            return update<Board>(newBoard, {
              data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
            });
          }

          // Remove sorting in the destination lane
          const destinationParentPath = dropPath.slice(0, -1);
          const destinationParent = getEntityFromPath(board, destinationParentPath);

          if (destinationParent?.data?.sorted !== undefined) {
            return updateEntity(newBoard, destinationParentPath, {
              data: {
                $unset: ['sorted'],
              },
            });
          }

          return newBoard;
        });
      }

      const sourceView = plugin.getKanbanView(dragEntity.scopeId, dragEntityData.win);
      const sourceStateManager = plugin.stateManagers.get(sourceView.file);
      const destinationView = plugin.getKanbanView(dropEntity.scopeId, dropEntityData.win);
      const destinationStateManager = plugin.stateManagers.get(destinationView.file);

      sourceStateManager.setState((sourceBoard) => {
        const entity = getEntityFromPath(sourceBoard, dragPath);
        let replacementEntity: Nestable;

        destinationStateManager.setState((destinationBoard) => {
          if (inDropArea) {
            const parent = getEntityFromPath(destinationStateManager.state, dropPath);
            const shouldAppend =
              (destinationStateManager.getSetting('new-card-insertion-method') || 'append') ===
              'append';

            if (shouldAppend) dropPath.push(parent.children.length);
            else dropPath.push(0);
          }

          const toInsert: Nestable[] = [];

          if (entity.type === DataTypes.Item) {
            const { next, replacement } = maybeCompleteForMove(
              sourceStateManager,
              sourceBoard,
              dragPath,
              destinationStateManager,
              destinationBoard,
              dropPath,
              entity
            );
            replacementEntity = replacement;
            toInsert.push(next);
          } else {
            toInsert.push(entity);
          }

          if (entity.type === DataTypes.Lane) {
            const collapsedState = destinationView.getViewState('list-collapse');
            const val = sourceView.getViewState('list-collapse')[dragPath.last()];
            const op = (collapsedState: boolean[]) => {
              const newState = [...collapsedState];
              newState.splice(dropPath.last(), 0, val);
              return newState;
            };

            destinationView.setViewState('list-collapse', undefined, op);

            return update<Board>(insertEntity(destinationBoard, dropPath, toInsert), {
              data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
            });
          } else {
            return insertEntity(destinationBoard, dropPath, toInsert);
          }
        });

        if (entity.type === DataTypes.Lane) {
          const collapsedState = sourceView.getViewState('list-collapse');
          const op = (collapsedState: boolean[]) => {
            const newState = [...collapsedState];
            newState.splice(dragPath.last(), 1);
            return newState;
          };
          sourceView.setViewState('list-collapse', undefined, op);

          return update<Board>(removeEntity(sourceBoard, dragPath), {
            data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
          });
        } else {
          return removeEntity(sourceBoard, dragPath, replacementEntity);
        }
      });
    },
    [views]
  );

  if (portals.length)
    return (
      <DndContext win={win} onDrop={handleDrop}>
        {...portals}
        <DragOverlay>
          {(entity, styles) => {
            const [data, context] = useMemo(() => {
              if (entity.scopeId === 'htmldnd') {
                return [null, null];
              }

              const overlayData = entity.getData();

              const view = plugin.getKanbanView(entity.scopeId, overlayData.win);
              const stateManager = plugin.stateManagers.get(view.file);
              
              // 检测是否是项目视图模式
              let data: Nestable | null = null;
              try {
                const entityPath = entity.getPath();
                if (entityPath.length >= 1 && overlayData.type === DataTypes.Item) {
                  // 检查路径指向的 lane 是否是 filtered lane
                  const lanePath = entityPath.slice(0, 1);
                  const lane = getEntityFromPath(stateManager.state, lanePath);
                  if (lane && lane.type === DataTypes.Lane) {
                    const laneId = (lane as Lane).id;
                    if (laneId?.startsWith('filtered-')) {
                      // 在项目视图模式下，通过 item id 查找正确的 item
                      const itemId = overlayData.id;
                      for (let laneIdx = 0; laneIdx < stateManager.state.children.length; laneIdx++) {
                        const originalLane = stateManager.state.children[laneIdx];
                        for (let itemIdx = 0; itemIdx < originalLane.children.length; itemIdx++) {
                          if (originalLane.children[itemIdx].id === itemId) {
                            data = originalLane.children[itemIdx];
                            break;
                          }
                        }
                        if (data) break;
                      }
                    }
                  }
                }
              } catch (e) {
                // 如果检测失败，使用默认路径获取
              }
              
              // 如果通过 ID 查找失败，使用路径获取
              if (!data) {
                data = getEntityFromPath(stateManager.state, entity.getPath());
              }
              
              const boardModifiers = getBoardModifiers(view, stateManager);
              const filePath = view.file.path;

              return [
                data,
                {
                  view,
                  stateManager,
                  boardModifiers,
                  filePath,
                },
              ];
            }, [entity]);

            if (data?.type === DataTypes.Lane) {
              const boardView =
                context?.view.viewSettings[frontmatterKey] ||
                context?.stateManager.getSetting(frontmatterKey);
              const collapseState =
                context?.view.viewSettings['list-collapse'] ||
                context?.stateManager.getSetting('list-collapse');
              const laneIndex = entity.getPath().last();

              return (
                <KanbanContext.Provider value={context}>
                  <div
                    className={classcat([
                      c('drag-container'),
                      {
                        [c('horizontal')]: boardView !== 'list',
                        [c('vertical')]: boardView === 'list',
                      },
                    ])}
                    style={styles}
                  >
                    <DraggableLane
                      lane={data as Lane}
                      laneIndex={laneIndex}
                      isStatic={true}
                      isCollapsed={!!collapseState[laneIndex]}
                      collapseDir={boardView === 'list' ? 'vertical' : 'horizontal'}
                    />
                  </div>
                </KanbanContext.Provider>
              );
            }

            if (data?.type === DataTypes.Item) {
              return (
                <KanbanContext.Provider value={context}>
                  <div className={c('drag-container')} style={styles}>
                    <DraggableItem item={data as Item} itemIndex={0} isStatic={true} />
                  </div>
                </KanbanContext.Provider>
              );
            }

            return <div />;
          }}
        </DragOverlay>
      </DndContext>
    );
}
