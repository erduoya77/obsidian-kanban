import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { parseYaml } from 'obsidian';
import { KanbanSettings, settingKeyLookup } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { getNormalizedPath } from 'src/helpers/renderMarkdown';

/**
 * 确保节点的所有 children 都是数组（用于 visit 函数）
 * 这个函数会深度遍历整个 AST，确保所有层级的节点都有有效的 children 数组
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
  const safe: any = Object.assign({}, node);

  // 检查节点是否有 children 属性（使用 in 操作符会检查原型链）
  const hasChildrenProperty = 'children' in node || node.children !== undefined;
  
  if (hasChildrenProperty) {
    // 如果节点有 children 属性，无论值是什么，都要确保它是有效的数组
    if (node.children === undefined || node.children === null) {
      if (depth === 0) {
        console.warn(`⚠️ [DEBUG] ensureChildrenAreArrays: 节点 ${node.type || 'unknown'} 的 children 是 ${node.children === undefined ? 'undefined' : 'null'}，设置为空数组`);
      }
      safe.children = [];
    } else if (!Array.isArray(node.children)) {
      if (depth === 0) {
        console.warn(`⚠️ [DEBUG] ensureChildrenAreArrays: 节点 ${node.type || 'unknown'} 的 children 不是数组（类型: ${typeof node.children}），设置为空数组`);
      }
      safe.children = [];
    } else {
      // 递归清理子节点
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

  return safe;
}

import { frontmatterKey, getLinkedPageMetadata } from './common';
import { blockidExtension, blockidFromMarkdown } from './extensions/blockid';
import { genericWrappedExtension, genericWrappedFromMarkdown } from './extensions/genericWrapped';
import { internalMarkdownLinks } from './extensions/internalMarkdownLink';
import { tagExtension, tagFromMarkdown } from './extensions/tag';
import { gfmTaskListItem, gfmTaskListItemFromMarkdown } from './extensions/taskList';
import { FileAccessor } from './helpers/parser';

function extractFrontmatter(md: string) {
  let frontmatterStart = -1;
  let openDashCount = 0;

  for (let i = 0, len = md.length; i < len; i++) {
    if (openDashCount < 3) {
      if (md[i] === '-') {
        openDashCount++;
        continue;
      } else {
        throw new Error('Error parsing frontmatter');
      }
    }

    if (frontmatterStart < 0) frontmatterStart = i;

    if (md[i] === '-' && /[\r\n]/.test(md[i - 1]) && md[i + 1] === '-' && md[i + 2] === '-') {
      return parseYaml(md.slice(frontmatterStart, i - 1).trim());
    }
  }
}

function extractSettingsFooter(md: string) {
  let hasEntered = false;
  let openTickCount = 0;
  let settingsEnd = -1;

  for (let i = md.length - 1; i >= 0; i--) {
    if (!hasEntered && /[`%\n\r]/.test(md[i])) {
      if (md[i] === '`') {
        openTickCount++;

        if (openTickCount === 3) {
          hasEntered = true;
          settingsEnd = i - 1;
        }
      }
      continue;
    } else if (!hasEntered) {
      return {};
    }

    if (md[i] === '`' && md[i - 1] === '`' && md[i - 2] === '`' && /[\r\n]/.test(md[i - 3])) {
      return JSON.parse(md.slice(i + 1, settingsEnd).trim());
    }
  }
}

function getExtensions(stateManager: StateManager) {
  return [
    gfmTaskListItem,
    genericWrappedExtension('date', `${stateManager.getSetting('date-trigger')}{`, '}'),
    genericWrappedExtension('dateLink', `${stateManager.getSetting('date-trigger')}[[`, ']]'),
    genericWrappedExtension('time', `${stateManager.getSetting('time-trigger')}{`, '}'),
    genericWrappedExtension('embedWikilink', '![[', ']]'),
    genericWrappedExtension('wikilink', '[[', ']]'),
    tagExtension(),
    blockidExtension(),
  ];
}

/**
 * 包装扩展，确保所有创建的节点都有 children 属性
 * 通过拦截 this.enter 调用来实现
 */
function wrapExtension(extension: any): any {
  if (!extension || typeof extension !== 'object') {
    return extension;
  }

  const wrapped: any = {};

  // 包装 enter 回调
  if (extension.enter) {
    wrapped.enter = {};
    for (const [key, handler] of Object.entries(extension.enter)) {
      if (typeof handler === 'function') {
        wrapped.enter[key] = function(token: any) {
          // 保存原始的 enter 方法
          const originalEnter = this.enter;
          
          // 替换 enter 方法，确保所有节点都有 children 属性
          this.enter = function(node: any, token: any) {
            // 确保节点有 children 属性
            if (node && typeof node === 'object') {
              if (!('children' in node)) {
                node.children = [];
              } else if (node.children === undefined || node.children === null) {
                node.children = [];
              }
            }
            return originalEnter.call(this, node, token);
          };
          
          try {
            // 调用原始处理器
            return handler.call(this, token);
          } finally {
            // 恢复原始的 enter 方法
            this.enter = originalEnter;
          }
        };
      } else {
        wrapped.enter[key] = handler;
      }
    }
  }

  // 包装 exit 回调，确保节点有 children 属性
  if (extension.exit) {
    wrapped.exit = {};
    for (const [key, handler] of Object.entries(extension.exit)) {
      if (typeof handler === 'function') {
        wrapped.exit[key] = function(token: any) {
          try {
            const result = handler.call(this, token);
            // 在 exit 后，确保当前节点有 children 属性
            if (this.stack && this.stack.length > 0) {
              const currentNode = this.stack[this.stack.length - 1];
              if (currentNode && typeof currentNode === 'object') {
                if (!('children' in currentNode)) {
                  currentNode.children = [];
                } else if (currentNode.children === undefined || currentNode.children === null) {
                  currentNode.children = [];
                }
              }
            }
            return result;
          } catch (error) {
            console.error(`❌ [DEBUG] Extension exit handler error for ${key}:`, error);
            throw error;
          }
        };
      } else {
        wrapped.exit[key] = handler;
      }
    }
  }

  // 复制其他属性
  for (const [key, value] of Object.entries(extension)) {
    if (key !== 'enter' && key !== 'exit') {
      wrapped[key] = value;
    }
  }

  return wrapped;
}

function getMdastExtensions(stateManager: StateManager) {
  const extensions = [
    gfmTaskListItemFromMarkdown,
    genericWrappedFromMarkdown('date', (text, node) => {
      if (!text) return;
      node.date = text;
    }),
    genericWrappedFromMarkdown('dateLink', (text, node) => {
      if (!text) return;
      node.date = text;
    }),
    genericWrappedFromMarkdown('time', (text, node) => {
      if (!text) return;
      node.time = text;
    }),
    genericWrappedFromMarkdown('embedWikilink', (text, node) => {
      if (!text) return;

      const normalizedPath = getNormalizedPath(text);

      const file = stateManager.app.metadataCache.getFirstLinkpathDest(
        normalizedPath.root,
        stateManager.file.path
      );

      node.fileAccessor = {
        target: normalizedPath.root,
        isEmbed: true,
        stats: file?.stat,
      } as FileAccessor;
    }),
    genericWrappedFromMarkdown('wikilink', (text, node) => {
      if (!text) return;

      const normalizedPath = getNormalizedPath(text);

      const file = stateManager.app.metadataCache.getFirstLinkpathDest(
        normalizedPath.root,
        stateManager.file.path
      );

      node.fileAccessor = {
        target: normalizedPath.root,
        isEmbed: false,
      } as FileAccessor;

      if (file) {
        const metadata = getLinkedPageMetadata(stateManager, file);

        node.fileMetadata = metadata.fileMetadata;
        node.fileMetadataOrder = metadata.fileMetadataOrder;
      }
    }),
    internalMarkdownLinks((node, isEmbed) => {
      if (!node.url || /:\/\//.test(node.url) || !/.md$/.test(node.url)) {
        return;
      }

      const file = stateManager.app.metadataCache.getFirstLinkpathDest(
        decodeURIComponent(node.url),
        stateManager.file.path
      );

      if (isEmbed) {
        node.type = 'embedLink';
        node.fileAccessor = {
          target: decodeURIComponent(node.url),
          isEmbed: true,
          stats: file.stat,
        } as FileAccessor;
      } else {
        node.fileAccessor = {
          target: decodeURIComponent(node.url),
          isEmbed: false,
        } as FileAccessor;

        if (file) {
          const metadata = getLinkedPageMetadata(stateManager, file);

          node.fileMetadata = metadata.fileMetadata;
          node.fileMetadataOrder = metadata.fileMetadataOrder;
        }
      }
    }),
    tagFromMarkdown(),
    blockidFromMarkdown(),
  ];

  // 包装所有扩展，确保创建的节点都有 children 属性
  return extensions.map(ext => wrapExtension(ext));
}

export function parseMarkdown(stateManager: StateManager, md: string) {
  try {
    console.log('🔍 [DEBUG] parseMarkdown: 开始解析');
    const mdFrontmatter = extractFrontmatter(md);
    console.log('🔍 [DEBUG] parseMarkdown: frontmatter 提取成功');
    const mdSettings = extractSettingsFooter(md);
    console.log('🔍 [DEBUG] parseMarkdown: settings 提取成功');
    const settings = { ...mdSettings };
    const fileFrontmatter: Record<string, any> = {};

    Object.keys(mdFrontmatter).forEach((key) => {
      if (key === frontmatterKey) {
        const val = mdFrontmatter[key] === 'basic' ? 'board' : mdFrontmatter[key];
        settings[key] = val;
        fileFrontmatter[key] = val;
      } else if (settingKeyLookup.has(key as keyof KanbanSettings)) {
        settings[key] = mdFrontmatter[key];
      } else {
        fileFrontmatter[key] = mdFrontmatter[key];
      }
    });

    stateManager.compileSettings(settings);
    console.log('🔍 [DEBUG] parseMarkdown: 准备调用 fromMarkdown');

    let ast: any;
    try {
      ast = fromMarkdown(md, {
        extensions: [frontmatter(['yaml']), ...getExtensions(stateManager)],
        mdastExtensions: [frontmatterFromMarkdown(['yaml']), ...getMdastExtensions(stateManager)],
      });
      console.log('🔍 [DEBUG] parseMarkdown: fromMarkdown 调用成功', {
        astType: ast?.type,
        hasChildren: 'children' in ast,
        childrenIsArray: Array.isArray(ast?.children),
      });
      
      // 立即清理 AST，确保所有 children 都是有效的数组
      // 这必须在返回之前完成，因为后续的代码可能会使用 visit 函数
      console.log('🔍 [DEBUG] parseMarkdown: 开始清理 AST');
      try {
        ast = ensureChildrenAreArrays(ast, 0);
        console.log('🔍 [DEBUG] parseMarkdown: AST 清理成功', {
          astType: ast?.type,
          hasChildren: 'children' in ast,
          childrenIsArray: Array.isArray(ast?.children),
          childrenLength: Array.isArray(ast?.children) ? ast.children.length : 'N/A',
        });
      } catch (cleanError) {
        console.error('❌ [DEBUG] parseMarkdown: AST 清理失败:', cleanError);
        if (cleanError instanceof Error) {
          console.error('❌ [DEBUG] parseMarkdown: AST 清理错误堆栈:', cleanError.stack);
        }
        // 即使清理失败，也继续使用原始 AST
      }
    } catch (fromMarkdownError) {
      console.error('❌ [DEBUG] parseMarkdown: fromMarkdown 调用失败:', fromMarkdownError);
      if (fromMarkdownError instanceof Error) {
        console.error('❌ [DEBUG] parseMarkdown: fromMarkdown 错误堆栈:', fromMarkdownError.stack);
      }
      throw fromMarkdownError;
    }

    return {
      settings,
      frontmatter: fileFrontmatter,
      ast,
    };
  } catch (error) {
    console.error('❌ [DEBUG] parseMarkdown: 整体错误:', error);
    if (error instanceof Error) {
      console.error('❌ [DEBUG] parseMarkdown: 错误堆栈:', error.stack);
    }
    throw error;
  }
}

export function parseFragment(stateManager: StateManager, md: string) {
  return fromMarkdown(md, {
    extensions: getExtensions(stateManager),
    mdastExtensions: getMdastExtensions(stateManager),
  });
}
