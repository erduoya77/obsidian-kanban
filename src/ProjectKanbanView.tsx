import EventEmitter from 'eventemitter3';
import {
  HoverParent,
  HoverPopover,
  ItemView,
  Menu,
  Platform,
  TFile,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { createPortal, render } from 'preact/compat';

import { KanbanFormat, KanbanViewSettings } from './Settings';
import { Kanban } from './components/Kanban';
import { BasicMarkdownRenderer } from './components/MarkdownRenderer/MarkdownRenderer';
import { c } from './components/helpers';
import { Board } from './components/types';
import { getParentWindow } from './dnd/util/getWindow';
import { bindMarkdownEvents } from './helpers/renderMarkdown';
import { PromiseQueue } from './helpers/util';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';
import { ProjectStateManager } from './ProjectStateManager';

export const projectKanbanViewType = 'project-kanban';
export const projectKanbanIcon = 'lucide-folder-kanban';

/**
 * 创建一个虚拟文件用于承载项目看板视图
 */
function createVirtualFile(): TFile {
  return {
    path: 'project-kanban-view://virtual',
    name: 'Projects Kanban',
    basename: 'Projects Kanban',
    extension: 'md',
    stat: {
      ctime: 0,
      mtime: 0,
      size: 0,
    },
    vault: null as any,
  } as TFile;
}

export class ProjectKanbanView extends ItemView implements HoverParent {
  plugin: KanbanPlugin;
  hoverPopover: HoverPopover | null;
  emitter: EventEmitter;
  actionButtons: Record<string, HTMLElement> = {};

  previewCache: Map<string, BasicMarkdownRenderer>;
  previewQueue: PromiseQueue;

  activeEditor: any;
  viewSettings: KanbanViewSettings = {};
  
  virtualFile: TFile;
  projectStateManager: ProjectStateManager;

  get id(): string {
    return `${(this.leaf as any).id}:::project-kanban-view`;
  }

  get isShiftPressed(): boolean {
    return this.plugin.isShiftPressed;
  }

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.emitter = new EventEmitter();
    this.previewCache = new Map();
    this.virtualFile = createVirtualFile();

    this.previewQueue = new PromiseQueue(() => this.emitter.emit('queueEmpty'));

    // 创建项目状态管理器
    this.projectStateManager = new ProjectStateManager(
      this.app,
      this,
      () => this.plugin.settings
    );

    bindMarkdownEvents(this);
  }

  getViewType() {
    return projectKanbanViewType;
  }

  getIcon() {
    return projectKanbanIcon;
  }

  getDisplayText() {
    return 'Projects Kanban';
  }

  getWindow() {
    return getParentWindow(this.containerEl) as Window & typeof globalThis;
  }

  async prerender(board: Board) {
    board.children.forEach((lane) => {
      lane.children.forEach((item) => {
        if (this.previewCache.has(item.id)) return;

        this.previewQueue.add(async () => {
          const preview = this.addChild(new BasicMarkdownRenderer(this as any, item.data.title));
          this.previewCache.set(item.id, preview);
          await preview.renderCapability.promise;
        });
      });
    });

    if (this.previewQueue.isRunning) {
      await new Promise((res) => {
        this.emitter.once('queueEmpty', res);
      });
    }

    this.initHeaderButtons();
  }

  validatePreviewCache(board: Board) {
    const seenKeys = new Set<string>();
    board.children.forEach((lane) => {
      seenKeys.add(lane.id);
      lane.children.forEach((item) => {
        seenKeys.add(item.id);
      });
    });

    for (const k of this.previewCache.keys()) {
      if (!seenKeys.has(k)) {
        this.removeChild(this.previewCache.get(k));
        this.previewCache.delete(k);
      }
    }
  }

  setView(view: KanbanFormat) {
    this.setViewState(frontmatterKey, view);
  }

  setBoard(board: Board, shouldSave: boolean = true) {
    // 项目看板视图不支持直接设置看板
    // 所有更改都需要通过 ProjectStateManager 处理
  }

  getBoard(): Board {
    return this.projectStateManager.getBoard();
  }

  async onOpen() {
    console.log('🔍 [DEBUG] ProjectKanbanView.onOpen: 开始');
    
    // 订阅状态变化 - 使用防抖避免频繁渲染
    let renderTimeout: number | null = null;
    let isRendering = false;
    
    const stateUpdateHandler = (board: Board) => {
      // 如果正在渲染，跳过这次更新
      if (isRendering) {
        return;
      }
      
      console.log('🔍 [DEBUG] ProjectKanbanView.onOpen: 收到状态更新', {
        boardChildren: board?.children?.length || 0,
      });
      
      // 清除之前的定时器
      if (renderTimeout !== null) {
        clearTimeout(renderTimeout);
      }
      
      // 延迟渲染，避免频繁更新
      renderTimeout = window.setTimeout(() => {
        isRendering = true;
        try {
          this.validatePreviewCache(board);
          this.prerender(board);
          this.renderPortal();
        } catch (e) {
          console.error('Error in stateUpdateHandler:', e);
        } finally {
          isRendering = false;
          renderTimeout = null;
        }
      }, 100); // 增加延迟时间到 100ms
    };
    
    this.projectStateManager.stateReceivers.push(stateUpdateHandler);

    // 确保项目文件扫描完成
    console.log('🔍 [DEBUG] ProjectKanbanView.onOpen: 等待项目文件扫描完成');
    await this.projectStateManager.scanProjectFiles();
    
    // 初始化视图
    const board = this.projectStateManager.getBoard();
    console.log('🔍 [DEBUG] ProjectKanbanView.onOpen: 获取 board', {
      boardChildren: board?.children?.length || 0,
      boardId: board?.id,
    });
    await this.prerender(board);
    
    // 渲染看板组件 - 直接渲染到 contentEl
    console.log('🔍 [DEBUG] ProjectKanbanView.onOpen: 渲染看板');
    this.renderPortal();
  }

  renderPortal() {
    console.log('🔍 [DEBUG] renderPortal: 开始渲染', {
      contentElExists: !!this.contentEl,
      contentElChildren: this.contentEl?.children.length || 0,
    });
    
    const portal = this.getPortal();
    console.log('🔍 [DEBUG] renderPortal: portal 创建成功', {
      portalType: typeof portal,
      portalProps: portal?.props ? Object.keys(portal.props) : 'N/A',
    });
    
    const { DndContext } = require('./dnd/components/DndContext');
    const { DragOverlay } = require('./dnd/components/DragOverlay');
    const { getEntityFromPath } = require('./dnd/util/data');
    const { getProjectBoardModifiers } = require('./helpers/projectBoardModifiers');
    const { moveEntity } = require('./dnd/util/data');
    const { DataTypes } = require('./components/types');
    
    // 创建拖拽处理函数
    const handleDrop = (dragEntity: any, dropEntity: any) => {
      if (!dragEntity || !dropEntity) {
        console.log('🔍 [DEBUG] handleDrop: dragEntity 或 dropEntity 为空');
        return;
      }
      
      const dragPath = dragEntity.getPath();
      const dropPath = dropEntity.getPath();
      
      console.log('🔍 [DEBUG] handleDrop: 拖拽路径', {
        dragPath,
        dropPath,
        dragType: dragEntity.getData()?.type,
        dropType: dropEntity.getData()?.type,
      });
      
      // 检查是否在同一项目文件内（通过 lane ID 判断）
      const board = this.projectStateManager.getBoard();
      
      // 获取拖拽源和目标所在的 lane
      const dragLaneIndex = dragPath[0] as number;
      const dropLaneIndex = dropPath[0] as number;
      const dragLane = board.children[dragLaneIndex];
      const dropLane = board.children[dropLaneIndex];
      
      if (!dragLane || !dropLane) {
        console.warn('🔍 [DEBUG] handleDrop: lane 不存在', {
          dragLaneIndex,
          dropLaneIndex,
          hasDragLane: !!dragLane,
          hasDropLane: !!dropLane,
        });
        return;
      }
      
      // 提取项目文件路径
      const dragProject = dragLane.id.split(':::')[0];
      const dropProject = dropLane.id.split(':::')[0];
      
      console.log('🔍 [DEBUG] handleDrop: 项目检查', {
        dragProject,
        dropProject,
        isSameProject: dragProject === dropProject,
      });
      
      // 只允许在同一项目文件内拖拽
      if (dragProject !== dropProject) {
        console.warn('Cannot drag items between different projects');
        return;
      }
      
      // 使用 projectBoardModifiers 处理拖拽
      const boardModifiers = getProjectBoardModifiers(this, this.projectStateManager);
      
      // 执行移动操作
      console.log('🔍 [DEBUG] handleDrop: 执行移动操作');
      this.projectStateManager.setState((boardData) => {
        const entity = getEntityFromPath(boardData, dragPath);
        if (!entity) {
          console.warn('🔍 [DEBUG] handleDrop: 无法找到拖拽实体');
          return boardData;
        }
        const newBoard = moveEntity(boardData, dragPath, dropPath);
        console.log('🔍 [DEBUG] handleDrop: 移动完成');
        return newBoard;
      }, true); // 确保保存到文件
    };
    
    // 包裹在 DndContext 中以支持拖拽
    const wrappedPortal = (
      <DndContext win={this.getWindow()} onDrop={handleDrop}>
        {portal}
        <DragOverlay>
          {() => <div />}
        </DragOverlay>
      </DndContext>
    );
    
    console.log('🔍 [DEBUG] renderPortal: wrappedPortal 创建成功', {
      wrappedPortalType: typeof wrappedPortal,
    });
    
    // 清除之前的内容（使用 unmountComponentAtNode 来正确卸载）
    const { unmountComponentAtNode } = require('preact/compat');
    if (this.contentEl.children.length > 0) {
      try {
        unmountComponentAtNode(this.contentEl);
        console.log('🔍 [DEBUG] renderPortal: 卸载旧组件成功');
      } catch (e) {
        console.warn('🔍 [DEBUG] renderPortal: 卸载旧组件失败，使用 empty()', e);
        this.contentEl.empty();
      }
    } else {
      this.contentEl.empty();
    }
    console.log('🔍 [DEBUG] renderPortal: contentEl 已清空', {
      childrenCount: this.contentEl?.children.length || 0,
    });
    
    // 渲染组件
    try {
      render(wrappedPortal, this.contentEl);
      console.log('🔍 [DEBUG] renderPortal: render 调用成功', {
        contentElChildrenAfter: this.contentEl?.children.length || 0,
        contentElHTML: this.contentEl?.innerHTML?.substring(0, 200) || 'empty',
      });
      
      // 等待一下，检查是否异步渲染
      setTimeout(() => {
        console.log('🔍 [DEBUG] renderPortal: 延迟检查', {
          contentElChildrenAfter: this.contentEl?.children.length || 0,
          contentElHTML: this.contentEl?.innerHTML?.substring(0, 200) || 'empty',
        });
      }, 100);
    } catch (error) {
      console.error('❌ [DEBUG] renderPortal: render 调用失败', error);
      throw error;
    }
  }

  async onClose() {
    // 取消订阅
    const index = this.projectStateManager.stateReceivers.findIndex(
      (receiver) => receiver === this.renderPortal.bind(this)
    );
    if (index > -1) {
      this.projectStateManager.stateReceivers.splice(index, 1);
    }

    this.previewQueue.clear();
    this.previewCache.clear();
    this.emitter.emit('queueEmpty');
    this.emitter.removeAllListeners();
    this.activeEditor = null;
    this.actionButtons = {};
  }

  async setState(state: any, result: any): Promise<void> {
    if (state?.kanbanViewState) {
      this.viewSettings = { ...state.kanbanViewState };
    }
    await super.setState(state, result);
  }

  getState() {
    const state = super.getState();
    // 确保 state 对象存在且所有属性都是有效的
    if (!state) {
      return {
        file: this.virtualFile.path || '',
        kanbanViewState: { ...this.viewSettings },
      };
    }
    
    // 确保 file 属性是字符串，避免其他插件调用 .trim() 时报错
    if (state.file && typeof state.file !== 'string') {
      state.file = String(state.file);
    }
    if (!state.file || (typeof state.file === 'string' && state.file.trim() === '')) {
      state.file = this.virtualFile.path || 'project-kanban-view://virtual';
    }
    
    state.kanbanViewState = { ...this.viewSettings };
    return state;
  }

  setViewState<K extends keyof KanbanViewSettings>(
    key: K,
    val?: KanbanViewSettings[K],
    globalUpdater?: (old: KanbanViewSettings[K]) => KanbanViewSettings[K]
  ) {
    if (globalUpdater) {
      this.viewSettings[key] = globalUpdater(this.viewSettings[key]);
    } else if (val) {
      this.viewSettings[key] = val;
    }

    this.app.workspace.requestSaveLayout();
  }

  populateViewState(settings: any) {
    this.viewSettings['kanban-plugin'] ??= settings['kanban-plugin'] || 'board';
    this.viewSettings['list-collapse'] ??= settings['list-collapse'] || [];
  }

  // Obsidian 的 ItemView.getViewState() 返回文件路径字符串
  // 我们需要重写它以返回虚拟文件路径，避免其他插件调用 .trim() 时报错
  // 同时支持带参数调用以获取视图设置（我们的代码使用）
  getViewState(): string;
  getViewState<K extends keyof KanbanViewSettings>(key: K): KanbanViewSettings[K];
  getViewState<K extends keyof KanbanViewSettings>(key?: K): string | KanbanViewSettings[K] {
    // 如果没有参数，返回文件路径（Obsidian 核心代码调用）
    if (key === undefined) {
      return this.virtualFile.path || 'project-kanban-view://virtual';
    }
    // 如果有参数，返回视图设置（我们的代码调用）
    const value = this.viewSettings[key] ?? this.projectStateManager.getSetting(key);
    // 确保返回值不是 undefined
    if (value === undefined || value === null) {
      if (key === 'kanban-plugin') {
        return 'board' as any;
      }
      if (key === 'list-collapse') {
        return [] as any;
      }
      return '' as any;
    }
    return value;
  }

  useViewState<K extends keyof KanbanViewSettings>(key: K) {
    const settingVal = this.projectStateManager.useSetting(key);
    return this.viewSettings[key] ?? settingVal;
  }

  getPortal() {
    return <Kanban stateManager={this.projectStateManager as any} view={this as any} />;
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source !== 'more-options') {
      return;
    }

    menu
      .addItem((item) => {
        item
          .setTitle(t('Refresh projects'))
          .setIcon('lucide-refresh-cw')
          .setSection('pane')
          .onClick(() => {
            this.projectStateManager.scanProjectFiles();
          });
      });
  }

  initHeaderButtons = debounce(() => this._initHeaderButtons(), 10, true);

  _initHeaderButtons = async () => {
    if (Platform.isPhone) return;

    if (!this.actionButtons['refresh-projects']) {
      this.actionButtons['refresh-projects'] = this.addAction(
        'lucide-refresh-cw',
        t('Refresh projects'),
        () => {
          this.projectStateManager.scanProjectFiles();
        }
      );
    }
  };
}

