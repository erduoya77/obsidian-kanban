import update from 'immutability-helper';
import { moment } from 'obsidian';
import { ProjectKanbanView } from 'src/ProjectKanbanView';
import { ProjectStateManager } from 'src/ProjectStateManager';
import { Path } from 'src/dnd/types';
import {
  appendEntities,
  getEntityFromPath,
  insertEntity,
  moveEntity,
  prependEntities,
  removeEntity,
  updateEntity,
  updateParentEntity,
} from 'src/dnd/util/data';

import { generateInstanceId } from '../components/helpers';
import { Board, DataTypes, Item, Lane } from '../components/types';
import { getTaskStatusDone } from '../parsers/helpers/inlineMetadata';

/**
 * 检查路径是否属于同一个项目文件
 */
function isSameProject(path1: Path, path2: Path, board: Board): boolean {
  if (path1.length === 0 || path2.length === 0) return false;
  
  const lane1 = board.children[path1[0] as number];
  const lane2 = board.children[path2[0] as number];
  
  if (!lane1 || !lane2) return false;
  
  // 提取项目文件路径（lane ID 的第一部分）
  const project1 = lane1.id.split(':::')[0];
  const project2 = lane2.id.split(':::')[0];
  
  return project1 === project2;
}

/**
 * 获取项目文件路径
 */
function getProjectPath(laneId: string): string | null {
  const parts = laneId.split(':::');
  return parts.length >= 1 ? parts[0] : null;
}

export function getProjectBoardModifiers(
  view: ProjectKanbanView,
  stateManager: ProjectStateManager
) {
  const archiveDateFormat = stateManager.getSetting('archive-date-format');
  const archiveDateSeparator = stateManager.getSetting('archive-date-separator');
  const archiveDateAfterTitle = stateManager.getSetting('append-archive-date');

  const appendArchiveDate = (item: Item) => {
    const newTitle = [moment().format(archiveDateFormat)];

    if (archiveDateSeparator) newTitle.push(archiveDateSeparator);

    newTitle.push(item.data.titleRaw);

    if (archiveDateAfterTitle) newTitle.reverse();

    const titleRaw = newTitle.join(' ');
    return stateManager.updateItemContent(item, titleRaw);
  };

  return {
    appendItems: (path: Path, items: Item[]) => {
      stateManager.setState((boardData) => appendEntities(boardData, path, items));
    },

    prependItems: (path: Path, items: Item[]) => {
      stateManager.setState((boardData) => prependEntities(boardData, path, items));
    },

    insertItems: (path: Path, items: Item[]) => {
      stateManager.setState((boardData) => insertEntity(boardData, path, items));
    },

    replaceItem: (path: Path, items: Item[]) => {
      stateManager.setState((boardData) =>
        insertEntity(removeEntity(boardData, path), path, items)
      );
    },

    splitItem: (path: Path, items: Item[]) => {
      stateManager.setState((boardData) => {
        return insertEntity(removeEntity(boardData, path), path, items);
      });
    },

    moveItemToTop: (path: Path) => {
      stateManager.setState((boardData) => {
        const laneIndex = path[0] as number;
        const lane = boardData.children[laneIndex];
        if (!lane) return boardData;
        
        // 确保在同一项目内
        return moveEntity(boardData, path, [laneIndex, 0]);
      });
    },

    moveItemToBottom: (path: Path) => {
      stateManager.setState((boardData) => {
        const laneIndex = path[0] as number;
        const lane = boardData.children[laneIndex];
        if (!lane) return boardData;
        
        // 确保在同一项目内
        return moveEntity(boardData, path, [laneIndex, lane.children.length]);
      });
    },

    addLane: (lane: Lane) => {
      // 项目视图中不支持添加新 lane（需要在原文件中添加）
      console.warn('Cannot add lane in project view. Please add it in the original project file.');
    },

    insertLane: (path: Path, lane: Lane) => {
      // 项目视图中不支持插入新 lane
      console.warn('Cannot insert lane in project view. Please add it in the original project file.');
    },

    updateLane: (path: Path, lane: Lane) => {
      stateManager.setState((boardData) =>
        updateParentEntity(boardData, path, {
          children: {
            [path[path.length - 1]]: {
              $set: lane,
            },
          },
        })
      );
    },

    archiveLane: (path: Path) => {
      stateManager.setState((boardData) => {
        const lane = getEntityFromPath(boardData, path);
        const items = lane.children;

        try {
          return update(removeEntity(boardData, path), {
            data: {
              archive: {
                $unshift: stateManager.getSetting('archive-with-date')
                  ? items.map(appendArchiveDate)
                  : items,
              },
            },
          });
        } catch (e) {
          console.error(e);
          return boardData;
        }
      });
    },

    archiveLaneItems: (path: Path) => {
      stateManager.setState((boardData) => {
        const lane = getEntityFromPath(boardData, path);
        const items = lane.children;

        try {
          return update(
            updateEntity(boardData, path, {
              children: {
                $set: [],
              },
            }),
            {
              data: {
                archive: {
                  $unshift: stateManager.getSetting('archive-with-date')
                    ? items.map(appendArchiveDate)
                    : items,
                },
              },
            }
          );
        } catch (e) {
          console.error(e);
          return boardData;
        }
      });
    },

    deleteEntity: (path: Path) => {
      stateManager.setState((boardData) => {
        const entity = getEntityFromPath(boardData, path);
        return removeEntity(boardData, path);
      });
    },

    updateItem: (path: Path, item: Item) => {
      stateManager.setState((boardData) => {
        return updateParentEntity(boardData, path, {
          children: {
            [path[path.length - 1]]: {
              $set: item,
            },
          },
        });
      });
    },

    archiveItem: (path: Path) => {
      stateManager.setState((boardData) => {
        const item = getEntityFromPath(boardData, path);
        try {
          return update(removeEntity(boardData, path), {
            data: {
              archive: {
                $push: [
                  stateManager.getSetting('archive-with-date') ? appendArchiveDate(item) : item,
                ],
              },
            },
          });
        } catch (e) {
          console.error(e);
          return boardData;
        }
      });
    },

    duplicateEntity: (path: Path) => {
      stateManager.setState((boardData) => {
        const entity = getEntityFromPath(boardData, path);
        const entityWithNewID = update(entity, {
          id: {
            $set: generateInstanceId(),
          },
        });

        return insertEntity(boardData, path, [entityWithNewID]);
      });
    },
  };
}

