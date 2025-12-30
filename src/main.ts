import { around } from 'monkey-around';
import {
  MarkdownView,
  Platform,
  Plugin,
  TFile,
  TFolder,
  ViewState,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { render, unmountComponentAtNode, useEffect, useState } from 'preact/compat';

import { createApp } from './DragDropApp';
import { KanbanView, kanbanIcon, kanbanViewType } from './KanbanView';
import { ProjectKanbanView, projectKanbanIcon, projectKanbanViewType } from './ProjectKanbanView';
import { KanbanSettings, KanbanSettingsTab } from './Settings';
import { StateManager } from './StateManager';
import { DateSuggest, TimeSuggest } from './components/Editor/suggest';
import { getParentWindow } from './dnd/util/getWindow';
import { hasFrontmatterKey } from './helpers';
import { t } from './lang/helpers';
import { basicFrontmatter, frontmatterKey } from './parsers/common';

interface WindowRegistry {
  viewMap: Map<string, KanbanView>;
  viewStateReceivers: Array<(views: KanbanView[]) => void>;
  appRoot: HTMLElement;
}

function getEditorClass(app: any) {
  const md = app.embedRegistry.embedByExtension.md(
    { app: app, containerEl: createDiv(), state: {} },
    null,
    ''
  );

  md.load();
  md.editable = true;
  md.showEditor();

  const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

  md.unload();

  return MarkdownEditor;
}

export default class KanbanPlugin extends Plugin {
  settingsTab: KanbanSettingsTab;
  settings: KanbanSettings = {};

  // leafid => view mode
  kanbanFileModes: Record<string, string> = {};
  stateManagers: Map<TFile, StateManager> = new Map();

  windowRegistry: Map<Window, WindowRegistry> = new Map();

  _loaded: boolean = false;

  isShiftPressed: boolean = false;

  async loadSettings() {
    this.settings = Object.assign({}, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  unload(): void {
    super.unload();
    // 不再需要处理单文件看板视图的卸载
    // 项目看板视图会自动清理
  }

  onunload() {
    this.MarkdownEditor = null;
    this.windowRegistry.forEach((reg, win) => {
      reg.viewStateReceivers.forEach((fn) => fn([]));
      this.unmount(win);
    });

    this.unmount(window);

    this.stateManagers.clear();
    this.windowRegistry.clear();
    this.kanbanFileModes = {};

    (this.app.workspace as any).unregisterHoverLinkSource(frontmatterKey);
  }

  MarkdownEditor: any;

  async onload() {
    await this.loadSettings();

    this.MarkdownEditor = getEditorClass(this.app);

    this.registerEditorSuggest(new TimeSuggest(this.app, this));
    this.registerEditorSuggest(new DateSuggest(this.app, this));

    this.registerEvent(
      this.app.workspace.on('window-open', (_: any, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      this.app.workspace.on('window-close', (_: any, win: Window) => {
        this.unmount(win);
      })
    );

    this.settingsTab = new KanbanSettingsTab(this, {
      onSettingsChange: async (newSettings) => {
        this.settings = newSettings;
        await this.saveSettings();

        // Force a complete re-render when settings change
        this.stateManagers.forEach((stateManager) => {
          stateManager.forceRefresh();
        });
      },
    });

    this.addSettingTab(this.settingsTab);

    // 只注册项目看板视图，不再注册单文件看板视图
    this.registerView(projectKanbanViewType, (leaf) => new ProjectKanbanView(leaf, this));
    this.registerMonkeyPatches();
    this.registerCommands();
    this.registerEvents();

    // Mount an empty component to start; views will be added as we go
    this.mount(window);

    (this.app.workspace as any).floatingSplit?.children?.forEach((c: any) => {
      this.mount(c.win);
    });

    this.registerDomEvent(window, 'keydown', this.handleShift);
    this.registerDomEvent(window, 'keyup', this.handleShift);

    // 只保留一个 ribbon 图标，用于打开项目看板视图
    this.addRibbonIcon(kanbanIcon, t('Open projects kanban'), () => {
      this.openProjectKanban();
    });
  }

  handleShift = (e: KeyboardEvent) => {
    this.isShiftPressed = e.shiftKey;
  };

  getKanbanViews(win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg) {
      return Array.from(reg.viewMap.values());
    }

    return [];
  }

  getKanbanView(id: string, win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg?.viewMap.has(id)) {
      return reg.viewMap.get(id);
    }

    for (const reg of this.windowRegistry.values()) {
      if (reg.viewMap.has(id)) {
        return reg.viewMap.get(id);
      }
    }

    return null;
  }

  getStateManager(file: TFile) {
    return this.stateManagers.get(file);
  }

  getStateManagerFromViewID(id: string, win: Window) {
    const view = this.getKanbanView(id, win);

    if (!view) {
      return null;
    }

    return this.stateManagers.get(view.file);
  }

  useKanbanViews(win: Window): KanbanView[] {
    const [state, setState] = useState(this.getKanbanViews(win));

    useEffect(() => {
      const reg = this.windowRegistry.get(win);

      reg?.viewStateReceivers.push(setState);

      return () => {
        reg?.viewStateReceivers.remove(setState);
      };
    }, [win]);

    return state;
  }

  addView(view: KanbanView, data: string, shouldParseData: boolean) {
    const win = view.getWindow();
    const reg = this.windowRegistry.get(win);

    if (!reg) return;
    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    const file = view.file;

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).registerView(view, data, shouldParseData);
    } else {
      this.stateManagers.set(
        file,
        new StateManager(
          this.app,
          view,
          data,
          () => this.stateManagers.delete(file),
          () => this.settings
        )
      );
    }

    reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
  }

  removeView(view: KanbanView) {
    const entry = Array.from(this.windowRegistry.entries()).find(([, reg]) => {
      return reg.viewMap.has(view.id);
    }, []);

    if (!entry) return;

    const [win, reg] = entry;
    const file = view.file;

    if (reg.viewMap.has(view.id)) {
      reg.viewMap.delete(view.id);
    }

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).unregisterView(view);
      reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
    }
  }

  handleViewFileRename(view: KanbanView, oldPath: string) {
    const win = view.getWindow();
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);
    const oldId = `${(view.leaf as any).id}:::${oldPath}`;

    if (reg.viewMap.has(oldId)) {
      reg.viewMap.delete(oldId);
    }

    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    if (view.isPrimary) {
      this.getStateManager(view.file).softRefresh();
    }
  }

  mount(win: Window) {
    if (this.windowRegistry.has(win)) {
      return;
    }

    const el = win.document.body.createDiv();

    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });

    render(createApp(win, this), el);
  }

  unmount(win: Window) {
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);

    for (const view of reg.viewMap.values()) {
      this.removeView(view);
    }

    unmountComponentAtNode(reg.appRoot);

    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  }

  async setMarkdownView(leaf: WorkspaceLeaf, focus: boolean = true) {
    await leaf.setViewState(
      {
        type: 'markdown',
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus }
    );
  }

  // 不再需要 setKanbanView，因为只使用项目看板视图
  // async setKanbanView(leaf: WorkspaceLeaf) {
  //   await leaf.setViewState({
  //     type: kanbanViewType,
  //     state: leaf.view.getState(),
  //     popstate: true,
  //   } as ViewState);
  // }

  /**
   * 创建新的项目看板文件（包含 project frontmatter）
   */
  async newProjectKanban(folder?: TFolder) {
    const targetFolder = folder
      ? folder
      : this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path || '');

    try {
      const projectFile: TFile = await (this.app.fileManager as any).createNewMarkdownFile(
        targetFolder,
        'Untitled Project'
      );

      // 创建包含 project 标记的 frontmatter
      const projectFrontmatter = [
        '---',
        '',
        'project: true',
        `${frontmatterKey}: board`,
        '',
        '---',
        '',
        '',
      ].join('\n');

      await this.app.vault.modify(projectFile, projectFrontmatter);
      
      // 打开项目看板视图（会自动扫描并显示新文件）
      await this.openProjectKanban();
    } catch (e) {
      console.error('Error creating project kanban board:', e);
    }
  }

  /**
   * 保留原有方法用于向后兼容，但改为创建项目文件
   */
  async newKanban(folder?: TFolder) {
    return this.newProjectKanban(folder);
  }

  registerEvents() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (source === 'link-context-menu') return;

        const fileIsFile = file instanceof TFile;
        const fileIsFolder = file instanceof TFolder;
        const leafIsMarkdown = leaf?.view instanceof MarkdownView;
        const leafIsKanban = leaf?.view instanceof KanbanView;

        // Add a menu item to the folder context menu to create a project board
        if (fileIsFolder) {
          menu.addItem((item) => {
            item
              .setSection('action-primary')
              .setTitle(t('New project board'))
              .setIcon(kanbanIcon)
              .onClick(() => this.newProjectKanban(file));
          });
          return;
        }

        // 移除了单文件看板相关的菜单项，只支持项目看板视图
        // 如果文件包含 project frontmatter，可以提示用户打开项目看板视图
        if (
          fileIsFile &&
          leaf &&
          source === 'sidebar-context-menu'
        ) {
          const cache = this.app.metadataCache.getFileCache(file);
          if (cache?.frontmatter && cache.frontmatter['project']) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open projects kanban'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.openProjectKanban();
                });
            });
          }
        }

        // 移除了单文件看板的菜单处理
        // 项目看板视图的菜单在 ProjectKanbanView.onPaneMenu 中处理
      })
    );

    // 移除了单文件看板的文件重命名处理
    // 项目看板视图会在 ProjectStateManager 中处理文件变化

    const notifyFileChange = debounce(
      (file: TFile) => {
        // 项目看板视图的文件变化处理在 ProjectStateManager 中
        // 这里保留用于向后兼容（如果有单文件看板视图打开）
        this.stateManagers.forEach((manager) => {
          if (manager.file !== file) {
            manager.onFileMetadataChange();
          }
        });
      },
      2000,
      true
    );

    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (file instanceof TFile) {
          notifyFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      (this.app as any).metadataCache.on('dataview:metadata-change', (_: any, file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      (this.app as any).metadataCache.on('dataview:api-ready', () => {
        this.stateManagers.forEach((manager) => {
          manager.forceRefresh();
        });
      })
    );

    (this.app.workspace as any).registerHoverLinkSource(frontmatterKey, {
      display: 'Kanban',
      defaultMod: true,
    });
  }

  async openProjectKanban() {
    const leaf = this.app.workspace.getLeaf();
    await leaf.setViewState({
      type: projectKanbanViewType,
    });
  }

  registerCommands() {
    // 主要命令：打开项目看板视图
    this.addCommand({
      id: 'open-project-kanban',
      name: t('Open projects kanban'),
      callback: () => this.openProjectKanban(),
    });

    // 创建新项目看板文件
    this.addCommand({
      id: 'create-new-kanban-board',
      name: t('Create new project board'),
      callback: () => this.newProjectKanban(),
    });

    // 移除了所有单文件看板相关的命令，只保留项目看板视图的命令
    // 如果需要，可以为项目看板视图添加相应的命令
  }

  registerMonkeyPatches() {
    const self = this;

    // 移除了单文件看板的命令拦截，项目看板视图不需要

    // 移除了单文件看板的 activeEditor 设置
    // this.register(
    //   around(this.app.workspace, {
    //     // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //     // @ts-ignore
    //     setActiveLeaf(next) {
    //       return function (...args) {
    //         next.apply(this, args);
    //         const view = this.getActiveViewOfType(KanbanView);
    //         if (view?.activeEditor) {
    //           this.activeEditor = view.activeEditor;
    //         }
    //       };
    //     },
    //   })
    // );

    // Monkey patch WorkspaceLeaf to open Kanbans with KanbanView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Kanbans can be viewed as markdown or kanban, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.kanbanFileModes[this.id || state.file]) {
              delete self.kanbanFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState(next) {
          return function (state: ViewState, ...rest: any[]) {
            // 不再自动打开单文件看板视图，只支持项目聚合视图
            // 保留此方法以支持手动打开旧格式的看板文件（如果需要）
            return next.apply(this, [state, ...rest]);
          };
        },
      })
    );
  }
}
