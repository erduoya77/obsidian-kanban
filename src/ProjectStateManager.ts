import update from 'immutability-helper';
import { App, TFile } from 'obsidian';
import { useEffect, useState } from 'preact/compat';

import { ProjectKanbanView } from './ProjectKanbanView';
import { KanbanSettings } from './Settings';
import { Board, BoardTemplate, Item, Lane, LaneTemplate } from './components/types';
import { StateManager } from './StateManager';
import { frontmatterKey } from './parsers/common';
import { parseMarkdown } from './parsers/parseMarkdown';
import { astToUnhydratedBoard } from './parsers/formats/list';

export interface ProjectFile {
  file: TFile;
  board: Board;
  stateManager: {
    file: TFile;
    parser: any;
    originalContent: string;
  };
}

export class ProjectStateManager {
  app: App;
  view: ProjectKanbanView;
  getGlobalSettings: () => KanbanSettings;

  stateReceivers: Array<(state: Board) => void> = [];
  projectFiles: Map<string, ProjectFile> = new Map();
  aggregatedBoard: Board;
  errors: Array<{ file: TFile; error: Error }> = [];
  
  // 虚拟文件，用于兼容需要 file 属性的代码
  file: TFile;
  
  // 扫描状态
  private scanPromise: Promise<void> | null = null;

  constructor(
    app: App,
    view: ProjectKanbanView,
    getGlobalSettings: () => KanbanSettings
  ) {
    this.app = app;
    this.view = view;
    this.getGlobalSettings = getGlobalSettings;

    // 创建虚拟文件用于兼容需要 file 属性的代码
    this.file = {
      path: 'project-kanban-view://virtual',
      name: 'Projects Kanban',
      basename: 'Projects Kanban',
      extension: 'md',
      stat: {
        ctime: 0,
        mtime: 0,
        size: 0,
      },
      vault: app.vault,
    } as TFile;

    // 初始化聚合看板
    this.aggregatedBoard = {
      ...BoardTemplate,
      id: 'project-aggregated-board',
      children: [],
      data: {
        archive: [],
        settings: { [frontmatterKey]: 'board' },
        frontmatter: {},
        isSearching: false,
        errors: [],
      },
    };

    // 异步扫描项目文件，但不阻塞构造函数
    // 保存 promise，以便在需要时等待
    this.scanPromise = this.scanProjectFiles().catch((e) => {
      console.error('Error scanning project files:', e);
    });
    this.registerFileWatchers();
  }

  /**
   * 扫描所有包含 project frontmatter 的文件
   */
  async scanProjectFiles() {
    // 如果已经有扫描在进行，等待它完成
    if (this.scanPromise) {
      console.log('🔍 [DEBUG] scanProjectFiles: 等待现有扫描完成');
      await this.scanPromise;
      // 如果等待后扫描已完成，直接返回
      if (this.projectFiles.size > 0) {
        console.log('🔍 [DEBUG] scanProjectFiles: 现有扫描已完成，跳过');
        return;
      }
    }
    
    console.log('🔍 [DEBUG] scanProjectFiles: 开始扫描');
    const projectFiles: TFile[] = [];
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const file of markdownFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter && cache.frontmatter['project']) {
        projectFiles.push(file);
      }
    }

    // 解析每个项目文件
    const newProjectFiles = new Map<string, ProjectFile>();
    const newErrors: Array<{ file: TFile; error: Error }> = [];

    for (const file of projectFiles) {
      try {
        const content = await this.app.vault.read(file);
        
        // 检查文件是否为空
        if (!content || content.trim().length === 0) {
          console.warn(`Project file ${file.path} is empty, skipping`);
          continue;
        }
        
        const tempStateManager = this.createTempStateManager(file);
        const board = await this.parseProjectFile(content, tempStateManager);
        
        // 验证 board 是否有效
        if (!board || !board.children) {
          throw new Error('Invalid board structure');
        }
        
        // 保存原始内容，用于后续保存
        newProjectFiles.set(file.path, {
          file,
          board,
          stateManager: {
            file,
            parser: null, // 延迟创建
            originalContent: content,
          } as any,
        });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        console.error(`Error parsing project file ${file.path}:`, error);
        newErrors.push({ file, error });
      }
    }

    this.projectFiles = newProjectFiles;
    this.errors = newErrors;
    
    // 如果有错误，在聚合看板中记录
    if (newErrors.length > 0) {
      this.aggregatedBoard = update(this.aggregatedBoard, {
        data: {
          errors: {
            $set: newErrors.map(({ file, error }) => ({
              description: `Error parsing ${file.path}: ${error.message}`,
              stack: error.stack || '',
            })),
          },
        },
      });
    }
    
    this.aggregateBoards();
    
    // 清除扫描 promise，表示扫描完成
    this.scanPromise = null;
    console.log('🔍 [DEBUG] scanProjectFiles: 扫描完成');
  }

  /**
   * 创建临时 StateManager 用于解析项目文件
   */
  createTempStateManager(file: TFile): any {
    // 创建一个临时的 StateManager-like 对象用于解析
    const compiledSettings: Partial<KanbanSettings> = {};
    
    return {
      app: this.app,
      file,
      getSetting: (key: keyof KanbanSettings) => {
        return compiledSettings[key] ?? this.getGlobalSettings()[key];
      },
      getGlobalSettings: this.getGlobalSettings,
      compileSettings: (settings: KanbanSettings) => {
        // 合并设置（简化版本）
        Object.assign(compiledSettings, settings);
      },
      compiledSettings,
      state: null,
      hasError: () => false,
    };
  }

  /**
   * 递归清理 AST 节点，确保所有 children 都是数组
   * 这是深度清理，确保 visit 函数不会访问 undefined.length
   */
  private sanitizeAST(node: any): any {
    if (!node || typeof node !== 'object') {
      return node;
    }

    // 如果是数组，递归处理每个元素
    if (Array.isArray(node)) {
      return node.map((child: any) => this.sanitizeAST(child)).filter((child: any) => child !== null && child !== undefined);
    }

    // 创建新对象，避免修改原始对象
    const sanitized: any = { ...node };

    // 确保所有可能有 children 的节点都有有效的 children 数组
    if ('children' in node) {
      // 先检查 children 是否存在且是数组
      if (node.children === undefined || node.children === null) {
        sanitized.children = [];
      } else if (!Array.isArray(node.children)) {
        // 如果 children 不是数组，设置为空数组
        sanitized.children = [];
      } else {
        // 递归清理子节点，确保每个子节点都被清理
        sanitized.children = node.children
          .map((child: any) => {
            try {
              return this.sanitizeAST(child);
            } catch (e) {
              console.warn('Error sanitizing child node:', e);
              return null;
            }
          })
          .filter((child: any) => child !== null && child !== undefined);
      }
    }

    return sanitized;
  }

  /**
   * 解析项目文件内容为 Board
   */
  async parseProjectFile(content: string, tempStateManager: any): Promise<Board> {
    try {
      console.log('🔍 [DEBUG] ========== 开始解析文件 ==========');
      console.log('🔍 [DEBUG] 文件路径:', tempStateManager.file.path);
      console.log('🔍 [DEBUG] 文件内容长度:', content.length);
      console.log('🔍 [DEBUG] 文件内容前 500 字符:', content.substring(0, 500));
      
      let ast: any;
      let settings: any;
      let frontmatter: any;
      
      try {
        console.log('🔍 [DEBUG] 准备调用 parseMarkdown...');
        const result = parseMarkdown(tempStateManager, content);
        settings = result.settings;
        frontmatter = result.frontmatter;
        ast = result.ast;
        console.log('🔍 [DEBUG] parseMarkdown 调用成功');
      } catch (parseError) {
        console.error('❌ [DEBUG] parseMarkdown 调用失败:', parseError);
        if (parseError instanceof Error) {
          console.error('❌ [DEBUG] parseMarkdown 错误堆栈:', parseError.stack);
        }
        throw parseError;
      }
      
      try {
        console.log('🔍 [DEBUG] AST 基本信息:', {
          type: ast?.type,
          hasChildren: 'children' in ast,
          childrenValue: ast?.children,
          childrenIsArray: Array.isArray(ast?.children),
          childrenLength: Array.isArray(ast?.children) ? ast.children.length : 'N/A',
        });
      } catch (logError) {
        console.error('❌ [DEBUG] 打印 AST 基本信息时出错:', logError);
        console.error('❌ [DEBUG] ast 值:', ast);
        throw logError;
      }
      
      // 检查 ast 是否有效
      if (!ast) {
        throw new Error('AST is null or undefined');
      }
      
      if (!ast.children) {
        console.warn('⚠️ [DEBUG] AST has no children property, creating empty children array');
        ast.children = [];
      }
      
      if (!Array.isArray(ast.children)) {
        console.warn('⚠️ [DEBUG] AST.children is not an array, converting to array');
        ast.children = [];
      }
      
      // 深度检查 AST 结构，找出所有可能有问题的节点
      function checkAST(node: any, path: string = 'root', depth: number = 0): void {
        if (depth > 10) return; // 防止无限递归
        
        if (!node || typeof node !== 'object') return;
        
        const nodeType = node.type || 'unknown';
        const hasChildren = 'children' in node;
        const childrenValue = node.children;
        const childrenIsArray = Array.isArray(childrenValue);
        const childrenIsUndefined = childrenValue === undefined;
        const childrenIsNull = childrenValue === null;
        
        // 检查潜在问题
        if (hasChildren && (childrenIsUndefined || childrenIsNull || !childrenIsArray)) {
          console.warn(`⚠️ [DEBUG] ${path}:`, {
            type: nodeType,
            hasChildren,
            childrenValue,
            childrenIsArray,
            childrenIsUndefined,
            childrenIsNull,
            issue: childrenIsUndefined ? 'children 是 undefined' : childrenIsNull ? 'children 是 null' : 'children 不是数组',
          });
        }
        
        // 递归检查子节点
        if (hasChildren && childrenIsArray && childrenValue.length > 0) {
          childrenValue.forEach((child: any, index: number) => {
            if (child && typeof child === 'object') {
              checkAST(child, `${path}.children[${index}]`, depth + 1);
            }
          });
        }
      }
      
      console.log('🔍 [DEBUG] ========== 检查 AST 结构 ==========');
      checkAST(ast, 'ast');
      
      // 清理 AST，确保所有 children 都是有效的数组
      // 这必须在调用 astToUnhydratedBoard 之前完成
      console.log('🔍 [DEBUG] ========== 清理 AST ==========');
      const sanitizedAST = this.sanitizeAST(ast);
      
      console.log('🔍 [DEBUG] 清理后的 AST:', {
        type: sanitizedAST?.type,
        hasChildren: 'children' in sanitizedAST,
        childrenIsArray: Array.isArray(sanitizedAST?.children),
        childrenLength: Array.isArray(sanitizedAST?.children) ? sanitizedAST.children.length : 'N/A',
      });
      
      // 再次检查清理后的 AST
      if (!sanitizedAST || !sanitizedAST.children || !Array.isArray(sanitizedAST.children)) {
        throw new Error('Sanitized AST is invalid');
      }
      
      // 再次深度检查清理后的 AST
      console.log('🔍 [DEBUG] ========== 检查清理后的 AST ==========');
      checkAST(sanitizedAST, 'sanitizedAST');
      
      tempStateManager.compileSettings(settings);

      console.log('🔍 [DEBUG] ========== 调用 astToUnhydratedBoard ==========');
      const board = astToUnhydratedBoard(
        tempStateManager,
        settings,
        frontmatter,
        sanitizedAST,
        content
      );

      console.log('✅ [DEBUG] 解析成功，board children 数量:', board.children.length);
      return board;
    } catch (e) {
      console.error('Error parsing project file:', tempStateManager.file.path, e);
      if (e instanceof Error) {
        console.error('Error stack:', e.stack);
      }
      // 返回一个空的 board
      return {
        ...BoardTemplate,
        id: tempStateManager.file.path,
        children: [],
        data: {
          archive: [],
          settings: { [frontmatterKey]: 'board' },
          frontmatter: {},
          isSearching: false,
          errors: [{ description: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : '' }],
        },
      };
    }
  }

  /**
   * 聚合所有项目的看板数据
   */
  aggregateBoards() {
    console.log('🔍 [DEBUG] aggregateBoards: 开始聚合，项目文件数量:', this.projectFiles.size);
    const aggregatedLanes: Lane[] = [];

    // 遍历所有项目文件
    for (const [filePath, projectFile] of this.projectFiles.entries()) {
      console.log(`🔍 [DEBUG] aggregateBoards: 处理项目文件 ${filePath}`, {
        hasBoard: !!projectFile.board,
        hasChildren: !!projectFile.board?.children,
        childrenIsArray: Array.isArray(projectFile.board?.children),
        childrenLength: Array.isArray(projectFile.board?.children) ? projectFile.board.children.length : 'N/A',
      });
      // 检查 board 和 board.children 是否存在
      if (!projectFile.board || !projectFile.board.children || !Array.isArray(projectFile.board.children)) {
        console.warn(`Project file ${filePath} has invalid board structure, skipping`);
        continue;
      }
      
      const projectName = projectFile.file.basename;
      
      // 遍历项目的每个 lane
      projectFile.board.children.forEach((lane, laneIndex) => {
        // 检查 lane 是否存在
        if (!lane) {
          console.warn(`Lane at index ${laneIndex} in project ${filePath} is undefined, skipping`);
          return;
        }
        
        // 检查 lane.children 是否存在
        const laneChildren = lane.children && Array.isArray(lane.children) ? lane.children : [];
        
        // 文件名就是项目名，不需要在标题前添加项目名称
        // 保持原始标题不变
        const originalTitle = lane.data?.title || 'Untitled';
        
        // 创建新的 lane，保持原始标题
        const aggregatedLane: Lane = {
          ...LaneTemplate,
          id: `${filePath}:::${lane.id || `lane-${laneIndex}`}`,
          data: {
            ...lane.data,
            title: originalTitle,
          },
          children: laneChildren.map((item) => {
            // 检查 item 是否存在
            if (!item) {
              console.warn(`Item in lane ${lane.id} is undefined, skipping`);
              return null;
            }
            return {
              ...item,
              id: `${filePath}:::${lane.id || `lane-${laneIndex}`}:::${item.id || 'unknown'}`,
              // 保存原始信息，用于后续写回文件
              data: {
                ...item.data,
                projectFile: projectFile.file,
                projectLaneId: lane.id || `lane-${laneIndex}`,
                projectItemId: item.id || 'unknown',
              },
            };
          }).filter((item) => item !== null) as Item[],
        };

        aggregatedLanes.push(aggregatedLane);
      });
    }

    console.log('🔍 [DEBUG] aggregateBoards: 聚合完成，lanes 数量:', aggregatedLanes.length);
    console.log('🔍 [DEBUG] aggregateBoards: aggregatedLanes:', aggregatedLanes.map(l => ({
      id: l.id,
      title: l.data?.title,
      childrenLength: l.children?.length || 0,
    })));

    this.aggregatedBoard = update(this.aggregatedBoard, {
      children: { $set: aggregatedLanes },
    });

    console.log('🔍 [DEBUG] aggregateBoards: 更新后的 aggregatedBoard:', {
      id: this.aggregatedBoard.id,
      childrenLength: this.aggregatedBoard.children?.length || 0,
      receiversCount: this.stateReceivers.length,
    });

    // 通知所有接收者
    this.stateReceivers.forEach((receiver) => {
      console.log('🔍 [DEBUG] aggregateBoards: 通知接收者');
      receiver(this.aggregatedBoard);
    });
  }

  /**
   * 注册文件监听器
   */
  registerFileWatchers() {
    // 监听文件修改
    this.app.vault.on('modify', async (file: TFile) => {
      if (file instanceof TFile && this.projectFiles.has(file.path)) {
        await this.scanProjectFiles();
      }
    });

    // 监听文件重命名
    this.app.vault.on('rename', async (file: TFile, oldPath: string) => {
      if (file instanceof TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        const hadProject = this.projectFiles.has(oldPath);
        const hasProject = !!(cache?.frontmatter && cache.frontmatter['project']);

        if (hadProject || hasProject) {
          await this.scanProjectFiles();
        }
      }
    });

    // 监听 metadata 变化
    this.app.metadataCache.on('changed', async (file: TFile) => {
      if (file instanceof TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        const hasProject = !!(cache?.frontmatter && cache.frontmatter['project']);
        const wasProject = this.projectFiles.has(file.path);

        if (hasProject !== wasProject) {
          await this.scanProjectFiles();
        } else if (hasProject) {
          await this.scanProjectFiles();
        }
      }
    });
  }

  /**
   * 获取聚合后的看板
   */
  getBoard(): Board {
    return this.aggregatedBoard;
  }

  /**
   * 设置聚合看板状态，并同步到对应的项目文件
   */
  setState(updater: Board | ((board: Board) => Board), shouldSave: boolean = true) {
    const newBoard = typeof updater === 'function' ? updater(this.aggregatedBoard) : updater;
    
    // 验证 board 结构
    if (!newBoard || !newBoard.children || !Array.isArray(newBoard.children)) {
      console.error('Invalid board structure in setState:', newBoard);
      return;
    }
    
    // 更新聚合看板
    this.aggregatedBoard = newBoard;
    
    // 通知所有接收者（使用防抖避免频繁更新）
    if (this.stateReceivers.length > 0) {
      // 使用 requestAnimationFrame 延迟通知，避免在同步过程中触发更新
      requestAnimationFrame(() => {
        this.stateReceivers.forEach((receiver) => {
          try {
            receiver(this.aggregatedBoard);
          } catch (e) {
            console.error('Error in state receiver:', e);
          }
        });
      });
    }

    if (shouldSave) {
      // 异步保存，避免阻塞
      this.syncToProjectFiles(newBoard).catch((e) => {
        console.error('Error syncing to project files:', e);
      });
    }
  }

  /**
   * 将聚合看板的更改同步回各个项目文件
   */
  async syncToProjectFiles(aggregatedBoard: Board) {
    // 验证 board 结构
    if (!aggregatedBoard || !aggregatedBoard.children || !Array.isArray(aggregatedBoard.children)) {
      console.error('Invalid board structure in syncToProjectFiles:', aggregatedBoard);
      return;
    }
    
    // 按项目文件分组 lanes
    const projectLanesMap = new Map<string, { lane: Lane; aggregatedIndex: number }[]>();

    aggregatedBoard.children.forEach((aggregatedLane, index) => {
      if (!aggregatedLane || !aggregatedLane.id) {
        console.warn('Invalid lane at index', index);
        return;
      }
      const parts = aggregatedLane.id.split(':::');
      if (parts.length >= 2) {
        const filePath = parts[0];
        const originalLaneId = parts[1];

        if (!projectLanesMap.has(filePath)) {
          projectLanesMap.set(filePath, []);
        }

        projectLanesMap.get(filePath)!.push({
          lane: aggregatedLane,
          aggregatedIndex: index,
        });
      }
    });

    // 更新每个项目文件
    for (const [filePath, lanes] of projectLanesMap.entries()) {
      const projectFile = this.projectFiles.get(filePath);
      if (!projectFile) continue;

      // 重建项目文件的 board
      const updatedLanes: Lane[] = projectFile.board.children.map((originalLane) => {
        // 找到对应的聚合 lane
        const aggregatedLane = lanes.find((l) => l.lane.id === `${filePath}:::${originalLane.id}`);
        
        if (!aggregatedLane) {
          // 如果没有找到，保持原样
          return originalLane;
        }

        // 将聚合 lane 的 items 转换回原始格式
        const updatedItems: Item[] = aggregatedLane.lane.children.map((aggregatedItem) => {
          // 提取原始 item ID
          const itemParts = aggregatedItem.id.split(':::');
          const originalItemId = itemParts.slice(2).join(':::');

          // 找到原始 item
          const originalItem = originalLane.children.find((i) => i.id === originalItemId);
          if (!originalItem) {
            // 如果是新 item，创建它（移除项目信息）
            const newItemData = {
              ...aggregatedItem.data,
              projectFile: undefined as TFile | undefined,
              projectLaneId: undefined as string | undefined,
              projectItemId: undefined as string | undefined,
            };
            return {
              ...aggregatedItem,
              id: originalItemId || aggregatedItem.id,
              data: newItemData,
            };
          }

          // 更新 item，但保持原始 ID
          const updatedItemData = {
            ...aggregatedItem.data,
            projectFile: undefined as TFile | undefined,
            projectLaneId: undefined as string | undefined,
            projectItemId: undefined as string | undefined,
          };
          return {
            ...aggregatedItem,
            id: originalItemId,
            data: updatedItemData,
          };
        });

        return {
          ...originalLane,
          children: updatedItems,
        };
      });

      // 创建更新后的 board
      const updatedBoard = update(projectFile.board, {
        children: { $set: updatedLanes },
      });

      // 保存到文件
      await this.saveBoardToFile(projectFile.file, updatedBoard);
    }

    // 重新扫描以更新内部状态
    await this.scanProjectFiles();
  }

  /**
   * 根据聚合后的 item ID 找到原始项目文件和 item
   */
  findOriginalItem(aggregatedItemId: string): {
    projectFile: ProjectFile;
    lane: Lane;
    item: Item;
  } | null {
    const parts = aggregatedItemId.split(':::');
    if (parts.length < 3) return null;

    const filePath = parts[0];
    const laneId = parts[1];
    const itemId = parts.slice(2).join(':::');

    const projectFile = this.projectFiles.get(filePath);
    if (!projectFile) return null;

    const lane = projectFile.board.children.find((l) => l.id === laneId);
    if (!lane) return null;

    const item = lane.children.find((i) => i.id === itemId);
    if (!item) return null;

    return { projectFile, lane, item };
  }

  /**
   * 更新项目文件中的 item
   */
  async updateItemInProjectFile(
    projectFile: ProjectFile,
    laneId: string,
    itemId: string,
    updatedItem: Item
  ) {
    // 找到对应的 lane 和 item
    const lane = projectFile.board.children.find((l) => l.id === laneId);
    if (!lane) return;

    const itemIndex = lane.children.findIndex((i) => i.id === itemId);
    if (itemIndex === -1) return;

    // 更新 board
    const updatedBoard = update(projectFile.board, {
      children: {
        [projectFile.board.children.indexOf(lane)]: {
          children: {
            [itemIndex]: { $set: updatedItem },
          },
        },
      },
    });

    // 保存到文件
    await this.saveBoardToFile(projectFile.file, updatedBoard);
  }

  /**
   * 将 Board 保存回文件
   */
  async saveBoardToFile(file: TFile, board: Board) {
    const projectFile = this.projectFiles.get(file.path);
    if (!projectFile) return;

    try {
      // 创建临时 StateManager 用于转换
      const tempView = {
        file,
        plugin: { stateManagers: new Map() },
      } as any;
      
      const tempStateManager = new StateManager(
        this.app,
        tempView,
        projectFile.stateManager.originalContent || '',
        () => {},
        this.getGlobalSettings
      );
      
      tempStateManager.state = board;
      const content = tempStateManager.parser.boardToMd(board);
      await this.app.vault.modify(file, content);
      
      // 更新原始内容缓存
      projectFile.stateManager.originalContent = content;
    } catch (e) {
      console.error(`Error saving project file ${file.path}:`, e);
    }
  }

  /**
   * 创建新 item（用于项目视图）
   */
  getNewItem(content: string, checkChar: string, forceEdit?: boolean): Item {
    // 使用第一个项目文件的 parser（所有项目文件使用相同的格式）
    const firstProject = Array.from(this.projectFiles.values())[0];
    if (!firstProject) {
      throw new Error('No project files available');
    }

    // 创建临时 StateManager 来生成 item
    const tempView = {
      file: firstProject.file,
      plugin: { stateManagers: new Map() },
    } as any;
    
    const tempStateManager = new StateManager(
      this.app,
      tempView,
      '',
      () => {},
      this.getGlobalSettings
    );

    return tempStateManager.getNewItem(content, checkChar, forceEdit);
  }

  /**
   * 更新 item 内容
   */
  updateItemContent(item: Item, content: string): Item {
    // 使用第一个项目文件的 parser
    const firstProject = Array.from(this.projectFiles.values())[0];
    if (!firstProject) {
      return item;
    }

    const tempView = {
      file: firstProject.file,
      plugin: { stateManagers: new Map() },
    } as any;
    
    const tempStateManager = new StateManager(
      this.app,
      tempView,
      '',
      () => {},
      this.getGlobalSettings
    );

    return tempStateManager.updateItemContent(item, content);
  }

  /**
   * React hook 用于订阅状态变化
   */
  useState(): Board {
    const [state, setState] = useState(this.aggregatedBoard);

    useEffect(() => {
      console.log('🔍 [DEBUG] ProjectStateManager.useState: 设置接收者', {
        currentBoardChildren: this.aggregatedBoard.children?.length || 0,
      });
      this.stateReceivers.push(setState);
      console.log('🔍 [DEBUG] ProjectStateManager.useState: 设置初始状态', {
        boardChildren: this.aggregatedBoard.children?.length || 0,
      });
      setState(this.aggregatedBoard);
      return () => {
        const index = this.stateReceivers.indexOf(setState);
        if (index > -1) {
          this.stateReceivers.splice(index, 1);
        }
      };
    }, []);

    console.log('🔍 [DEBUG] ProjectStateManager.useState: 返回状态', {
      stateChildren: state?.children?.length || 0,
      aggregatedBoardChildren: this.aggregatedBoard.children?.length || 0,
    });

    return state;
  }

  /**
   * 获取设置
   */
  getSetting<K extends keyof KanbanSettings>(key: K): KanbanSettings[K] {
    return this.getGlobalSettings()[key];
  }

  useSetting<K extends keyof KanbanSettings>(key: K): KanbanSettings[K] {
    return this.getSetting(key);
  }

  /**
   * 检查是否有错误（兼容 StateManager 接口）
   */
  hasError(): boolean {
    return this.errors.length > 0 || (this.aggregatedBoard?.data?.errors?.length || 0) > 0;
  }
}

