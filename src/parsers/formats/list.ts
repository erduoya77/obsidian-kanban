import update from 'immutability-helper';
import { Content, List, Parent, Root } from 'mdast';
import { ListItem } from 'mdast-util-from-markdown/lib';
import { toString } from 'mdast-util-to-string';
import { stringifyYaml } from 'obsidian';
import { KanbanSettings } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { generateInstanceId } from 'src/components/helpers';
import {
  Board,
  BoardTemplate,
  Item,
  ItemData,
  ItemTemplate,
  Lane,
  LaneTemplate,
} from 'src/components/types';
import { laneTitleWithMaxItems } from 'src/helpers';
import { defaultSort } from 'src/helpers/util';
import { t } from 'src/lang/helpers';
import { visit } from 'unist-util-visit';

import { archiveString, completeString, frontmatterKey, settingsToCodeblock } from '../common';
import { DateNode, FileNode, TimeNode, ValueNode } from '../extensions/types';
import {
  ContentBoundary,
  getNextOfType,
  getNodeContentBoundary,
  getPrevSibling,
  getStringFromBoundary,
} from '../helpers/ast';
import { hydrateItem, preprocessTitle } from '../helpers/hydrateBoard';
import { extractInlineFields, taskFields } from '../helpers/inlineMetadata';
import {
  addBlockId,
  dedentNewLines,
  executeDeletion,
  indentNewLines,
  markRangeForDeletion,
  parseLaneTitle,
  removeBlockId,
  replaceBrs,
  replaceNewLines,
} from '../helpers/parser';
import { parseFragment } from '../parseMarkdown';

interface TaskItem extends ListItem {
  checkChar?: string;
}

/**
 * 确保节点的所有 children 都是数组（用于 visit 函数）
 * visit 函数会递归遍历整个树，所以我们需要确保所有节点都有有效的 children 属性
 * 这个函数会深度遍历整个 AST，确保所有层级的节点都有有效的 children 数组
 * 
 * 关键：visit 函数在遍历时会检查每个节点是否有 children 属性
 * 如果节点有 children 属性，visit 函数会访问 children.length
 * 所以我们必须确保所有有 children 属性的节点，children 都是有效的数组
 */
function ensureChildrenAreArrays(node: any, depth: number = 0): any {
  // 防止无限递归
  if (depth > 100) {
    console.warn('⚠️ [DEBUG] Maximum recursion depth reached in ensureChildrenAreArrays');
    return node;
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  // 如果是数组，递归处理每个元素
  if (Array.isArray(node)) {
    return node
      .map((child: any) => {
        try {
          return ensureChildrenAreArrays(child, depth + 1);
        } catch (e) {
          console.warn('⚠️ [DEBUG] Error ensuring children are arrays for array element:', e);
          return null;
        }
      })
      .filter((child: any) => child !== null && child !== undefined);
  }

  // 创建新对象，避免修改原始对象
  // 使用 Object.assign 而不是展开运算符，确保所有属性都被复制
  const safe: any = Object.assign({}, node);

  // 关键：visit 函数会检查节点是否有 children 属性
  // 如果节点有 children 属性（即使是 undefined），visit 函数可能会访问 children.length
  // 所以我们必须确保所有有 children 属性的节点，children 都是有效的数组
  
  // 检查节点是否有 children 属性（使用 in 操作符会检查原型链，可能包括 undefined）
  // 或者直接检查 node.children 是否存在（包括 undefined）
  // 注意：visit 函数可能会检查原型链，所以我们需要检查 'children' in node
  const hasChildrenProperty = 'children' in node || node.children !== undefined;
  
  if (hasChildrenProperty) {
    // 如果节点有 children 属性，无论值是什么，都要确保它是有效的数组
    // visit 函数在遍历时会检查 children 是否存在，如果存在就会访问 children.length
    if (node.children === undefined || node.children === null) {
      if (depth === 0) {
        console.warn(`⚠️ [DEBUG] ensureChildrenAreArrays: 节点 ${node.type || 'unknown'} 的 children 是 ${node.children === undefined ? 'undefined' : 'null'}，设置为空数组`);
      }
      safe.children = [];
    } else if (!Array.isArray(node.children)) {
      if (depth === 0) {
        console.warn(`⚠️ [DEBUG] ensureChildrenAreArrays: 节点 ${node.type || 'unknown'} 的 children 不是数组（类型: ${typeof node.children}），设置为空数组`);
      }
      // 如果不是数组，尝试转换为数组或设置为空数组
      safe.children = [];
    } else {
      // 递归清理子节点，并过滤掉 null/undefined
      // 这是关键：visit 函数会递归遍历，所以我们必须确保所有子节点也被清理
      safe.children = node.children
        .map((child: any) => {
          try {
            return ensureChildrenAreArrays(child, depth + 1);
          } catch (e) {
            console.warn(`⚠️ [DEBUG] Error ensuring children are arrays for child at depth ${depth}:`, e);
            return null;
          }
        })
        .filter((child: any) => child !== null && child !== undefined);
    }
  }
  
  // 对于所有对象节点，确保如果它们可能被 visit 函数访问，都有有效的 children 属性
  // 但是不要为所有节点都添加 children，因为这可能会破坏原始结构
  // 只在确实需要时（即节点已经有 children 属性）才处理

  return safe;
}

export function listItemToItemData(stateManager: StateManager, md: string, item: TaskItem) {
  const moveTags = stateManager.getSetting('move-tags');
  const moveDates = stateManager.getSetting('move-dates');

  // 检查 item.children 是否存在
  if (!item || !item.children) {
    return {
      blockId: undefined,
      checked: item?.checked || false,
      checkChar: item?.checked ? (item.checkChar || ' ') : ' ',
      title: '',
      titleRaw: '',
      titleSearch: '',
      titleSearchRaw: '',
      metadata: {
        dateStr: undefined,
        date: undefined,
        time: undefined,
        timeStr: undefined,
        tags: [],
        fileAccessor: undefined,
        file: undefined,
        fileMetadata: undefined,
        fileMetadataOrder: undefined,
      },
    };
  }

  // 检查 children 是否为数组且有长度
  const children = item.children;
  if (!Array.isArray(children) || children.length === 0) {
    return {
      blockId: undefined,
      checked: item.checked || false,
      checkChar: item.checked ? (item.checkChar || ' ') : ' ',
      title: '',
      titleRaw: '',
      titleSearch: '',
      titleSearchRaw: '',
      metadata: {
        dateStr: undefined,
        date: undefined,
        time: undefined,
        timeStr: undefined,
        tags: [],
        fileAccessor: undefined,
        file: undefined,
        fileMetadata: undefined,
        fileMetadataOrder: undefined,
      },
    };
  }

  // 安全地访问 first 和 last
  const startNode = (children as any).first ? (children as any).first() : children[0];
  const endNode = (children as any).last ? (children as any).last() : children[children.length - 1];

  // 检查节点是否存在
  if (!startNode || !endNode) {
    return {
      blockId: undefined,
      checked: item.checked || false,
      checkChar: item.checked ? (item.checkChar || ' ') : ' ',
      title: '',
      titleRaw: '',
      titleSearch: '',
      titleSearchRaw: '',
      metadata: {
        dateStr: undefined,
        date: undefined,
        time: undefined,
        timeStr: undefined,
        tags: [],
        fileAccessor: undefined,
        file: undefined,
        fileMetadata: undefined,
        fileMetadataOrder: undefined,
      },
    };
  }

  // 检查 position 是否存在
  if (!startNode.position?.start?.offset || !endNode.position?.end?.offset) {
    return {
      blockId: undefined,
      checked: item.checked || false,
      checkChar: item.checked ? (item.checkChar || ' ') : ' ',
      title: '',
      titleRaw: '',
      titleSearch: '',
      titleSearchRaw: '',
      metadata: {
        dateStr: undefined,
        date: undefined,
        time: undefined,
        timeStr: undefined,
        tags: [],
        fileAccessor: undefined,
        file: undefined,
        fileMetadata: undefined,
        fileMetadataOrder: undefined,
      },
    };
  }

  const start =
    startNode.type === 'paragraph'
      ? (getNodeContentBoundary(startNode)?.start ?? startNode.position.start.offset)
      : startNode.position.start.offset;
  const end =
    endNode.type === 'paragraph'
      ? (getNodeContentBoundary(endNode)?.end ?? endNode.position.end.offset)
      : endNode.position.end.offset;
  const itemBoundary: ContentBoundary = { start, end };

  let itemContent = getStringFromBoundary(md, itemBoundary);

  // Handle empty task
  if (itemContent === '[' + (item.checked ? item.checkChar : ' ') + ']') {
    itemContent = '';
  }

  let title = itemContent;
  let titleSearch = '';

  // 确保 item 有有效的 children 属性，避免 visit 函数内部访问 undefined.length
  // visit 函数会递归遍历整个树，所以我们需要确保所有节点的 children 都是数组
  try {
    if (item && item.children && Array.isArray(item.children) && item.children.length > 0) {
      console.log('🔍 [DEBUG] listItemToItemData: 准备处理 item', {
        type: item.type,
        checked: item.checked,
        hasChildren: 'children' in item,
        childrenLength: Array.isArray(item.children) ? item.children.length : 'N/A',
      });
      
      // 检查原始 item 的所有子节点
      function checkItemChildren(node: any, path: string = 'item', depth: number = 0): void {
        if (depth > 5) return;
        if (!node || typeof node !== 'object') return;
        
        const hasChildren = 'children' in node;
        const childrenValue = node.children;
        const childrenIsArray = Array.isArray(childrenValue);
        const childrenIsUndefined = childrenValue === undefined;
        
        if (hasChildren && (childrenIsUndefined || !childrenIsArray)) {
          console.warn(`⚠️ [DEBUG] ${path}:`, {
            type: node.type,
            hasChildren,
            childrenValue,
            childrenIsArray,
            childrenIsUndefined,
          });
        }
        
        if (hasChildren && childrenIsArray && childrenValue.length > 0) {
          childrenValue.forEach((child: any, index: number) => {
            if (child && typeof child === 'object') {
              checkItemChildren(child, `${path}.children[${index}]`, depth + 1);
            }
          });
        }
      }
      
      console.log('🔍 [DEBUG] ========== 检查原始 item 结构 ==========');
      checkItemChildren(item, 'item');
      
      // 创建一个安全的访问器，确保 visit 函数不会访问 undefined.length
      // 深度清理整个 AST 树，确保所有层级的节点都有有效的 children 数组
      const safeItem = ensureChildrenAreArrays(item, 0);
      
      console.log('🔍 [DEBUG] ========== 检查清理后的 safeItem ==========');
      checkItemChildren(safeItem, 'safeItem');
      
      // 再次验证 safeItem 的结构
      if (!safeItem || !safeItem.children || !Array.isArray(safeItem.children)) {
        console.warn('⚠️ [DEBUG] SafeItem validation failed, skipping visit');
        titleSearch = title;
      } else {
        // 使用 try-catch 包装 visit 调用，捕获任何可能的错误
        try {
          console.log('🔍 [DEBUG] ========== 准备调用 visit ==========');
          
          // 创建一个包装函数，在 visit 内部访问节点时进行安全检查
          const safeVisit = (node: any, i: number | undefined, parent: any) => {
            // 检查 node 是否存在
            if (!node) return;
            
            // 确保 node 有有效的 children 属性（visit 函数可能会访问它）
            if (node && typeof node === 'object' && 'children' in node) {
              if (node.children === undefined || node.children === null) {
                console.warn('⚠️ [DEBUG] visit 回调中发现 node.children 是 undefined/null，正在修复:', {
                  nodeType: node.type,
                  path: i !== undefined ? `children[${i}]` : 'unknown',
                });
                node.children = [];
              } else if (!Array.isArray(node.children)) {
                console.warn('⚠️ [DEBUG] visit 回调中发现 node.children 不是数组，正在修复:', {
                  nodeType: node.type,
                  childrenType: typeof node.children,
                });
                node.children = [];
              }
            }
            
            // 确保 parent.children 是有效的数组（visit 函数可能会访问它）
            if (parent && parent.children !== undefined) {
              if (!Array.isArray(parent.children)) {
                console.warn('⚠️ [DEBUG] visit 回调中发现 parent.children 不是数组，正在修复:', {
                  parentType: parent.type,
                  childrenType: typeof parent.children,
                });
                parent.children = [];
              }
            }
            
            if (node.type === 'hashtag') {
              // 检查 parent 和 parent.children 是否存在
              if (parent && parent.children) {
                const parentChildren = parent.children;
                if (Array.isArray(parentChildren) && parentChildren.length > 0) {
                  const firstChild = (parentChildren as any).first ? (parentChildren as any).first() : parentChildren[0];
                  if (!firstChild?.value?.startsWith('```')) {
                    titleSearch += ' #' + (node.value || '');
                  }
                } else {
                  titleSearch += ' #' + (node.value || '');
                }
              } else {
                titleSearch += ' #' + (node.value || '');
              }
            } else {
              titleSearch += node.value || node.alt || '';
            }
          };
          
          visit(
            safeItem,
            ['text', 'wikilink', 'embedWikilink', 'image', 'inlineCode', 'code', 'hashtag'],
            safeVisit
          );
          
          console.log('✅ [DEBUG] visit 调用成功');
        } catch (visitError) {
          console.error('❌ [DEBUG] ========== visit 函数错误 ==========');
          console.error('❌ [DEBUG] 错误详情:', visitError);
          console.error('❌ [DEBUG] safeItem 结构:', JSON.stringify(safeItem, null, 2));
          if (visitError instanceof Error) {
            console.error('❌ [DEBUG] 错误堆栈:', visitError.stack);
          }
          // 如果 visit 失败，至少提取基本的文本内容
          titleSearch = title;
        }
      }
    }
  } catch (e) {
    console.error('❌ [DEBUG] ========== listItemToItemData 外层错误 ==========');
    console.error('❌ [DEBUG] 错误详情:', e);
    if (e instanceof Error) {
      console.error('❌ [DEBUG] 错误堆栈:', e.stack);
    }
    // 如果 visit 失败，至少提取基本的文本内容
    titleSearch = title;
  }

  const itemData: ItemData = {
    titleRaw: removeBlockId(dedentNewLines(replaceBrs(itemContent))),
    blockId: undefined,
    title: '',
    titleSearch,
    titleSearchRaw: titleSearch,
    metadata: {
      dateStr: undefined,
      date: undefined,
      time: undefined,
      timeStr: undefined,
      tags: [],
      fileAccessor: undefined,
      file: undefined,
      fileMetadata: undefined,
      fileMetadataOrder: undefined,
    },
    checked: item.checked,
    checkChar: item.checked ? item.checkChar || ' ' : ' ',
  };

  // 确保 item 有有效的 children 属性，避免 visit 函数内部访问 undefined.length
  // visit 函数会递归遍历整个树，所以我们需要确保所有节点的 children 都是数组
  try {
    if (item && item.children && Array.isArray(item.children) && item.children.length > 0) {
      // 创建一个安全的访问器，确保 visit 函数不会访问 undefined.length
      // 深度清理整个 AST 树，确保所有层级的节点都有有效的 children 数组
      const safeItem = ensureChildrenAreArrays(item, 0);
      
      // 再次验证 safeItem 的结构
      if (!safeItem || !safeItem.children || !Array.isArray(safeItem.children)) {
        console.warn('SafeItem validation failed for metadata visit, skipping');
      } else {
        // 使用 try-catch 包装 visit 调用，捕获任何可能的错误
        try {
          // 创建一个包装函数，在 visit 内部访问节点时进行安全检查
          const safeVisit = (node: any, i: number | undefined, parent: any) => {
            // 检查 node 是否存在
            if (!node) return;
            
            // 确保 node 有有效的 children 属性（visit 函数可能会访问它）
            if (node && typeof node === 'object' && 'children' in node) {
              if (node.children === undefined || node.children === null) {
                node.children = [];
              } else if (!Array.isArray(node.children)) {
                node.children = [];
              }
            }
            
            // 确保 parent.children 是有效的数组（visit 函数可能会访问它）
            if (parent && parent.children !== undefined) {
              if (!Array.isArray(parent.children)) {
                parent.children = [];
              }
            }
            
            const genericNode = node as ValueNode;

            if (genericNode.type === 'blockid') {
              itemData.blockId = genericNode.value;
              return true;
            }

            // 检查 parent 和 parent.children 是否存在
            let parentHasChildren = false;
            let firstChildValue: any = null;
            
            if (parent && parent.children) {
              const parentChildren = parent.children;
              if (Array.isArray(parentChildren) && parentChildren.length > 0) {
                parentHasChildren = true;
                const firstChild = (parentChildren as any).first ? (parentChildren as any).first() : parentChildren[0];
                firstChildValue = firstChild?.value;
              }
            }
            
            if (
              genericNode.type === 'hashtag' &&
              (!parentHasChildren || !firstChildValue?.startsWith('```'))
            ) {
              if (!itemData.metadata.tags) {
                itemData.metadata.tags = [];
              }

              itemData.metadata.tags.push('#' + genericNode.value);

              if (moveTags && node.position?.start?.offset && node.position?.end?.offset) {
                title = markRangeForDeletion(title, {
                  start: node.position.start.offset - itemBoundary.start,
                  end: node.position.end.offset - itemBoundary.start,
                });
              }
              return true;
            }

            if (genericNode.type === 'date' || genericNode.type === 'dateLink') {
              itemData.metadata.dateStr = (genericNode as DateNode).date;

              if (moveDates && node.position?.start?.offset && node.position?.end?.offset) {
                title = markRangeForDeletion(title, {
                  start: node.position.start.offset - itemBoundary.start,
                  end: node.position.end.offset - itemBoundary.start,
                });
              }
              return true;
            }

            if (genericNode.type === 'time') {
              itemData.metadata.timeStr = (genericNode as TimeNode).time;
              if (moveDates && node.position?.start?.offset && node.position?.end?.offset) {
                title = markRangeForDeletion(title, {
                  start: node.position.start.offset - itemBoundary.start,
                  end: node.position.end.offset - itemBoundary.start,
                });
              }
              return true;
            }

            if (genericNode.type === 'embedWikilink') {
              itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
              return true;
            }

            if (genericNode.type === 'wikilink') {
              itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
              itemData.metadata.fileMetadata = (genericNode as FileNode).fileMetadata;
              itemData.metadata.fileMetadataOrder = (genericNode as FileNode).fileMetadataOrder;
              return true;
            }

            if (genericNode.type === 'link' && (genericNode as FileNode).fileAccessor) {
              itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
              itemData.metadata.fileMetadata = (genericNode as FileNode).fileMetadata;
              itemData.metadata.fileMetadataOrder = (genericNode as FileNode).fileMetadataOrder;
              return true;
            }

            if (genericNode.type === 'embedLink') {
              itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
              return true;
            }
          };
          
          visit(
            safeItem,
            (node) => {
              return node && node.type !== 'paragraph';
            },
            safeVisit
          );
        } catch (visitError) {
          console.warn('Error in visit function for metadata (inner):', visitError);
          // 如果 visit 失败，继续使用已有的 itemData
        }
      }
    }
  } catch (e) {
    console.warn('Error in visit function for metadata (outer):', e);
    // 如果 visit 失败，继续使用已有的 itemData
  }

  itemData.title = preprocessTitle(stateManager, dedentNewLines(executeDeletion(title)));

  const firstLineEnd = itemData.title.indexOf('\n');
  const inlineFields = extractInlineFields(itemData.title, true);

  if (inlineFields?.length) {
    const inlineMetadata = (itemData.metadata.inlineMetadata = inlineFields.reduce((acc, curr) => {
      if (!taskFields.has(curr.key)) acc.push(curr);
      else if (firstLineEnd <= 0 || curr.end < firstLineEnd) acc.push(curr);

      return acc;
    }, []));

    const moveTaskData = stateManager.getSetting('move-task-metadata');
    const moveMetadata = stateManager.getSetting('inline-metadata-position') !== 'body';

    if (moveTaskData || moveMetadata) {
      let title = itemData.title;
      for (const item of [...inlineMetadata].reverse()) {
        const isTask = taskFields.has(item.key);

        if (isTask && !moveTaskData) continue;
        if (!isTask && !moveMetadata) continue;

        title = title.slice(0, item.start) + title.slice(item.end);
      }

      itemData.title = title;
    }
  }

  itemData.metadata.tags?.sort(defaultSort);

  return itemData;
}

function isArchiveLane(child: Content, children: Content[], currentIndex: number) {
  if (child.type !== 'heading' || toString(child, { includeImageAlt: false }) !== t('Archive')) {
    return false;
  }

  const prev = getPrevSibling(children, currentIndex);

  return prev && prev.type === 'thematicBreak';
}

export function astToUnhydratedBoard(
  stateManager: StateManager,
  settings: KanbanSettings,
  frontmatter: Record<string, any>,
  root: Root,
  md: string
): Board {
  console.log('🔍 [DEBUG] astToUnhydratedBoard: 开始处理');
  const lanes: Lane[] = [];
  const archive: Item[] = [];
  
  // 检查 root 和 root.children 是否存在
  if (!root || !root.children || !Array.isArray(root.children)) {
    console.warn('⚠️ [DEBUG] astToUnhydratedBoard: root.children 无效');
    return {
      ...BoardTemplate,
      id: stateManager.file?.path || 'unknown',
      children: [],
      data: {
        archive: [],
        settings: { [frontmatterKey]: 'board' },
        frontmatter: {},
        isSearching: false,
        errors: [{ description: 'Invalid AST structure: root.children is undefined or not an array', stack: '' }],
      },
    };
  }
  
  console.log('🔍 [DEBUG] astToUnhydratedBoard: root.children 数量:', root.children.length);
  
  root.children.forEach((child, index) => {
    // 检查 child 是否存在
    if (!child) {
      console.warn(`⚠️ [DEBUG] astToUnhydratedBoard: child[${index}] 是 null/undefined`);
      return;
    }
    
    try {
      // 确保 child 的 children 是有效的数组
      const safeChild = ensureChildrenAreArrays(child, 0);
      
      if (safeChild.type === 'heading') {
        console.log(`🔍 [DEBUG] astToUnhydratedBoard: 处理 heading[${index}]`);
        const isArchive = isArchiveLane(safeChild, root.children, index);
        const headingBoundary = getNodeContentBoundary(safeChild as Parent);
        
        // 检查 headingBoundary 是否有效
        if (!headingBoundary) {
          console.warn(`⚠️ [DEBUG] astToUnhydratedBoard: heading[${index}] boundary 无效，跳过`);
          return;
        }
        
        const title = getStringFromBoundary(md, headingBoundary);

        let shouldMarkItemsComplete = false;

        const list = getNextOfType(root.children, index, 'list', (child) => {
          if (child.type === 'heading') return false;

          if (child.type === 'paragraph') {
            try {
              // toString 可能会调用 visit，需要确保 child 的 children 是有效的数组
              // 先清理 child，确保其 children 是数组
              const safeChild = ensureChildrenAreArrays(child, 0);
              const childStr = toString(safeChild);

              if (childStr.startsWith('%% kanban:settings')) {
                return false;
              }

              if (childStr === t('Complete')) {
                shouldMarkItemsComplete = true;
                return true;
              }
            } catch (toStringError) {
              console.error(`❌ [DEBUG] astToUnhydratedBoard: toString 调用失败:`, toStringError);
              console.error(`❌ [DEBUG] astToUnhydratedBoard: child 结构:`, child);
              if (toStringError instanceof Error) {
                console.error(`❌ [DEBUG] astToUnhydratedBoard: toString 错误堆栈:`, toStringError.stack);
              }
              // 如果 toString 失败，跳过这个 child
              return false;
            }
          }

          return true;
        });

      if (isArchive && list) {
        // 确保 list 有有效的 children 属性
        const listObj = list as List;
        if (!listObj.children) {
          listObj.children = [];
        }
        if (!Array.isArray(listObj.children)) {
          listObj.children = [];
        }
        
        const listChildren = listObj.children;
        if (listChildren && listChildren.length > 0) {
          archive.push(
            ...listChildren.map((listItem) => {
              if (!listItem) {
                console.warn('List item is null or undefined, skipping');
                return null;
              }
              try {
                return {
                  ...ItemTemplate,
                  id: generateInstanceId(),
                  data: listItemToItemData(stateManager, md, listItem),
                };
              } catch (e) {
                console.warn('Error processing list item:', e);
                return null;
              }
            }).filter((item) => item !== null) as Item[]
          );
        }

        return;
      }

      if (!list) {
        lanes.push({
          ...LaneTemplate,
          children: [],
          id: generateInstanceId(),
          data: {
            ...parseLaneTitle(title),
            shouldMarkItemsComplete,
          },
        });
      } else {
        // 确保 list 有有效的 children 属性
        const listObj = list as List;
        if (!listObj.children) {
          listObj.children = [];
        }
        if (!Array.isArray(listObj.children)) {
          listObj.children = [];
        }
        
        const listChildren = listObj.children;
        if (!listChildren || listChildren.length === 0) {
          lanes.push({
            ...LaneTemplate,
            children: [],
            id: generateInstanceId(),
            data: {
              ...parseLaneTitle(title),
              shouldMarkItemsComplete,
            },
          });
        } else {
          lanes.push({
            ...LaneTemplate,
            children: listChildren.map((listItem) => {
              if (!listItem) {
                console.warn('List item is null or undefined, skipping');
                return null;
              }
              try {
                const data = listItemToItemData(stateManager, md, listItem);
                return {
                  ...ItemTemplate,
                  id: generateInstanceId(),
                  data,
                };
              } catch (e) {
                console.warn('Error processing list item:', e);
                return null;
              }
            }).filter((item) => item !== null) as Item[],
            id: generateInstanceId(),
            data: {
              ...parseLaneTitle(title),
              shouldMarkItemsComplete,
            },
          });
        }
      }
      } // 关闭 if (safeChild.type === 'heading')
    } catch (childError) {
      console.error(`❌ [DEBUG] astToUnhydratedBoard: 处理 child[${index}] 时出错:`, childError);
      console.error(`❌ [DEBUG] astToUnhydratedBoard: child 结构:`, child);
      if (childError instanceof Error) {
        console.error(`❌ [DEBUG] astToUnhydratedBoard: child 错误堆栈:`, childError.stack);
      }
      // 继续处理下一个 child，不中断整个流程
    }
  });

  console.log('✅ [DEBUG] astToUnhydratedBoard: 处理完成，lanes 数量:', lanes.length);
  return {
    ...BoardTemplate,
    id: stateManager.file.path,
    children: lanes,
    data: {
      settings,
      frontmatter,
      archive,
      isSearching: false,
      errors: [],
    },
  };
}

export function updateItemContent(stateManager: StateManager, oldItem: Item, newContent: string) {
  const md = `- [${oldItem.data.checkChar}] ${addBlockId(indentNewLines(newContent), oldItem)}`;

  const ast = parseFragment(stateManager, md);
  const itemData = listItemToItemData(stateManager, md, (ast.children[0] as List).children[0]);
  const newItem = update(oldItem, {
    data: {
      $set: itemData,
    },
  });

  try {
    hydrateItem(stateManager, newItem);
  } catch (e) {
    console.error(e);
  }

  return newItem;
}

export function newItem(
  stateManager: StateManager,
  newContent: string,
  checkChar: string,
  forceEdit?: boolean
) {
  const md = `- [${checkChar}] ${indentNewLines(newContent)}`;
  const ast = parseFragment(stateManager, md);
  const itemData = listItemToItemData(stateManager, md, (ast.children[0] as List).children[0]);

  itemData.forceEditMode = !!forceEdit;

  const newItem: Item = {
    ...ItemTemplate,
    id: generateInstanceId(),
    data: itemData,
  };

  try {
    hydrateItem(stateManager, newItem);
  } catch (e) {
    console.error(e);
  }

  return newItem;
}

export function reparseBoard(stateManager: StateManager, board: Board) {
  try {
    return update(board, {
      children: {
        $set: board.children.map((lane) => {
          return update(lane, {
            children: {
              $set: lane.children.map((item) => {
                return updateItemContent(stateManager, item, item.data.titleRaw);
              }),
            },
          });
        }),
      },
    });
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }
}

function itemToMd(item: Item) {
  return `- [${item.data.checkChar}] ${addBlockId(indentNewLines(item.data.titleRaw), item)}`;
}

function laneToMd(lane: Lane) {
  const lines: string[] = [];

  lines.push(`## ${replaceNewLines(laneTitleWithMaxItems(lane.data.title, lane.data.maxItems))}`);

  lines.push('');

  if (lane.data.shouldMarkItemsComplete) {
    lines.push(completeString);
  }

  lane.children.forEach((item) => {
    lines.push(itemToMd(item));
  });

  lines.push('');
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

function archiveToMd(archive: Item[]) {
  if (archive.length) {
    const lines: string[] = [archiveString, '', `## ${t('Archive')}`, ''];

    archive.forEach((item) => {
      lines.push(itemToMd(item));
    });

    return lines.join('\n');
  }

  return '';
}

export function boardToMd(board: Board) {
  const lanes = board.children.reduce((md, lane) => {
    return md + laneToMd(lane);
  }, '');

  const frontmatter = ['---', '', stringifyYaml(board.data.frontmatter), '---', '', ''].join('\n');

  return frontmatter + lanes + archiveToMd(board.data.archive) + settingsToCodeblock(board);
}
