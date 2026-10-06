import type { ConditionGroup, RuleCondition } from '../models/ruleModel';

/**
 * 条件树以“从根组出发的子项索引路径”寻址，例如 [2, 0] 表示根组第 3 个子组里的第 1 个条件。
 * 所有操作都返回新树，不修改传入的结构。
 */

export function getConditionAtPath(root: ConditionGroup, path: number[]): RuleCondition | undefined {
  let current: RuleCondition = root;
  for (const index of path) {
    if (current.kind !== 'group') return undefined;
    const next: RuleCondition | undefined = current.conditions[index];
    if (!next) return undefined;
    current = next;
  }
  return current;
}

export function replaceConditionAtPath(root: ConditionGroup, path: number[], node: RuleCondition): ConditionGroup {
  if (path.length === 0) return node.kind === 'group' ? node : root;
  const [head, ...rest] = path;
  return {
    ...root,
    conditions: root.conditions.map((child, index) => {
      if (index !== head) return child;
      return rest.length === 0 ? node : child.kind === 'group' ? replaceConditionAtPath(child, rest, node) : child;
    }),
  };
}

export function appendConditionAtPath(root: ConditionGroup, groupPath: number[], node: RuleCondition): ConditionGroup {
  if (groupPath.length === 0) return { ...root, conditions: [...root.conditions, node] };
  const [head, ...rest] = groupPath;
  return {
    ...root,
    conditions: root.conditions.map((child, index) =>
      index === head && child.kind === 'group' ? appendConditionAtPath(child, rest, node) : child),
  };
}

export function removeConditionAtPath(root: ConditionGroup, path: number[]): ConditionGroup {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (rest.length === 0) return { ...root, conditions: root.conditions.filter((_, index) => index !== head) };
  return {
    ...root,
    conditions: root.conditions.map((child, index) =>
      index === head && child.kind === 'group' ? removeConditionAtPath(child, rest) : child),
  };
}

export function setGroupOperatorAtPath(root: ConditionGroup, path: number[], operator: ConditionGroup['operator']): ConditionGroup {
  if (path.length === 0) return { ...root, operator };
  const [head, ...rest] = path;
  return {
    ...root,
    conditions: root.conditions.map((child, index) =>
      index === head && child.kind === 'group' ? setGroupOperatorAtPath(child, rest, operator) : child),
  };
}

/**
 * 规范化嵌套结构：丢弃空的嵌套条件组、展开只有一个子项的嵌套组（级联向上）。
 * 根组本身始终保留，即使只剩 0 或 1 个子项——空根组由校验与编辑守卫处理。
 * 没有任何变化时返回原引用，调用方可以据此判断是否发生了折叠。
 */
export function normalizeConditionTree(group: ConditionGroup): ConditionGroup {
  let changed = false;
  const conditions: RuleCondition[] = [];
  for (const child of group.conditions) {
    if (child.kind !== 'group') {
      conditions.push(child);
      continue;
    }
    const normalized = normalizeConditionTree(child);
    if (normalized.conditions.length === 0) {
      changed = true;
      continue;
    }
    if (normalized.conditions.length === 1) {
      conditions.push(normalized.conditions[0]);
      changed = true;
      continue;
    }
    if (normalized !== child) changed = true;
    conditions.push(normalized);
  }
  return changed ? { ...group, conditions } : group;
}
