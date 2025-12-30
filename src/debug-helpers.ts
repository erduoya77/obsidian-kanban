/**
 * 调试辅助函数
 * 用于定位 AST 解析问题
 */

/**
 * 深度检查 AST 节点结构，找出所有可能有问题的节点
 */
export function debugAST(node: any, path: string = 'root', depth: number = 0, maxDepth: number = 10): void {
  if (depth > maxDepth) {
    console.warn(`🔍 [DEBUG] 达到最大深度 ${maxDepth}，停止检查: ${path}`);
    return;
  }

  if (!node || typeof node !== 'object') {
    console.log(`🔍 [DEBUG] ${path}: 非对象节点，值:`, node);
    return;
  }

  const nodeType = node.type || 'unknown';
  const hasChildren = 'children' in node;
  const childrenValue = node.children;
  const childrenIsArray = Array.isArray(childrenValue);
  const childrenIsUndefined = childrenValue === undefined;
  const childrenIsNull = childrenValue === null;

  // 检查潜在问题
  const issues: string[] = [];
  if (hasChildren && childrenIsUndefined) {
    issues.push('⚠️ children 属性存在但值为 undefined');
  }
  if (hasChildren && childrenIsNull) {
    issues.push('⚠️ children 属性存在但值为 null');
  }
  if (hasChildren && !childrenIsArray && !childrenIsUndefined && !childrenIsNull) {
    issues.push(`⚠️ children 不是数组，类型: ${typeof childrenValue}`);
  }

  const logPrefix = '  '.repeat(depth);
  if (issues.length > 0) {
    console.warn(`${logPrefix}🔍 [DEBUG] ${path}:`, {
      type: nodeType,
      hasChildren,
      childrenValue,
      childrenIsArray,
      issues,
    });
  } else {
    console.log(`${logPrefix}🔍 [DEBUG] ${path}:`, {
      type: nodeType,
      hasChildren,
      childrenIsArray,
      childrenLength: childrenIsArray ? childrenValue.length : 'N/A',
    });
  }

  // 递归检查子节点
  if (hasChildren && childrenIsArray && childrenValue.length > 0) {
    childrenValue.forEach((child: any, index: number) => {
      if (child && typeof child === 'object') {
        debugAST(child, `${path}.children[${index}]`, depth + 1, maxDepth);
      }
    });
  }
}

/**
 * 检查节点是否可以被 visit 函数安全访问
 */
export function checkNodeSafety(node: any, nodeName: string = 'node'): boolean {
  if (!node || typeof node !== 'object') {
    console.warn(`⚠️ [DEBUG] ${nodeName}: 不是对象`);
    return false;
  }

  // 检查是否有 children 属性（包括原型链）
  const hasChildren = 'children' in node;
  
  if (hasChildren) {
    const childrenValue = node.children;
    
    if (childrenValue === undefined) {
      console.warn(`⚠️ [DEBUG] ${nodeName}: children 属性存在但值为 undefined`);
      return false;
    }
    
    if (childrenValue === null) {
      console.warn(`⚠️ [DEBUG] ${nodeName}: children 属性存在但值为 null`);
      return false;
    }
    
    if (!Array.isArray(childrenValue)) {
      console.warn(`⚠️ [DEBUG] ${nodeName}: children 不是数组，类型: ${typeof childrenValue}`, childrenValue);
      return false;
    }
    
    // 检查子节点
    childrenValue.forEach((child: any, index: number) => {
      if (child && typeof child === 'object') {
        checkNodeSafety(child, `${nodeName}.children[${index}]`);
      }
    });
  }

  return true;
}

/**
 * 包装 visit 函数调用，添加调试信息
 */
export function debugVisit<T extends { type?: string }>(
  node: T,
  test: string[] | ((node: any) => boolean),
  visitor: (node: any, index: number | undefined, parent: any) => void,
  nodeName: string = 'root'
): void {
  console.log(`🔍 [DEBUG] 准备调用 visit，节点:`, {
    name: nodeName,
    type: node?.type,
    hasChildren: 'children' in node,
    childrenValue: (node as any)?.children,
    childrenIsArray: Array.isArray((node as any)?.children),
  });

  // 检查节点安全性
  if (!checkNodeSafety(node, nodeName)) {
    console.error(`❌ [DEBUG] 节点 ${nodeName} 不安全，无法调用 visit`);
    return;
  }

  try {
    const { visit } = require('unist-util-visit');
    visit(node, test, visitor);
    console.log(`✅ [DEBUG] visit 调用成功: ${nodeName}`);
  } catch (error) {
    console.error(`❌ [DEBUG] visit 调用失败: ${nodeName}`, error);
    console.error(`❌ [DEBUG] 错误节点结构:`, JSON.stringify(node, null, 2));
    throw error;
  }
}

/**
 * 检查 AST 中所有可能有问题的节点
 */
export function findProblematicNodes(node: any, path: string = 'root', depth: number = 0): Array<{ path: string; issue: string; node: any }> {
  const problems: Array<{ path: string; issue: string; node: any }> = [];

  if (!node || typeof node !== 'object') {
    return problems;
  }

  const hasChildren = 'children' in node;
  
  if (hasChildren) {
    const childrenValue = node.children;
    
    if (childrenValue === undefined) {
      problems.push({
        path,
        issue: 'children 属性存在但值为 undefined',
        node: { type: node.type, ...node },
      });
    } else if (childrenValue === null) {
      problems.push({
        path,
        issue: 'children 属性存在但值为 null',
        node: { type: node.type, ...node },
      });
    } else if (!Array.isArray(childrenValue)) {
      problems.push({
        path,
        issue: `children 不是数组，类型: ${typeof childrenValue}`,
        node: { type: node.type, children: childrenValue },
      });
    } else {
      // 递归检查子节点
      childrenValue.forEach((child: any, index: number) => {
        if (child && typeof child === 'object') {
          problems.push(...findProblematicNodes(child, `${path}.children[${index}]`, depth + 1));
        }
      });
    }
  }

  return problems;
}

