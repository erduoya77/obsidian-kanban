import { Extension as FromMarkdownExtension, Token } from 'mdast-util-from-markdown';
import { markdownLineEnding, markdownLineEndingOrSpace } from 'micromark-util-character';
import { Effects, Extension, State } from 'micromark-util-types';

import { getSelf } from './helpers';

export function genericWrappedExtension(
  name: string,
  startMarker: string,
  endMarker: string
): Extension {
  function tokenize(effects: Effects, ok: State, nok: State) {
    let data = false;
    let startMarkerCursor = 0;
    let endMarkerCursor = 0;

    return start;

    function start(code: number) {
      if (code !== startMarker.charCodeAt(startMarkerCursor)) return nok(code);

      effects.enter(name as any);
      effects.enter(`${name}Marker` as any);

      return consumeStart(code);
    }

    function consumeStart(code: number) {
      if (startMarkerCursor === startMarker.length) {
        effects.exit(`${name}Marker` as any);
        return consumeData(code);
      }

      if (code !== startMarker.charCodeAt(startMarkerCursor)) {
        return nok(code);
      }

      effects.consume(code);
      startMarkerCursor++;

      return consumeStart;
    }

    function consumeData(code: number) {
      if (markdownLineEnding(code) || code === null) {
        return nok(code);
      }

      effects.enter(`${name}Data` as any);
      effects.enter(`${name}Target` as any);
      return consumeTarget(code);
    }

    function consumeTarget(code: number) {
      if (code === endMarker.charCodeAt(endMarkerCursor)) {
        if (!data) return nok(code);
        effects.exit(`${name}Target` as any);
        effects.exit(`${name}Data` as any);
        effects.enter(`${name}Marker` as any);
        return consumeEnd(code);
      }

      if (markdownLineEnding(code) || code === null) {
        return nok(code);
      }

      if (!markdownLineEndingOrSpace(code)) {
        data = true;
      }

      effects.consume(code);

      return consumeTarget;
    }

    function consumeEnd(code: number) {
      if (endMarkerCursor === endMarker.length) {
        effects.exit(`${name}Marker` as any);
        effects.exit(name as any);
        return ok(code);
      }

      if (code !== endMarker.charCodeAt(endMarkerCursor)) {
        return nok(code);
      }

      effects.consume(code);
      endMarkerCursor++;

      return consumeEnd;
    }
  }

  const call = { tokenize: tokenize };

  return {
    text: { [startMarker.charCodeAt(0)]: call },
  };
}

export function genericWrappedFromMarkdown(
  name: string,
  process?: (str: string, curr: Record<string, any>) => void
): FromMarkdownExtension {
  function enterWrapped(token: Token) {
    this.enter(
      {
        type: name,
        value: null,
        children: [], // 确保节点有 children 属性，避免 visit 函数访问 undefined.length
      },
      token
    );
  }

  function exitWrappedTarget(token: Token) {
    const target = this.sliceSerialize(token);
    const current = getSelf(this.stack);

    (current as any).value = target;

    // 确保当前节点和整个 stack 中的所有节点都有 children 属性
    // 避免 process 回调中调用 visit 时出错
    if (this.stack && Array.isArray(this.stack)) {
      for (const node of this.stack) {
        if (node && typeof node === 'object') {
          if (!('children' in node)) {
            node.children = [];
          } else if (node.children === undefined || node.children === null) {
            node.children = [];
          }
        }
      }
    }

    // 确保当前节点有 children 属性
    if (current && typeof current === 'object') {
      if (!('children' in current)) {
        current.children = [];
      } else if (current.children === undefined || current.children === null) {
        current.children = [];
      }
    }

    if (process) {
      try {
        process(target, current);
      } catch (error) {
        console.error(`❌ [DEBUG] genericWrappedFromMarkdown process callback error for ${name}:`, error);
        // 不重新抛出错误，避免中断解析过程
      }
    }
  }

  function exitWrapped(token: Token) {
    this.exit(token);
  }

  return {
    enter: {
      [name]: enterWrapped,
    },
    exit: {
      [`${name}Target`]: exitWrappedTarget,
      [name]: exitWrapped,
    },
  };
}
