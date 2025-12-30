import update from 'immutability-helper';
import { memo, useCallback, useEffect, useMemo, useState } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { getTaskStatusDone } from 'src/parsers/helpers/inlineMetadata';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { Icon } from '../Icon/Icon';
import { c } from '../helpers';
import { Item } from '../types';

interface ItemCheckboxProps {
  path: Path;
  item: Item;
  shouldMarkItemsComplete: boolean;
  stateManager: StateManager;
  boardModifiers: BoardModifiers;
}

export const ItemCheckbox = memo(function ItemCheckbox({
  shouldMarkItemsComplete,
  path,
  item,
  stateManager,
  boardModifiers,
}: ItemCheckboxProps) {
  const shouldShowCheckbox = stateManager.useSetting('show-checkboxes');

  const [isCtrlHoveringCheckbox, setIsCtrlHoveringCheckbox] = useState(false);
  const [isHoveringCheckbox, setIsHoveringCheckbox] = useState(false);

  // 缓存 doneChar 以避免重复计算
  const doneChar = useMemo(() => getTaskStatusDone(), []);

  const onCheckboxChange = useCallback(() => {
    // 强制使用三态切换逻辑（在看板模式下）
    // 三态切换：' ' (未开始) → '/' (进行中) → 'x' (已完成) → ' '
    const currentChar = item.data.checkChar;
    let nextChar: string;
    let nextChecked: boolean;

    if (currentChar === ' ') {
      // 未完成 → 进行中
      nextChar = '/';
      nextChecked = false;
    } else if (currentChar === '/') {
      // 进行中 → 完成
      nextChar = doneChar;
      nextChecked = true;
    } else if (currentChar === doneChar) {
      // 完成 → 未完成
      nextChar = ' ';
      nextChecked = false;
    } else {
      // 其他状态（如 Tasks 插件的其他状态）→ 未完成
      nextChar = ' ';
      nextChecked = false;
    }

    // 直接更新状态，不更新 titleRaw（titleRaw 不包含 checkChar）
    // titleRaw 会在保存时通过 itemToMd 函数重新组装
    boardModifiers.updateItem(
      path,
      update(item, {
        data: {
          checkChar: {
            $set: nextChar,
          },
          checked: {
            $set: nextChecked,
          },
        },
      })
    );
  }, [item.data.checkChar, item.data.checked, stateManager, boardModifiers.updateItem, doneChar, path]);

  useEffect(() => {
    if (isHoveringCheckbox) {
      const handler = (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey) {
          setIsCtrlHoveringCheckbox(true);
        } else {
          setIsCtrlHoveringCheckbox(false);
        }
      };

      activeWindow.addEventListener('keydown', handler);
      activeWindow.addEventListener('keyup', handler);

      return () => {
        activeWindow.removeEventListener('keydown', handler);
        activeWindow.removeEventListener('keyup', handler);
      };
    }
  }, [isHoveringCheckbox]);

  if (!(shouldMarkItemsComplete || shouldShowCheckbox)) {
    return null;
  }

  return (
    <div
      onMouseEnter={(e) => {
        setIsHoveringCheckbox(true);

        if (e.ctrlKey || e.metaKey) {
          setIsCtrlHoveringCheckbox(true);
        }
      }}
      onMouseLeave={() => {
        setIsHoveringCheckbox(false);

        if (isCtrlHoveringCheckbox) {
          setIsCtrlHoveringCheckbox(false);
        }
      }}
      className={c('item-prefix-button-wrapper')}
    >
      {shouldShowCheckbox && !isCtrlHoveringCheckbox && (
        <input
          onChange={onCheckboxChange}
          type="checkbox"
          className="task-list-item-checkbox"
          checked={item.data.checked}
          data-task={item.data.checkChar}
        />
      )}
      {(isCtrlHoveringCheckbox || (!shouldShowCheckbox && shouldMarkItemsComplete)) && (
        <a
          onClick={() => {
            boardModifiers.archiveItem(path);
          }}
          className={`${c('item-prefix-button')} clickable-icon`}
          aria-label={isCtrlHoveringCheckbox ? undefined : 'Archive card'}
        >
          <Icon name="sheets-in-box" />
        </a>
      )}
    </div>
  );
});
