import classcat from 'classcat';
import { memo, useMemo } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { getTaskStatusDone } from 'src/parsers/helpers/inlineMetadata';
import { t } from 'src/lang/helpers';

import { Icon } from './Icon/Icon';
import { c } from './helpers';
import { Board, SearchContextProps } from './types';

interface FilterToolbarProps {
  stateManager: StateManager;
  boardData: Board;
  statusFilter: 'all' | 'pending' | 'in-progress' | 'done';
  setStatusFilter: (filter: 'all' | 'pending' | 'in-progress' | 'done') => void;
  projectFilters: Set<string>;
  searchValue: SearchContextProps;
}

export const FilterToolbar = memo(function FilterToolbar({
  stateManager,
  boardData,
  statusFilter,
  setStatusFilter,
  projectFilters,
  searchValue,
}: FilterToolbarProps) {
  // 提取所有项目（从 lane title）
  const allProjects = useMemo(() => {
    return boardData.children.map((lane) => lane.data.title).sort();
  }, [boardData]);

  const doneChar = getTaskStatusDone();

  // 统计各状态的卡片数量
  const statusCounts = useMemo(() => {
    let pending = 0;
    let inProgress = 0;
    let done = 0;

    // 在项目视图模式下，直接使用lane的长度（因为已经按状态分组了）
    if (boardData.children.some(lane => lane.id.startsWith('filtered-'))) {
      boardData.children.forEach((lane) => {
        if (lane.id === 'filtered-pending') {
          pending = lane.children.length;
        } else if (lane.id === 'filtered-in-progress') {
          inProgress = lane.children.length;
        } else if (lane.id === 'filtered-done') {
          done = lane.children.length;
        }
      });
    } else {
      // 正常模式下的统计
      boardData.children.forEach((lane) => {
        lane.children.forEach((item) => {
          if (item.data.checkChar === ' ') {
            pending++;
          } else if (item.data.checkChar === '/') {
            inProgress++;
          } else if (item.data.checkChar === doneChar) {
            done++;
          }
        });
      });
    }

    return { pending, inProgress, done };
  }, [boardData, doneChar]);

  // 统计各项目的卡片数量
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    boardData.children.forEach((lane) => {
      const projectName = lane.data.title;
      counts.set(projectName, lane.children.length);
    });
    return counts;
  }, [boardData]);

  // 始终显示过滤器工具栏

  return (
    <div className={c('filter-toolbar')}>
      {projectFilters.size > 0 ? (
        // 项目视图模式：显示当前选择的项目
        <div className={c('filter-group')}>
          <span className={c('filter-label')}>{t('Project')}:</span>
          <div className={c('project-indicator')}>
            {Array.from(projectFilters).join(', ')}
            <button
              className={c('filter-clear-button')}
              onClick={() => searchValue.setProjectFilters(new Set())}
              aria-label={t('Clear project filter')}
            >
              <Icon name="lucide-x" />
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 状态过滤器 */}
          <div className={c('filter-group')}>
            <span className={c('filter-label')}>{t('Status')}:</span>
            <div className={c('filter-buttons')}>
              <button
                className={classcat([c('filter-button'), { [c('filter-button-active')]: statusFilter === 'all' }])}
                onClick={() => setStatusFilter('all')}
              >
                {t('All')} ({statusCounts.pending + statusCounts.inProgress + statusCounts.done})
              </button>
              <button
                className={classcat([c('filter-button'), { [c('filter-button-active')]: statusFilter === 'pending' }])}
                onClick={() => setStatusFilter('pending')}
              >
                {t('Pending')} ({statusCounts.pending})
              </button>
              <button
                className={classcat([c('filter-button'), { [c('filter-button-active')]: statusFilter === 'in-progress' }])}
                onClick={() => setStatusFilter('in-progress')}
              >
                {t('In Progress')} ({statusCounts.inProgress})
              </button>
              <button
                className={classcat([c('filter-button'), { [c('filter-button-active')]: statusFilter === 'done' }])}
                onClick={() => setStatusFilter('done')}
              >
                {t('Done')} ({statusCounts.done})
              </button>
            </div>
          </div>

          {/* 项目过滤器 */}
          <div className={c('filter-group')}>
            <span className={c('filter-label')}>{t('Project')}:</span>
            <div className={c('filter-buttons')}>
              {allProjects.map((project) => {
                const isActive = projectFilters.has(project);
                const count = projectCounts.get(project) || 0;
                return (
                  <button
                    key={project}
                    className={classcat([c('filter-button'), { [c('filter-button-active')]: isActive }])}
                    onClick={() => searchValue.toggleProjectFilter(project)}
                  >
                    {project} ({count})
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* 清除所有过滤器 - 只在非项目视图模式下显示 */}
      {projectFilters.size === 0 && (statusFilter !== 'all' || projectFilters.size > 0) && (
        <button
          className={c('filter-clear-button')}
          onClick={() => {
            setStatusFilter('all');
            searchValue.setProjectFilters(new Set());
          }}
          aria-label={t('Clear filters')}
        >
          <Icon name="lucide-x" /> {t('Clear')}
        </button>
      )}
    </div>
  );
});

