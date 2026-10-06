import type { ConditionGroup, RuleCondition } from '../models/ruleModel';

/**
 * 从根条件组到某个节点的索引路径；空路径表示根条件组本身。
 * 规则卡片里的每一行条件、每一个嵌套条件组都用这样一条路径定位。
 */
export type ConditionPath = readonly number[];

export function getConditionNode(root: ConditionGroup, path: ConditionPath): RuleCondition | undefined {
  let node: RuleCondition = root;
  for (const index of path) {
    if (node.kind !== 'group') return undefined;
    const child: RuleCondition | undefined = node.conditions[index];
    if (!child) return undefined;
    node = child;
  }
  return node;
}

export function getConditionGroup(root: ConditionGroup, path: ConditionPath): ConditionGroup | undefined {
  const node = getConditionNode(root, path);
  return node?.kind === 'group' ? node : undefined;
}

/** 对路径指向的条件组应用变换，返回新的根条件组；路径无效时原样返回。 */
export function mapConditionGroup(
  root: ConditionGroup,
  path: ConditionPath,
  update: (group: ConditionGroup) => ConditionGroup,
): ConditionGroup {
  if (path.length === 0) return update(root);
  const [head, ...rest] = path;
  const child = root.conditions[head];
  if (!child || child.kind !== 'group') return root;
  const conditions = root.conditions.slice();
  conditions[head] = mapConditionGroup(child, rest, update);
  return { ...root, conditions };
}

/** 替换路径指向的任意节点（谓词或条件组）；路径无效时原样返回。 */
export function replaceConditionNode(root: ConditionGroup, path: ConditionPath, next: RuleCondition): ConditionGroup {
  if (path.length === 0) return next.kind === 'group' ? next : root;
  const [head, ...rest] = path;
  if (head >= root.conditions.length) return root;
  const conditions = root.conditions.slice();
  if (rest.length === 0) {
    conditions[head] = next;
    return { ...root, conditions };
  }
  const child = conditions[head];
  if (!child || child.kind !== 'group') return root;
  conditions[head] = replaceConditionNode(child, rest, next);
  return { ...root, conditions };
}

/** 移除路径指向的节点；路径无效或指向根条件组时原样返回。 */
export function removeConditionNode(root: ConditionGroup, path: ConditionPath): ConditionGroup {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (head >= root.conditions.length) return root;
  if (rest.length === 0) {
    return { ...root, conditions: root.conditions.filter((_, index) => index !== head) };
  }
  const child = root.conditions[head];
  if (!child || child.kind !== 'group') return root;
  const conditions = root.conditions.slice();
  conditions[head] = removeConditionNode(child, rest);
  return { ...root, conditions };
}

/**
 * 规整条件树，保证不出现无意义结构：
 * - 丢弃没有任何子项的嵌套条件组；
 * - 把只剩一个子项的嵌套条件组折叠成这个子项（AND/OR 作用于单个子项恒等于子项本身，语义不变）。
 * 根条件组不参与折叠，允许只含一个条件，由编辑器保证其不为空。
 */
export function normalizeConditionGroup(group: ConditionGroup): ConditionGroup {
  const conditions: RuleCondition[] = [];
  for (const child of group.conditions) {
    if (child.kind !== 'group') {
      conditions.push(child);
      continue;
    }
    const normalized = normalizeConditionGroup(child);
    if (normalized.conditions.length === 0) continue;
    if (normalized.conditions.length === 1) conditions.push(normalized.conditions[0]);
    else conditions.push(normalized);
  }
  const unchanged = conditions.length === group.conditions.length
    && conditions.every((condition, index) => condition === group.conditions[index]);
  return unchanged ? group : { ...group, conditions };
}
