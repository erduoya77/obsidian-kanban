# 如何使用调试函数

## 方法 1: 在 `ProjectStateManager.ts` 中添加调试

在 `parseProjectFile` 方法中添加：

```typescript
import { debugAST, findProblematicNodes } from './debug-helpers';

async parseProjectFile(content: string, tempStateManager: any): Promise<Board> {
  try {
    console.log('🔍 [DEBUG] ========== 开始解析文件 ==========');
    console.log('🔍 [DEBUG] 文件路径:', tempStateManager.file.path);
    console.log('🔍 [DEBUG] 文件内容长度:', content.length);
    console.log('🔍 [DEBUG] 文件内容前 200 字符:', content.substring(0, 200));
    
    const { settings, frontmatter, ast } = parseMarkdown(tempStateManager, content);
    
    console.log('🔍 [DEBUG] AST 基本信息:', {
      type: ast?.type,
      hasChildren: 'children' in ast,
      childrenValue: ast?.children,
      childrenIsArray: Array.isArray(ast?.children),
    });
    
    // 深度检查 AST
    console.log('🔍 [DEBUG] ========== AST 结构检查 ==========');
    debugAST(ast, 'ast');
    
    // 查找有问题的节点
    console.log('🔍 [DEBUG] ========== 查找问题节点 ==========');
    const problems = findProblematicNodes(ast, 'ast');
    if (problems.length > 0) {
      console.warn('⚠️ [DEBUG] 发现', problems.length, '个潜在问题:');
      problems.forEach(({ path, issue, node }) => {
        console.warn(`  - ${path}: ${issue}`, node);
      });
    } else {
      console.log('✅ [DEBUG] 未发现明显问题');
    }
    
    // ... 其余代码保持不变
  } catch (e) {
    console.error('❌ [DEBUG] ========== 错误详情 ==========');
    console.error('❌ [DEBUG] 文件:', tempStateManager.file.path);
    console.error('❌ [DEBUG] 错误:', e);
    if (e instanceof Error) {
      console.error('❌ [DEBUG] 错误消息:', e.message);
      console.error('❌ [DEBUG] 错误堆栈:', e.stack);
    }
    throw e;
  }
}
```

## 方法 2: 在 `list.ts` 中添加调试

在 `listItemToItemData` 函数中，在调用 `visit` 之前：

```typescript
import { debugAST, checkNodeSafety, debugVisit } from '../debug-helpers';

export function listItemToItemData(stateManager: StateManager, md: string, item: TaskItem) {
  // ... 前面的代码 ...
  
  // 在调用 visit 之前添加调试
  try {
    if (item && item.children && Array.isArray(item.children) && item.children.length > 0) {
      console.log('🔍 [DEBUG] ========== 处理 item ==========');
      console.log('🔍 [DEBUG] item 基本信息:', {
        type: item.type,
        checked: item.checked,
        hasChildren: 'children' in item,
        childrenLength: Array.isArray(item.children) ? item.children.length : 'N/A',
      });
      
      // 检查原始 item
      console.log('🔍 [DEBUG] 检查原始 item 安全性...');
      const originalSafe = checkNodeSafety(item, 'item');
      console.log('🔍 [DEBUG] 原始 item 安全性:', originalSafe);
      
      // 深度检查 item 结构
      debugAST(item, 'item');
      
      const safeItem = ensureChildrenAreArrays(item, 0);
      
      // 检查清理后的 item
      console.log('🔍 [DEBUG] 检查清理后的 item 安全性...');
      const cleanedSafe = checkNodeSafety(safeItem, 'safeItem');
      console.log('🔍 [DEBUG] 清理后的 item 安全性:', cleanedSafe);
      
      // 再次深度检查
      debugAST(safeItem, 'safeItem');
      
      if (!safeItem || !safeItem.children || !Array.isArray(safeItem.children)) {
        console.warn('⚠️ [DEBUG] SafeItem 验证失败');
        titleSearch = title;
      } else {
        // 使用调试版本的 visit
        try {
          debugVisit(
            safeItem,
            ['text', 'wikilink', 'embedWikilink', 'image', 'inlineCode', 'code', 'hashtag'],
            (node: any, i, parent) => {
              // 原有的 visitor 逻辑
              // ...
            },
            'safeItem'
          );
        } catch (visitError) {
          console.error('❌ [DEBUG] visit 调用失败:', visitError);
          throw visitError;
        }
      }
    }
  } catch (e) {
    console.error('❌ [DEBUG] listItemToItemData 错误:', e);
    throw e;
  }
  
  // ... 其余代码 ...
}
```

## 方法 3: 在浏览器控制台中直接调试

打开 Obsidian 的开发者工具（Ctrl+Shift+I），在 Console 中输入：

```javascript
// 检查当前解析的文件
// 需要先找到 ProjectStateManager 实例
// 或者在代码中添加全局变量来访问

// 例如，在 ProjectStateManager 构造函数中添加：
window.debugProjectManager = this;

// 然后在控制台中使用：
window.debugProjectManager.projectFiles.forEach((file, path) => {
  console.log('文件:', path);
  console.log('Board:', file.board);
});
```

## 方法 4: 添加条件断点

在关键位置添加条件断点：

```typescript
// 在 visit 调用前
if (process.env.NODE_ENV === 'development') {
  debugger; // 浏览器会在这里暂停
}

// 或者添加条件
if (tempStateManager.file.path.includes('白山云')) {
  debugger; // 只在特定文件暂停
}
```

## 查看调试输出

1. 打开 Obsidian
2. 按 `Ctrl+Shift+I` (Windows/Linux) 或 `Cmd+Option+I` (Mac) 打开开发者工具
3. 切换到 Console 标签
4. 重新加载插件或触发文件解析
5. 查看以 `🔍 [DEBUG]` 开头的日志
6. 查找以 `⚠️` 或 `❌` 开头的警告和错误

## 分析调试输出

重点关注：
1. **AST 结构**：检查是否有节点缺少 `children` 属性或 `children` 不是数组
2. **问题节点**：`findProblematicNodes` 会列出所有有问题的节点
3. **visit 调用**：检查 `visit` 调用前后的节点状态
4. **错误堆栈**：查看完整的错误堆栈，定位具体位置

## 临时启用调试

如果不想修改代码，可以在浏览器控制台中临时启用：

```javascript
// 拦截 console.log，只显示调试信息
const originalLog = console.log;
console.log = function(...args) {
  if (args[0] && args[0].includes('[DEBUG]')) {
    originalLog.apply(console, args);
  }
};
```

