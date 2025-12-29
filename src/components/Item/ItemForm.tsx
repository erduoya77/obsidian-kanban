import { EditorView } from '@codemirror/view';
import { Dispatch, StateUpdater, useContext, useRef } from 'preact/hooks';
import useOnclickOutside from 'react-cool-onclickoutside';
import { moment } from 'obsidian';
import { t } from 'src/lang/helpers';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import { getDropAction } from '../Editor/helpers';
import { KanbanContext } from '../context';
import { c, escapeRegExpStr } from '../helpers';
import { EditState, EditingState, Item, isEditing } from '../types';

interface ItemFormProps {
  addItems: (items: Item[]) => void;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  hideButton?: boolean;
}

export function ItemForm({ addItems, editState, setEditState, hideButton }: ItemFormProps) {
  const { stateManager } = useContext(KanbanContext);
  const editorRef = useRef<EditorView>();

  const clear = () => setEditState(EditingState.cancel);
  const clickOutsideRef = useOnclickOutside(clear, {
    ignoreClass: [c('ignore-click-outside'), 'mobile-toolbar', 'suggestion-container'],
  });

  const createItem = (title: string) => {
    // 自动添加当前日期和时间
    const trimmedTitle = title.trim();
    let finalTitle = trimmedTitle;
    
    // 获取日期和时间触发器
    const dateTrigger = stateManager.getSetting('date-trigger') || '@';
    const timeTrigger = stateManager.getSetting('time-trigger') || '@@';
    const dateFormat = stateManager.getSetting('date-format') || 'YYYY-MM-DD';
    const timeFormat = stateManager.getSetting('time-format') || 'HH:mm';
    
    // 转义触发器用于正则表达式
    const escapedDateTrigger = escapeRegExpStr(dateTrigger);
    const escapedTimeTrigger = escapeRegExpStr(timeTrigger);
    
    // 检查是否已经包含日期和时间（避免重复添加）
    const datePattern = new RegExp(
      `${escapedDateTrigger}(?:\\[\\[([^\\]]+)\\]\\]|\\{([^}]+)\\})`
    );
    const timePattern = new RegExp(
      `${escapedTimeTrigger}\\{([^}]+)\\}`
    );
    
    const hasDate = datePattern.test(trimmedTitle);
    const hasTime = timePattern.test(trimmedTitle);
    
    // 如果标题中还没有日期或时间，则添加
    if (!hasDate || !hasTime) {
      const currentTime = moment();
      const parts: string[] = [];
      
      // 添加日期（如果还没有）
      if (!hasDate) {
        const formattedDate = currentTime.format(dateFormat);
        // 使用日期链接格式 @[[YYYY-MM-DD]]
        parts.push(`${dateTrigger}[[${formattedDate}]]`);
      }
      
      // 添加时间（如果还没有）
      if (!hasTime) {
        const formattedTime = currentTime.format(timeFormat);
        parts.push(`${timeTrigger}{${formattedTime}}`);
      }
      
      // 在标题末尾添加日期和时间
      if (parts.length > 0) {
        finalTitle = trimmedTitle
          ? `${trimmedTitle} ${parts.join(' ')}`
          : parts.join(' ');
      }
    }
    
    addItems([stateManager.getNewItem(finalTitle, ' ')]);
    const cm = editorRef.current;
    if (cm) {
      cm.dispatch({
        changes: {
          from: 0,
          to: cm.state.doc.length,
          insert: '',
        },
      });
    }
  };

  if (isEditing(editState)) {
    return (
      <div className={c('item-form')} ref={clickOutsideRef}>
        <div className={c('item-input-wrapper')}>
          <MarkdownEditor
            editorRef={editorRef}
            editState={{ x: 0, y: 0 }}
            className={c('item-input')}
            placeholder={t('Card title...')}
            onEnter={(cm, mod, shift) => {
              if (!allowNewLine(stateManager, mod, shift)) {
                createItem(cm.state.doc.toString());
                return true;
              }
            }}
            onSubmit={(cm) => {
              createItem(cm.state.doc.toString());
            }}
            onEscape={clear}
          />
        </div>
      </div>
    );
  }

  if (hideButton) return null;

  return (
    <div className={c('item-button-wrapper')}>
      <button
        className={c('new-item-button')}
        onClick={() => setEditState({ x: 0, y: 0 })}
        onDragOver={(e) => {
          if (getDropAction(stateManager, e.dataTransfer)) {
            setEditState({ x: 0, y: 0 });
          }
        }}
      >
        <span className={c('item-button-plus')}>+</span> {t('Add a card')}
      </button>
    </div>
  );
}
