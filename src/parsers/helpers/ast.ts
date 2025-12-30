import { Content, Parent } from 'mdast';

export interface ContentBoundary {
  start: number;
  end: number;
}

export function getNodeContentBoundary(node: Parent): ContentBoundary | null {
  if (!node || !node.children || node.children.length === 0) return null;
  
  // 检查 position 是否存在
  if (!node.children[0]?.position?.start?.offset) {
    return null;
  }
  
  const last = node.children.length - 1;

  if ((node.children[last] as any).type === 'blockid') {
    if (last === 0) {
      return {
        start: node.children[0].position.start.offset,
        end: node.children[0].position.start.offset,
      };
    }

    if (!node.children[last - 1]?.position?.end?.offset) {
      return null;
    }

    return {
      start: node.children[0].position.start.offset,
      end: node.children[last - 1].position.end.offset,
    };
  }

  if (!node.children[last]?.position?.end?.offset) {
    return null;
  }

  return {
    start: node.children[0].position.start.offset,
    end: node.children[last].position.end.offset,
  };
}

export function getStringFromBoundary(md: string, boundary: ContentBoundary | null) {
  if (!boundary) return '';

  return md.slice(boundary.start, boundary.end);
}

export function getPrevSibling(children: Content[], currentIndex: number) {
  if (!children || !Array.isArray(children) || currentIndex <= 0) return null;
  return children[currentIndex - 1];
}

export function getNextSibling(children: Content[], currentIndex: number) {
  if (!children || !Array.isArray(children) || children.length === 0) return null;
  if (currentIndex === children.length - 1) return null;
  return children[currentIndex + 1];
}

export function getNextOfType(
  children: Content[],
  currentIndex: number,
  type: string,
  shouldContinue: (child: Content) => boolean = () => true
) {
  // 检查 children 是否存在且为数组
  if (!children || !Array.isArray(children) || children.length === 0) {
    return null;
  }
  
  for (let i = currentIndex + 1, len = children.length; i < len; i++) {
    const child = children[i];

    if (!child) continue;

    if (type === child.type) {
      return child;
    }

    if (!shouldContinue(child)) {
      return null;
    }
  }

  return null;
}
